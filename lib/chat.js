'use strict';

// ─── JS Chat: room-based chat over WebSocket (/ws/chat) ───
// Client → server: create {username} · join {username, code, session?} · message {message, image}
// Server → client: joined {code, username, session, history, users} · message · system · users · error {code?, message}
// The session token lets a client that lost its socket take its own name back when it rejoins.

const config = require('./config');
const { log } = require('./log');
const { RoomRegistry, validateUsername, parseRoomCode, newSession } = require('./rooms');

const MAX_BUFFERED = 1024 * 1024;   // a client this far behind is dropped and reconnects with a fresh replay
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

function send(ws, payload) {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(payload)); } catch { /* socket went away */ }
}

function attachChat(wss, ctx) {
    const rooms = new RoomRegistry('chat');
    const usersOf = (room) => [...room.clients].map(c => c.username).filter(Boolean);
    const fail = (ws, message, code) => send(ws, code ? { type: 'error', code, message } : { type: 'error', message });

    function broadcast(room, payload, except) {
        const data = JSON.stringify(payload);
        for (const client of room.clients) {
            if (client === except || client.readyState !== 1) continue;
            if (client.bufferedAmount > MAX_BUFFERED) { client.terminate(); continue; }
            try { client.send(data); } catch { /* ignore */ }
        }
    }

    // Wrong room codes are counted per socket so a code cannot be guessed at speed.
    function failJoin(ws, message) {
        ws.failedJoins = (ws.failedJoins || 0) + 1;
        fail(ws, message);
        if (ws.failedJoins >= config.limits.maxFailedJoins) ws.close(1008, 'Too many failed attempts');
    }

    function onCreate(ws, msg) {
        if (ws.room) return fail(ws, 'You are already in a room');
        const name = validateUsername(msg.username);
        if (!name.ok) return fail(ws, name.error);
        const room = rooms.create();
        if (!room) return fail(ws, 'The server is at room capacity. Try again later.');
        ws.username = name.value;
        ws.session = newSession();
        rooms.add(room, ws);
        send(ws, { type: 'joined', code: room.code, username: ws.username, session: ws.session, history: [], users: usersOf(room) });
        log('CHAT', `${ws.username} created room ${room.code} (${rooms.size} active rooms)`);
    }

    function onJoin(ws, msg) {
        if (ws.room) return fail(ws, 'You are already in a room');
        const name = validateUsername(msg.username);
        if (!name.ok) return fail(ws, name.error);
        const code = parseRoomCode(msg.code);
        if (!code) return fail(ws, 'Room codes are 6 characters: letters A-Z (no I or O) and digits 2-9');
        const room = rooms.get(code);
        if (!room) return failJoin(ws, 'Room not found');
        const session = typeof msg.session === 'string' && msg.session.length <= 64 ? msg.session : null;
        const holder = room.findByName(name.value);
        const rejoining = Boolean(holder && session && holder.session === session);
        if (!rooms.reclaimName(room, name.value, session)) {
            return fail(ws, `The name "${name.value}" is already taken in this room`, 'name-taken');
        }
        ws.failedJoins = 0;
        ws.username = name.value;
        ws.session = session || newSession();
        rooms.add(room, ws);
        send(ws, { type: 'joined', code, username: ws.username, session: ws.session, history: room.messages, users: usersOf(room) });
        if (!rejoining) broadcast(room, { type: 'system', message: ws.username + ' joined the room', ts: Date.now() }, ws);
        broadcast(room, { type: 'users', users: usersOf(room) });
        log('CHAT', `${ws.username} ${rejoining ? 'rejoined' : 'joined'} room ${code} (${room.clients.size} users)`);
    }

    function onMessage(ws, msg) {
        const room = ws.room;
        if (!room || !ws.username) return fail(ws, 'Join a room first');
        const text = typeof msg.message === 'string' ? msg.message.trim() : '';
        if (text.length > config.limits.maxMsgChars) return fail(ws, `Message too long (max ${config.limits.maxMsgChars} characters)`);
        let image = null;
        if (msg.image != null) {
            if (typeof msg.image !== 'string' || msg.image.length > config.limits.maxImageBytes) return fail(ws, 'Image too large');
            if (!IMAGE_DATA_URL_RE.test(msg.image)) return fail(ws, 'Unsupported image');
            image = msg.image;
        }
        if (!text && !image) return;
        const chatMsg = { type: 'message', username: ws.username, message: text, image, ts: Date.now() };
        room.remember(chatMsg);
        broadcast(room, chatMsg);
        log('CHAT', `[${room.code}] ${ws.username}: ${image ? 'image' : text.length + ' chars'}`);
    }

    function onClose(ws) {
        const room = ws.room;
        if (!room) return;
        rooms.remove(room, ws);
        if (ws.username) {
            broadcast(room, { type: 'system', message: ws.username + ' left the room', ts: Date.now() });
            broadcast(room, { type: 'users', users: usersOf(room) });
        }
        log('CHAT', `${ws.username || 'anonymous'} left room ${room.code} (${room.clients.size} remaining)`);
    }

    // Prototype-free so a type like "__proto__" or "constructor" can never resolve to something callable.
    const handlers = Object.assign(Object.create(null), { create: onCreate, join: onJoin, message: onMessage });

    wss.on('connection', (ws) => {
        ws.room = null;
        ws.username = null;
        ws.session = null;
        ws.isAlive = true;
        log('CHAT', 'Client connected');
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('error', (err) => log('CHAT', 'Socket error: ' + err.message));
        ws.on('close', () => onClose(ws));
        ws.on('message', (data) => {
            if (!ctx.limiter.consume(ws.clientIp, 'ws')) return fail(ws, "Slow down! You're sending messages too fast.");
            let msg;
            try { msg = JSON.parse(data); } catch { return fail(ws, 'Invalid message'); }
            const handler = msg && typeof msg === 'object' && typeof msg.type === 'string' ? handlers[msg.type] : undefined;
            if (typeof handler !== 'function') return fail(ws, 'Unknown message type');
            try { handler(ws, msg); }
            catch (err) { log('ERROR', 'Chat handler failed: ' + (err.stack || err.message)); }
        });
    });

    return { rooms };
}

module.exports = { attachChat };
