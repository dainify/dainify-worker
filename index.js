/**
 * Dainify Konverteris
 * Express.js servisas (Render.com) – kuria 30s HLS peržiūras (demo) iš MP3 ARBA HLS (m3u8)
 * ir kelia į R2. Pabaigoje siunčia callback į Worker'į.
 */

import express from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

// --- KONFIGŪRACIJA ---
const config = {
  port: process.env.PORT || 10000,
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
};

// --- INICIALIZAVIMAS ---
Ffmpeg.setFfmpegPath(ffmpegStatic);
// Jei reikės ffprobe:
// import ffprobe from 'ffprobe-static';
// Ffmpeg.setFfprobePath(ffprobe.path);

const R2_ENDPOINT = `https://${config.r2.accountId}.r2.cloudflarestorage.com`;
const s3Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

// --- EXPRESS APLIKACIJA ---
const app = express();
app.use(express.json());

const verifySecret = (req, res, next) => {
  const secret = req.headers['x-webhook-secret'];
  if (!config.webhookSecret || secret !== config.webhookSecret) {
    console.warn('Unauthorized attempt: Invalid or missing webhook secret.');
    return res.status(401).send('Unauthorized');
  }
  next();
};

// --- ROUTES ---
app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok', message: 'Dainify Konverteris is running.' });
});

app.post('/create-preview', verifySecret, async (req, res) => {
  const { internalTaskId, sunoVariants, customerId } = req.body || {};
  if (!internalTaskId || !Array.isArray(sunoVariants) || !customerId) {
    return res.status(400).send('Bad Request: Missing required payload fields.');
  }

  // grąžinam greitai, o sunkų darbą darom „fone“
  res.status(202).send({ status: 'accepted', message: 'Processing started in the background.' });

  console.log(`[${internalTaskId}] Starting processing for ${sunoVariants.length} variants.`);

  try {
    const normalized = sunoVariants.map((v, i) => normalizeVariant(v, i));

    // diagnostika: kurie neturi nei MP3, nei HLS
    const invalids = normalized
      .map((v, i) => ({ i, ok: !!(v.audioUrl || v.streamUrl), keys: Object.keys(sunoVariants[i] || {}) }))
      .filter(x => !x.ok);
    if (invalids.length) {
      console.warn(
        `[${internalTaskId}] Variants missing audioUrl/streamUrl:`,
        invalids.map(x => ({ index: x.i, keys: x.keys }))
      );
    }

    const results = await Promise.allSettled(
      normalized.map(variant => processVariant(variant, internalTaskId))
    );

    const finalItems = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (finalItems.length === 0) {
      console.error(`[${internalTaskId}] All variants failed. Sending failure callback.`);
      // pranešam Worker'iui apie nesėkmę (kad UI galėtų parodyti žinutę)
      try {
        await axios.post(
          config.worker.callbackUrl,
          {
            mode: 'conversion-failed',
            customerId,
            taskId: internalTaskId,
            errs: results
              .map((r, i) => (r.status === 'rejected' ? { index: i, error: r.reason?.message || String(r.reason) } : null))
              .filter(Boolean),
          },
          { headers: { 'X-Webhook-Secret': config.worker.callbackSecret }, timeout: 10000 }
        );
      } catch {/* swallow */}
      return;
    }

    // success callback
    await axios.post(
      config.worker.callbackUrl,
      { mode: 'conversion-complete', customerId, taskId: internalTaskId, finalItems },
      { headers: { 'X-Webhook-Secret': config.worker.callbackSecret }, timeout: 10000 }
    );

    console.log(`[${internalTaskId}] Successfully processed ${finalItems.length} variant(s) and sent callback.`);
  } catch (error) {
    console.error(`[${internalTaskId}] A critical unexpected error occurred:`, error);
  }
});

app.listen(config.port, () => {
  console.log(`Dainify Konverteris is running on port ${config.port}`);
});

/* ============== CORE ============== */

/**
 * Normalizatorius: priima įvairius laukų pavadinimus iš Worker’io/Suno ir suvienodina.
 */
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

/**
 * Apdoroja vieną dainos variantą:
 * - jei turime MP3: MP3 -> 30s HLS
 * - jei turime tik HLS: HLS (m3u8) -> 30s HLS (apkarpyta)
 * - galiausiai viską įkelia į R2
 */
async function processVariant(variant, internalTaskId) {
  const variantTaskId = `${internalTaskId}-${variant.index}`;
  const tempDir = await fs.mkdtemp(path.join('/tmp', `song-${variantTaskId}-`));
  try {
    const originalFilePath = path.join(tempDir, 'original.mp3');

    const inputUrl = variant.audioUrl || variant.streamUrl;
    if (!inputUrl) throw new Error('Invalid URL: both audioUrl and streamUrl are missing.');
    console.log(`[${variantTaskId}] Downloading from ${inputUrl}`);

    const hlsOutputPath = path.join(tempDir, 'demo.m3u8');

    if (variant.audioUrl) {
      // MP3 -> 30s HLS
      const response = await axios({
        url: inputUrl,
        responseType: 'arraybuffer',
        timeout: 45000,
        headers: { 'User-Agent': 'Dainify-Konverteris/1.0' }
      });
      await fs.writeFile(originalFilePath, response.data);
      console.log(`[${variantTaskId}] File downloaded successfully.`);

      console.log(`[${variantTaskId}] Converting MP3 -> HLS preview...`);
      await new Promise((resolve, reject) => {
        Ffmpeg(originalFilePath)
          .setStartTime(0)
          .duration(30)
          .outputOptions([
            '-f hls',
            '-hls_time 10',
            '-hls_list_size 0',
            '-hls_segment_filename', path.join(tempDir, 'segment%03d.ts')
          ])
          .on('end', resolve)
          .on('error', err => reject(new Error(`FFmpeg error: ${err.message}`)))
          .save(hlsOutputPath);
      });
    } else {
      // HLS (m3u8) -> 30s HLS
      console.log(`[${variantTaskId}] Transcoding HLS (m3u8) -> trimmed HLS preview...`);
      await new Promise((resolve, reject) => {
        Ffmpeg(inputUrl)
          .inputOptions([
            '-protocol_whitelist', 'file,http,https,tcp,tls',
            '-user_agent', 'Dainify-Konverteris/1.0'
          ])
          .setStartTime(0)
          .duration(30)
          .outputOptions([
            '-f hls',
            '-hls_time 10',
            '-hls_list_size 0',
            '-hls_segment_filename', path.join(tempDir, 'segment%03d.ts')
          ])
          .on('end', resolve)
          .on('error', err => reject(new Error(`FFmpeg HLS error: ${err.message}`)))
          .save(hlsOutputPath);
      });
    }

    // Įkėlimas į R2
    console.log(`[${variantTaskId}] Uploading HLS files to R2...`);
    const filesToUpload = await fs.readdir(tempDir);
    for (const file of filesToUpload) {
      if (file.endsWith('.m3u8') || file.endsWith('.ts')) {
        const filePath = path.join(tempDir, file);
        const fileContent = await fs.readFile(filePath);
        const r2Key = `previews/${variantTaskId}/${file}`;
        await s3Client.send(new PutObjectCommand({
          Bucket: config.r2.bucketName,
          Key: r2Key,
          Body: fileContent,
          ContentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        }));
      }
    }

    return {
      index: variant.index,
      title: variant.title,
      cover: variant.imageUrl || null,
      fullUrl: variant.audioUrl || null, // jeigu MP3 buvo
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
