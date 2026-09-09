'use strict';

// ─── Rate limiting (token buckets per key) and connection accounting ───

const config = require('./config');

const MAX_BUCKETS = 50000;   // forged identities cannot grow the map without bound

class RateLimiter {
    constructor(configs = config.limits.rate) {
        this.configs = configs;
        this.buckets = new Map();
        // Forget buckets that have been idle for 10 minutes. unref() so the timer never keeps the process alive.
        this._gc = setInterval(() => {
            const cutoff = Date.now() - 10 * 60 * 1000;
            for (const [key, bucket] of this.buckets) {
                if (bucket.lastAccess < cutoff) this.buckets.delete(key);
            }
        }, 5 * 60 * 1000);
        this._gc.unref();
    }

    /** Returns true when the caller may proceed, false when the bucket for (key, type) is empty. */
    consume(key, type) {
        const cfg = this.configs[type];
        if (!cfg) return true;
        const id = key + ':' + type;
        const now = Date.now();
        let bucket = this.buckets.get(id);
        if (!bucket) {
            if (this.buckets.size >= MAX_BUCKETS) return true;
            bucket = { tokens: cfg.max, lastRefill: now, lastAccess: now };
            this.buckets.set(id, bucket);
        }
        const elapsedSec = (now - bucket.lastRefill) / 1000;
        bucket.tokens = Math.min(cfg.max, bucket.tokens + elapsedSec * cfg.refillPerSec);
        bucket.lastRefill = now;
        bucket.lastAccess = now;
        if (bucket.tokens >= 1) { bucket.tokens -= 1; return true; }
        return false;
    }

    destroy() { clearInterval(this._gc); }
}

class ConnectionTracker {
    constructor() {
        this.total = 0;
        this.perIp = new Map();
    }

    add(ip) {
        this.total += 1;
        this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);
    }

    remove(ip) {
        this.total = Math.max(0, this.total - 1);
        const count = (this.perIp.get(ip) || 1) - 1;
        if (count <= 0) this.perIp.delete(ip);
        else this.perIp.set(ip, count);
    }

    canConnect(ip) {
        if (this.total >= config.limits.maxConnections) return { ok: false, reason: 'Server at capacity' };
        if ((this.perIp.get(ip) || 0) >= config.limits.maxPerIp) return { ok: false, reason: 'Too many connections from your IP' };
        return { ok: true };
    }
}

module.exports = { RateLimiter, ConnectionTracker };
