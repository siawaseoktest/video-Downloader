const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// ダウンロード保存先フォルダを確保
const downloadsDir = path.join(__dirname, 'public', 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

app.use(express.json());
app.use(express.static('public'));

const PROXY_URL = process.env.YT_DLP_PROXY || "http://ytproxy-siawaseok.duckdns.org:3007";

// --- 補助関数: yt-dlpの実行 ---
function runYtDlp(args) {
    return new Promise((resolve) => {
        const ytDlp = spawn('yt-dlp', args);
        let output = '';
        let errorOutput = '';

        ytDlp.stdout.on('data', (data) => { output += data.toString(); });
        ytDlp.stderr.on('data', (data) => { errorOutput += data.toString(); });

        ytDlp.on('close', (code) => {
            resolve({ code, output, errorOutput });
        });
    });
}

// --- ① 画質一覧を取得するAPI ---
app.post('/api/info', async (req, res) => {
    const { url, browserSupport } = req.body;
    if (!url) return res.status(400).json({ error: 'URLが必要です' });

    console.log(`情報取得開始: ${url}`);
    
    // YouTubeかどうかを判定
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    
    let result;
    let usedProxy = false;

    if (isYouTube) {
        // YouTubeは初手プロキシ
        console.log(`[YouTube判定] プロキシを使用して取得します`);
        result = await runYtDlp(['--proxy', PROXY_URL, '--dump-json', url]);
        usedProxy = true;
    } else {
        // それ以外は初手プロキシなし
        console.log(`[通常判定] プロキシなしで取得を試みます`);
        result = await runYtDlp(['--dump-json', url]);
        
        // 失敗したらプロキシありでリトライ
        if (result.code !== 0) {
            console.log(`[エラー検知] 直アクセスに失敗しました。プロキシを使用して再試行します...`);
            result = await runYtDlp(['--proxy', PROXY_URL, '--dump-json', url]);
            usedProxy = true;
        }
    }

    if (result.code !== 0) {
        console.error(`[yt-dlp 取得エラー (プロキシ使用: ${usedProxy})]:`, result.errorOutput);
        return res.status(500).json({ 
            error: '動画情報の取得に失敗しました。', 
            details: `プロキシ使用: ${usedProxy}\n${result.errorOutput}` 
        });
    }

    try {
        const info = JSON.parse(result.output);
        
        const formats = info.formats
            .filter(f => f.vcodec !== 'none' && (f.resolution || (f.width && f.height))) 
            .filter(f => {
                if (!browserSupport) return true; 
                const vcodec = (f.vcodec || '').toLowerCase();
                if (vcodec.includes('av01') && !browserSupport.av1) return false;
                if (vcodec.includes('vp9') && !browserSupport.vp9) return false;
                return true;
            })
            .map(f => {
                let resStr = f.resolution;
                if (!resStr || !resStr.includes('x')) {
                    if (f.width && f.height) resStr = `${f.width}x${f.height}`;
                    else resStr = '0x0'; 
                }
                return {
                    id: f.format_id,
                    resolution: resStr,
                    ext: f.ext,
                    vcodec: f.vcodec || 'unknown',
                    note: f.format_note || f.format_id || ''
                };
            })
            .sort((a, b) => {
                const resA = parseInt(a.resolution.split('x')[1] || 0) || 0;
                const resB = parseInt(b.resolution.split('x')[1] || 0) || 0;
                return resB - resA;
            });
        
        if (formats.length === 0) {
            return res.json({ 
                title: info.title, 
                usedProxy,
                formats: [{ id: 'best', resolution: '自動解析', ext: 'mp4', vcodec: 'auto', note: '最高画質設定' }] 
            });
        }

        res.json({ title: info.title, usedProxy, formats });
    } catch (e) {
        res.status(500).json({ error: 'データの解析に失敗しました。', details: e.message });
    }
});

// --- ② ダウンロード処理とSSE ---
app.get('/api/download-stream', (req, res) => {
    const { url, format, proxy } = req.query; // info APIで決まったプロキシ設定を受け取る
    if (!url || !format) return res.status(400).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const fileId = Date.now().toString();
    const useProxy = proxy === 'true';
    
    console.log(`ダウンロード開始: ${url} (プロキシ使用: ${useProxy})`);

    const args = [];
    if (useProxy) {
        args.push('--proxy', PROXY_URL);
    }
    args.push(
        '-f', format === 'best' ? 'bestvideo+bestaudio/best' : `${format}+bestaudio/best`,
        '-o', `public/downloads/${fileId}.%(ext)s`, 
        '--newline', 
        url
    );

    const ytDlp = spawn('yt-dlp', args);
    const progressRegex = /\[download\]\s+([0-9.]+)%/;

    ytDlp.stdout.on('data', (data) => {
        const text = data.toString();
        const match = text.match(progressRegex);
        if (match) {
            res.write(`data: ${JSON.stringify({ type: 'progress', percent: parseFloat(match[1]) })}\n\n`);
        }
    });

    ytDlp.stderr.on('data', (data) => {
        console.error(`[FFmpeg/yt-dlpログ]: ${data.toString().trim()}`);
    });

    ytDlp.on('close', (code) => {
        if (code === 0) {
            fs.readdir(downloadsDir, (err, files) => {
                const downloadedFile = files.find(f => f.startsWith(fileId));
                
                if (downloadedFile) {
                    res.write(`data: ${JSON.stringify({ type: 'complete', downloadUrl: `/downloads/${downloadedFile}` })}\n\n`);
                } else {
                    res.write(`data: ${JSON.stringify({ type: 'error', message: 'ファイルの保存に失敗しました。' })}\n\n`);
                }
                res.end();
            });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: '処理中にエラーが発生しました。詳細はサーバーログを確認してください。' })}\n\n`);
            res.end();
        }
    });
});

// --- ③ 定期的な自動クリーンアップ処理（15分経過したファイルを削除） ---
const CLEANUP_INTERVAL = 5 * 60 * 1000; 
const FILE_MAX_AGE = 15 * 60 * 1000;    

setInterval(() => {
    fs.readdir(downloadsDir, (err, files) => {
        if (err) return console.error('ディレクトリの読み取りエラー:', err);

        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return console.error(`ファイル情報取得エラー (${file}):`, err);

                if (now - stats.mtimeMs > FILE_MAX_AGE) {
                    fs.unlink(filePath, err => {
                        if (err) console.error(`削除エラー (${file}):`, err);
                        else console.log(`🧹 自動削除しました (15分経過): ${file}`);
                    });
                }
            });
        });
    });
}, CLEANUP_INTERVAL);

app.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
    console.log(`自動お掃除機能が有効です（15分経過したファイルを自動削除します）`);
});