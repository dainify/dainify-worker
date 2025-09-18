import express from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// --- KONFIGŪRACIJA ---
// Nuskaitome aplinkos kintamuosius, kuriuos sukonfigūravote Render.com
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

// Nustatome FFmpeg kelią
ffmpeg.setFfmpegPath(ffmpegStatic);

// --- R2 KLIENTO INICIALIZAVIMAS ---
const R2_ENDPOINT = `https://${config.r2.accountId}.r2.cloudflarestorage.com`;
const s3Client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
    },
});

// --- APLIKACIJOS PALEIDIMAS ---
const app = express();
app.use(express.json());

// --- SAUGUMO FUNKCIJA (MIDDLEWARE) ---
// Tikrina, ar užklausa iš Worker'io yra autentiška
const verifySecret = (req, res, next) => {
    const secret = req.headers['x-webhook-secret'];
    if (!config.webhookSecret || secret !== config.webhookSecret) {
        console.warn('Invalid or missing webhook secret.');
        return res.status(401).send('Unauthorized');
    }
    next();
};

// --- PAGRINDINIS MARŠRUTAS ---
// /create-preview yra adresas, kurį nurodėte Cloudflare Worker'iui
app.post('/create-preview', verifySecret, async (req, res) => {
    const { internalTaskId, sunoVariants, customerId } = req.body;

    if (!internalTaskId || !Array.isArray(sunoVariants) || !customerId) {
        return res.status(400).send('Missing required payload fields.');
    }
    
    // Iškart atsakome Worker'iui, kad užduotį gavome ir apdorosime fone.
    res.status(202).send({ status: 'accepted', message: 'Processing started.' });

    console.log(`[${internalTaskId}] Starting processing for ${sunoVariants.length} variants.`);

    try {
        // Apdorojame abu variantus lygiagrečiai
        const processingPromises = sunoVariants.map(variant => processVariant(variant, internalTaskId));
        const finalItems = await Promise.all(processingPromises);

        // Kai abu variantai apdoroti, siunčiame atsakymą atgal į Worker'į
        await axios.post(config.worker.callbackUrl, {
            mode: 'conversion-complete',
            customerId,
            taskId: internalTaskId,
            finalItems,
        }, {
            headers: { 'X-Webhook-Secret': config.worker.callbackSecret }
        });

        console.log(`[${internalTaskId}] Successfully processed and sent callback.`);

    } catch (error) {
        console.error(`[${internalTaskId}] CRITICAL ERROR during processing:`, error);
        // Čia galite pridėti logiką, kuri praneštų apie klaidą, pvz., per kitą webhook'ą
    }
});

app.listen(config.port, () => {
    console.log(`Dainify Konverteris is running on port ${config.port}`);
});

// --- PAGALBINĖS FUNKCIJOS ---

/**
 * Apdoroja vieną dainos variantą: atsisiunčia, apkerpa, konvertuoja į HLS ir įkelia į R2.
 */
async function processVariant(variant, internalTaskId) {
    const tempDir = await fs.mkdtemp(path.join('/tmp', `song-${variant.id}-`));
    const originalFilePath = path.join(tempDir, 'original.mp3');
    const hlsOutputPath = path.join(tempDir, 'demo.m3u8');
    const variantTaskId = `${internalTaskId}-${variant.index}`;
    
    try {
        // 1. Atsisiunčiame originalų MP3 failą
        console.log(`[${variantTaskId}] Downloading from ${variant.audioUrl}`);
        const response = await axios({ url: variant.audioUrl, responseType: 'stream' });
        await new Promise((resolve, reject) => {
            const writer = response.data.pipe(fs.createWriteStream(originalFilePath));
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // 2. Konvertuojame į 30s HLS peržiūrą su FFmpeg
        console.log(`[${variantTaskId}] Converting to HLS...`);
        await new Promise((resolve, reject) => {
            ffmpeg(originalFilePath)
                .setStartTime(0)
                .duration(30)
                .outputOptions([
                    '-f hls',
                    '-hls_time 10', // 10 sekundžių segmentai
                    '-hls_list_size 0', // Neribotas segmentų sąrašas
                    '-hls_segment_filename', `${tempDir}/segment%03d.ts`
                ])
                .on('end', resolve)
                .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
                .save(hlsOutputPath);
        });

        // 3. Įkeliame HLS failus į R2
        console.log(`[${variantTaskId}] Uploading to R2...`);
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

        // 4. Grąžiname rezultatą, kurio reikės callback'ui
        return {
            index: variant.index,
            title: variant.title,
            cover: variant.imageUrl,
            fullUrl: variant.audioUrl,
            previewR2Path: `previews/${variantTaskId}/demo.m3u8`, // Kelias iki pagrindinio HLS failo R2
        };

    } finally {
        // 5. Išvalome laikinus failus
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log(`[${variantTaskId}] Cleaned up temp files.`);
    }
}
