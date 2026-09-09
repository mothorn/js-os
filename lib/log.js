'use strict';

// ─── Logger (pretty for terminals, JSON for hosted logs) ───

const config = require('./config');

const ANSI = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m',
    red: '\x1b[31m', magenta: '\x1b[35m', white: '\x1b[37m', gray: '\x1b[90m',
};

const COLORS = {
    SERVER: ANSI.green, HTTP: ANSI.gray, WS: ANSI.cyan, CHAT: ANSI.yellow,
    CALL: ANSI.magenta, JSTUBE: ANSI.cyan, AI: ANSI.cyan, ERROR: ANSI.red,
};

// User-supplied text never gets to inject newlines or escape codes into the log.
function clean(text) {
    return String(text).replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')).slice(0, 1000);
}

function log(category, msg, data) {
    const safeMsg = clean(msg);
    if (config.logFormat === 'json') {
        const entry = { time: new Date().toISOString(), level: category === 'ERROR' ? 'error' : 'info', category, msg: safeMsg };
        if (data !== undefined) entry.data = data;
        console.log(JSON.stringify(entry));
        return;
    }
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const color = COLORS[category] || ANSI.white;
    const prefix = `${ANSI.dim}${time}${ANSI.reset} ${color}${ANSI.bold}${category.padEnd(6)}${ANSI.reset} ${ANSI.dim}│${ANSI.reset}`;
    if (data !== undefined) console.log(`${prefix} ${safeMsg}`, data);
    else console.log(`${prefix} ${safeMsg}`);
}

module.exports = { log, ANSI };
