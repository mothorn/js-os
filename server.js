'use strict';

// ═══════════════════════════════════════════════════════════
//  JS OS server — static files, JSON API and WebSockets
//  Runs locally with `npm start` and unchanged on Vercel, which captures
//  the server through the listen() call below.
// ═══════════════════════════════════════════════════════════

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const config = require('./lib/config');
const { log, ANSI } = require('./lib/log');
const { RateLimiter, ConnectionTracker } = require('./lib/limits');
const { applySecurityHeaders, getClientIp, isAllowedOrigin, sendJson } = require('./lib/http');
const { serveStatic } = require('./lib/static');
const { handleApi } = require('./lib/api');
const { attachChat } = require('./lib/chat');
const { attachCall } = require('./lib/call');

const INSTANCE_ID = crypto.randomBytes(4).toString('hex');
const limiter = new RateLimiter();
const tracker = new ConnectionTracker();

const socketOptions = { noServer: true, maxPayload: config.limits.maxWsMessageBytes };
const chatSockets = new WebSocketServer(socketOptions);
const callSockets = new WebSocketServer(socketOptions);

const ctx = { instanceId: INSTANCE_ID, limiter, tracker };
const chat = attachChat(chatSockets, ctx);
const call = attachCall(callSockets, ctx);
ctx.stats = () => ({ connections: tracker.total, chatRooms: chat.rooms.size, callRooms: call.rooms.size });

// A bug in one request must never take every room and call down with it.
process.on('uncaughtException', (err) => log('ERROR', 'Uncaught exception: ' + (err.stack || err.message)));
process.on('unhandledRejection', (err) => log('ERROR', 'Unhandled rejection: ' + (err && (err.stack || err.message) || err)));

// ─── HTTP ───
const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    const ip = getClientIp(req);

    let url;
    try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
    catch { return sendJson(res, 400, { error: 'Bad request' }); }

    // Only the API draws from the per-IP budget; the page and its assets are cheap and cached.
    if (url.pathname.startsWith('/api/') && !limiter.consume(ip, 'api')) {
        return sendJson(res, 429, { error: 'Rate limit exceeded. Try again later.' }, { 'Retry-After': '10' });
    }

    try {
        if (await handleApi(req, res, url, ctx)) return;
        await serveStatic(req, res, url.pathname);
    } catch (err) {
        log('ERROR', `${req.method} ${url.pathname}: ${err.stack || err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
        else res.end();
    }
});

server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

// ─── WebSocket upgrades ───
const SOCKET_ROUTES = { '/ws/chat': chatSockets, '/ws/call': callSockets };

function rejectUpgrade(socket, status, reason) {
    if (socket.writable) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});   // a raw upgrade socket has no error listener until ws adopts it
    const ip = getClientIp(req);
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* keep '/' */ }

    const sockets = SOCKET_ROUTES[pathname];
    if (!sockets) { log('WS', `Upgrade on unknown path ${pathname} rejected`); return rejectUpgrade(socket, 404, 'Not Found'); }
    if (!isAllowedOrigin(req)) { log('WS', `Upgrade from origin ${req.headers.origin} rejected`); return rejectUpgrade(socket, 403, 'Forbidden'); }
    if (!limiter.consume(ip, 'conn')) { log('WS', `Connection from ${ip} rate limited`); return rejectUpgrade(socket, 429, 'Too Many Requests'); }
    const check = tracker.canConnect(ip);
    if (!check.ok) { log('WS', `Connection from ${ip} rejected: ${check.reason}`); return rejectUpgrade(socket, 503, 'Service Unavailable'); }

    sockets.handleUpgrade(req, socket, head, (ws) => {
        ws.clientIp = ip;
        tracker.add(ip);
        ws.on('close', () => tracker.remove(ip));
        sockets.emit('connection', ws, req);
    });
});

// ─── Heartbeat: ping regularly and drop sockets that stopped answering ───
const heartbeat = setInterval(() => {
    for (const sockets of [chatSockets, callSockets]) {
        for (const ws of sockets.clients) {
            if (ws.isAlive === false) { log('WS', 'Terminating unresponsive connection'); ws.terminate(); continue; }
            ws.isAlive = false;
            if (ws.readyState === 1) ws.ping();
        }
    }
}, config.limits.heartbeatMs);
heartbeat.unref();

// ─── Shutdown ───
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('SERVER', `${signal} received — shutting down`);
    clearInterval(heartbeat);
    limiter.destroy();
    for (const sockets of [chatSockets, callSockets]) {
        for (const ws of sockets.clients) ws.close(1001, 'Server shutting down');
    }
    server.close(() => { log('SERVER', 'Shutdown complete'); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n  ERROR: port ${config.port} is already in use. Stop the other process or set PORT in .env.\n`);
        process.exit(1);
    }
    throw err;
});

// ─── Start ───
function printBanner() {
    const { yellow: Y, green: G, red: RED, dim: D, bold: B, reset: R } = ANSI;
    const width = 39;
    const row = (label, value, color = '') =>
        `  ${Y}║${R}  ${D}${label.padEnd(9)}${R}${color}${value.padEnd(width - 11)}${R}${Y}║${R}`;
    const title = '{ }  JS OS Server';
    const left = Math.floor((width - title.length) / 2);
    console.log('');
    console.log(`  ${Y}╔${'═'.repeat(width)}╗${R}`);
    console.log(`  ${Y}║${R}${' '.repeat(left)}${Y}${B}{ }${R}  ${B}JS OS Server${R}${' '.repeat(width - left - title.length)}${Y}║${R}`);
    console.log(`  ${Y}╠${'═'.repeat(width)}╣${R}`);
    console.log(row('URL', `http://localhost:${config.port}`, G));
    console.log(row('Node', process.version));
    console.log(row('OS', os.platform() + ' ' + os.arch()));
    console.log(row('Instance', INSTANCE_ID));
    console.log(row('Gemini', config.gemini.apiKey ? config.gemini.model : 'missing API key', config.gemini.apiKey ? '' : RED));
    console.log(`  ${Y}╚${'═'.repeat(width)}╝${R}`);
    console.log('');
}

server.listen(config.port, () => {
    if (config.logFormat === 'pretty') printBanner();
    if (!config.gemini.apiKey) log('ERROR', 'GEMINI_API_KEY is not set — JS AI is unavailable until it is (see .env.example)');
    log('SERVER', `Ready on http://localhost:${config.port}`);
});
