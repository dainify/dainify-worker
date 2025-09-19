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
// Nuskaitome aplinkos kintamuosius (Environment Variables) iš Render.com
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

// --- FFmpeg IR R2 KLIENTŲ INICIALIZAVIMAS ---
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

// --- EXPRESS APLIKACIJOS PALEIDIMAS ---
const app = express();
app.use(express.json());

/**
 * Saugumo Middleware
 * Tikrina, ar gaunama užklausa turi teisingą slaptažodį ('x-webhook-secret' antraštėje),
 * kad apsaugotų servisą nuo neteisėtų iškvietimų.
 */
const verifySecret = (req, res, next) => {
    const secret = req.headers['x-webhook-secret'];
    if (!config.webhookSecret || secret !== config.webhookSecret) {
        console.warn('Unauthorized attempt: Invalid or missing webhook secret.');
        return res.status(401).send('Unauthorized');
    }
    next();
};

// --- MARŠRUTAI (ROUTES) ---

// Sveikatos patikros maršrutas (Health Check)
app.get('/health', (req, res) => {
    res.status(200).send({ status: 'ok', message: 'Dainify Konverteris is running.' });
});

/**
 * Pagrindinis maršrutas peržiūrų kūrimui.
 */
app.post('/create-preview', verifySecret, async (req, res) => {
    const { internalTaskId, sunoVariants, customerId } = req.body;

    if (!internalTaskId || !Array.isArray(sunoVariants) || !customerId) {
        return res.status(400).send('Bad Request: Missing required payload fields.');
    }
    
    // Iškart atsakome Worker'iui "202 Accepted"
    res.status(202).send({ status: 'accepted', message: 'Processing started in the background.' });

    console.log(`[${internalTaskId}] Starting processing for ${sunoVariants.length} variants.`);

    try {
        // Apdorojame variantus lygiagrečiai, naudojant Promise.allSettled
        const results = await Promise.allSettled(
            sunoVariants.map(variant => processVariant(variant, internalTaskId))
        );

        const finalItems = results
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value);

        const failedItems = results
            .filter(result => result.status === 'rejected')
            .map(result => result.reason.message || 'Unknown error');

        if (failedItems.length > 0) {
            console.error(`[${internalTaskId}] ${failedItems.length} variant(s) failed to process:`, failedItems);
        }
        
        if (finalItems.length === 0) {
            console.error(`[${internalTaskId}] All variants failed. No callback will be sent.`);
            return;
        }

        // Siunčiame atsakymą atgal į Worker'į
        await axios.post(config.worker.callbackUrl, {
            mode: 'conversion-complete',
            customerId,
            taskId: internalTaskId,
            finalItems,
        }, {
            headers: { 'X-Webhook-Secret': config.worker.callbackSecret }
        });

        console.log(`[${internalTaskId}] Successfully processed ${finalItems.length} variant(s) and sent callback.`);

    } catch (error) {
        console.error(`[${internalTaskId}] A critical unexpected error occurred:`, error);
    }
});

// Startuojame serverį
app.listen(config.port, () => {
    console.log(`Dainify Konverteris is running on port ${config.port}`);
});


/**
 * Pagalbinė funkcija, apdorojanti vieną dainos variantą.
 * @param {object} variant - Dainos varianto objektas iš Suno.
 * @param {string} internalTaskId - Vidinis užduoties ID.
 * @returns {Promise<object>} Objektas su informacija apie sukurtą peržiūrą.
 */
async function processVariant(variant, internalTaskId) {
    const variantTaskId = `${internalTaskId}-${variant.index}`;
    const tempDir = await fs.mkdtemp(path.join('/tmp', `song-${variantTaskId}-`));
    
    try {
        // 1. Atsisiunčiame originalų MP3 failą kaip dvejetainį buferį (binary buffer)
        const originalFilePath = path.join(tempDir, 'original.mp3');
        console.log(`[${variantTaskId}] Downloading from ${variant.audioUrl}`);
        
        // PAKEISTA: Naudojame 'arraybuffer' vietoj 'stream', kad išvengtume klaidų.
        const response = await axios({
            url: variant.audioUrl,
            responseType: 'arraybuffer' 
        });

        // PAKEISTA: Naudojame modernų fs.writeFile vietoj seno stream.pipe.
        // Tai išsprendžia "fs.createWriteStream is not a function" klaidą.
        await fs.writeFile(originalFilePath, response.data);
        console.log(`[${variantTaskId}] File downloaded successfully.`);

        // 2. Konvertuojame į 30s HLS peržiūrą su FFmpeg
        const hlsOutputPath = path.join(tempDir, 'demo.m3u8');
        console.log(`[${variantTaskId}] Converting to HLS preview...`);
        await new Promise((resolve, reject) => {
            Ffmpeg(originalFilePath)
                .setStartTime(0)
                .duration(30)
                .outputOptions([
                    '-f hls',
                    '-hls_time 10',
                    '-hls_list_size 0',
                    '-hls_segment_filename', `${tempDir}/segment%03d.ts`
                ])
                .on('end', resolve)
                .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
                .save(hlsOutputPath);
        });

        // 3. Įkeliame HLS failus (.m3u8 ir .ts) į R2
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

        // 4. Grąžiname rezultatą, kurio reikės callback'ui į Worker'į
        return {
            index: variant.index,
            title: variant.title,
            cover: variant.imageUrl,
            fullUrl: variant.audioUrl,
            previewR2Path: `previews/${variantTaskId}/demo.m3u8`, // Kelias iki pagrindinio HLS failo R2
        };

    } finally {
        // 5. Būtinai išvalome laikinus failus, net jei įvyko klaida
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log(`[${variantTaskId}] Cleaned up temporary files.`);
    }
}
