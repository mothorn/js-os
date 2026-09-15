'use strict';

// ─── Configuration ───
// Values come from the environment. A local .env file is loaded when present
// (Node's built-in loader, 20.12+). On Vercel the values come from the project
// settings instead, and the missing .env file is simply ignored.

const os = require('os');
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

function list(value) {
    return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

// "49160-49200" → [49160, 49200]; anything malformed falls back.
function portRange(value, fallback) {
    const match = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(value || '');
    if (!match) return fallback;
    const low = parseInt(match[1], 10);
    const high = parseInt(match[2], 10);
    if (low < 1024 || high > 65535 || low > high) return fallback;
    return [low, high];
}

const stunUrls = list(env.STUN_URLS);

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

    // JSTube playback. 'auto' uses the built-in HLS player wherever yt-dlp can run (everywhere but Vercel,
    // whose datacenter addresses YouTube refuses); 'native' forces it; 'embed' keeps the YouTube iframe.
    tube: Object.freeze({
        player: ['auto', 'native', 'embed'].includes(env.TUBE_PLAYER) ? env.TUBE_PLAYER : 'auto',
        ytdlpPath: (env.YTDLP_PATH || '').trim(),
        // The downloaded yt-dlp binary and its own cache live here. Vercel only allows writes under /tmp.
        cacheDir: (env.JSOS_CACHE_DIR || '').trim() || (onVercel ? path.join(os.tmpdir(), 'jsos-cache') : path.join(__dirname, '..', '.cache')),
        resolveTimeoutMs: 90000,            // one yt-dlp run
        entryTtlMs: 2 * 60 * 60 * 1000,     // resolved stream URLs are reused this long (YouTube's expire after ~6h)
        maxEntries: 50,                     // each open video keeps its playlists and segment addresses in memory
        maxInFlightResolves: 3,
        maxInFlightSegments: 64,
    }),

    // WebRTC connectivity for JS Call. STUN lets a browser learn its public address; TURN relays the audio
    // when a firewall or symmetric NAT blocks the direct path. TURN_PORT starts the built-in relay.
    ice: Object.freeze({
        stunUrls: stunUrls.length ? stunUrls : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
        turnUrls: list(env.TURN_URLS),                        // an external TURN server (coturn, a hosted one, ...)
        turnUsername: (env.TURN_USERNAME || '').trim(),
        turnPassword: (env.TURN_PASSWORD || '').trim(),
        turnSecret: (env.TURN_SECRET || '').trim(),            // shared secret for time-limited credentials
        turnPort: positiveInt(env.TURN_PORT, 0),               // 0 = built-in TURN server off
        turnRelayPorts: portRange(env.TURN_RELAY_PORTS, [49160, 49223]),   // 64 relay allocations at once
        publicHost: (env.PUBLIC_HOST || '').trim(),            // hostname or IP people use to reach this machine
        publicIp: (env.PUBLIC_IP || '').trim(),                // public IPv4 of this machine (auto-detected when empty)
        upnp: env.UPNP === 'true',                             // ask the router to forward the ports above
        credentialTtlSec: 12 * 60 * 60,
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
            tube:   { max: 30,  refillPerSec: 30 / 60 },  // 30 JSTube videos opened / minute (each runs yt-dlp)
            media:  { max: 600, refillPerSec: 10 },       // playlist and segment fetches while watching
        }),
    }),

    usernameRe: /^[a-zA-Z0-9_ -]{1,20}$/,
    roomCodeRe: /^[A-Z2-9]{6}$/,
    roomCodeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
});
