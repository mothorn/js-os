'use strict';

// ─── Rooms and usernames (in memory, single process) ───
// Chat rooms and call rooms share one code space so a code always means one thing.
// Usernames only need to be unique inside a room.

const crypto = require('crypto');
const config = require('./config');
const { log } = require('./log');

const usedCodes = new Set();

function generateCode() {
    const chars = config.roomCodeChars;
    for (let attempt = 0; attempt < 100; attempt++) {
        let code = '';
        for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
        if (!usedCodes.has(code)) return code;
    }
    return null;
}

function validateUsername(name) {
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'Username is required' };
    const trimmed = name.trim();
    if (!config.usernameRe.test(trimmed)) {
        return { ok: false, error: 'Username must be 1-20 characters: letters, numbers, spaces, _ or -' };
    }
    return { ok: true, value: trimmed };
}

function parseRoomCode(code) {
    if (typeof code !== 'string') return null;
    const upper = code.trim().toUpperCase();
    return config.roomCodeRe.test(upper) ? upper : null;
}

function messageSize(message) {
    return (message.message ? message.message.length : 0) + (message.image ? message.image.length : 0);
}

class Room {
    constructor(kind, code) {
        this.kind = kind;
        this.code = code;
        this.clients = new Set();
        this.messages = [];          // chat history, capped by count and bytes
        this.historyBytes = 0;
        this.createdAt = Date.now();
        this._deleteTimer = null;
    }

    /** The client currently holding a username, if any. */
    findByName(name) {
        const lower = name.toLowerCase();
        for (const client of this.clients) {
            if (client.username && client.username.toLowerCase() === lower) return client;
        }
        return null;
    }

    remember(message) {
        this.messages.push(message);
        this.historyBytes += messageSize(message);
        while (this.messages.length > 1 &&
               (this.messages.length > config.limits.historyCap || this.historyBytes > config.limits.historyBytesCap)) {
            this.historyBytes -= messageSize(this.messages.shift());
        }
    }
}

class RoomRegistry {
    constructor(kind) {
        this.kind = kind;
        this.rooms = new Map();
        this._logCategory = kind === 'chat' ? 'CHAT' : 'CALL';
    }

    get size() { return this.rooms.size; }

    get(code) { return this.rooms.get(code) || null; }

    /** Creates a room, or returns null when the server is at room capacity. */
    create() {
        if (usedCodes.size >= config.limits.maxRooms) return null;
        const code = generateCode();
        if (!code) return null;
        usedCodes.add(code);
        const room = new Room(this.kind, code);
        this.rooms.set(code, room);
        return room;
    }

    add(room, ws) {
        if (room._deleteTimer) { clearTimeout(room._deleteTimer); room._deleteTimer = null; }
        room.clients.add(ws);
        ws.room = room;
    }

    remove(room, ws) {
        room.clients.delete(ws);
        ws.room = null;
        if (room.clients.size === 0 && !room._deleteTimer) {
            // Keep an empty room briefly so a client whose socket dropped can rejoin it.
            room._deleteTimer = setTimeout(() => this._delete(room), config.limits.emptyRoomGraceMs);
            room._deleteTimer.unref();
        }
    }

    /**
     * Frees a username held by a socket that is really the same person (same session token)
     * or that has stopped answering, so a reconnecting client can take its own name back.
     * Returns false when a live, different client holds the name.
     */
    reclaimName(room, name, session) {
        const holder = room.findByName(name);
        if (!holder) return true;
        const sameSession = Boolean(session) && holder.session === session;
        const dead = holder.readyState !== 1 || holder.isAlive === false;
        if (!sameSession && !dead) return false;
        this.remove(room, holder);
        try { holder.terminate(); } catch { /* already gone */ }
        log(this._logCategory, `Replaced ${dead ? 'unresponsive' : 'previous'} socket for ${name} in ${room.code}`);
        return true;
    }

    _delete(room) {
        room._deleteTimer = null;
        if (room.clients.size > 0) return;
        this.rooms.delete(room.code);
        usedCodes.delete(room.code);
        log(this._logCategory, `Room ${room.code} deleted (empty) — ${this.rooms.size} active`);
    }
}

function newSession() { return crypto.randomUUID(); }

module.exports = { RoomRegistry, validateUsername, parseRoomCode, newSession };
