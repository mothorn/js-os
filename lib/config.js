'use strict';

// ─── Configuration ───
// Values come from the environment. A local .env file is loaded when present
// (Node's built-in loader, 20.12+). On Vercel the values come from the project
// settings instead, and the missing .env file is simply ignored.

const path = require('path');

if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env file */ }
}

const env = process.env;
const onVercel = Boolean(env.VERCEL);

function positiveInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = Object.freeze({
    port: positiveInt(env.PORT, 8080),
    onVercel,
    // Behind Vercel (or any proxy you control) the client IP arrives in a header.
    trustProxy: env.TRUST_PROXY === 'true' || onVercel,
    // Extra origins allowed to open sockets or call the API, comma separated (same-origin is always allowed).
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    logFormat: env.LOG_FORMAT === 'json' || (onVercel && env.LOG_FORMAT !== 'pretty') ? 'json' : 'pretty',

    gemini: Object.freeze({
        apiKey: (env.GEMINI_API_KEY || '').trim(),
        model: (env.GEMINI_MODEL || 'gemini-3.6-flash').trim(),
        timeoutMs: 120000,       // whole streamed answer
        maxMessages: 60,         // newest messages kept from a conversation
        maxMessageChars: 24000,  // per message
        maxTotalChars: 200000,   // per request
    }),

    limits: Object.freeze({
        maxConnections: positiveInt(env.MAX_CONNECTIONS, 100000),
        maxPerIp: positiveInt(env.MAX_PER_IP, 50),
        heartbeatMs: 15000,          // ping cadence; a silent socket is dropped after two misses
        emptyRoomGraceMs: 60000,     // keep an empty room alive briefly so a reconnect can rejoin it
        historyCap: 100,             // chat messages remembered per room
        historyBytesCap: 4 * 1024 * 1024, // and at most this much text + image data per room
        maxCallPeers: 8,             // full-mesh audio gets heavy past this
        maxFailedJoins: 8,           // wrong room codes on one socket before it is closed
        maxBodyBytes: 1024 * 1024,   // JSON request bodies
        maxWsMessageBytes: 1024 * 1024,
        maxSignalBytes: 100 * 1024,  // WebRTC signal payloads
        maxMsgChars: 10000,
        maxImageBytes: 800 * 1024,   // pasted image data URLs (client compresses to <= 700 KB)
        maxSearchQuery: 200,
        maxRooms: 10000,
        rate: Object.freeze({
            api:    { max: 100, refillPerSec: 100 / 60 }, // 100 API requests / minute
            search: { max: 20,  refillPerSec: 20 / 60 },  // 20 YouTube searches / minute
            ws:     { max: 30,  refillPerSec: 30 },       // 30 chat/control messages / second
            signal: { max: 300, refillPerSec: 100 },      // WebRTC signalling bursts on join
            conn:   { max: 60,  refillPerSec: 30 / 60 },  // new sockets: 60 burst, 30 / minute sustained
        }),
    }),

    usernameRe: /^[a-zA-Z0-9_ -]{1,20}$/,
    roomCodeRe: /^[A-Z2-9]{6}$/,
    roomCodeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
});
