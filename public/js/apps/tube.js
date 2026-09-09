// ─── JSTube: YouTube search and embedded player ───

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
    onRestore() { if (!this._iframe) this.els.input.focus({ preventScroll: true }); }
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

    play(video) {
        if (!JSTubeApp.VIDEO_ID_RE.test(String(video.videoId))) { this.desktop.showErrorDialog('That video cannot be played.'); return; }
        log.info('JSTUBE', 'Playing:', video.title, '[' + video.videoId + ']');
        this.els.results.hidden = true;
        this.els.player.hidden = false;
        if (this._iframe) this._iframe.remove();
        this._iframe = document.createElement('iframe');
        // playsinline keeps iPhones inside the JS OS window instead of the system fullscreen player.
        this._iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(video.videoId) + '?autoplay=1&rel=0&playsinline=1';
        this._iframe.title = video.title || 'Video';
        this._iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        this._iframe.allowFullscreen = true;
        this.els.playerContainer.replaceChildren(this._iframe);

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
        this.els.status.textContent = 'Playing: ' + (video.title || '');
    }

    showResults() {
        if (this._iframe) {
            this._iframe.remove();
            this._iframe = null;
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
