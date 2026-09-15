'use strict';

// ─── JS Call connectivity: STUN, TURN and the built-in relay ───
// Audio travels browser to browser; this server never carries it. What it does hand out is the
// list of ICE servers each browser uses to find a path:
//   • STUN tells a browser its public address, so peers on different networks can connect directly.
//   • TURN relays the audio when that fails: symmetric NAT, firewalls that block UDP, most schools.
// TURN_PORT starts a relay inside this process (pure JavaScript, nothing to install); TURN_URLS
// points at an external one instead or as well. Credentials are minted per call and expire.

const crypto = require('crypto');
const os = require('os');
const config = require('./config');
const { log } = require('./log');
const upnp = require('./upnp');

const REALM = 'jsos';
const PUBLIC_IP_TIMEOUT_MS = 5000;
const secret = config.ice.turnSecret || crypto.randomBytes(32).toString('base64url');

const state = {
    server: null,            // the built-in TURN server once it listens
    listening: [],           // ['udp 3478', 'tcp 3478']
    externalIp: config.ice.publicIp || null,
    turnError: null,
    upnp: null,              // { mapper, mapped, wanted }
    upnpError: null,
};

// Addresses the relay may forward to. Anyone in a call gets relay credentials, so the relay must never be a
// way into the operator's own network: private, link-local and loopback peers are refused, except this
// machine's own addresses, which relay-to-relay calls legitimately use.
const PRIVATE_RE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/;
function isPrivateIp(ip) {
    const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (PRIVATE_RE.test(plain)) return true;
    const low = plain.toLowerCase();
    return low === '::1' || low === '::' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd');
}
function ownAddresses() {
    const set = new Set();
    if (state.externalIp) set.add(state.externalIp);
    for (const list of Object.values(os.networkInterfaces())) for (const iface of list || []) set.add(iface.address);
    return set;
}
function peerAllowed(info) {
    const ip = info && info.peer && typeof info.peer.ip === 'string' ? info.peer.ip : '';
    if (!ip) return false;
    return !isPrivateIp(ip) || ownAddresses().has(ip.startsWith('::ffff:') ? ip.slice(7) : ip);
}

// An external relay needs credentials; browsers refuse a turn: entry without them.
const externalTurnUsable = config.ice.turnUrls.length > 0 && Boolean((config.ice.turnUsername && config.ice.turnPassword) || config.ice.turnSecret);

// TURN REST credentials: username "<expiry>:<user>", password HMAC-SHA1(secret, username). coturn-compatible.
function mintCredentials(userId, turnSecret) {
    const username = Math.floor(Date.now() / 1000 + config.ice.credentialTtlSec) + ':' + userId;
    const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
    return { username, credential };
}

function hostnameOf(hostHeader) {
    if (typeof hostHeader !== 'string' || !hostHeader) return null;
    try { return new URL('http://' + hostHeader).hostname || null; } catch { return null; }
}

/** ICE servers for one browser. `userId` scopes its temporary TURN credentials; `hostHeader` is how it reached us. */
function iceServersFor(userId, hostHeader) {
    const servers = [{ urls: config.ice.stunUrls }];
    const safeId = String(userId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'guest';
    if (externalTurnUsable) {
        const entry = { urls: config.ice.turnUrls };
        if (config.ice.turnUsername && config.ice.turnPassword) {
            entry.username = config.ice.turnUsername;
            entry.credential = config.ice.turnPassword;
        } else {
            Object.assign(entry, mintCredentials(safeId, config.ice.turnSecret));
        }
        servers.push(entry);
    }
    if (state.server) {
        const host = config.ice.publicHost || hostnameOf(hostHeader) || state.externalIp;
        if (host) {
            const port = config.ice.turnPort;
            servers.push({ urls: [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`], ...mintCredentials(safeId, secret) });
        }
    }
    return servers;
}

async function detectPublicIp() {
    try {
        const { getPublicIP } = await import('turn-server');
        return await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), PUBLIC_IP_TIMEOUT_MS);
            getPublicIP(config.ice.stunUrls[0], (err, info) => { clearTimeout(timer); resolve(!err && info && info.ip ? info.ip : null); });
        });
    } catch { return null; }
}

async function startUpnp() {
    const ports = upnp.portsFor(config.ice, config.port);
    try {
        const result = await upnp.mapPorts(ports);
        state.upnp = { mapper: result.mapper, mapped: result.mapped, wanted: result.wanted };
        if (result.externalIp && !state.externalIp) state.externalIp = result.externalIp;
        log('CALL', `UPnP: forwarded ${result.mapped}/${result.wanted} ports on the router` + (result.externalIp ? ` (public address ${result.externalIp})` : ''));
        for (const failure of result.failures.slice(0, 3)) log('CALL', `UPnP: port ${failure.port}/${failure.protocol} not forwarded: ${failure.error}`);
        if (!result.mapped) state.upnpError = result.failures[0] ? result.failures[0].error : 'no ports forwarded';
    } catch (err) {
        state.upnpError = err.message;
        log('CALL', 'UPnP: could not forward ports (' + err.message + '). Forward them on the router by hand; see .env.example.');
    }
}

async function startTurn() {
    let createServer;
    try { ({ createServer } = await import('turn-server')); }
    catch (err) {
        state.turnError = 'turn-server is not installed (run npm install)';
        log('ERROR', 'Built-in TURN relay unavailable: ' + err.message);
        return;
    }
    const externalIp = state.externalIp;
    const [low, high] = config.ice.turnRelayPorts;
    const server = createServer({
        software: 'JS OS',
        auth: { mechanism: 'long-term', realm: REALM, secret },
        relay: { ip: '0.0.0.0', externalIp: externalIp || undefined, portRange: [low, high] },
        allowLoopback: false,   // the relay must never be a path to services on this machine
        maxConnections: 4096,
        userQuota: 32,                              // one caller holds two allocations per peer in a mesh call
        totalQuota: Math.max(8, high - low + 1),   // one relay port per allocation
        idleTimeout: 300000,
    });
    for (const hook of ['beforePermission', 'beforeChannelBind', 'beforeConnect']) {
        server.on(hook, (info, cb) => { const ok = peerAllowed(info); if (typeof cb === 'function') cb(ok); return ok; });
    }
    let starting = true;
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        server.on('listening', (info) => {
            state.listening.push(`${info.transport} ${info.port}`);
            if (state.listening.length >= 2) { clearTimeout(timer); resolve(); }
        });
        server.on('error', (err) => {
            if (starting) { state.turnError = err.message; clearTimeout(timer); resolve(); return; }
            // A browser closing its TCP TURN connection mid-call surfaces as a reset; that is normal, not a fault.
            if (!['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'].includes(err.code)) log('CALL', 'TURN relay error: ' + err.message);
        });
        try { server.listen({ port: config.ice.turnPort }); }
        catch (err) { state.turnError = err.message; clearTimeout(timer); resolve(); }
    });
    starting = false;
    if (!state.listening.length) {
        log('ERROR', `Built-in TURN relay could not start on port ${config.ice.turnPort}: ${state.turnError || 'unknown error'}`);
        try { server.drain(0, () => {}); } catch { /* nothing to stop */ }
        return;
    }
    state.server = server;
    log('CALL', `TURN relay listening on ${state.listening.join(', ')}; relay ports ${low}-${high}; public address ${externalIp || 'unknown'}`);
    if (!externalIp) log('CALL', 'PUBLIC_IP could not be detected. Set it in .env so relayed calls work from outside your network.');
    else if (/^127\.|^::1$/.test(externalIp)) log('CALL', 'PUBLIC_IP is a loopback address; relayed audio cannot flow through it. Use your LAN or public IP.');
}

/** Starts the built-in relay and port forwarding as configured. Never throws; problems are logged. */
async function start() {
    const wantTurn = config.ice.turnPort > 0;
    if (config.ice.turnUrls.length && !externalTurnUsable) {
        log('CALL', 'TURN_URLS is set without TURN_USERNAME + TURN_PASSWORD or TURN_SECRET; browsers refuse a relay without credentials, so it is ignored.');
    }
    if (config.onVercel) {
        if (wantTurn || config.ice.upnp) log('CALL', 'TURN_PORT and UPNP do nothing on Vercel (functions cannot accept UDP). Use TURN_URLS there.');
        return;
    }
    if (config.ice.upnp) await startUpnp();   // first, because it also learns the public address
    if (!wantTurn) return;
    if (!state.externalIp) state.externalIp = await detectPublicIp();
    await startTurn();
}

async function stop() {
    const jobs = [];
    if (state.server) {
        const server = state.server;
        state.server = null;
        jobs.push(new Promise((resolve) => { try { server.drain(1000, resolve); } catch { resolve(); } setTimeout(resolve, 1500).unref(); }));
    }
    if (state.upnp) { jobs.push(upnp.close(state.upnp.mapper)); state.upnp = null; }
    await Promise.all(jobs);
}

/** Human-readable summary for the banner and /health. */
function describe() {
    const turn = state.server ? 'built-in' : externalTurnUsable ? 'external' : 'off';
    return {
        stun: config.ice.stunUrls.length,
        turn,
        turnPort: state.server ? config.ice.turnPort : undefined,
        upnp: state.upnp ? `${state.upnp.mapped}/${state.upnp.wanted} ports` : config.ice.upnp ? 'failed' : 'off',
        healthy: !state.turnError && !state.upnpError,
    };
}

// Short enough for the startup banner column.
function summary() {
    if (config.onVercel) return externalTurnUsable ? 'STUN + external TURN' : 'STUN only';
    if (config.ice.turnPort > 0) return `STUN + TURN :${config.ice.turnPort}` + (config.ice.upnp ? ' + UPnP' : '');
    return externalTurnUsable ? 'STUN + external TURN' : 'STUN only (no TURN_PORT)';
}

module.exports = { start, stop, iceServersFor, describe, summary };
