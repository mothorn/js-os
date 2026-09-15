// ─── JSTube: YouTube search with a built-in player ───
// Videos play in a real <video> element fed by the server's HLS relay (hls.js, or Safari's own HLS support).
// Whenever that is off or fails (Vercel, a live stream, a blocked video) the YouTube embed takes over.

'use strict';

class JSTubeApp extends BaseApp {
    constructor(desktop) {
        super(desktop, 'jstube-window', 'jstube-icon');
        this.els = {
            results: $('jstube-results'), player: $('jstube-player'), playerContainer: $('jstube-player-container'),
            videoInfo: $('jstube-video-info'), backBtn: $('jstube-back-btn'),
            form: $('jstube-search-form'), input: $('jstube-search'), status: $('jstube-status'),
        };
        this._iframe = null;
        this._native = null;        // { el, hls } while the built-in player is up
        this._current = null;       // the video being played
        this._playSeq = 0;          // bumps on every play/stop so a slow start cannot resurrect an old video
        this._playerMode = null;    // 'native' | 'embed', asked from the server once
        this._hlsLoading = null;
        this._searchSeq = 0;
        this._controller = null;
        this._resultCount = 0;
        const submit = () => {
            const query = this.els.input.value.trim();
            if (query) this.search(query);
        };
        this.els.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
        this.els.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
        });
        this.els.backBtn.addEventListener('click', () => this.showResults());
    }

    onLaunch() { this.els.input.focus({ preventScroll: true }); }
    onRestore() { if (!this._current) this.els.input.focus({ preventScroll: true }); }
    onClose() { this.reset(); }

    async search(query) {
        const seq = ++this._searchSeq;
        if (this._controller) this._controller.abort();
        const controller = new AbortController();
        this._controller = controller;
        log.info('JSTUBE', 'Searching:', query);
        this.els.status.textContent = 'Searching…';
        this._setPlaceholder('Searching for "' + query + '"…', 'jstube-loading');
        this.showResults();
        try {
            const res = await fetch('/api/search?q=' + encodeURIComponent(query), { signal: controller.signal });
            const data = await res.json().catch(() => ({}));
            if (seq !== this._searchSeq) return;   // a newer search replaced this one
            if (!res.ok || (data && data.error)) throw new Error((data && data.error) || 'Search failed (HTTP ' + res.status + ')');
            if (!Array.isArray(data) || !data.length) {
                this._resultCount = 0;
                this._setPlaceholder('No results found');
                this.els.status.textContent = 'No results';
                return;
            }
            this._resultCount = data.length;
            const fragment = document.createDocumentFragment();
            for (const video of data) fragment.appendChild(this._card(video));
            this.els.results.replaceChildren(fragment);
            this.els.results.scrollTop = 0;
            this.els.status.textContent = data.length + ' results';
            log.info('JSTUBE', 'Found', data.length, 'results');
        } catch (err) {
            if (err.name === 'AbortError' || seq !== this._searchSeq) return;
            log.error('JSTUBE', 'Search failed:', err.message);
            this._setPlaceholder('Search failed: ' + err.message);
            this.els.status.textContent = 'Error';
        } finally {
            if (this._controller === controller) this._controller = null;
        }
    }

    _setPlaceholder(text, className) {
        const el = document.createElement('div');
        el.className = className || 'jstube-placeholder';
        el.textContent = text;
        this.els.results.replaceChildren(el);
    }

    _card(video) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'jstube-card';
        const thumb = document.createElement('img');
        thumb.className = 'jstube-thumb';
        thumb.alt = '';
        thumb.loading = 'lazy';
        if (typeof video.thumbnail === 'string' && video.thumbnail.startsWith('https://i.ytimg.com/')) thumb.src = video.thumbnail;
        const info = document.createElement('div');
        info.className = 'jstube-card-info';
        const title = document.createElement('div');
        title.className = 'jstube-card-title';
        title.textContent = video.title || '(untitled)';
        const channel = document.createElement('div');
        channel.className = 'jstube-card-channel';
        channel.textContent = video.channel || '';
        const meta = document.createElement('div');
        meta.className = 'jstube-card-meta';
        meta.textContent = [video.views, video.published, video.duration].filter(Boolean).join(' · ');
        info.append(title, channel, meta);
        card.append(thumb, info);
        card.addEventListener('click', () => this.play(video));
        return card;
    }

    // ─── Playback ───
    async play(video) {
        if (!JSTubeApp.VIDEO_ID_RE.test(String(video.videoId))) { this.desktop.showErrorDialog('That video cannot be played.'); return; }
        this._stopPlayback();            // also invalidates any start still in flight
        const seq = this._playSeq;
        this._current = video;
        log.info('JSTUBE', 'Playing:', video.title, '[' + video.videoId + ']');
        this.els.results.hidden = true;
        this.els.player.hidden = false;
        this._renderInfo(video);
        this.els.status.textContent = 'Loading: ' + (video.title || '');

        const mode = await this._getPlayerMode();
        if (seq !== this._playSeq) return;
        if (mode === 'native') {
            const started = await this._playNative(video, seq);
            if (seq !== this._playSeq || started) return;
            log.warn('JSTUBE', 'Built-in player could not start; using the YouTube player');
        }
        this._playEmbed(video);
    }

    async _getPlayerMode() {
        if (this._playerMode) return this._playerMode;
        try {
            const res = await fetch('/api/tube/player', { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok || (data.mode !== 'native' && data.mode !== 'embed')) return 'embed';   // a hiccup; ask again next time
            this._playerMode = data.mode;
        } catch { return 'embed'; }
        log.info('JSTUBE', 'Player mode:', this._playerMode);
        return this._playerMode;
    }

    _loadHls() {
        if (window.Hls) return Promise.resolve(true);
        if (this._hlsLoading) return this._hlsLoading;
        this._hlsLoading = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'js/vendor/hls.min.js';
            script.async = true;
            script.onload = () => resolve(Boolean(window.Hls));
            script.onerror = () => { this._hlsLoading = null; resolve(false); };
            document.head.appendChild(script);
        });
        return this._hlsLoading;
    }

    // Resolves true once the built-in player is playing, false when the embed should take over.
    async _playNative(video, seq) {
        const src = '/api/tube/hls/' + encodeURIComponent(video.videoId) + '/master.m3u8';
        // Ask the server first, so a video it cannot relay (live, blocked, YouTube said no) falls back cleanly.
        try {
            const res = await fetch(src, { cache: 'no-store' });
            if (res.body) res.body.cancel().catch(() => {});
            if (!res.ok) {
                log.warn('JSTUBE', 'Built-in player unavailable for this video: HTTP ' + res.status);
                return false;
            }
        } catch (err) { log.warn('JSTUBE', 'Built-in player request failed:', err.message); return false; }
        if (seq !== this._playSeq) return true;

        const el = document.createElement('video');
        el.className = 'jstube-video';
        el.controls = true;
        el.autoplay = true;
        el.playsInline = true;
        el.setAttribute('playsinline', '');
        el.preload = 'auto';
        el.setAttribute('aria-label', video.title || 'Video');
        this.els.playerContainer.replaceChildren(el);
        const native = { el, hls: null, settle: null, started: false };
        this._native = native;
        // After the async start-up the click's permission to play sound may have lapsed (iOS especially):
        // the controls stay visible, so tell the person to press play instead of claiming it is playing.
        const play = () => {
            const p = el.play();
            if (p && p.catch) p.catch((err) => {
                if (this._native === native && err && err.name === 'NotAllowedError') this.els.status.textContent = 'Press play: ' + (video.title || '');
            });
        };

        const hlsReady = await this._loadHls();
        if (this._native !== native) return true;   // stopped or replaced while the player library loaded
        if (hlsReady && window.Hls && Hls.isSupported()) {
            // Start at 720p rather than hls.js's cautious default, then let adaptive streaming settle.
            const hls = new Hls({ enableWorker: true, maxBufferLength: 30, backBufferLength: 60, abrEwmaDefaultEstimate: 1500000 });
            native.hls = hls;
            return new Promise((resolve) => {
                native.settle = resolve;
                hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
                    const levels = data && data.levels ? data.levels.length : 0;
                    log.info('JSTUBE', 'Built-in player:', levels, 'quality level(s)');
                    native.started = true;
                    this.els.status.textContent = 'Playing: ' + (video.title || '');
                    play();
                    resolve(true);
                });
                hls.on(Hls.Events.ERROR, (_, data) => {
                    if (!data || !data.fatal) return;
                    log.warn('JSTUBE', 'Built-in player error:', data.type, data.details);
                    if (this._native !== native) return resolve(true);
                    if (native.started) this._fallbackMidPlay(video, seq);
                    else { this._stopNative(); resolve(false); }
                });
                hls.loadSource(src);
                hls.attachMedia(el);
            });
        }
        if (el.canPlayType('application/vnd.apple.mpegurl')) {   // Safari plays HLS on its own
            return new Promise((resolve) => {
                native.settle = resolve;
                el.addEventListener('loadedmetadata', () => { native.started = true; this.els.status.textContent = 'Playing: ' + (video.title || ''); resolve(true); }, { once: true });
                el.addEventListener('error', () => {
                    if (this._native !== native) return resolve(true);
                    if (native.started) this._fallbackMidPlay(video, seq);
                    else { this._stopNative(); resolve(false); }
                });
                el.src = src;
                play();
            });
        }
        this._stopNative();
        return false;
    }

    // The built-in player died after it had started (expired addresses, a network blip): hand over to the embed.
    _fallbackMidPlay(video, seq) {
        if (seq !== this._playSeq) return;
        log.warn('JSTUBE', 'Switching to the YouTube player');
        this._stopNative();
        this._playEmbed(video);
        this.desktop.showToast('Switched to the YouTube player');
    }

    _playEmbed(video) {
        this._stopNative();
        if (this._iframe) this._iframe.remove();
        this._iframe = document.createElement('iframe');
        // playsinline keeps iPhones inside the JS OS window instead of the system fullscreen player.
        this._iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(video.videoId) + '?autoplay=1&rel=0&playsinline=1';
        this._iframe.title = video.title || 'Video';
        this._iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        this._iframe.allowFullscreen = true;
        this.els.playerContainer.replaceChildren(this._iframe);
        this.els.status.textContent = 'Playing: ' + (video.title || '');
    }

    _renderInfo(video) {
        const title = document.createElement('div');
        title.className = 'jstube-video-title';
        title.textContent = video.title || '';
        const channel = document.createElement('div');
        channel.className = 'jstube-video-channel';
        channel.textContent = video.channel || '';
        const meta = document.createElement('div');
        meta.className = 'jstube-video-meta';
        meta.textContent = [video.views, video.published].filter(Boolean).join(' · ');
        this.els.videoInfo.replaceChildren(title, channel, meta);
    }

    _stopNative() {
        const native = this._native;
        if (!native) return;
        this._native = null;
        if (native.settle) native.settle(true);   // a start still in flight is over; nothing to fall back to
        if (native.hls) { try { native.hls.destroy(); } catch { /* already gone */ } }
        try {
            native.el.pause();
            native.el.removeAttribute('src');
            native.el.load();
        } catch { /* ignore */ }
        native.el.remove();
    }

    _stopPlayback() {
        this._playSeq += 1;
        this._stopNative();
        if (this._iframe) { this._iframe.remove(); this._iframe = null; }
        this._current = null;
    }

    showResults() {
        if (this._current) {
            this._stopPlayback();
            this.els.status.textContent = this._resultCount ? this._resultCount + ' results' : 'Ready';
        }
        this.els.player.hidden = true;
        this.els.results.hidden = false;
    }

    reset() {
        this._searchSeq += 1;
        this._resultCount = 0;
        if (this._controller) { this._controller.abort(); this._controller = null; }
        this.showResults();
        this._setPlaceholder('Search for videos to get started');
        this.els.input.value = '';
        this.els.status.textContent = 'Ready';
    }
}
JSTubeApp.VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
