// ====== Reikalingi moduliai ======
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// ====== Konfigūracija ======
const app = express();
app.use(express.json());

// Konfigūruojame S3 klientą darbui su Cloudflare R2.
// Visi duomenys paimami iš Environment Variables, kuriuos nustatėte Render.com.
const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// ====== API Endpoint'as ======
// Šį adresą kviečia jūsų pagrindinis Cloudflare Worker
app.post('/create-preview', async (req, res) => {
    const { internalTaskId, sunoVariants, customerId } = req.body;

    // Patikriname, ar gavome visus reikiamus duomenis
    if (!internalTaskId || !sunoVariants || !Array.isArray(sunoVariants)) {
        return res.status(400).send({ error: 'Missing required parameters.' });
    }

    // Svarbu: iškart grąžiname atsakymą, o darbus tęsiame fone.
    res.status(202).send({ message: 'Accepted, processing started.' });

    // Tęsiame darbus fone
    try {
        console.log(`[${internalTaskId}] Processing started for ${sunoVariants.length} variants.`);

        for (const variant of sunoVariants) {
            const streamUrl = variant.streamUrl;
            if (!streamUrl) {
                console.log(`[${internalTaskId}] Variant ${variant.index} is missing streamUrl. Skipping.`);
                continue;
            }

            const r2Prefix = `previews/${internalTaskId}-${variant.index}`;
            const tmpDir = await fs.mkdtemp(path.join('/tmp/', `dainify-${variant.index}-`));
            
            console.log(`[${internalTaskId}-${variant.index}] Created temp directory: ${tmpDir}`);
            
            // 1. Atsisiunčiame ~30s iš HLS srauto į laikiną MP3 failą
            console.log(`[${internalTaskId}-${variant.index}] Downloading stream from Suno...`);
            await runCommand(`ffmpeg -i "${streamUrl}" -t 30 -c copy ${tmpDir}/temp.mp3`);

            // 2. Pridedame 5 sekundžių nutildymą (fade-out) nuo 25-os sekundės
            console.log(`[${internalTaskId}-${variant.index}] Applying fade-out...`);
            await runCommand(`ffmpeg -i ${tmpDir}/temp.mp3 -af "afade=t=out:st=25:d=5" -y ${tmpDir}/temp_faded.mp3`);

            // 3. Konvertuojame į HLS segmentus (4 sekundžių trukmės)
            console.log(`[${internalTaskId}-${variant.index}] Segmenting into HLS...`);
            await runCommand(`ffmpeg -i ${tmpDir}/temp_faded.mp3 -c:a aac -b:a 128k -hls_time 4 -hls_playlist_type vod -hls_segment_filename "${tmpDir}/seg_%03d.aac" ${tmpDir}/demo.m3u8`);

            // 4. Įkeliame visus sugeneruotus failus į R2 saugyklą
            console.log(`[${internalTaskId}-${variant.index}] Uploading files to R2 bucket...`);
            await uploadDirectoryToR2(tmpDir, r2Prefix);

            // 5. Išvalome laikiną katalogą
            console.log(`[${internalTaskId}-${variant.index}] Cleaning up temporary files...`);
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
        
        console.log(`[${internalTaskId}] All variants processed successfully.`);

    } catch (error) {
        console.error(`[${internalTaskId}] CRITICAL ERROR during processing:`, error);
    }
});

// ====== Serverio Paleidimas ======
// Naudojame 10000 portą, kaip reikalauja Render
app.listen(10000, () => console.log('✅ Conversion server is running on port 10000.'));


// ====== Pagalbinės Funkcijos ======

/**
 * Vykdo komandinės eilutės komandą ir grąžina Promise.
 * @param {string} command - Komanda, kurią reikia įvykdyti.
 * @returns {Promise<string>} - Promise, kuris grąžina komandos išvestį.
 */
function runCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Error executing command: ${command}`);
                console.error(`   stderr: ${stderr}`);
                return reject(error);
            }
            resolve(stdout);
        });
    });
}

/**
 * Įkelia visus failus iš nurodyto katalogo į R2 saugyklą.
 * @param {string} directoryPath - Vietinis katalogas, iš kurio kelti failus.
 * @param {string} r2Prefix - R2 kelias (prefix), į kurį kelti failus.
 */
async function uploadDirectoryToR2(directoryPath, r2Prefix) {
    const files = await fs.readdir(directoryPath);
    for (const file of files) {
        // Įkeliame tik .m3u8 ir .aac failus
        if (file.endsWith('.m3u8') || file.endsWith('.aac')) {
            const localFilePath = path.join(directoryPath, file);
            const r2Key = `${r2Prefix}/${file}`;
            
            await s3.send(new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: r2Key,
                Body: await fs.readFile(localFilePath),
                ContentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'audio/aac'
            }));

            console.log(`   ✔ Uploaded ${file} to ${r2Key}`);
        }
    }
}
