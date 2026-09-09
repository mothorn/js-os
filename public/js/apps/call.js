// ─── JS Call: WebRTC voice calls with room codes ───

'use strict';

class JSCallApp extends BaseApp {
    constructor(desktop) {
        super(desktop, 'call-window', 'call-icon');
        this.client = new CallClient();
        this._users = [];
        this._speaking = new Set();   // remote peers currently talking
        this._selfSpeaking = false;   // tracked separately: our own peerId is unknown until the server answers
        this._lastCode = '';
        this.els = {
            lobby: $('call-lobby'), view: $('call-view'),
            username: $('call-username'), code: $('call-code'), error: $('call-error'),
            createBtn: $('btn-create-call'), joinBtn: $('btn-join-call'),
            codeDisplay: $('call-code-display'), userCount: $('call-user-count'), usersGrid: $('call-users-grid'),
            muteBtn: $('call-mute-btn'), muteLabel: $('mute-label'), leaveBtn: $('call-leave-btn'),
            statusUsername: $('call-status-username'), statusRight: $('call-status-right'),
        };
        this._bindClient();
        this._bindUI();
    }

    onLaunch() {
        this._showLobby();
        this.els.username.focus({ preventScroll: true });
    }

    onRestore() {
        if (!this.client.inCall) this.els.username.focus({ preventScroll: true });
    }

    onClose() {
        this.client.disconnect();
        this._showLobby();
        this.els.error.textContent = '';
    }

    // ─── Views ───
    _showLobby() {
        this.els.view.hidden = true;
        this.els.lobby.hidden = false;
        this._users = [];
        this._speaking.clear();
        this._selfSpeaking = false;
        this.els.usersGrid.innerHTML = '';
        this.els.userCount.textContent = '';
        this.els.codeDisplay.textContent = '';
        this.els.statusUsername.textContent = '';
        this._setMuteButton(false);
        this._setBusy(false);
    }

    _showCall(code) {
        this.els.lobby.hidden = true;
        this.els.view.hidden = false;
        this.els.codeDisplay.textContent = code;
        this.els.statusUsername.textContent = this.client.username;
        this.els.statusRight.textContent = 'In call';
        this.els.muteBtn.focus({ preventScroll: true });
    }

    _setBusy(busy) {
        this.els.createBtn.disabled = busy;
        this.els.joinBtn.disabled = busy;
        this.els.error.textContent = busy ? 'Waiting for microphone access…' : '';
    }

    _setMuteButton(muted) {
        this.els.muteBtn.classList.toggle('muted', muted);
        this.els.muteBtn.setAttribute('aria-pressed', String(muted));
        this.els.muteLabel.textContent = muted ? 'Unmute' : 'Mute';
    }

    // ─── Client events ───
    _bindClient() {
        this.client.onJoined = (code) => { this._lastCode = code; this._setBusy(false); this._showCall(code); };
        this.client.onUsers = (users) => { this._users = users; this._renderUsers(); };
        this.client.onSpeaking = (id, speaking) => {
            if (id === 'self') this._selfSpeaking = speaking;
            else if (speaking) this._speaking.add(id);
            else this._speaking.delete(id);
            this._renderUsers();
        };
        this.client.onError = (message) => { this._setBusy(false); this.desktop.showErrorDialog(message); };
        this.client.onDisconnect = (reason) => {
            this._showLobby();
            if (this._lastCode) this.els.code.value = this._lastCode;   // the room survives a minute; make rejoining easy
            this.desktop.showErrorDialog(reason);
        };
    }

    // ─── UI events ───
    _bindUI() {
        this.els.createBtn.addEventListener('click', () => this._createCall());
        this.els.joinBtn.addEventListener('click', () => this._joinCall());
        this.els.username.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (this.els.code.value.trim()) this._joinCall(); else this._createCall();
        });
        this.els.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._joinCall(); } });
        this.els.code.addEventListener('input', () => {
            this.els.code.value = this.els.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        });
        this.els.muteBtn.addEventListener('click', () => {
            const muted = this.client.toggleMute();
            this._setMuteButton(muted);
            this._users = this._users.map((u) => (u.peerId === this.client.peerId ? { ...u, muted } : u));
            this._renderUsers();
        });
        this.els.leaveBtn.addEventListener('click', () => {
            const code = this.client.roomCode;
            this.client.disconnect();
            this._showLobby();
            if (code) this.els.code.value = code;
            this.els.username.focus({ preventScroll: true });
        });
        this.els.codeDisplay.addEventListener('click', () => this._copyCode());
    }

    _validLobby(needCode) {
        const name = this.els.username.value.trim();
        if (!name) { this.els.error.textContent = 'Enter a username first'; this.els.username.focus(); return null; }
        if (!USERNAME_RE.test(name)) { this.els.error.textContent = USERNAME_HINT; this.els.username.focus(); return null; }
        const code = this.els.code.value.trim().toUpperCase();
        if (needCode && !ROOM_CODE_RE.test(code)) { this.els.error.textContent = ROOM_CODE_HINT; this.els.code.focus(); return null; }
        this.els.error.textContent = '';
        return { name, code };
    }

    _createCall() {
        if (this.els.createBtn.disabled) return;   // a connect is already waiting for the microphone
        const values = this._validLobby(false);
        if (!values) return;
        this._setBusy(true);
        this.client.connect('create', values.name);
    }

    _joinCall() {
        if (this.els.joinBtn.disabled) return;
        const values = this._validLobby(true);
        if (!values) return;
        this._setBusy(true);
        this.client.connect('join', values.name, values.code);
    }

    async _copyCode() {
        const code = this.client.roomCode;
        if (!code) return;
        const ok = await copyText(code);
        this.desktop.showToast(ok ? 'Call code copied!' : 'Call code: ' + code);
    }

    // ─── Rendering ───
    _renderUsers() {
        this.els.usersGrid.innerHTML = '';
        for (const user of this._users) {
            const isSelf = user.peerId === this.client.peerId;
            const speaking = !user.muted && (isSelf ? this._selfSpeaking : this._speaking.has(user.peerId));
            const card = document.createElement('div');
            card.className = 'call-user-card' + (user.muted ? ' muted' : '') + (speaking ? ' speaking' : '');
            const avatar = document.createElement('div');
            avatar.className = 'call-user-avatar';
            avatar.textContent = (user.username || '?').charAt(0).toUpperCase();
            const name = document.createElement('div');
            name.className = 'call-user-name';
            name.textContent = user.username + (isSelf ? ' (you)' : '');
            name.title = user.username;
            const status = document.createElement('div');
            status.className = 'call-user-status' + (user.muted ? ' muted-status' : speaking ? ' speaking-status' : '');
            status.textContent = user.muted ? 'Muted' : speaking ? 'Speaking' : 'In call';
            card.append(avatar, name, status);
            this.els.usersGrid.appendChild(card);
        }
        this.els.userCount.textContent = this._users.length + ' in call';
    }
}
