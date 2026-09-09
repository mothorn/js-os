// ─── JS Chat: room-based chat with image sharing ───

'use strict';

class JSChatApp extends BaseApp {
    constructor(desktop) {
        super(desktop, 'chat-window', 'app-icon');
        this.client = new ChatClient(desktop.sound, desktop.notifications);
        this._pendingImage = null;
        this._attachToken = 0;   // invalidates an image still being compressed when the room changes
        this.els = {
            lobby: $('lobby'), chatView: $('chat-view'), form: $('chat-form'), messages: $('messages'), input: $('message'),
            username: $('lobby-username'), code: $('lobby-code'), error: $('lobby-error'),
            createBtn: $('btn-create'), joinBtn: $('btn-join'),
            windowTitle: $('window-title'), roomCode: $('room-code-display'),
            statusUsername: $('status-username'), statusRight: $('chat-status-right'), statusIndicator: $('chat-status-indicator'),
            userList: $('user-list'), userCount: $('user-count'), userPanel: $('user-panel'), userPanelToggle: $('user-panel-toggle'),
            imagePreview: $('image-preview'), imagePreviewImg: $('image-preview-img'), imagePreviewRemove: $('image-preview-remove'),
            attachBtn: $('attach-btn'), fileInput: $('image-file'),
        };
        this._bindClient();
        this._bindUI();
    }

    onLaunch() {
        this._showLobby();
        this.els.username.focus({ preventScroll: true });
    }

    onRestore() {
        (this.client.inRoom ? this.els.input : this.els.username).focus({ preventScroll: true });
    }

    onClose() {
        this.client.disconnect();
        this._showLobby();
        this.els.error.textContent = '';
    }

    // ─── Views ───
    _showLobby() {
        this.els.chatView.hidden = true;
        this.els.lobby.hidden = false;
        this.els.messages.innerHTML = '';
        this.els.userList.innerHTML = '';
        this.els.userCount.textContent = '';
        this.els.roomCode.textContent = '';
        this.els.statusUsername.textContent = '';
        this.els.windowTitle.textContent = '{ } ' + appName('chat', 'JS Chat');
        this.els.input.value = '';
        this._clearImagePreview();
        this._setStatus('Connected', 'on');
        this._setBusy(false);
    }

    _showRoom(code) {
        this.els.lobby.hidden = true;
        this.els.chatView.hidden = false;
        this.els.roomCode.textContent = code;
        this.els.statusUsername.textContent = this.client.username;
        this.els.windowTitle.textContent = '{ } ' + appName('chat', 'JS Chat') + ' — ' + code;
        this._setPanel(!isPhoneLayout());
        this.els.input.focus({ preventScroll: true });
    }

    _setStatus(text, state) {
        this.els.statusRight.textContent = text;
        this.els.statusIndicator.className = 'status-indicator' + (state === 'on' ? '' : ' ' + state);
    }

    _setBusy(busy) {
        this.els.createBtn.disabled = busy;
        this.els.joinBtn.disabled = busy;
    }

    // ─── Client events ───
    _bindClient() {
        this.client.onJoined = ({ code, history, users, reconnected }) => {
            this._setBusy(false);
            if (reconnected) this.els.messages.innerHTML = '';
            this._showRoom(code);
            for (const item of history) {
                if (item.type === 'message') this._addMessage(item.username, item.message, item.image, true);
                else if (item.type === 'system') this._addSystemMessage(item.message);
            }
            if (reconnected) this._addSystemMessage('Reconnected to the room.');
            this._renderUsers(users);
            this._setStatus('Connected', 'on');
        };
        this.client.onMessage = (msg) => this._addMessage(msg.username, msg.message, msg.image, false);
        this.client.onSystem = (text) => this._addSystemMessage(text);
        this.client.onUsers = (users) => this._renderUsers(users);
        this.client.onError = (message) => { this._setBusy(false); this.desktop.showErrorDialog(message); };
        this.client.onReconnecting = (attempt, max) => {
            this._setStatus('Reconnecting (' + attempt + '/' + max + ')…', 'warn');
            if (attempt === 1) this._addSystemMessage('Connection lost — reconnecting…');
        };
        this.client.onDisconnect = (reason) => {
            const code = this.client.roomCode;
            this._showLobby();
            if (code) this.els.code.value = code;
            this.desktop.showErrorDialog(reason);
        };
    }

    // ─── UI events ───
    _bindUI() {
        this.els.createBtn.addEventListener('click', () => this._createRoom());
        this.els.joinBtn.addEventListener('click', () => this._joinRoom());
        this.els.username.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (this.els.code.value.trim()) this._joinRoom(); else this._createRoom();
        });
        this.els.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._joinRoom(); } });
        this.els.code.addEventListener('input', () => {
            this.els.code.value = this.els.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        });
        this.els.form.addEventListener('submit', (e) => { e.preventDefault(); this._sendMessage(); });
        this.els.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this._sendMessage(); }
        });
        this.els.roomCode.addEventListener('click', () => this._copyCode());
        this.els.userPanelToggle.addEventListener('click', () => this._setPanel(this.els.userPanel.hidden));
        this.els.attachBtn.addEventListener('click', () => this.els.fileInput.click());
        this.els.fileInput.addEventListener('change', () => {
            const file = this.els.fileInput.files && this.els.fileInput.files[0];
            this.els.fileInput.value = '';
            if (file) this._attachImage(file);
        });
        this.els.imagePreviewRemove.addEventListener('click', () => { this._clearImagePreview(); this.els.input.focus(); });
        document.addEventListener('paste', (e) => this._onPaste(e));
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

    _createRoom() {
        const values = this._validLobby(false);
        if (!values) return;
        this.desktop.notifications.requestPermission();   // inside the click, as browsers require
        this._setBusy(true);
        this.client.connect('create', values.name);
    }

    _joinRoom() {
        const values = this._validLobby(true);
        if (!values) return;
        this.desktop.notifications.requestPermission();
        this._setBusy(true);
        this.client.connect('join', values.name, values.code);
    }

    _sendMessage() {
        const text = this.els.input.value.trim();
        if (!text && !this._pendingImage) return;
        if (text.length > JSChatApp.MAX_MESSAGE_CHARS) {
            this.desktop.showErrorDialog('That message is too long (max ' + JSChatApp.MAX_MESSAGE_CHARS + ' characters).');
            return;
        }
        if (!this.client.send(text, this._pendingImage)) {
            this.desktop.showErrorDialog('Not connected to the room right now. Wait for the reconnect and try again.');
            return;
        }
        this.els.input.value = '';
        this._clearImagePreview();
        this.els.input.focus();
    }

    async _copyCode() {
        const code = this.client.roomCode;
        if (!code) return;
        const ok = await copyText(code);
        this.desktop.showToast(ok ? 'Room code copied!' : 'Room code: ' + code);
    }

    _setPanel(open) {
        this.els.userPanel.hidden = !open;
        this.els.userPanelToggle.setAttribute('aria-expanded', String(open));
    }

    // ─── Images ───
    _onPaste(event) {
        if (this.windowEl.hidden || !this.client.inRoom) return;
        const items = event.clipboardData && event.clipboardData.items;
        if (!items) return;
        for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                event.preventDefault();
                const file = item.getAsFile();
                if (file) this._attachImage(file);
                return;
            }
        }
    }

    async _attachImage(file) {
        if (!file.type.startsWith('image/')) { this.desktop.showErrorDialog('Only image files can be attached.'); return; }
        if (file.size > JSChatApp.MAX_IMAGE_FILE_BYTES) { this.desktop.showErrorDialog('That image is too large (max 10 MB).'); return; }
        const token = this._attachToken;
        try {
            const dataUrl = await JSChatApp.compressImage(file);
            if (token !== this._attachToken || !this.client.inRoom) return;   // the room changed meanwhile
            this._pendingImage = dataUrl;
            this.els.imagePreviewImg.src = dataUrl;
            this.els.imagePreview.hidden = false;
            log.info('IMAGE', 'Attached, ' + Math.round(dataUrl.length / 1024) + ' KB');
            this.els.input.focus();
        } catch (err) {
            log.warn('IMAGE', err.message);
            this.desktop.showErrorDialog(err.message);
        }
    }

    _clearImagePreview() {
        this._attachToken += 1;
        this._pendingImage = null;
        this.els.imagePreview.hidden = true;
        this.els.imagePreviewImg.removeAttribute('src');
    }

    /** Scales the image down and re-encodes it as JPEG until it fits the size limit. */
    static async compressImage(file) {
        const source = await JSChatApp._decodeImage(file);
        let width = source.naturalWidth || source.width;
        let height = source.naturalHeight || source.height;
        if (!width || !height) throw new Error('Could not read the image.');
        const scale = Math.min(1, JSChatApp.MAX_IMAGE_WIDTH / width, JSChatApp.MAX_IMAGE_HEIGHT / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(source, 0, 0, width, height);
        if (source.close) source.close();
        for (const quality of [0.7, 0.5, 0.35]) {
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length <= JSChatApp.MAX_IMAGE_DATA_CHARS) return dataUrl;
        }
        throw new Error('That image is too large to send, even after compression.');
    }

    static _decodeImage(file) {
        if (window.createImageBitmap) {
            return createImageBitmap(file, { imageOrientation: 'from-image' })
                .catch(() => createImageBitmap(file))
                .catch(() => JSChatApp._decodeWithImageElement(file));
        }
        return JSChatApp._decodeWithImageElement(file);
    }

    static _decodeWithImageElement(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image.')); };
            img.src = url;
        });
    }

    // ─── Rendering ───
    _isNearBottom() {
        const el = this.els.messages;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }

    _scrollToBottom() { this.els.messages.scrollTop = this.els.messages.scrollHeight; }

    _addMessage(username, text, image, fromHistory) {
        const stick = fromHistory || this._isNearBottom() || username === this.client.username;
        const container = document.createElement('div');
        const line = document.createElement('p');
        const who = document.createElement('span');
        who.className = 'msg-user';
        who.textContent = username + ':';
        line.appendChild(who);
        line.appendChild(document.createTextNode(' ' + (text || '')));
        container.appendChild(line);
        if (image) {
            const img = document.createElement('img');
            img.src = image;
            img.className = 'chat-image';
            img.alt = 'Image from ' + username;
            img.addEventListener('load', () => { if (stick) this._scrollToBottom(); });
            img.addEventListener('click', () => this.desktop.showLightbox(image));
            container.appendChild(img);
        }
        this.els.messages.appendChild(container);
        if (stick) this._scrollToBottom();
    }

    _addSystemMessage(text) {
        const stick = this._isNearBottom();
        const line = document.createElement('p');
        line.className = 'system-msg';
        line.textContent = text;
        this.els.messages.appendChild(line);
        if (stick) this._scrollToBottom();
    }

    _renderUsers(users) {
        this.els.userList.innerHTML = '';
        for (const name of users) {
            const item = document.createElement('li');
            item.textContent = name;
            item.title = name;
            if (name === this.client.username) item.className = 'self';
            this.els.userList.appendChild(item);
        }
        this.els.userCount.textContent = users.length + ' online';
        this.els.userPanelToggle.textContent = 'Users (' + users.length + ')';
    }
}
JSChatApp.MAX_MESSAGE_CHARS = 10000;       // same as the server
JSChatApp.MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
JSChatApp.MAX_IMAGE_DATA_CHARS = 700000;   // what the server accepts comfortably
JSChatApp.MAX_IMAGE_WIDTH = 800;
JSChatApp.MAX_IMAGE_HEIGHT = 1200;
