const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'error' : 'info');
const logInfo = (...args) => {
    if (LOG_LEVEL === 'info') console.log(...args);
};
const logError = (...args) => {
    console.error(...args);
};

// ダウンロード保存先を用意
const downloadsDir = path.join(__dirname, 'public', 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

app.use(express.json());
app.use(express.static('public'));

const PROXY_URL = process.env.YT_DLP_PROXY || "http://ytproxy-siawaseok.duckdns.org:3007";

// yt-dlp 実行
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

// 画質一覧を取得
app.post('/api/info', async (req, res) => {
    const { url, browserSupport } = req.body;
    if (!url) return res.status(400).json({ error: 'URLが必要です' });

    logInfo(`情報取得開始: ${url}`);

    // YouTube判定
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    
    let result;
    let usedProxy = false;

    if (isYouTube) {
        logInfo(`[YouTube] プロキシ使用で取得`);
        result = await runYtDlp(['--proxy', PROXY_URL, '--dump-json', url]);
        usedProxy = true;
    } else {
        logInfo(`[通常] プロキシなしで取得`);
        result = await runYtDlp(['--dump-json', url]);
        
        if (result.code !== 0) {
            logInfo(`[再試行] プロキシ使用`);
            result = await runYtDlp(['--proxy', PROXY_URL, '--dump-json', url]);
            usedProxy = true;
        }
    }

    if (result.code !== 0) {
        logError(`[yt-dlp 取得エラー (プロキシ使用: ${usedProxy})]:`, result.errorOutput);
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

// ダウンロードとSSE
app.get('/api/download-stream', (req, res) => {
    const { url, format, proxy } = req.query;
    if (!url || !format) return res.status(400).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const fileId = Date.now().toString();
    const useProxy = proxy === 'true';
    
    logInfo(`ダウンロード開始: ${url} (プロキシ使用: ${useProxy})`);

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

    const handleProgress = (data) => {
        const text = data.toString();
        const match = text.match(progressRegex);
        if (match) {
            res.write(`data: ${JSON.stringify({ type: 'progress', percent: parseFloat(match[1]) })}\n\n`);
            return true;
        }
        return false;
    };

    ytDlp.stdout.on('data', (data) => {
        handleProgress(data);
    });

    ytDlp.stderr.on('data', (data) => {
        if (!handleProgress(data)) {
            logError(`[yt-dlpログ]: ${data.toString().trim()}`);
        }
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

// 定期クリーンアップ（15分経過したファイルを削除）
const CLEANUP_INTERVAL = 5 * 60 * 1000; 
const FILE_MAX_AGE = 15 * 60 * 1000;    

setInterval(() => {
    fs.readdir(downloadsDir, (err, files) => {
        if (err) return logError('ディレクトリの読み取りエラー:', err);

        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return logError(`ファイル情報取得エラー (${file}):`, err);

                if (now - stats.mtimeMs > FILE_MAX_AGE) {
                    fs.unlink(filePath, err => {
                        if (err) logError(`削除エラー (${file}):`, err);
                    });
                }
            });
        });
    });
}, CLEANUP_INTERVAL);

app.listen(PORT, () => {
    logInfo(`Server running: http://localhost:${PORT}`);
    logInfo(`自動お掃除機能が有効です（15分経過したファイルを自動削除します）`);
});
