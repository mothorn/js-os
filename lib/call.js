'use strict';

// ─── JS Call: WebRTC signaling over WebSocket (/ws/call) ───
// Client → server: create-call {username} · join-call {username, code, session?} · signal {to, signal} · mute {muted}
// Server → client: call-joined {code, peerId, username, session, peers, iceServers} · peer-joined · peer-left · call-users · signal · error
// Audio itself flows peer-to-peer; the server only relays offers, answers and ICE candidates, and tells
// each browser which STUN/TURN servers to use (see ice.js).

const config = require('./config');
const { log } = require('./log');
const ice = require('./ice');
const { RoomRegistry, validateUsername, parseRoomCode, newSession } = require('./rooms');

const MAX_BUFFERED = 1024 * 1024;

function send(ws, payload) {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(payload)); } catch { /* socket went away */ }
}

function isValidSignal(signal) {
    if (!signal || typeof signal !== 'object') return false;
    if (signal.sdp) {
        return typeof signal.sdp === 'object'
            && (signal.sdp.type === 'offer' || signal.sdp.type === 'answer')
            && typeof signal.sdp.sdp === 'string';
    }
    return Boolean(signal.candidate) && typeof signal.candidate === 'object';
}

function attachCall(wss, ctx) {
    const rooms = new RoomRegistry('call');
    let nextPeer = 1;

    const peerInfo = (client) => ({ peerId: client.peerId, username: client.username, muted: client.muted });
    const usersOf = (room) => [...room.clients].filter(c => c.username).map(peerInfo);
    const fail = (ws, message, code) => send(ws, code ? { type: 'error', code, message } : { type: 'error', message });

    function broadcast(room, payload, except) {
        const data = JSON.stringify(payload);
        for (const client of room.clients) {
            if (client === except || client.readyState !== 1) continue;
            if (client.bufferedAmount > MAX_BUFFERED) { client.terminate(); continue; }
            try { client.send(data); } catch { /* ignore */ }
        }
    }

    function failJoin(ws, message) {
        ws.failedJoins = (ws.failedJoins || 0) + 1;
        fail(ws, message);
        if (ws.failedJoins >= config.limits.maxFailedJoins) ws.close(1008, 'Too many failed attempts');
    }

    function onCreate(ws, msg) {
        if (ws.room) return fail(ws, 'You are already in a call');
        const name = validateUsername(msg.username);
        if (!name.ok) return fail(ws, name.error);
        const room = rooms.create();
        if (!room) return fail(ws, 'The server is at room capacity. Try again later.');
        ws.username = name.value;
        ws.session = newSession();
        rooms.add(room, ws);
        send(ws, { type: 'call-joined', code: room.code, peerId: ws.peerId, username: ws.username, session: ws.session, peers: [], iceServers: ice.iceServersFor(ws.peerId, ws.host) });
        broadcast(room, { type: 'call-users', users: usersOf(room) });
        log('CALL', `${ws.username} created call ${room.code}`);
    }

    function onJoin(ws, msg) {
        if (ws.room) return fail(ws, 'You are already in a call');
        const name = validateUsername(msg.username);
        if (!name.ok) return fail(ws, name.error);
        const code = parseRoomCode(msg.code);
        if (!code) return fail(ws, 'Room codes are 6 characters: letters A-Z (no I or O) and digits 2-9');
        const room = rooms.get(code);
        if (!room) return failJoin(ws, 'Call not found');
        const session = typeof msg.session === 'string' && msg.session.length <= 64 ? msg.session : null;
        if (!rooms.reclaimName(room, name.value, session)) {
            return fail(ws, `The name "${name.value}" is already taken in this call`, 'name-taken');
        }
        if (room.clients.size >= config.limits.maxCallPeers) return fail(ws, `This call is full (${config.limits.maxCallPeers} people max)`);
        ws.failedJoins = 0;
        ws.username = name.value;
        ws.session = session || newSession();
        const existingPeers = usersOf(room);
        rooms.add(room, ws);
        // The newcomer sends offers to every existing peer and existing peers only answer,
        // so two sides never offer to each other at the same time.
        send(ws, { type: 'call-joined', code, peerId: ws.peerId, username: ws.username, session: ws.session, peers: existingPeers, iceServers: ice.iceServersFor(ws.peerId, ws.host) });
        broadcast(room, { type: 'peer-joined', peerId: ws.peerId, username: ws.username, muted: false }, ws);
        broadcast(room, { type: 'call-users', users: usersOf(room) });
        log('CALL', `${ws.username} joined call ${code} (${room.clients.size} peers)`);
    }

    function onSignal(ws, msg) {
        const room = ws.room;
        if (!room || typeof msg.to !== 'string' || !isValidSignal(msg.signal)) return;
        if (JSON.stringify(msg.signal).length > config.limits.maxSignalBytes) return;
        for (const client of room.clients) {
            if (client.peerId === msg.to) {
                send(client, { type: 'signal', from: ws.peerId, signal: msg.signal });
                return;
            }
        }
    }

    function onMute(ws, msg) {
        ws.muted = Boolean(msg.muted);
        if (ws.room) broadcast(ws.room, { type: 'call-users', users: usersOf(ws.room) });
    }

    function onClose(ws) {
        const room = ws.room;
        if (!room) return;
        rooms.remove(room, ws);
        broadcast(room, { type: 'peer-left', peerId: ws.peerId });
        broadcast(room, { type: 'call-users', users: usersOf(room) });
        log('CALL', `${ws.username || ws.peerId} left call ${room.code} (${room.clients.size} remaining)`);
    }

    // Prototype-free so a type like "__proto__" or "constructor" can never resolve to something callable.
    const handlers = Object.assign(Object.create(null), { 'create-call': onCreate, 'join-call': onJoin, signal: onSignal, mute: onMute });

    wss.on('connection', (ws, req) => {
        ws.peerId = ctx.instanceId + '-' + (nextPeer++);
        ws.host = req && req.headers ? req.headers.host : null;   // the address this browser used; the built-in TURN is reachable there too
        ws.room = null;
        ws.username = null;
        ws.session = null;
        ws.muted = false;
        ws.isAlive = true;
        ws.signalKey = ws.clientIp + '#' + ws.peerId;   // signalling gets its own per-socket budget
        log('CALL', `Peer ${ws.peerId} connected`);
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('error', (err) => log('CALL', 'Socket error: ' + err.message));
        ws.on('close', () => onClose(ws));
        ws.on('message', (data) => {
            let msg;
            try { msg = JSON.parse(data); } catch { return fail(ws, 'Invalid message'); }
            const type = msg && typeof msg === 'object' && typeof msg.type === 'string' ? msg.type : '';
            if (type === 'signal') {
                if (!ctx.limiter.consume(ws.signalKey, 'signal')) return;   // dropped quietly; ICE retries on its own
            } else if (!ctx.limiter.consume(ws.clientIp, 'ws')) {
                return fail(ws, 'Slow down! Too many messages.');
            }
            const handler = type ? handlers[type] : undefined;
            if (typeof handler !== 'function') return fail(ws, 'Unknown message type');
            try { handler(ws, msg); }
            catch (err) { log('ERROR', 'Call handler failed: ' + (err.stack || err.message)); }
        });
    });

    return { rooms };
}

module.exports = { attachCall };
