'use strict';

// ─── JSTube: built-in player (HLS relayed through this server) ───
// yt-dlp resolves a video to YouTube's own HLS ladder (MPEG-TS segments, audio included), which YouTube
// serves for some videos. Its separate DASH streams are deliberately not used: without YouTube's bot
// attestation tokens they stop after about a minute of media, for every quality. Videos with no HLS
// play in the YouTube embed instead (the page falls back on its own).
// Playlists are rewritten so every address points back at this server, which fetches the bytes from
// googlevideo.com, because the addresses YouTube hands out are tied to whoever asked. Only addresses
// that came out of those playlists are ever fetched, and only from googlevideo.com.
//
//   GET /api/tube/player                    which player the page should use
//   GET /api/tube/hls/<id>/master.m3u8      the qualities (up to 720p), pointing at the playlists below
//   GET /api/tube/hls/<id>/v<n>.m3u8        one quality's segment list
//   GET /api/tube/hls/<id>/s<n>-<i>.ts      a media segment
//   GET /api/tube/hls/<id>/i<n>-<j>.bin     an init segment (fragmented-MP4 variants only)

const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('./config');
const { log } = require('./log');
const { sendJson, getClientIp, HttpError } = require('./http');
const ytdlp = require('./ytdlp');

const ROUTE_RE = /^\/api\/tube\/hls\/([A-Za-z0-9_-]{11})\/(?:(master\.m3u8)|v(\d{1,3})\.m3u8|s(\d{1,3})-(\d{1,5})\.ts|i(\d{1,3})-(\d{1,3})\.bin)$/;
const UPSTREAM_HOST_RE = /(^|\.)googlevideo\.com$/i;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_VARIANTS = 64;
const MAX_SEGMENTS = 20000;
const MAX_HEIGHT = 720;                     // plenty inside a 750 px window, and half the bandwidth of 1080p
const PLAYLIST_TIMEOUT_MS = 20000;
const SEGMENT_TIMEOUT_MS = 60000;
const REQUEST_HEADERS = Object.freeze({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
});

const entries = new Map();    // videoId → entry (see resolve)
const pending = new Map();    // videoId → in-flight resolve()
let inFlightResolves = 0;
let inFlightSegments = 0;

function playerMode() {
    if (config.tube.player === 'embed') return 'embed';
    if (config.tube.player === 'native') return ytdlp.canProvide() ? 'native' : 'embed';
    return config.onVercel || !ytdlp.canProvide() ? 'embed' : 'native';
}

function isUpstream(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && UPSTREAM_HOST_RE.test(parsed.hostname);
    } catch { return false; }
}

function absolute(uri, base) {
    try { return new URL(uri, base).href; } catch { return ''; }
}

function getEntry(videoId) {
    const entry = entries.get(videoId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { entries.delete(videoId); return null; }
    return entry;
}

function forget(videoId) { entries.delete(videoId); }

function trimEntries() {
    while (entries.size > config.tube.maxEntries) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
    }
}

// ─── Choosing streams ───

function pickManifest(info) {
    if (typeof info.manifest_url === 'string' && isUpstream(info.manifest_url)) return info.manifest_url;
    for (const format of Array.isArray(info.formats) ? info.formats : []) {
        if (typeof format.manifest_url === 'string' && /m3u8/.test(String(format.protocol)) && isUpstream(format.manifest_url)) return format.manifest_url;
    }
    return null;
}

/** Runs yt-dlp once per video (single-flight) and remembers which streams to relay. */
function resolve(videoId) {
    const cached = getEntry(videoId);
    if (cached) return Promise.resolve(cached);
    if (pending.has(videoId)) return pending.get(videoId);
    if (inFlightResolves >= config.tube.maxInFlightResolves) return Promise.reject(new HttpError(503, 'The player is busy. Try again in a moment.'));

    const promise = (async () => {
        inFlightResolves += 1;
        try {
            const info = await ytdlp.info(videoId);
            if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') throw new HttpError(422, 'Live streams play through the YouTube player.');
            const masterUrl = pickManifest(info);
            if (!masterUrl) throw new HttpError(422, 'YouTube serves no HLS stream for this video; it plays in the YouTube player.');
            const entry = { title: String(info.title || ''), expiresAt: Date.now() + config.tube.entryTtlMs, masterUrl, masterText: null, masterPending: null, variants: [] };
            entries.set(videoId, entry);
            trimEntries();
            return entry;
        } catch (err) {
            if (err instanceof HttpError) throw err;
            log('JSTUBE', `Resolve failed for ${videoId}: ${err.message}`);   // details stay in the log, not in the response
            throw new HttpError(502, 'Could not open this video.');
        } finally {
            inFlightResolves -= 1;
        }
    })().finally(() => pending.delete(videoId));
    pending.set(videoId, promise);
    return promise;
}

// ─── Fetching from YouTube ───

async function readCapped(response, maxBytes) {
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of response.body) {
        text += decoder.decode(chunk, { stream: true });
        if (text.length > maxBytes) throw new HttpError(502, 'The playlist was unexpectedly large');
    }
    return text + decoder.decode();
}

// One log line per (video, status) per minute, so a throttled burst does not flood the log.
const recentFailures = new Map();
function noteUpstreamFailure(key, status, what) {
    const id = String(key).slice(0, 80) + '#' + status;
    const now = Date.now();
    if ((recentFailures.get(id) || 0) > now - 60000) return;
    recentFailures.set(id, now);
    if (recentFailures.size > 500) recentFailures.delete(recentFailures.keys().next().value);
    log('JSTUBE', `YouTube answered HTTP ${status} for a ${what} (${status === 403 ? 'throttled; the player retries' : 'gone'})`);
}

// fetch() that follows redirects only while they stay on googlevideo.com; nothing else is ever requested.
async function fetchUpstream(url, init) {
    let current = url;
    for (let hop = 0; hop < 3; hop++) {
        if (!isUpstream(current)) throw new HttpError(502, 'The stream moved somewhere unexpected');
        const response = await fetch(current, { ...init, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        if (response.body) response.body.cancel().catch(() => {});
        if (!location) throw new HttpError(502, 'YouTube redirected nowhere');
        current = absolute(location, current);
    }
    throw new HttpError(502, 'Too many redirects from YouTube');
}

async function fetchPlaylist(url) {
    let response;
    try { response = await fetchUpstream(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS) }); }
    catch (err) { throw err instanceof HttpError ? err : new HttpError(502, 'Could not reach YouTube for the playlist (' + err.message + ')'); }
    if (!response.ok || !response.body) {
        noteUpstreamFailure(url, response.status, 'playlist');
        throw new HttpError(response.status === 404 || response.status === 410 ? 410 : 502, `YouTube answered HTTP ${response.status} for the playlist`);
    }
    const text = await readCapped(response, MAX_PLAYLIST_BYTES);
    if (!text.startsWith('#EXTM3U')) throw new HttpError(502, 'YouTube returned something that is not a playlist');
    return text;
}

// ─── YouTube HLS: rewriting real playlists ───

// Master playlist: keep the H.264 quality ladder up to 720p and any separate audio renditions, point
// each at v<n>.m3u8, and drop what is not relayed (subtitles, trick-play streams, session keys).
// YouTube serves two shapes: muxed (audio inside each quality) and demuxed (audio in a rendition group).
function rewriteMaster(entry, text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    const variants = [];
    const add = (uri) => { variants.push({ url: uri, text: null, pending: null, segments: null, maps: null }); return `v${variants.length - 1}.m3u8`; };
    const streams = lines.filter(l => l.startsWith('#EXT-X-STREAM-INF:'));
    const hasH264 = streams.some(l => /CODECS="[^"]*avc1/.test(l));
    let qualities = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const next = (lines[i + 1] || '').trim();
            i += 1;
            if (!next || next.startsWith('#')) continue;   // a tag with no address is not a quality
            const uri = absolute(next, entry.masterUrl);
            const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
            if (res && Math.min(Number(res[1]), Number(res[2])) > MAX_HEIGHT) continue;   // "720p" is the short side; portrait videos count too
            if (hasH264 && !/CODECS="[^"]*avc1/.test(line)) continue;   // VP9/AV1 copies of the same ladder: Safari cannot play them
            if (!isUpstream(uri) || variants.length >= MAX_VARIANTS) continue;
            out.push(line.replace(/,SUBTITLES="[^"]*"/, ''));
            out.push(add(uri));
            qualities += 1;
            continue;
        }
        if (line.startsWith('#EXT-X-MEDIA:')) {
            if (!/TYPE=AUDIO/.test(line)) continue;
            const match = /URI="([^"]+)"/.exec(line);
            const uri = match ? absolute(match[1], entry.masterUrl) : '';
            if (!isUpstream(uri) || variants.length >= MAX_VARIANTS) continue;
            out.push(line.replace(/URI="[^"]+"/, `URI="${add(uri)}"`));
            continue;
        }
        if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:') || line.startsWith('#EXT-X-SESSION-KEY:')) continue;
        if (line.startsWith('#')) out.push(line);
        // A bare address outside a STREAM-INF pair is not part of a valid master playlist: dropped.
    }
    if (!qualities) throw new HttpError(502, 'The playlist has no playable qualities');
    entry.variants = variants;
    return out.join('\n') + '\n';
}

// Quality playlist: every segment address becomes s<n>-<i>.ts (init segments i<n>-<j>.bin).
function rewriteVariant(variant, index, text) {
    const segments = [];
    const maps = [];
    const out = [];
    for (let line of text.split(/\r?\n/)) {
        line = line.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/.test(line)) throw new HttpError(422, 'Encrypted streams are not supported');
            if (line.startsWith('#EXT-X-MAP:')) {
                const match = /URI="([^"]+)"/.exec(line);
                const uri = match ? absolute(match[1], variant.url) : '';
                if (!isUpstream(uri) || maps.length >= 16) throw new HttpError(502, 'Unexpected init segment address');
                maps.push(uri);
                out.push(line.replace(/URI="[^"]+"/, `URI="i${index}-${maps.length - 1}.bin"`));
                continue;
            }
            out.push(line);
            continue;
        }
        const uri = absolute(line, variant.url);
        if (!isUpstream(uri)) throw new HttpError(502, 'Unexpected segment address');
        if (segments.length >= MAX_SEGMENTS) throw new HttpError(422, 'This video has too many segments');
        segments.push(uri);
        out.push(`s${index}-${segments.length - 1}.ts`);
    }
    if (!segments.length) throw new HttpError(502, 'The playlist has no segments');
    variant.segments = segments;
    variant.maps = maps;
    return out.join('\n') + '\n';
}

// ─── Playlists ───

async function masterText(videoId) {
    const entry = await resolve(videoId);
    if (entry.masterText) return entry.masterText;
    if (!entry.masterPending) {
        entry.masterPending = fetchPlaylist(entry.masterUrl)
            .then((text) => { entry.masterText = rewriteMaster(entry, text); return entry.masterText; })
            .catch((err) => { if (err.status === 410) forget(videoId); throw err; })
            .finally(() => { entry.masterPending = null; });
    }
    return entry.masterPending;
}

async function variantText(videoId, entry, index) {
    const variant = entry.variants[index];
    if (!variant) throw new HttpError(404, 'Unknown quality');
    if (variant.text) return variant.text;
    if (!variant.pending) {
        variant.pending = fetchPlaylist(variant.url)
            .then((text) => { variant.text = rewriteVariant(variant, index, text); return variant.text; })
            .catch((err) => { if (err.status === 410) forget(videoId); throw err; })
            .finally(() => { variant.pending = null; });
    }
    return variant.pending;
}

function sendPlaylist(req, res, text) {
    res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : text);
}

// ─── Media bytes ───

// Streams one segment (or byte range of a stream) from YouTube to the viewer and stops when the viewer leaves.
async function proxySegment(req, res, url, contentType, videoId) {
    if (inFlightSegments >= config.tube.maxInFlightSegments) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '2', 'Cache-Control': 'no-store' });
        return res.end('Busy');
    }
    inFlightSegments += 1;
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.on('close', onClose);
    try {
        const headers = { ...REQUEST_HEADERS };
        if (typeof req.headers.range === 'string') headers.Range = req.headers.range;
        let upstream;
        for (let attempt = 0; ; attempt++) {
            try { upstream = await fetchUpstream(url, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEGMENT_TIMEOUT_MS)]) }); }
            catch (err) {
                if (abort.signal.aborted) return;
                throw err instanceof HttpError ? err : new HttpError(502, 'Could not reach YouTube for the segment (' + err.message + ')');
            }
            // YouTube throttles bursts of range requests with a 403 that clears within a moment: try once more.
            if (upstream.status !== 403 || attempt >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 400));
            if (abort.signal.aborted) return;
        }
        if (upstream.status !== 200 && upstream.status !== 206) {
            // 404/410: the addresses are gone, so the next play must resolve afresh. A 403 inside the entry's
            // lifetime is YouTube throttling a burst of requests; the player retries it on its own.
            if (upstream.status === 404 || upstream.status === 410) forget(videoId);
            noteUpstreamFailure(videoId, upstream.status, 'segment');
            throw new HttpError(502, `YouTube answered HTTP ${upstream.status} for the segment`, { 'Retry-After': '1' });
        }
        const outHeaders = { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
        const length = upstream.headers.get('content-length');
        if (length && !upstream.headers.get('content-encoding')) outHeaders['Content-Length'] = length;
        const contentRange = upstream.headers.get('content-range');
        if (contentRange) outHeaders['Content-Range'] = contentRange;
        if (res.destroyed) { abort.abort(); return; }
        res.writeHead(upstream.status, outHeaders);
        if (req.method === 'HEAD' || !upstream.body) { abort.abort(); return res.end(); }
        await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (err) {
        if (res.destroyed || abort.signal.aborted) return;   // the viewer went away mid-segment
        if (res.headersSent) { res.destroy(); return; }
        throw err instanceof HttpError ? err : new HttpError(502, 'Could not fetch the video segment');
    } finally {
        inFlightSegments -= 1;
        res.off('close', onClose);
    }
}

// ─── Routing ───

/** Handles /api/tube/* requests. Returns false when the URL is not one of them. */
async function handleTube(req, res, url, ctx) {
    if (url.pathname === '/api/tube/player') {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new HttpError(405, 'Method not allowed'); }
        sendJson(res, 200, { mode: playerMode() });
        return true;
    }
    const match = ROUTE_RE.exec(url.pathname);
    if (!match) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, 'Method not allowed'); }
    if (playerMode() !== 'native') throw new HttpError(404, 'The built-in player is off on this server');
    // Other websites must not embed this relay in their own players (browsers label such requests cross-site).
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'The built-in player only serves JS OS pages');

    const videoId = match[1];
    if (match[2]) {   // master.m3u8
        // Opening a video runs yt-dlp, so that is what the budget counts; re-reads of an open video are free.
        if (!getEntry(videoId) && !ctx.limiter.consume(getClientIp(req), 'tube')) throw new HttpError(429, 'Too many videos opened at once. Try again in a minute.');
        const text = await masterText(videoId);
        log('JSTUBE', `Playing ${videoId} through the built-in player`);
        sendPlaylist(req, res, text);
        return true;
    }
    const entry = getEntry(videoId);
    if (!entry || !entry.masterText) throw new HttpError(404, 'This video is not open. Play it again.');

    if (match[3] !== undefined) {   // v<n>.m3u8
        sendPlaylist(req, res, await variantText(videoId, entry, Number(match[3])));
        return true;
    }
    if (match[4] !== undefined) {   // s<n>-<i>.ts
        const variant = entry.variants[Number(match[4])];
        const segment = variant && variant.segments && variant.segments[Number(match[5])];
        if (!segment) throw new HttpError(404, 'Unknown segment');
        await proxySegment(req, res, segment, 'video/mp2t', videoId);
        return true;
    }
    const variant = entry.variants[Number(match[6])];   // i<n>-<j>.bin
    const init = variant && variant.maps && variant.maps[Number(match[7])];
    if (!init) throw new HttpError(404, 'Unknown init segment');
    await proxySegment(req, res, init, 'video/mp4', videoId);
    return true;
}

/** Warms up the extractor at startup so the first video does not wait for a download. */
function prepare() {
    if (playerMode() !== 'native') return;
    ytdlp.ensure()
        .then((file) => log('JSTUBE', 'Built-in player ready (yt-dlp: ' + file + ')'))
        .catch((err) => log('JSTUBE', 'Built-in player unavailable, JSTube will use the YouTube player: ' + err.message));
}

function status() {
    return { player: playerMode(), open: entries.size, streaming: inFlightSegments, ytdlp: ytdlp.status() };
}

module.exports = { handleTube, prepare, status, playerMode };
