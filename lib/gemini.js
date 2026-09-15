'use strict';

// ─── Google Gemini: streaming chat proxy ───
// The browser never sees the API key. Answers are relayed as Server-Sent Events:
//   data: {"content": "..."}   a chunk of the answer
//   data: {"notice": "..."}    the model stopped early (safety filter, length, ...)
//   data: {"error": "..."}     the request failed
//   data: [DONE]

const config = require('./config');
const { log } = require('./log');
const { HttpError } = require('./http');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

const pkg = require('../package.json');

// What the model may say about JS OS. Everything here is true of this build, and the model is told not
// to go beyond it, so it cannot describe features, history or versions that never existed.
function systemInstruction() {
    const today = new Date().toISOString().slice(0, 10);
    return [
        `You are JS AI, the assistant built into JS OS. Today's date is ${today}.`,
        'Facts about JS OS you may rely on. Do not invent history, authors, versions or features beyond these:',
        `- JS OS is a web app styled like a retro Windows 2000 desktop, currently version ${pkg.version}. It runs in the browser, ` +
            'is served by a small Node.js server, installs as a progressive web app, and works on phones.',
        '- Its apps are JS Chat (chat rooms joined with a 6-character code, with image sharing), ' +
            `JS AI (you, powered by Google's ${config.gemini.model} model), JSTube (search and watch YouTube videos), ` +
            'and JS Call (voice calls between browsers, joined with a room code).',
        '- There are no user accounts. Chat rooms are not kept after everyone leaves; JS AI conversations are stored only in the browser.',
        '- JS OS is current and actively maintained, not an old or discontinued project.',
        '- If asked about JS OS beyond these facts, say you do not know rather than guessing.',
        'Be helpful, accurate and concise. Answer in Markdown: use headings, bullet or numbered lists, **bold**, *italics*, ' +
            '`inline code`, links, simple tables, and fenced code blocks tagged with the language whenever you show code.',
    ].join('\n');
}

const STOP_REASONS = {
    SAFETY: 'The answer was stopped by Gemini safety filters.',
    RECITATION: 'The answer was stopped because it repeated copyrighted material.',
    PROHIBITED_CONTENT: 'The answer was blocked as prohibited content.',
    BLOCKLIST: 'The answer was blocked by a content blocklist.',
    SPII: 'The answer was blocked because it contained sensitive personal information.',
    MALFORMED_FUNCTION_CALL: 'The model produced an invalid tool call.',
    MAX_TOKENS: 'The answer reached the maximum length.',
    OTHER: 'The answer was stopped by Gemini.',
};

// The most recent upstream failure, so /api/ai/status can report a key or model problem.
let lastFailure = null;

function status() {
    const model = config.gemini.model;
    if (!config.gemini.apiKey) return { status: 'missing-key', model };
    if (lastFailure && Date.now() - lastFailure.at < 60000) return { status: 'error', model, reason: lastFailure.reason };
    return { status: 'ok', model };
}

// Validates the client's [{role, content}] list and converts it to Gemini "contents".
function toContents(messages) {
    if (!Array.isArray(messages) || !messages.length) throw new HttpError(400, 'messages array required');
    const { maxMessages, maxMessageChars, maxTotalChars } = config.gemini;

    const contents = [];
    for (const m of messages.slice(-maxMessages)) {
        if (!m || typeof m !== 'object' || typeof m.content !== 'string') continue;
        const role = m.role === 'assistant' ? 'model' : m.role === 'user' ? 'user' : null;
        if (!role) continue;
        const text = m.content.trim().slice(0, maxMessageChars);
        if (!text) continue;
        const last = contents[contents.length - 1];
        if (last && last.role === role) last.parts[0].text += '\n\n' + text;   // Gemini requires alternating roles
        else contents.push({ role, parts: [{ text }] });
    }

    let total = contents.reduce((sum, c) => sum + c.parts[0].text.length, 0);
    while (contents.length > 1 && total > maxTotalChars) total -= contents.shift().parts[0].text.length;
    while (contents.length && contents[0].role !== 'user') contents.shift();

    if (!contents.length || contents[contents.length - 1].role !== 'user') {
        throw new HttpError(400, 'The last message must come from the user');
    }
    return contents;
}

function describeUpstreamError(response, bodyText) {
    let detail = '';
    try { detail = JSON.parse(bodyText)?.error?.message || ''; } catch { /* not JSON */ }
    switch (response.status) {
        case 400: return detail ? 'Gemini rejected the request: ' + detail.slice(0, 200) : 'Gemini rejected the request.';
        case 401:
        case 403: return 'The Gemini API key was rejected. Check GEMINI_API_KEY on the server.';
        case 404: return `The model "${config.gemini.model}" is not available for this API key. Set GEMINI_MODEL to a current model.`;
        case 429: return 'Gemini is rate limiting requests right now. Try again in a moment.';
        case 503: return 'Gemini is temporarily overloaded. Try again in a moment.';
        default: return `Gemini error ${response.status}${detail ? ': ' + detail.slice(0, 200) : ''}`;
    }
}

async function streamChat(messages, req, res) {
    if (!config.gemini.apiKey) throw new HttpError(503, 'The Gemini API key is not configured on the server');
    const contents = toContents(messages);   // throws HttpError(400) before any headers are sent

    const controller = new AbortController();
    const abortOnClose = () => controller.abort();
    res.on('close', abortOnClose);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.gemini.timeoutMs)]);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const emit = (payload) => { if (!res.destroyed) res.write('data: ' + JSON.stringify(payload) + '\n\n'); };
    // SSE comments keep proxies from closing a slow-to-start answer.
    const keepAlive = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 15000);

    log('AI', `Chat: ${contents.length} turns, model=${config.gemini.model}`);
    let chars = 0;
    let stopNotice = null;

    // One "data:" line from Gemini's stream.
    const handleLine = (rawLine) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let event;
        try { event = JSON.parse(payload); } catch { return; }

        if (event.error) throw new Error(event.error.message || 'Gemini returned an error');
        const blockReason = event.promptFeedback?.blockReason;
        if (blockReason) throw new Error('The request was blocked by Gemini safety filters (' + blockReason + ').');

        const candidate = event.candidates?.[0];
        if (!candidate) return;
        const text = (candidate.content?.parts || [])
            .filter(part => typeof part.text === 'string' && !part.thought)
            .map(part => part.text)
            .join('');
        if (text) { chars += text.length; emit({ content: text }); }
        const reason = candidate.finishReason;
        if (reason && reason !== 'STOP' && STOP_REASONS[reason]) stopNotice = STOP_REASONS[reason];
    };

    try {
        const upstream = await fetch(API_BASE + encodeURIComponent(config.gemini.model) + ':streamGenerateContent?alt=sse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
            body: JSON.stringify({ systemInstruction: { parts: [{ text: systemInstruction() }] }, contents }),
            signal,
        });

        if (!upstream.ok) {
            const bodyText = await upstream.text().catch(() => '');
            const message = describeUpstreamError(upstream, bodyText);
            if ([401, 403, 404].includes(upstream.status)) lastFailure = { at: Date.now(), reason: message };
            throw new Error(message);
        }

        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of upstream.body) {
            if (res.destroyed) break;
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) handleLine(line);
        }
        buffer += decoder.decode();
        if (buffer.trim()) handleLine(buffer);   // a final event without a trailing newline

        if (stopNotice) emit({ notice: stopNotice });
        lastFailure = null;
        log('AI', `Chat response completed (${chars} chars)`);
    } catch (err) {
        if (res.destroyed) {
            log('AI', 'Client disconnected mid-answer');
        } else if (signal.aborted && signal.reason && signal.reason.name === 'TimeoutError') {
            emit({ error: 'Gemini took too long to answer. Try again.' });
            log('AI', 'Chat timed out');
        } else {
            emit({ error: err.message || 'Gemini request failed' });
            log('AI', 'Chat error: ' + err.message);
        }
    } finally {
        clearInterval(keepAlive);
        res.off('close', abortOnClose);
        if (!res.destroyed) { res.write('data: [DONE]\n\n'); res.end(); }
    }
}

module.exports = { status, streamChat };
