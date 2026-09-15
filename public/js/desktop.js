// ═══════════════════════════════════════════════════════════
//  JS OS — Desktop: boots the OS and manages windows, apps, dialogs and PWA install
//  Either the explorer or exactly one app window is visible; minimized apps keep running.
// ═══════════════════════════════════════════════════════════

'use strict';

const JSOS_VERSION = '4.1.0';

const HELP_TEXT = {
    'help-chat': {
        title: 'JS Chat Help',
        html: '<p>Enter a name and <strong>Create Room</strong>, then share the 6-character code so friends can <strong>Join Room</strong>. Names must be unique within a room.</p>' +
              '<p>Click the room code to copy it. Paste an image or use the picture button to share one. If the connection drops, JS Chat reconnects on its own.</p>',
    },
    'help-call': {
        title: 'JS Call Help',
        html: '<p>Enter a name and <strong>Create Call</strong>, then share the code. Joining needs microphone permission.</p>' +
              '<p>Audio goes directly between browsers (WebRTC); when this server has a TURN relay set up, it takes over if a network blocks the direct path. Voice calls need an HTTPS address unless you are on localhost. Use <strong>Mute</strong> to silence your microphone.</p>',
    },
    'about': {
        title: 'About JS OS',
        html: '<p><strong>JS OS</strong> v' + JSOS_VERSION + '</p>' +
              '<p>A retro Windows 2000-style web desktop with chat, AI, a built-in video player and voice calls. Built with vanilla JavaScript, Node.js and WebSockets. No frameworks.</p>',
    },
};

class Desktop {
    constructor() {
        this.sound = new SoundManager();
        this.notifications = new NotificationManager();
        this.windowManager = new WindowManager();
        this.apps = new Map();
        this.activeApp = null;      // the visible app window, or null while the explorer shows
        this._busy = false;
        this._booting = false;
        this._openDialogs = new Map();
        this.explorerEl = $('explorer-window');
        this.splashEl = $('splash');
        this.toastEl = $('copy-toast');
        this.statusRightEl = $('explorer-status-right');
        this.installBtn = $('install-btn');

        this.windowManager.register('explorer', this.explorerEl);
        // Register apps — to add one, add a line here and its markup in index.html
        this.registerApp(new JSChatApp(this));
        this.registerApp(new JSAIApp(this));
        this.registerApp(new JSTubeApp(this));
        this.registerApp(new JSCallApp(this));

        this._applyConfig();
        this._bindExplorer();
        this._bindSplash();
        this._bindDialogLinks();
        this._setupPWA();
        this._bindHistory();
        window.addEventListener('resize', () => { if (this.activeApp) this.activeApp.onLayoutChange(); });
    }

    // Phone Back button (and browser Back) returns to the explorer instead of leaving the page.
    _bindHistory() {
        this._historyDepth = 0;
        window.addEventListener('popstate', () => {
            this._historyDepth = Math.max(0, this._historyDepth - 1);
            if (this.activeApp) this.minimizeApp(this.activeApp.name);
        });
    }

    _applyConfig() {
        const cfg = window.JSOS_CONFIG;
        if (!cfg) return;
        if (cfg.os) document.title = cfg.os;
        for (const el of document.querySelectorAll('[data-name]')) {
            const value = cfg[el.dataset.name];
            if (value) el.textContent = (el.dataset.namePrefix || '') + value;
        }
        log.info('DESKTOP', 'Config applied');
    }

    registerApp(app) {
        this.apps.set(app.name, app);
        this.windowManager.register(app.name, app.windowEl);
        log.info('DESKTOP', 'App registered:', app.name);
    }

    // ─── App lifecycle ───
    async launchApp(name) {
        const app = this.apps.get(name);
        if (!app || this._busy || this.activeApp === app) return;
        this._busy = true;
        try {
            log.info('DESKTOP', (app.running ? 'Restoring:' : 'Launching:'), name);
            if (this.activeApp) await this._hideApp(this.activeApp);
            else await this.windowManager.close('explorer');
            this.activeApp = app;
            this.windowManager.open(name);
            if (app.running) app.onRestore();
            else { app.running = true; app.onLaunch(); }
            this._updateExplorerStatus();
            if (this._historyDepth === 0) {
                try { history.pushState({ jsos: name }, ''); this._historyDepth = 1; } catch { /* sandboxed page */ }
            }
        } finally { this._busy = false; }
    }

    async minimizeApp(name) {
        const app = this.apps.get(name);
        if (!app || this._busy || this.activeApp !== app) return;
        this._busy = true;
        try {
            this.sound.play('window');
            await this._hideApp(app);
            this.windowManager.open('explorer');
            this._updateExplorerStatus();
        } finally { this._busy = false; }
    }

    async closeApp(name) {
        const app = this.apps.get(name);
        if (!app || this._busy) return;
        this._busy = true;
        try {
            log.info('DESKTOP', 'Closing:', name);
            this.sound.play('window');
            app.onClose();
            app.running = false;
            app.windowEl.classList.remove('maximized');
            this._setMaximizeButton(app.windowEl, false);
            if (this.activeApp === app) {
                await this.windowManager.close(name);
                this.activeApp = null;
                this.windowManager.open('explorer');
            }
            this._updateExplorerStatus();
        } finally { this._busy = false; }
    }

    toggleMaximize(name) {
        const el = name === 'explorer' ? this.explorerEl : (this.apps.get(name) || {}).windowEl;
        if (!el) return;
        this.sound.play('window');
        const on = el.classList.toggle('maximized');
        this._setMaximizeButton(el, on);
        const app = this.apps.get(name);
        if (app) app.onLayoutChange();
    }

    async _hideApp(app) {
        app.onMinimize();
        await this.windowManager.close(app.name);
        if (this.activeApp === app) this.activeApp = null;
    }

    _setMaximizeButton(el, maximized) {
        const button = el.querySelector('[data-action="maximize"]');
        if (!button) return;
        button.title = maximized ? 'Restore' : 'Maximize';
        button.setAttribute('aria-label', button.title);
    }

    _updateExplorerStatus() {
        let running = 0;
        for (const app of this.apps.values()) {
            app.iconEl.classList.toggle('running', app.running);
            if (app.running) running += 1;
        }
        this.statusRightEl.textContent = running ? running + (running === 1 ? ' app running' : ' apps running') : 'Ready';
    }

    // ─── Explorer ───
    _bindExplorer() {
        this.explorerEl.querySelector('[data-action="close"]').addEventListener('click', () => this.logOff());
        this.explorerEl.querySelector('[data-action="maximize"]').addEventListener('click', () => this.toggleMaximize('explorer'));
    }

    /** Closes every running app and returns to the splash screen. */
    async logOff() {
        if (this._busy) return;
        const ok = await this.showConfirmDialog('Log off ' + appName('os', 'JS OS') + '? Any running apps will be closed.', { okLabel: 'Log off' });
        if (!ok) return;
        this._busy = true;
        try {
            log.info('DESKTOP', 'Logging off');
            this.sound.play('window');
            for (const app of this.apps.values()) {
                if (!app.running) continue;
                app.onClose();
                app.running = false;
                app.windowEl.classList.remove('maximized');
                this._setMaximizeButton(app.windowEl, false);
                app.windowEl.hidden = true;
            }
            this.activeApp = null;
            await this.windowManager.close('explorer');
            this.explorerEl.classList.remove('maximized');
            this._setMaximizeButton(this.explorerEl, false);
            this._updateExplorerStatus();
            this.splashEl.classList.remove('hidden');
            this.splashEl.removeAttribute('aria-hidden');
            this.splashEl.focus({ preventScroll: true });
        } finally { this._busy = false; }
    }

    // ─── Splash / boot ───
    _bindSplash() {
        const boot = () => {
            if (this._booting || this.splashEl.classList.contains('hidden')) return;
            this._booting = true;
            log.info('DESKTOP', 'Booting');
            this.sound.unlock();
            this.sound.play('startup');
            this.splashEl.classList.add('hidden');
            this.splashEl.setAttribute('aria-hidden', 'true');
            setTimeout(() => {
                this.explorerEl.hidden = false;
                this.explorerEl.classList.add('opening-slow');
                this.windowManager.afterAnimation(this.explorerEl, 900).then(() => this.explorerEl.classList.remove('opening-slow'));
                this._booting = false;
            }, 1200);
        };
        this.splashEl.addEventListener('click', boot);
        this.splashEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); boot(); }
        });
    }

    // Help / About links in the app top bars
    _bindDialogLinks() {
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[data-dialog]');
            if (!link) return;
            e.preventDefault();
            const entry = HELP_TEXT[link.dataset.dialog];
            if (entry) this.showInfoDialog(entry.title, entry.html);
        });
    }

    // ─── Toast, dialogs, lightbox ───
    showToast(text) {
        this.toastEl.textContent = text;
        this.toastEl.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2000);
    }

    showErrorDialog(message, title) {
        log.warn('DESKTOP', 'Error dialog:', message);
        return this._dialog({ title: title || appName('os', 'JS OS') + ' - Error', message, icon: '⚠', buttons: [{ label: 'OK', value: true }] });
    }

    showConfirmDialog(message, options = {}) {
        return this._dialog({
            title: options.title || appName('os', 'JS OS'),
            message, icon: '❓', kind: 'info',
            buttons: [{ label: options.okLabel || 'OK', value: true }, { label: options.cancelLabel || 'Cancel', value: false, secondary: true }],
        });
    }

    /** `html` is trusted, static markup from this file. */
    showInfoDialog(title, html) {
        return this._dialog({ title, html, icon: 'ℹ', kind: 'info', buttons: [{ label: 'OK', value: true }] });
    }

    _dialog({ title, message, html, icon, kind, buttons }) {
        // The same dialog twice in a row (two failed attempts, two error frames) shows once.
        const key = title + ' ' + (html || message);
        if (this._openDialogs.has(key)) return this._openDialogs.get(key);
        const promise = new Promise((resolve) => {
            this.sound.play('window');
            const overlay = document.createElement('div');
            overlay.className = 'error-overlay';
            const dialog = document.createElement('div');
            dialog.className = 'error-dialog' + (kind === 'info' ? ' info' : '');
            dialog.setAttribute('role', kind === 'info' ? 'dialog' : 'alertdialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-label', title);

            const titlebar = document.createElement('div');
            titlebar.className = 'error-dialog-titlebar';
            const titleSpan = document.createElement('span');
            titleSpan.textContent = title;
            titlebar.appendChild(titleSpan);

            const body = document.createElement('div');
            body.className = 'error-dialog-body';
            const iconEl = document.createElement('div');
            iconEl.className = 'error-dialog-icon';
            iconEl.textContent = icon;
            const text = document.createElement('div');
            text.className = 'error-dialog-text';
            if (html) text.innerHTML = html; else text.textContent = message;
            body.append(iconEl, text);

            const actions = document.createElement('div');
            actions.className = 'error-dialog-buttons';
            const cancelValue = buttons[buttons.length - 1].value;
            const finish = (value) => {
                this._openDialogs.delete(key);
                document.removeEventListener('keydown', onKey, true);
                overlay.classList.add('closing');
                setTimeout(() => overlay.remove(), 150);
                if (previous && previous.focus) previous.focus({ preventScroll: true });
                resolve(value);
            };
            // Escape cancels; Tab stays inside the dialog (the page behind it is not operable).
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); finish(cancelValue); return; }
                if (e.key !== 'Tab') return;
                const items = actions.querySelectorAll('button');
                const first = items[0];
                const last = items[items.length - 1];
                if (!dialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
                else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            };
            for (const spec of buttons) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'error-dialog-btn' + (spec.secondary ? ' secondary' : '');
                button.textContent = spec.label;
                button.addEventListener('click', () => finish(spec.value));
                actions.appendChild(button);
            }

            dialog.append(titlebar, body, actions);
            overlay.appendChild(dialog);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(cancelValue); });
            const previous = document.activeElement;
            document.body.appendChild(overlay);
            document.addEventListener('keydown', onKey, true);
            actions.firstChild.focus({ preventScroll: true });
        });
        this._openDialogs.set(key, promise);
        return promise;
    }

    showLightbox(src) {
        const overlay = document.createElement('div');
        overlay.className = 'lightbox';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-label', 'Image');
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        overlay.appendChild(img);
        const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
        overlay.addEventListener('click', close);
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
    }

    // ─── PWA install ───
    _setupPWA() {
        this._installPrompt = null;
        const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this._installPrompt = e;
            if (!standalone) this.installBtn.hidden = false;
            log.info('DESKTOP', 'Install prompt available');
        });
        window.addEventListener('appinstalled', () => {
            this._installPrompt = null;
            this.installBtn.hidden = true;
            this.showToast(appName('os', 'JS OS') + ' installed!');
        });
        if (isIOS && !standalone) this.installBtn.hidden = false;

        this.installBtn.addEventListener('click', async () => {
            if (this._installPrompt) {
                const prompt = this._installPrompt;
                this._installPrompt = null;
                this.installBtn.hidden = true;
                prompt.prompt();
                const choice = await prompt.userChoice.catch(() => null);
                log.info('DESKTOP', 'Install choice:', choice && choice.outcome);
                return;
            }
            this.showInfoDialog('Install ' + appName('os', 'JS OS'),
                '<p>Install ' + escapeHtml(appName('os', 'JS OS')) + ' as an app for full screen and notifications.</p>' +
                '<p>Tap the <strong>Share</strong> button, then <strong>Add to Home Screen</strong>.</p>');
        });
    }
}

// ─── Boot ───
const desktop = new Desktop();
log.info('DESKTOP', 'JS OS v' + JSOS_VERSION + ' booted —', desktop.apps.size, 'apps registered');
