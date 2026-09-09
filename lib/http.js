'use strict';

// ─── Small HTTP helpers shared by the API, static and upgrade handlers ───

const config = require('./config');

const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://i.ytimg.com",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
});

function applySecurityHeaders(res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

// One key per client for rate limits and connection counts. IPv4-mapped addresses lose
// their prefix and IPv6 clients are grouped by /64, the block a single subscriber controls.
function normalizeIp(raw) {
    if (!raw) return 'unknown';
    let ip = raw.trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip.includes(':')) {
        const groups = ip.split(':');
        if (groups.length >= 4) return groups.slice(0, 4).join(':') + '::/64';
    }
    return ip;
}

function getClientIp(req) {
    if (config.trustProxy) {
        if (config.onVercel) {
            const real = req.headers['x-real-ip'];
            if (typeof real === 'string' && real.trim()) return normalizeIp(real);
        }
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded.trim()) {
            // The last entry was appended by the proxy in front of us; earlier ones are client-supplied.
            const hops = forwarded.split(',').map(s => s.trim()).filter(Boolean);
            if (hops.length) return normalizeIp(hops[hops.length - 1]);
        }
    }
    return normalizeIp(req.socket.remoteAddress);
}

// Browsers send Origin on cross-site requests and WebSocket handshakes; only our own pages may use them.
function isAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;   // non-browser client or same-origin GET
    const host = req.headers.host;
    if (host && (origin === 'https://' + host || origin === 'http://' + host)) return true;
    return config.allowedOrigins.includes(origin);
}

function sendJson(res, status, body, extraHeaders) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders,
    });
    res.end(data);
}

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

// Collects a JSON body with a hard size cap. Throws HttpError(413|400).
function readJsonBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (chunk) => {
            if (tooLarge) return;            // keep draining so the 413 can still be written
            size += chunk.length;
            if (size > maxBytes) {
                tooLarge = true;
                chunks.length = 0;
                reject(new HttpError(413, 'Request body too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge) return;
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
            catch { reject(new HttpError(400, 'Invalid JSON')); }
        });
        req.on('error', () => reject(new HttpError(400, 'Request aborted')));
    });
}

module.exports = { SECURITY_HEADERS, applySecurityHeaders, getClientIp, isAllowedOrigin, sendJson, readJsonBody, HttpError };
