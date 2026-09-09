'use strict';

// ─── JSON API ───
//   GET  /health          server stats
//   GET  /api/search?q=   JSTube search
//   GET  /api/ai/status   is JS AI configured, and with which model
//   POST /api/ai/chat     streaming Gemini answer (Server-Sent Events)

const config = require('./config');
const { log } = require('./log');
const { sendJson, readJsonBody, isAllowedOrigin, getClientIp, HttpError } = require('./http');
const gemini = require('./gemini');
const { searchVideos } = require('./youtube');

const routes = {
    '/health': {
        GET(req, res, url, ctx) {
            const memory = process.memoryUsage();
            sendJson(res, 200, {
                status: 'ok',
                uptime: Math.floor(process.uptime()),
                instance: ctx.instanceId,
                ...ctx.stats(),
                memory: { rss: Math.round(memory.rss / 1048576) + 'MB', heap: Math.round(memory.heapUsed / 1048576) + 'MB' },
                gemini: gemini.status().status,
            });
        },
    },

    '/api/search': {
        async GET(req, res, url, ctx) {
            const query = (url.searchParams.get('q') || '').trim();
            if (!query) throw new HttpError(400, 'Missing q parameter');
            if (query.length > config.limits.maxSearchQuery) throw new HttpError(400, 'Query too long');
            if (!ctx.limiter.consume(getClientIp(req), 'search')) throw new HttpError(429, 'Too many searches. Try again in a minute.');
            log('JSTUBE', `Searching (${query.length} chars)`);
            let results;
            try { results = await searchVideos(query); }
            catch (err) {
                log('JSTUBE', 'Search error: ' + err.message);
                throw new HttpError(502, 'YouTube search failed: ' + err.message);
            }
            log('JSTUBE', `Found ${results.length} results`);
            sendJson(res, 200, results);
        },
    },

    '/api/ai/status': {
        GET(req, res) { sendJson(res, 200, gemini.status()); },
    },

    '/api/ai/chat': {
        async POST(req, res) {
            // Only our own pages may spend the Gemini key: a JSON content type forces browsers
            // to preflight cross-site requests, and the Origin check refuses foreign pages outright.
            const contentType = String(req.headers['content-type'] || '');
            if (!contentType.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
            if (!isAllowedOrigin(req)) throw new HttpError(403, 'Cross-origin requests are not allowed');
            const body = await readJsonBody(req, config.limits.maxBodyBytes);
            await gemini.streamChat(body && body.messages, req, res);
        },
    },
};

/** Handles API routes. Returns false when the URL is not an API route. */
async function handleApi(req, res, url, ctx) {
    const route = routes[url.pathname];
    if (!route) {
        if (!url.pathname.startsWith('/api/')) return false;
        sendJson(res, 404, { error: 'Not found' });
        return true;
    }
    try {
        const handler = route[req.method];
        if (!handler) {
            res.setHeader('Allow', Object.keys(route).join(', '));
            throw new HttpError(405, 'Method not allowed');
        }
        await handler(req, res, url, ctx);
    } catch (err) {
        if (res.headersSent) { res.end(); return true; }
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) log('ERROR', `${req.method} ${url.pathname}: ${err.stack || err.message}`);
        sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
    return true;
}

module.exports = { handleApi };
