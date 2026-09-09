'use strict';

// ─── JSTube: YouTube search ───
// Reads the public search results page and extracts the embedded result data,
// so no YouTube API key is needed. YouTube can change that page at any time;
// when it does, searches fail with a clear error instead of bad data.

const SEARCH_URL = 'https://www.youtube.com/results?search_query=';
const VIDEOS_ONLY_FILTER = '&sp=EgIQAQ%3D%3D';
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_RESULTS = 20;
const MAX_DEPTH = 60;
const MAX_PAGE_CHARS = 4 * 1024 * 1024;   // result pages are 1-2 MB; anything bigger is not a results page
const MAX_IN_FLIGHT = 8;

let inFlight = 0;

function text(node) {
    if (!node) return '';
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map(run => run.text || '').join('');
    return '';
}

// Results are nested differently over time; walk the tree and collect every videoRenderer.
function collectVideos(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || out.length >= MAX_RESULTS) return;
    if (Array.isArray(node)) {
        for (const item of node) collectVideos(item, out, depth + 1);
        return;
    }
    if (node.videoRenderer && typeof node.videoRenderer === 'object') out.push(node.videoRenderer);
    for (const key of Object.keys(node)) {
        if (key === 'videoRenderer') continue;
        const value = node[key];
        if (value && typeof value === 'object') collectVideos(value, out, depth + 1);
    }
}

function extractInitialData(html) {
    const match = html.match(/ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s);
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch { return null; }
}

function isLive(video) {
    return (video.thumbnailOverlays || []).some(o => o.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE')
        || (video.badges || []).some(b => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW');
}

async function readPage(response) {
    const decoder = new TextDecoder();
    let html = '';
    for await (const chunk of response.body) {
        html += decoder.decode(chunk, { stream: true });
        if (html.length > MAX_PAGE_CHARS) throw new Error('the results page was unexpectedly large');
    }
    return html + decoder.decode();
}

async function searchVideos(query) {
    if (inFlight >= MAX_IN_FLIGHT) throw new Error('too many searches at once, try again in a moment');
    inFlight += 1;
    try {
        const response = await fetch(SEARCH_URL + encodeURIComponent(query) + VIDEOS_ONLY_FILTER, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': 'SOCS=CAI; CONSENT=YES+1',   // skips the EU consent interstitial
            },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('YouTube responded with HTTP ' + response.status);

        const data = extractInitialData(await readPage(response));
        if (!data) throw new Error('could not read the results page (YouTube changed its format)');

        const videos = [];
        collectVideos(data.contents, videos, 0);
        return videos
            .filter(v => typeof v.videoId === 'string' && VIDEO_ID_RE.test(v.videoId))
            .map(v => ({
                videoId: v.videoId,
                title: text(v.title),
                channel: text(v.ownerText) || text(v.longBylineText),
                views: text(v.viewCountText) || text(v.shortViewCountText),
                published: text(v.publishedTimeText),
                duration: text(v.lengthText) || (isLive(v) ? 'LIVE' : ''),
                thumbnail: 'https://i.ytimg.com/vi/' + v.videoId + '/mqdefault.jpg',
            }))
            .slice(0, MAX_RESULTS);
    } finally {
        inFlight -= 1;
    }
}

module.exports = { searchVideos };
