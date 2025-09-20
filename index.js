/**
 * Dainify Konverteris (maksimaliai ištobulinta versija)
 * - Priima MP3 (audioUrl) ir HLS (streamUrl/m3u8) variantus
 * - Iš HLS master parenka vieną MEDIA playlistą (protingai – „vidurinį“ pagal BW)
 * - Absoliutina segmentų ir KEY/MAP URL'us, rašo lokalų .m3u8
 * - Trim'ina iki 30 s su FFmpeg, kelia į R2, siunčia callback į Worker'į
 * - Tvirtas retry/timeout/headers, konkurentiškumo limiteris
 */

import express from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/* ===================== KONFIGŪRACIJA ===================== */

const config = {
  port: Number(process.env.PORT || 10000),
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME,
  },
  worker: {
    callbackUrl: process.env.WORKER_CALLBACK_URL,
    callbackSecret: process.env.WORKER_CALLBACK_SECRET,
  },
  webhookSecret: process.env.WEBHOOK_SECRET,
  // techniniai:
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 2),
  ffmpegTrimSeconds: Number(process.env.TRIM_SECONDS || 30),
  hlsSegmentSeconds: Number(process.env.HLS_SEGMENT_SECONDS || 10),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 20000),
  callbackTimeoutMs: Number(process.env.CALLBACK_TIMEOUT_MS || 10000),
};

validateEnv(config);

// ffmpeg kelias
Ffmpeg.setFfmpegPath(ffmpegStatic);

// R2 S3 client
const R2_ENDPOINT = `https://${config.r2.accountId}.r2.cloudflarestorage.com`;
const s3Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

// Axios basic defaults
const AXIOS_DEFAULTS = {
  timeout: config.requestTimeoutMs,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Dainify-Konverteris/1.0',
    'Accept': 'application/vnd.apple.mpegurl, audio/mpegurl, application/x-mpegURL, */*',
    'Referer': 'https://dainify.com',
  },
};

/* ===================== EXPRESS APP ===================== */

const app = express();
app.use(express.json());

const verifySecret = (req, _res, next) => {
  const secret = req.headers['x-webhook-secret'];
  if (!config.webhookSecret || secret !== config.webhookSecret) {
    console.warn('Unauthorized attempt: Invalid or missing webhook secret.');
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  next();
};

app.get('/health', (_req, res) => {
  res.status(200).send({ status: 'ok', message: 'Dainify Konverteris is running.' });
});

app.post('/create-preview', verifySecret, async (req, res) => {
  const { internalTaskId, sunoVariants, customerId } = req.body || {};
  if (!internalTaskId || !Array.isArray(sunoVariants) || !customerId) {
    return res.status(400).send('Bad Request: Missing required payload fields.');
  }

  // quick ack
  res.status(202).send({ status: 'accepted', message: 'Processing started in the background.' });

  console.log(`[${internalTaskId}] Starting processing for ${sunoVariants.length} variants.`);

  const normalized = sunoVariants.map((v, i) => normalizeVariant(v, i));
  const invalids = normalized
    .map((v, i) => ({ i, hasUrl: !!(v.audioUrl || v.streamUrl), keys: Object.keys(sunoVariants[i] || {}) }))
    .filter(x => !x.hasUrl);
  if (invalids.length) {
    console.warn(`[${internalTaskId}] Variants missing audioUrl/streamUrl:`, invalids);
  }

  // limit concurrency
  const limit = pLimit(config.maxConcurrent);

  const results = await Promise.allSettled(
    normalized.map(variant => limit(() => processVariantSafe(variant, internalTaskId)))
  );

  const finalItems = results.filter(r => r.status === 'fulfilled').map(r => r.value);

  if (finalItems.length === 0) {
    console.error(`[${internalTaskId}] All variants failed. Sending failure callback.`);
    await safePost(config.worker.callbackUrl, {
      mode: 'conversion-failed',
      customerId,
      taskId: internalTaskId,
      errs: results.map((r, i) =>
        r.status === 'rejected' ? { index: i, error: r.reason?.message || String(r.reason) } : null
      ).filter(Boolean)
    }, { headers: { 'X-Webhook-Secret': config.worker.callbackSecret }, timeout: config.callbackTimeoutMs });
    return;
  }

  await safePost(config.worker.callbackUrl, {
    mode: 'conversion-complete',
    customerId,
    taskId: internalTaskId,
    finalItems,
  }, { headers: { 'X-Webhook-Secret': config.worker.callbackSecret }, timeout: config.callbackTimeoutMs });

  console.log(`[${internalTaskId}] Successfully processed ${finalItems.length} variant(s) and sent callback.`);
});

// global error handler
app.use((err, _req, res, _next) => {
  const code = err.statusCode || 500;
  res.status(code).send(err.message || 'Server error');
});

const server = app.listen(config.port, () => {
  console.log(`Dainify Konverteris is running on port ${config.port}`);
});

// graceful shutdown
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

/* ===================== CORE FUNKCIJOS ===================== */

/** Limitatorius (mini p-limit) */
function pLimit(concurrency = 2) {
  const queue = [];
  let active = 0;

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then((val) => { active--; resolve(val); next(); })
      .catch((err) => { active--; reject(err); next(); });
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

/** Saugesnis processVariant su aiškesne klaida */
async function processVariantSafe(variant, internalTaskId) {
  if (!variant || (!variant.audioUrl && !variant.streamUrl)) {
    throw new Error('Variant missing audioUrl/streamUrl');
  }
  return processVariant(variant, internalTaskId);
}

/** Normalizatorius: suderina laukus iš įvairių šaltinių */
function normalizeVariant(raw, i = 0) {
  const audioUrl =
    raw.audioUrl || raw.audio_url || raw.audio_url_mp3 || raw.mp3_url || raw.audio || null;

  const streamUrl =
    raw.streamUrl || raw.stream_url || raw.hls_url || raw.m3u8_url || raw.audio_hls || raw.hls || null;

  const imageUrl =
    raw.imageUrl || raw.image_url || raw.cover_image_url || raw.cover || raw.thumbnail_url || raw.image || null;

  const title = raw.title || raw.name || raw.track_title || `Song Variant ${i + 1}`;

  const index =
    typeof raw.index === 'number' ? raw.index
    : typeof raw.id === 'number' ? raw.id
    : i;

  return { audioUrl, streamUrl, imageUrl, title, index };
}

/** Pagrindinis apdorojimas vienam variantui */
async function processVariant(variant, internalTaskId) {
  const variantTaskId = `${internalTaskId}-${variant.index}`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `song-${variantTaskId}-`));
  try {
    const inputUrl = variant.audioUrl || variant.streamUrl;
    if (!inputUrl) throw new Error('Invalid URL: both audioUrl and streamUrl are missing.');
    console.log(`[${variantTaskId}] Downloading from ${inputUrl}`);

    const hlsOutputPath = path.join(tempDir, 'demo.m3u8');

    if (variant.audioUrl) {
      // MP3 -> HLS
      await mp3ToTrimmedHls(inputUrl, hlsOutputPath, tempDir, variantTaskId);
    } else {
      // HLS -> HLS (lokaliai paruoštas .m3u8)
      await hlsToTrimmedHls(inputUrl, hlsOutputPath, tempDir, variantTaskId);
    }

    // Įkeliam visus .m3u8 ir .ts
    console.log(`[${variantTaskId}] Uploading HLS files to R2...`);
    const filesToUpload = await fs.readdir(tempDir);
    await uploadFilesToR2(filesToUpload, tempDir, `previews/${variantTaskId}/`);

    return {
      index: variant.index,
      title: variant.title,
      cover: variant.imageUrl || null,
      fullUrl: variant.audioUrl || null,
      previewR2Path: `previews/${variantTaskId}/demo.m3u8`,
    };
  } catch (e) {
    console.error(`[${variantTaskId}] Failed: ${e.message}`);
    throw e;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log(`[${variantTaskId}] Cleaned up temporary files.`);
  }
}

/* ===== MP3 -> 30s HLS ===== */
async function mp3ToTrimmedHls(mp3Url, hlsOutPath, tempDir, variantTaskId) {
  const originalFilePath = path.join(tempDir, 'original.mp3');
  const r = await axios.get(mp3Url, {
    ...AXIOS_DEFAULTS,
    responseType: 'arraybuffer',
  });
  await fs.writeFile(originalFilePath, r.data);
  console.log(`[${variantTaskId}] MP3 downloaded (${(r.data?.length ?? 0) / 1024 | 0} KiB).`);

  await new Promise((resolve, reject) => {
    Ffmpeg(originalFilePath)
      .setStartTime(0)
      .duration(config.ffmpegTrimSeconds)
      .outputOptions([
        '-f hls',
        `-hls_time ${config.hlsSegmentSeconds}`,
        '-hls_list_size 0',
        '-hls_flags independent_segments',
        '-preset veryfast',
        '-movflags +faststart',
        '-avoid_negative_ts make_zero',
        '-y',
        '-hls_segment_type mpegts',
        '-max_muxing_queue_size 1024',
        '-hls_segment_filename', path.join(tempDir, 'segment%03d.ts'),
      ])
      .on('end', resolve)
      .on('error', err => reject(new Error(`FFmpeg error (MP3->HLS): ${err.message}`)))
      .save(hlsOutPath);
  });
}

/* ===== HLS -> 30s HLS (su m3u8 paruošimu) ===== */
async function hlsToTrimmedHls(hlsUrl, hlsOutPath, tempDir, variantTaskId) {
  let attempts = 0;
  while (true) {
    try {
      console.log(`[${variantTaskId}] Preparing local m3u8...`);
      const { localPath } = await fetchAndPrepareM3U8(hlsUrl, tempDir);

      console.log(`[${variantTaskId}] Transcoding local m3u8 -> trimmed HLS preview...`);
      await new Promise((resolve, reject) => {
        Ffmpeg(localPath)
          .inputOptions([
            '-protocol_whitelist', 'file,http,https,tcp,tls',
            '-user_agent', AXIOS_DEFAULTS.headers['User-Agent'],
            '-rw_timeout', '15000000', // ~15s mikrosekundėmis
          ])
          .setStartTime(0)
          .duration(config.ffmpegTrimSeconds)
          .outputOptions([
            '-f hls',
            `-hls_time ${config.hlsSegmentSeconds}`,
            '-hls_list_size 0',
            '-hls_flags independent_segments',
            '-preset veryfast',
            '-movflags +faststart',
            '-avoid_negative_ts make_zero',
            '-y',
            '-hls_segment_type mpegts',
            '-max_muxing_queue_size 1024',
            '-hls_segment_filename', path.join(tempDir, 'segment%03d.ts'),
          ])
          .on('end', resolve)
          .on('error', err => reject(new Error(`FFmpeg HLS error: ${err.message}`)))
          .save(hlsOutPath);
      });
      return;
    } catch (e) {
      attempts++;
      if (attempts >= 2) throw e;
      console.warn(`[${variantTaskId}] HLS attempt ${attempts} failed, retrying in 800ms...`, e.message);
      await sleep(800);
    }
  }
}

/* ===== R2 Upload helper ===== */
async function uploadFilesToR2(files, baseDir, prefix) {
  // šiek tiek ribojam paralelę
  const limit = pLimit(4);
  await Promise.all(
    files
      .filter(f => f.endsWith('.m3u8') || f.endsWith('.ts'))
      .map(file => limit(async () => {
        const filePath = path.join(baseDir, file);
        const buf = await fs.readFile(filePath);
        const key = `${prefix}${file}`;
        const ct = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
        await s3Client.send(new PutObjectCommand({
          Bucket: config.r2.bucketName,
          Key: key,
          Body: buf,
          ContentType: ct,
        }));
      }))
  );
}

/* ===================== HLS/M3U8 PARUOŠIMAS ===================== */

async function httpGet(url, opts = {}) {
  const r = await axios.get(url, { ...AXIOS_DEFAULTS, ...opts });
  return r;
}

function resolveRelative(base, maybeRel) {
  try { return new URL(maybeRel, base).toString(); } catch { return maybeRel; }
}
const isMasterPlaylist = (text) => /#EXT-X-STREAM-INF/i.test(text);
const isMediaPlaylist = (text) => /#EXTINF:/i.test(text);

function parseVariantsFromMaster(text, baseUrl) {
  // surenkam {bandwidth, url}
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^#EXT-X-STREAM-INF/i.test(ln)) {
      const bwMatch = /BANDWIDTH=(\d+)/i.exec(ln);
      let nextUrl = null;
      for (let j = i + 1; j < lines.length; j++) {
        const cand = lines[j].trim();
        if (!cand || cand.startsWith('#')) continue;
        nextUrl = resolveRelative(baseUrl, cand);
        break;
      }
      if (nextUrl) {
        variants.push({
          bandwidth: bwMatch ? Number(bwMatch[1]) : 0,
          url: nextUrl
        });
      }
    }
  }
  return variants;
}

function pickMedianVariant(variants) {
  if (!variants.length) return null;
  const sorted = variants.slice().sort((a, b) => a.bandwidth - b.bandwidth);
  return sorted[Math.floor(sorted.length / 2)] || sorted[0];
}

function absolutizePlaylist(text, baseUrl) {
  // Absoliutiname TS/MP4 segmentų eilutes, KEY ir MAP URI
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i];

    // #EXT-X-KEY:METHOD=AES-128,URI="key.key"
    if (/^#EXT-X-KEY/i.test(ln)) {
      ln = ln.replace(/URI="([^"]+)"/i, (_m, g1) => `URI="${resolveRelative(baseUrl, g1)}"`);
      out.push(ln);
      continue;
    }

    // #EXT-X-MAP:URI="init.mp4"
    if (/^#EXT-X-MAP/i.test(ln)) {
      ln = ln.replace(/URI="([^"]+)"/i, (_m, g1) => `URI="${resolveRelative(baseUrl, g1)}"`);
      out.push(ln);
      continue;
    }

    if (ln.startsWith('#') || ln.trim() === '') {
      out.push(ln);
    } else {
      out.push(resolveRelative(baseUrl, ln.trim()));
    }
  }
  // pasirūpinam ENDLIST
  if (!out.find(l => /^#EXT-X-ENDLIST/i.test(l))) out.push('#EXT-X-ENDLIST');
  return out.join('\n');
}

/**
 * Parsisiunčia HLS (master ar media). Jei master – paima „median BW“ variantą.
 * Absoliutina URL’us ir įrašo lokalų .m3u8 failą.
 */
async function fetchAndPrepareM3U8(inputUrl, tempDir) {
  // 1) parsisiunčiam
  const r1 = await httpGet(inputUrl, { responseType: 'text' });
  const ct = (r1.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('mpegurl') && !String(r1.data).startsWith('#EXTM3U')) {
    throw new Error(`Unexpected content-type for m3u8: ${ct || 'unknown'}`);
  }
  let baseUrl = r1.request?.res?.responseUrl || inputUrl;
  let text = r1.data;

  // 2) master? – rinktis media
  if (isMasterPlaylist(text)) {
    const variants = parseVariantsFromMaster(text, baseUrl);
    const pick = pickMedianVariant(variants) || variants[0];
    if (!pick) throw new Error('Master playlist without media variants');
    const r2 = await httpGet(pick.url, { responseType: 'text' });
    text = r2.data;
    baseUrl = r2.request?.res?.responseUrl || pick.url;
    if (!isMediaPlaylist(text)) {
      throw new Error('Chosen variant is not a MEDIA playlist');
    }
  }

  // 3) absoliutinam
  const abs = absolutizePlaylist(text, baseUrl);

  // 4) į failą
  const localPath = path.join(tempDir, 'source.m3u8');
  await fs.writeFile(localPath, abs, 'utf8');
  return { localPath };
}

/* ===================== BENDROSIOS PAGALBINĖS ===================== */

async function safePost(url, data, opts = {}) {
  try {
    await axios.post(url, data, { ...opts });
  } catch (e) {
    console.error('Callback POST failed:', e?.message || e);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function validateEnv(cfg) {
  const miss = [];
  if (!cfg.r2.accountId) miss.push('R2_ACCOUNT_ID');
  if (!cfg.r2.accessKeyId) miss.push('R2_ACCESS_KEY_ID');
  if (!cfg.r2.secretAccessKey) miss.push('R2_SECRET_ACCESS_KEY');
  if (!cfg.r2.bucketName) miss.push('R2_BUCKET_NAME');
  if (!cfg.worker.callbackUrl) miss.push('WORKER_CALLBACK_URL');
  if (!cfg.worker.callbackSecret) miss.push('WORKER_CALLBACK_SECRET');
  if (!cfg.webhookSecret) miss.push('WEBHOOK_SECRET');
  if (miss.length) {
    console.warn('⚠️ Missing env vars:', miss.join(', '));
  }
}
