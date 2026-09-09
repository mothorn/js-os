'use strict';

// ─── Static file serving for public/ ───
// Locally this serves everything. On Vercel the CDN serves public/** directly and
// this only sees whatever the CDN did not answer (for example "/").

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { log } = require('./log');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
};

// Images, sounds and fonts never change without changing name in practice; code and HTML must revalidate.
const LONG_LIVED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.mp3', '.wav', '.ogg', '.woff', '.woff2', '.ttf', '.wasm']);

function plain(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
}

function resolvePublicPath(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes('\0')) return null;
    let relative = path.posix.normalize(decoded);  // collapses "..", "." and duplicate slashes
    if (relative === '/' || relative === '') relative = '/index.html';
    const absolute = path.join(PUBLIC_DIR, relative);
    if (absolute !== PUBLIC_DIR && !absolute.startsWith(PUBLIC_DIR + path.sep)) return null;
    return absolute;
}

// "bytes=start-end" (either side optional) → { start, end } within the file, or null.
function parseRange(header, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
    if (!match || (!match[1] && !match[2])) return null;
    let start = match[1] ? parseInt(match[1], 10) : Math.max(0, size - parseInt(match[2], 10));
    let end = match[1] && match[2] ? parseInt(match[2], 10) : size - 1;
    if (end >= size) end = size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
    return { start, end };
}

function pipeFile(res, filePath, options) {
    return new Promise((resolve) => {
        const stream = fs.createReadStream(filePath, options);
        stream.on('error', () => { res.destroy(); resolve(); });
        stream.on('close', resolve);
        stream.pipe(res);
    });
}

async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return plain(res, 405, 'Method not allowed');
    }

    let filePath = resolvePublicPath(pathname);
    if (!filePath) {
        log('HTTP', `403 ${req.method} ${pathname}`);
        return plain(res, 403, 'Forbidden');
    }

    let stat;
    try {
        stat = await fsp.stat(filePath);
        if (stat.isDirectory()) {
            filePath = path.join(filePath, 'index.html');
            stat = await fsp.stat(filePath);
        }
    } catch {
        log('HTTP', `404 ${req.method} ${pathname}`);
        return plain(res, 404, 'Not found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': LONG_LIVED.has(ext) ? 'public, max-age=86400' : 'no-cache',
        'Last-Modified': stat.mtime.toUTCString(),
        'ETag': etag,
        'Accept-Ranges': 'bytes',
    };

    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
    }

    // Media players (iOS Safari especially) probe audio files with byte ranges.
    const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
    if (req.headers.range && !range) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
    }
    if (range) {
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
        headers['Content-Length'] = range.end - range.start + 1;
        res.writeHead(206, headers);
        if (req.method === 'HEAD') return res.end();
        return pipeFile(res, filePath, { start: range.start, end: range.end });
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return pipeFile(res, filePath);
}

module.exports = { serveStatic, PUBLIC_DIR };
