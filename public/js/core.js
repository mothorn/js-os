// ═══════════════════════════════════════════════════════════
//  JS OS — core: logger, helpers, sounds, notifications, window manager, BaseApp
//  Load order: config.js → core.js → clients.js → apps/*.js → desktop.js
// ═══════════════════════════════════════════════════════════

'use strict';

// ─── Logger ───
class Logger {
    constructor(level) {
        this._level = level;
        this._startTime = Date.now();
    }

    set level(value) { this._level = typeof value === 'string' ? (Logger.LEVELS[value.toUpperCase()] ?? 0) : value; }
    get level() { return this._level; }

    _format(category) {
        const elapsed = ((Date.now() - this._startTime) / 1000).toFixed(2);
        return [`%c[${elapsed}s] [${category}]`, `color: ${Logger.COLORS[category] || '#888'}; font-weight: bold`];
    }

    debug(category, ...args) { if (this._level <= 0) console.debug(...this._format(category), ...args); }
    info(category, ...args) { if (this._level <= 1) console.info(...this._format(category), ...args); }
    warn(category, ...args) { if (this._level <= 2) console.warn(...this._format(category), ...args); }
    error(category, ...args) { if (this._level <= 3) console.error(...this._format(category), ...args); }
}
// Assigned after the class so older Safari versions (no static class fields) can still parse this file.
Logger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, OFF: 4 };
Logger.COLORS = {
    DESKTOP: '#F7DF1E', WINDOW: '#c9b518', SOUND: '#c678dd', NOTIFY: '#61afef',
    CHAT: '#98c379', CALL: '#56b6c2', AI: '#e06c75', JSTUBE: '#c97a7a',
    WS: '#e0e0e0', WEBRTC: '#c678dd', IMAGE: '#F7DF1E', APP: '#F7DF1E',
};

// Global logger. Run `log.level = 'debug'` in the console for verbose output.
const log = new Logger(Logger.LEVELS.INFO);

// ─── Helpers ───
const $ = (id) => document.getElementById(id);
const appName = (key, fallback) => (window.JSOS_CONFIG && window.JSOS_CONFIG[key]) || fallback;
const isPhoneLayout = () => window.matchMedia('(max-width: 768px)').matches;
const isTouchDevice = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const USERNAME_RE = /^[a-zA-Z0-9_ -]{1,20}$/;
const ROOM_CODE_RE = /^[A-Z2-9]{6}$/;
const USERNAME_HINT = 'Username must be 1-20 characters: letters, numbers, spaces, _ or -';
const ROOM_CODE_HINT = 'Room codes are 6 characters: letters A-Z (no I or O) and digits 2-9';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Copies text to the clipboard; falls back to the legacy command on plain-HTTP pages.
async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch { return false; }
}

function formatTime(timestamp) {
    return new Date(timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── SoundManager ───
class SoundManager {
    constructor() {
        this.sounds = { startup: $('sound-startup'), notify: $('sound-message'), window: $('sound-window') };
        this.unlocked = false;
    }

    /** Call from a user gesture: plays each effect muted once so phones allow later playback. */
    unlock() {
        if (this.unlocked) return;
        this.unlocked = true;
        for (const [name, el] of Object.entries(this.sounds)) {
            if (!el || name === 'startup') continue;
            el.muted = true;
            const playing = el.play();
            if (playing && playing.then) {
                playing.then(() => { el.pause(); el.currentTime = 0; el.muted = false; }).catch(() => { el.muted = false; });
            } else {
                el.muted = false;
            }
        }
    }

    play(name) {
        const el = this.sounds[name];
        if (!el) { log.warn('SOUND', 'Unknown sound:', name); return; }
        try { el.currentTime = 0; } catch { /* not loaded yet */ }
        const playing = el.play();
        if (playing && playing.catch) playing.catch(() => {});
        log.debug('SOUND', 'Playing:', name);
    }
}

// ─── NotificationManager ───
class NotificationManager {
    constructor() {
        this.registration = null;
        this.supported = 'Notification' in window;
        this.pageVisible = document.visibilityState === 'visible';
        document.addEventListener('visibilitychange', () => { this.pageVisible = document.visibilityState === 'visible'; });
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js')
                .then(() => log.info('NOTIFY', 'Service worker registered'))
                .catch((err) => log.warn('NOTIFY', 'Service worker not registered:', err.message));
            // Only an active worker can show notifications; `ready` resolves once there is one.
            navigator.serviceWorker.ready.then((reg) => { this.registration = reg; }).catch(() => {});
        }
    }

    /** Call from a click or key handler: browsers only honour the request inside a user gesture. */
    requestPermission() {
        if (!this.supported || Notification.permission !== 'default') return;
        try {
            const result = Notification.requestPermission();
            if (result && result.then) {
                result.then((state) => log.info('NOTIFY', 'Permission:', state))
                    .catch((err) => log.warn('NOTIFY', 'Permission request rejected:', err.message));
            }
        } catch (err) { log.warn('NOTIFY', err.message); }
    }

    notify(title, body, tag) {
        if (!this.supported || this.pageVisible || Notification.permission !== 'granted') return;
        // renotify: a new message must alert again instead of silently replacing the previous one.
        const options = { body, tag, renotify: true, icon: 'images/icon-192.png', badge: 'images/icon-192.png' };
        if (this.registration && this.registration.active) {
            this.registration.showNotification(title, options).catch(() => {});
        } else {
            try { new Notification(title, options); } catch { /* not available here */ }
        }
        log.debug('NOTIFY', 'Sent:', title, '-', body);
    }

    chatMessage(username, text) { this.notify(appName('chat', 'JS Chat'), username + ': ' + text, 'chat'); }
}

// ─── WindowManager: open/close animations with a timeout fallback so promises always settle ───
class WindowManager {
    constructor() {
        this.windows = new Map();
    }

    register(id, el) { this.windows.set(id, el); }

    _el(id) {
        const el = this.windows.get(id);
        if (!el) log.warn('WINDOW', 'Unknown window:', id);
        return el;
    }

    isOpen(id) {
        const el = this.windows.get(id);
        return Boolean(el) && !el.hidden;
    }

    open(id) {
        const el = this._el(id);
        if (!el) return;
        el.classList.remove('closing', 'opening-slow');
        el.hidden = false;
        el.classList.add('opening');
        this.afterAnimation(el, 350).then(() => el.classList.remove('opening'));
        log.info('WINDOW', 'Opened:', id);
    }

    close(id) {
        const el = this._el(id);
        if (!el || el.hidden) return Promise.resolve();
        el.classList.remove('opening', 'opening-slow');
        el.classList.add('closing');
        return this.afterAnimation(el, 250).then(() => {
            el.hidden = true;
            el.classList.remove('closing');
            log.info('WINDOW', 'Closed:', id);
        });
    }

    /** Resolves when the element's own animation ends, or after a fallback delay (reduced motion, no animation). */
    afterAnimation(el, fallbackMs) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (event) => {
                if (event && event.target !== el) return;   // ignore animations of children
                if (done) return;
                done = true;
                el.removeEventListener('animationend', finish);
                resolve();
            };
            el.addEventListener('animationend', finish);
            setTimeout(finish, fallbackMs + 100);
        });
    }
}

// ─── BaseApp: every JS OS app extends this ───
class BaseApp {
    constructor(desktop, windowId, iconId) {
        this.desktop = desktop;
        this.windowEl = $(windowId);
        this.iconEl = $(iconId);
        this.name = windowId.replace('-window', '');
        this.running = false;
        log.debug('APP', 'Created:', this.name);

        this.iconEl.addEventListener('click', () => this.desktop.launchApp(this.name));
        this.iconEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.desktop.launchApp(this.name); }
        });
        this.windowEl.querySelector('[data-action="close"]').addEventListener('click', () => this.desktop.closeApp(this.name));
        this.windowEl.querySelector('[data-action="minimize"]').addEventListener('click', () => this.desktop.minimizeApp(this.name));
        this.windowEl.querySelector('[data-action="maximize"]').addEventListener('click', () => this.desktop.toggleMaximize(this.name));
    }

    /** The window was opened fresh (first launch, or after a close). */
    onLaunch() {}
    /** The window came back after being minimized; the app kept running meanwhile. */
    onRestore() {}
    /** The window is being minimized; the app keeps running. */
    onMinimize() {}
    /** The window is closing: disconnect and reset. */
    onClose() {}
    /** The window was maximized, restored, or the viewport changed. */
    onLayoutChange() {}
}
