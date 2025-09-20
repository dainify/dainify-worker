/**
 * Dainify Konverteris
 * Šis Express.js servisas, veikiantis Render.com platformoje, yra skirtas
 * gauti dainų variantus iš Cloudflare Worker'io, sukurti jų 30 sekundžių
 * HLS peržiūras (demo versijas) ir įkelti jas į R2 saugyklą.
 * Baigęs darbą, servisas išsiunčia pranešimą ("callback") atgal į Worker'į.
 */

import express from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import axios from 'axios';
import fs from 'fs/promises'; // Naudojame 'fs/promises' visiems veiksmams
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
    webhookSecret: process.env.WEBHOOK_SECRET
};

// --- INICIALIZAVIMAS ---
Ffmpeg.setFfmpegPath(ffmpegStatic);

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

// --- MARŠRUTAI ---
app.get('/health', (req, res) => {
    res.status(200).send({ status: 'ok', message: 'Dainify Konverteris is running.' });
});

app.post('/create-preview', verifySecret, async (req, res) => {
  const { internalTaskId, sunoVariants, customerId } = req.body;
  if (!internalTaskId || !Array.isArray(sunoVariants) || !customerId) {
    return res.status(400).send('Bad Request: Missing required payload fields.');
  }
  res.status(202).send({ status: 'accepted', message: 'Processing started in the background.' });

  console.log(`[${internalTaskId}] Starting processing for ${sunoVariants.length} variants.`);
  try {
    // normalizuojam visus variantus
    const normalized = sunoVariants.map((v, i) => normalizeVariant(v, i));

    // ankstyva validacija ir diagnostika
    const invalids = normalized
      .map((v, i) => ({ i, ok: !!v.audioUrl, v }))
      .filter(x => !x.ok);
    if (invalids.length) {
      console.warn(`[${internalTaskId}] Variants missing audioUrl:`, invalids.map(x => ({ i: x.i, keys: Object.keys(sunoVariants[x.i] || {}) })));
    }

    const results = await Promise.allSettled(
      normalized.map(variant => processVariant(variant, internalTaskId))
    );

    const finalItems = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (finalItems.length === 0) {
      console.error(`[${internalTaskId}] All variants failed. Sending failure callback.`);
      // SIŲSK bent „failure“ callback’ą su klaidų priežastimis, kad Worker’is galėtų rodyti UI žinutę
      await axios.post(config.worker.callbackUrl, {
        mode: 'conversion-failed',
        customerId,
        taskId: internalTaskId,
        errs: results.map((r, i) =>
          r.status === 'rejected' ? { index: i, error: r.reason?.message || String(r.reason) } : null
        ).filter(Boolean)
      }, { headers: { 'X-Webhook-Secret': config.worker.callbackSecret } }).catch(() => {});
      return;
    }

    await axios.post(config.worker.callbackUrl, {
      mode: 'conversion-complete',
      customerId,
      taskId: internalTaskId,
      finalItems,
    }, { headers: { 'X-Webhook-Secret': config.worker.callbackSecret } });

    console.log(`[${internalTaskId}] Successfully processed ${finalItems.length} variant(s) and sent callback.`);
  } catch (error) {
    console.error(`[${internalTaskId}] A critical unexpected error occurred:`, error);
  }
});

app.listen(config.port, () => {
    console.log(`Dainify Konverteris is running on port ${config.port}`);
});


/**
 * Pagalbinė funkcija, apdorojanti vieną dainos variantą.
 * @param {object} variant - Dainos varianto objektas iš Suno.
 * @param {string} internalTaskId - Vidinis užduoties ID.
 * @returns {Promise<object>} Objektas su informacija apie sukurtą peržiūrą.
 */
// processVariant() pradžia (pakeitimai pažymėti)
async function processVariant(variant, internalTaskId) {
  const variantTaskId = `${internalTaskId}-${variant.index}`;
  const tempDir = await fs.mkdtemp(path.join('/tmp', `song-${variantTaskId}-`));
  try {
    const originalFilePath = path.join(tempDir, 'original.mp3');

    // NEW: palaikyk ir HLS m3u8
    const inputUrl = variant.audioUrl || variant.streamUrl;
    if (!inputUrl) throw new Error('Invalid URL: both audioUrl and streamUrl are missing.');
    console.log(`[${variantTaskId}] Downloading from ${inputUrl}`);

    if (variant.audioUrl) {
      // kaip buvo: MP3 parsisiuntimas
      const response = await axios({ url: inputUrl, responseType: 'arraybuffer', timeout: 30000 });
      await fs.writeFile(originalFilePath, response.data);
      console.log(`[${variantTaskId}] File downloaded successfully.`);

      // Konvertuojam į 30s HLS
      const hlsOutputPath = path.join(tempDir, 'demo.m3u8');
      console.log(`[${variantTaskId}] Converting MP3 -> HLS preview...`);
      await new Promise((resolve, reject) => {
        Ffmpeg(originalFilePath)
          .setStartTime(0).duration(30)
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
      // NEW: turime tik HLS m3u8 – duokim m3u8 tiesiai į FFmpeg ir persugeneruokim savo 30s HLS
      const hlsOutputPath = path.join(tempDir, 'demo.m3u8');
      console.log(`[${variantTaskId}] Transcoding HLS (m3u8) -> trimmed HLS preview...`);
      await new Promise((resolve, reject) => {
        Ffmpeg(inputUrl)
          .inputOptions([
            // kartais prireikia, kai m3u8 traukia segmentus per https
            '-protocol_whitelist', 'file,http,https,tcp,tls'
          ])
          .setStartTime(0).duration(30)
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

    // Įkėlimas į R2 – paliekam kaip yra
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
      cover: variant.imageUrl,
      fullUrl: variant.audioUrl || null,      // MP3, jei buvo
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
