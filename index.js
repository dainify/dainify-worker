// Reikalingi moduliai
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
// ... ir AWS S3 SDK modulis failų įkėlimui į R2

const app = express();
app.use(express.json());

// API endpoint'as, kurį kvies pagrindinis worker'is
app.post('/create-preview', async (req, res) => {
    const { internalTaskId, sunoVariants, customerId } = req.body;
    
    // Svarbu iškart grąžinti atsakymą, o darbus tęsti fone
    res.status(202).send({ message: 'Accepted' });

    try {
        for (const variant of sunoVariants) {
            const streamUrl = variant.streamUrl;
            const r2Prefix = `previews/${internalTaskId}-${variant.index}`;
            const tmpDir = await fs.mkdtemp(path.join('/tmp/', `dainify-${variant.index}-`));

            // 1. Atsisiunčiame 30s iš HLS srauto
            console.log(`Starting ffmpeg for URL: ${streamUrl}`);
            await runCommand(`ffmpeg -i "${streamUrl}" -t 30 -c copy ${tmpDir}/temp.mp3`);
            console.log('Finished ffmpeg. Starting R2 upload.');
            
            // 2. Pridedame fade-out
            await runCommand(`ffmpeg -i ${tmpDir}/temp.mp3 -af "afade=t=out:st=25:d=5" ${tmpDir}/temp_faded.mp3`);

            // 3. Konvertuojame į HLS segmentus
            await runCommand(`ffmpeg -i ${tmpDir}/temp_faded.mp3 -c:a aac -b:a 128k -hls_time 4 -hls_playlist_type vod -hls_segment_filename "${tmpDir}/seg_%03d.aac" ${tmpDir}/demo.m3u8`);

            // 4. Įkeliame failus į R2
            await uploadDirectoryToR2(tmpDir, r2Prefix);
            console.log('Upload to R2 complete.');

            // 5. Išvalome laikinus failus
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
        
        // 6. (SVARBU) Atnaujiname KV įrašo statusą į 'locked', kad poller'is rastų failus
        // Čia turėtų būti kreipinys į jūsų Cloudflare Worker su admin raktu,
        // kuris atnaujintų `library:${customerId}:${internalTaskId}` įrašo statusą.

    } catch (error) {
        console.error(`Failed to process task ${internalTaskId}:`, error);
    }
});

app.listen(3000, () => console.log('Conversion server is running.'));

// Pagalbinės funkcijos runCommand ir uploadDirectoryToR2
// ...
