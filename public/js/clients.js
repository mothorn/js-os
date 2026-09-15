// ═══════════════════════════════════════════════════════════
//  JS OS — clients: protocol and feature logic with no UI
//  ChatClient (WebSocket) · CallClient (WebRTC) · JSAIClient (SSE) · ConversationStore (localStorage)
// ═══════════════════════════════════════════════════════════

'use strict';

// ─── ChatClient ───
// Reconnects automatically when the socket drops mid-session and rejoins the same room.
class ChatClient {
    constructor(sound, notifications) {
        this.sound = sound;
        this.notifications = notifications;
        this.ws = null;
        this.username = '';
        this.roomCode = '';
        this.session = null;            // token from the server that lets us take our own name back on rejoin
        this.inRoom = false;            // the server currently has us in a room
        this._rejoin = false;           // reconnect and rejoin if the socket drops
        this._action = 'create';
        this._intentionalClose = false;
        this._reconnectAttempts = 0;
        this._reconnectTimer = null;
        this.onJoined = null;           // ({ code, history, users, reconnected })
        this.onMessage = null;          // ({ username, message, image, ts })
        this.onSystem = null;           // (text)
        this.onUsers = null;            // (usernames)
        this.onError = null;            // (message)  recoverable, or a failed create/join
        this.onReconnecting = null;     // (attempt, max)
        this.onDisconnect = null;       // (reason)   the session is over
    }

    get connected() { return Boolean(this.ws) && this.ws.readyState === WebSocket.OPEN; }

    connect(action, username, code) {
        // Rejoining the same room under the same name keeps the session token, so a seat still held
        // by our dead socket can be taken back (the automatic reconnect path keeps it too).
        const keepSession = action === 'join' && this.session && code === this.roomCode && username === this.username ? this.session : null;
        this.disconnect();
        this.session = keepSession;
        this.username = username;
        this.roomCode = code || '';
        this._action = action;
        this._intentionalClose = false;
        this._reconnectAttempts = 0;
        log.info('CHAT', 'Connecting as', username, '(' + action + ')' + (code ? ' to ' + code : ''));
        this._open();
    }

    _open() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let ws;
        try { ws = new WebSocket(protocol + '//' + location.host + '/ws/chat'); }
        catch (err) { this._finish('Could not open a connection: ' + err.message); return; }
        this.ws = ws;

        ws.onopen = () => {
            log.debug('WS', 'Chat socket open');
            if (this._action === 'create') ws.send(JSON.stringify({ type: 'create', username: this.username }));
            else ws.send(JSON.stringify({ type: 'join', username: this.username, code: this.roomCode, session: this.session || undefined }));
        };
        ws.onmessage = (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            if (msg && typeof msg === 'object') this._handle(msg);
        };
        ws.onerror = () => log.warn('WS', 'Chat socket error');
        ws.onclose = (event) => {
            if (this.ws !== ws) return;   // an older socket; ignore
            this.ws = null;
            this.inRoom = false;
            log.info('WS', 'Chat socket closed (' + event.code + ')');
            if (this._intentionalClose) return;
            if (this._rejoin && this._reconnectAttempts < ChatClient.MAX_RECONNECTS) { this._scheduleReconnect(); return; }
            this._finish(this._rejoin ? 'Could not reconnect to the room.' : 'The connection to the server was lost.');
        };
    }

    _scheduleReconnect() {
        this._reconnectAttempts += 1;
        const delay = Math.min(1000 * 2 ** (this._reconnectAttempts - 1), 8000);
        log.info('WS', 'Reconnecting in', delay, 'ms (attempt ' + this._reconnectAttempts + ')');
        if (this.onReconnecting) this.onReconnecting(this._reconnectAttempts, ChatClient.MAX_RECONNECTS);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._action = 'join';
            this._open();
        }, delay);
    }

    /** The session is over: a failed attempt, a lost connection, or a reconnect that gave up. */
    _finish(reason) {
        this._teardown();
        if (this.onDisconnect) this.onDisconnect(reason);
    }

    _teardown() {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        this._closeSocket();
        this.inRoom = false;
        this._rejoin = false;
        this._reconnectAttempts = 0;
    }

    send(text, image) {
        if (!this.connected || !this.inRoom) return false;
        this.ws.send(JSON.stringify({ type: 'message', message: text, image: image || null }));
        log.debug('CHAT', 'Sent:', image ? '[image]' : text);
        return true;
    }

    disconnect() {
        this._intentionalClose = true;
        this._teardown();
        this.username = '';
        this.roomCode = '';
        this.session = null;
    }

    _handle(msg) {
        switch (msg.type) {
            case 'joined': {
                const reconnected = this._reconnectAttempts > 0;
                this.inRoom = true;
                this._rejoin = true;
                this._action = 'join';
                this._reconnectAttempts = 0;
                this.roomCode = msg.code;
                if (typeof msg.session === 'string') this.session = msg.session;
                if (msg.username) this.username = msg.username;
                log.info('CHAT', (reconnected ? 'Rejoined' : 'Joined') + ' room', msg.code);
                if (this.onJoined) this.onJoined({ code: msg.code, history: msg.history || [], users: msg.users || [], reconnected });
                break;
            }
            case 'message':
                if (this.onMessage) this.onMessage(msg);
                if (msg.username !== this.username && document.hidden) {
                    this.sound.play('notify');
                    this.notifications.chatMessage(msg.username, msg.message || '[image]');
                }
                break;
            case 'system':
                if (this.onSystem) this.onSystem(msg.message);
                break;
            case 'users':
                if (this.onUsers) this.onUsers(Array.isArray(msg.users) ? msg.users : []);
                break;
            case 'error':
                if (this.inRoom) { if (this.onError) this.onError(msg.message); break; }
                if (this._reconnectAttempts > 0) {
                    // Our old socket may still hold the name until the server notices it is dead: keep trying.
                    if (msg.code === 'name-taken' && this._reconnectAttempts < ChatClient.MAX_RECONNECTS) {
                        this._closeSocket();
                        this._scheduleReconnect();
                    } else {
                        this._finish('Could not rejoin the room: ' + msg.message);
                    }
                    break;
                }
                // The create/join attempt failed: drop the socket and report it.
                this._intentionalClose = true;
                this._teardown();
                if (this.onError) this.onError(msg.message);
                break;
            default:
                log.debug('CHAT', 'Ignoring message type', msg.type);
        }
    }

    _closeSocket() {
        if (!this.ws) return;
        const ws = this.ws;
        this.ws = null;
        ws.onclose = null;
        ws.onmessage = null;
        try { ws.close(); } catch { /* already closed */ }
    }
}
ChatClient.MAX_RECONNECTS = 8;

// ─── CallClient: microphone, signaling socket and one RTCPeerConnection per peer ───
class CallClient {
    constructor() {
        this.ws = null;
        this.username = '';
        this.roomCode = '';
        this.session = null;            // token from the last call, so a quick rejoin can take the name back
        this.peerId = null;
        this._connectSeq = 0;           // bumps on every connect/cleanup so an abandoned connect() cannot resume
        this.muted = false;
        this.localStream = null;
        this.peers = new Map();         // peerId → { pc, audio, pendingCandidates, remoteReady }
        this.names = new Map();         // peerId → username
        this.audioContext = null;
        this._meters = new Map();       // 'self' | peerId → { source, analyser, data, speaking }
        this._meterTimer = null;
        this._intentionalClose = false;
        this._audioHost = $('remote-audio');
        this.iceServers = null;         // STUN/TURN list the server handed us for this call
        this.paths = new Map();         // peerId → 'direct' | 'relay' once connected
        this.onJoined = null;           // (code)
        this.onUsers = null;            // ([{ peerId, username, muted }])
        this.onSpeaking = null;         // (peerId | 'self', speaking)
        this.onPath = null;             // (peerId, 'direct' | 'relay' | null)
        this.onError = null;            // (message)
        this.onDisconnect = null;       // (reason)
    }

    get inCall() { return Boolean(this.roomCode); }

    async connect(action, username, code) {
        this.disconnect();
        this._intentionalClose = false;
        const attempt = ++this._connectSeq;
        this.username = username;
        log.info('CALL', 'Connecting as', username, '(' + action + ')');

        // Created inside the click's call stack so iOS Safari allows it to run.
        if (!this.audioContext) {
            const Context = window.AudioContext || window.webkitAudioContext;
            if (Context) { try { this.audioContext = new Context(); } catch { this.audioContext = null; } }
        }
        if (this.audioContext && this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this._fail(window.isSecureContext ? 'This browser cannot use the microphone.' : 'Voice calls need a secure (HTTPS) connection to use the microphone.');
            return;
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false,
            });
        } catch (err) {
            if (attempt !== this._connectSeq) return;   // superseded while the prompt was open
            log.error('CALL', 'Microphone:', err.name);
            const message = err.name === 'NotAllowedError' || err.name === 'SecurityError'
                ? 'Microphone access was denied. Allow the microphone for this site and try again.'
                : err.name === 'NotFoundError' ? 'No microphone was found.' : 'The microphone could not be used (' + err.name + ').';
            this._fail(message);
            return;
        }
        // Closed, or connected again, while the permission prompt was open: release this stream and stop.
        if (this._intentionalClose || attempt !== this._connectSeq) {
            stream.getTracks().forEach((track) => track.stop());
            return;
        }
        this.localStream = stream;
        log.info('CALL', 'Microphone ready');
        this._watchLevel('self', this.localStream);

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let ws;
        try { ws = new WebSocket(protocol + '//' + location.host + '/ws/call'); }
        catch (err) { this._fail('Could not open a connection: ' + err.message); return; }
        this.ws = ws;
        ws.onopen = () => {
            log.debug('WS', 'Call socket open');
            if (action === 'create') ws.send(JSON.stringify({ type: 'create-call', username }));
            else ws.send(JSON.stringify({ type: 'join-call', username, code, session: this.session || undefined }));
        };
        ws.onmessage = (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            if (msg && typeof msg === 'object') this._handle(msg);
        };
        ws.onerror = () => log.warn('WS', 'Call socket error');
        ws.onclose = (event) => {
            if (this.ws !== ws) return;
            this.ws = null;
            log.info('WS', 'Call socket closed (' + event.code + ')');
            if (this._intentionalClose) return;
            const wasInCall = this.inCall;
            this._cleanup();
            if (this.onDisconnect) this.onDisconnect(wasInCall ? 'The connection to the call server was lost.' : 'Could not reach the call server.');
        };
    }

    toggleMute() {
        this.muted = !this.muted;
        if (this.localStream) this.localStream.getAudioTracks().forEach((track) => { track.enabled = !this.muted; });
        this._send({ type: 'mute', muted: this.muted });
        log.info('CALL', this.muted ? 'Muted' : 'Unmuted');
        return this.muted;
    }

    disconnect() {
        this._intentionalClose = true;
        this._cleanup();
    }

    _fail(message) {
        this._cleanup();
        if (this.onError) this.onError(message);
    }

    _cleanup() {
        this._connectSeq += 1;   // cancels any connect() still waiting on the microphone
        clearInterval(this._meterTimer);
        this._meterTimer = null;
        for (const meter of this._meters.values()) { try { meter.source.disconnect(); } catch { /* ignore */ } }
        this._meters.clear();
        for (const peerId of [...this.peers.keys()]) this._removePeer(peerId);
        this.names.clear();
        this.paths.clear();
        this.iceServers = null;
        if (this.localStream) { this.localStream.getTracks().forEach((track) => track.stop()); this.localStream = null; }
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            ws.onclose = null;
            ws.onmessage = null;
            try { ws.close(); } catch { /* already closed */ }
        }
        this.roomCode = '';
        this.peerId = null;
        this.muted = false;
    }

    _send(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    }

    _handle(msg) {
        log.debug('CALL', 'Received:', msg.type);
        switch (msg.type) {
            case 'call-joined': {
                this.roomCode = msg.code;
                this.peerId = msg.peerId;
                if (typeof msg.session === 'string') this.session = msg.session;
                this.iceServers = CallClient.sanitizeIceServers(msg.iceServers);
                if (this.iceServers) {
                    const relays = this.iceServers.filter((s) => s.urls.some((u) => u.startsWith('turn'))).length;
                    log.info('WEBRTC', 'ICE servers:', this.iceServers.length, '(' + relays + ' TURN)');
                }
                const peers = Array.isArray(msg.peers) ? msg.peers : [];
                for (const peer of peers) this.names.set(peer.peerId, peer.username);
                log.info('CALL', 'Joined call', msg.code, 'with', peers.length, 'existing peer(s)');
                if (this.onJoined) this.onJoined(msg.code);
                // The newcomer offers to everyone already in the call.
                for (const peer of peers) this._createPeer(peer.peerId, true);
                break;
            }
            case 'peer-joined':
                this.names.set(msg.peerId, msg.username);
                break;
            case 'signal':
                this._handleSignal(msg.from, msg.signal);
                break;
            case 'peer-left':
                this._removePeer(msg.peerId);
                this.names.delete(msg.peerId);
                break;
            case 'call-users': {
                const users = Array.isArray(msg.users) ? msg.users : [];
                for (const user of users) this.names.set(user.peerId, user.username);
                if (this.onUsers) this.onUsers(users);
                break;
            }
            case 'error':
                if (this.inCall) { if (this.onError) this.onError(msg.message); }
                else this._fail(msg.message);
                break;
            default:
                break;
        }
    }

    _createPeer(peerId, initiator) {
        this._removePeer(peerId);
        const pc = new RTCPeerConnection({ iceServers: this.iceServers || CallClient.ICE_SERVERS, iceTransportPolicy: CallClient.ICE_TRANSPORT_POLICY });
        const peer = { pc, audio: null, pendingCandidates: [], remoteReady: false };
        this.peers.set(peerId, peer);
        if (this.localStream) this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream));

        pc.ontrack = (event) => {
            const stream = event.streams[0] || new MediaStream([event.track]);
            if (!peer.audio) {
                peer.audio = document.createElement('audio');
                peer.audio.autoplay = true;
                peer.audio.setAttribute('playsinline', '');
                this._audioHost.appendChild(peer.audio);
            }
            if (peer.audio.srcObject !== stream) {
                peer.audio.srcObject = stream;
                this._watchLevel(peerId, stream);
            }
            const playing = peer.audio.play();
            if (playing && playing.catch) playing.catch(() => {});
        };
        pc.onicecandidate = (event) => {
            if (event.candidate) this._send({ type: 'signal', to: peerId, signal: { candidate: event.candidate.toJSON() } });
        };
        pc.onconnectionstatechange = () => {
            log.debug('WEBRTC', peerId, pc.connectionState);
            if (pc.connectionState === 'connected') this._reportPath(peerId, pc);
            if (pc.connectionState === 'failed' && initiator && pc.restartIce) pc.restartIce();
        };
        // Only the initiator ever offers, so the two sides can never offer at the same time.
        if (initiator) pc.onnegotiationneeded = () => this._offer(peerId, pc);
        log.debug('WEBRTC', 'Peer connection created for', peerId, initiator ? '(initiator)' : '(responder)');
        return peer;
    }


    async _offer(peerId, pc) {
        if (pc.signalingState !== 'stable') return;
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this._send({ type: 'signal', to: peerId, signal: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
            log.debug('WEBRTC', 'Sent offer to', peerId);
        } catch (err) { log.error('WEBRTC', 'Offer failed:', err.message); }
    }

    async _handleSignal(from, signal) {
        if (!signal || typeof from !== 'string') return;
        try {
            if (signal.sdp && signal.sdp.type === 'offer') {
                let peer = this.peers.get(from);
                // Reuse a healthy connection for a renegotiation (ICE restart); otherwise start fresh.
                if (!peer || peer.pc.signalingState !== 'stable' || peer.pc.connectionState === 'closed') peer = this._createPeer(from, false);
                await peer.pc.setRemoteDescription(signal.sdp);
                peer.remoteReady = true;
                await this._flushCandidates(peer);
                const answer = await peer.pc.createAnswer();
                await peer.pc.setLocalDescription(answer);
                this._send({ type: 'signal', to: from, signal: { sdp: { type: answer.type, sdp: answer.sdp } } });
                return;
            }
            const peer = this.peers.get(from);
            if (!peer) return;
            if (signal.sdp && signal.sdp.type === 'answer') {
                if (peer.pc.signalingState === 'have-local-offer') {
                    await peer.pc.setRemoteDescription(signal.sdp);
                    peer.remoteReady = true;
                    await this._flushCandidates(peer);
                }
                return;
            }
            if (signal.candidate) {
                if (peer.remoteReady) await peer.pc.addIceCandidate(signal.candidate).catch((err) => log.debug('WEBRTC', 'Candidate rejected:', err.message));
                else peer.pendingCandidates.push(signal.candidate);   // arrived before the remote description
            }
        } catch (err) { log.error('WEBRTC', 'Signal error:', err.message); }
    }

    async _flushCandidates(peer) {
        const pending = peer.pendingCandidates.splice(0);
        for (const candidate of pending) await peer.pc.addIceCandidate(candidate).catch(() => {});
    }

    _removePeer(peerId) {
        const peer = this.peers.get(peerId);
        if (!peer) return;
        this.peers.delete(peerId);
        try {
            peer.pc.ontrack = null;
            peer.pc.onicecandidate = null;
            peer.pc.onnegotiationneeded = null;
            peer.pc.onconnectionstatechange = null;
            peer.pc.close();
        } catch { /* already closed */ }
        if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
        const meter = this._meters.get(peerId);
        if (meter) { try { meter.source.disconnect(); } catch { /* ignore */ } this._meters.delete(peerId); }
        if (this.onSpeaking) this.onSpeaking(peerId, false);
        if (this.paths.delete(peerId) && this.onPath) this.onPath(peerId, null);
        log.debug('WEBRTC', 'Peer removed:', peerId);
    }

    // Which way the audio actually goes: straight to the peer, or relayed through a TURN server.
    async _reportPath(peerId, pc) {
        let stats;
        try { stats = await pc.getStats(); } catch { return; }
        if (!this.peers.has(peerId) || this.peers.get(peerId).pc !== pc) return;
        let pair = null;
        stats.forEach((report) => {
            if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId) || pair;
        });
        if (!pair) stats.forEach((report) => { if (report.type === 'candidate-pair' && (report.selected || report.nominated) && report.state === 'succeeded') pair = pair || report; });
        if (!pair) return;
        const local = stats.get(pair.localCandidateId) || {};
        const remote = stats.get(pair.remoteCandidateId) || {};
        const path = local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay' : 'direct';
        log.info('WEBRTC', 'Connected to', this.names.get(peerId) || peerId, 'via', path, '(' + (local.candidateType || '?') + ' → ' + (remote.candidateType || '?') + ')');
        this.paths.set(peerId, path);
        if (this.onPath) this.onPath(peerId, path);
    }

    // Only well-formed entries reach RTCPeerConnection; anything odd falls back to the built-in STUN list.
    static sanitizeIceServers(list) {
        if (!Array.isArray(list)) return null;
        const out = [];
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const hasCredentials = typeof item.username === 'string' && item.username && typeof item.credential === 'string' && item.credential;
            // Browsers throw on a turn: entry without credentials, so such URLs are dropped rather than the whole call.
            const urls = (Array.isArray(item.urls) ? item.urls : [item.urls]).filter((u) => typeof u === 'string' && (/^stuns?:/.test(u) || (/^turns?:/.test(u) && hasCredentials)));
            if (!urls.length) continue;
            const entry = { urls };
            if (typeof item.username === 'string') entry.username = item.username;
            if (typeof item.credential === 'string') entry.credential = item.credential;
            out.push(entry);
        }
        return out.length ? out : null;
    }

    // Voice activity: sample each stream's level a few times a second.
    _watchLevel(id, stream) {
        if (!this.audioContext) return;
        const old = this._meters.get(id);
        if (old) { try { old.source.disconnect(); } catch { /* ignore */ } }
        try {
            const source = this.audioContext.createMediaStreamSource(stream);
            const analyser = this.audioContext.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.5;
            source.connect(analyser);
            this._meters.set(id, { source, analyser, data: new Uint8Array(analyser.fftSize), speaking: false });
            if (!this._meterTimer) this._meterTimer = setInterval(() => this._sampleLevels(), 120);
        } catch (err) { log.warn('CALL', 'Level meter unavailable:', err.message); }
    }

    _sampleLevels() {
        for (const [id, meter] of this._meters) {
            meter.analyser.getByteTimeDomainData(meter.data);
            let sum = 0;
            for (let i = 0; i < meter.data.length; i++) { const v = (meter.data[i] - 128) / 128; sum += v * v; }
            const rms = Math.sqrt(sum / meter.data.length);
            const speaking = rms > CallClient.SPEAKING_THRESHOLD && !(id === 'self' && this.muted);
            if (speaking !== meter.speaking) {
                meter.speaking = speaking;
                if (this.onSpeaking) this.onSpeaking(id, speaking);
            }
        }
    }
}
CallClient.ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];   // used only if the server sends none
CallClient.ICE_TRANSPORT_POLICY = 'all';   // 'relay' forces every call through TURN (handy for testing a relay)
CallClient.SPEAKING_THRESHOLD = 0.04;

// ─── JSAIClient: streams answers from /api/ai/chat (Server-Sent Events) ───
class JSAIClient {
    constructor() {
        this._controller = null;
        this.streaming = false;
        this.onToken = null;      // (chunk, fullTextSoFar)
        this.onNotice = null;     // (text) the model stopped early
        this.onComplete = null;   // (fullText)
        this.onError = null;      // (message, partialText)
    }

    async chat(messages) {
        if (this.streaming) return;
        this.streaming = true;
        const controller = new AbortController();
        this._controller = controller;
        let fullText = '';
        try {
            const res = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || 'Request failed (HTTP ' + res.status + ')');
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let failure = null;
            let finished = false;   // the server's [DONE] marker; without it the stream was cut off
            while (!failure) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const rawLine of lines) {
                    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload) continue;
                    if (payload === '[DONE]') { finished = true; continue; }
                    let event;
                    try { event = JSON.parse(payload); } catch { continue; }
                    if (event.error) { failure = event.error; break; }
                    if (event.content) {
                        fullText += event.content;
                        if (this.onToken) this.onToken(event.content, fullText);
                    }
                    if (event.notice && this.onNotice) this.onNotice(event.notice);
                }
            }
            if (failure) throw new Error(failure);
            if (!finished) throw new Error('The connection closed before the answer finished.');
            log.info('AI', 'Response:', fullText.length, 'chars');
            if (this.onComplete) this.onComplete(fullText);
        } catch (err) {
            if (err.name === 'AbortError') { log.info('AI', 'Stopped'); return; }
            log.error('AI', 'Error:', err.message);
            // A bare network failure surfaces as a TypeError with a browser-specific message.
            const message = err instanceof TypeError ? 'Could not reach JS AI. Check your connection and try again.' : err.message;
            if (this.onError) this.onError(message, fullText);
        } finally {
            if (this._controller === controller) { this._controller = null; this.streaming = false; }
        }
    }

    abort() {
        if (this._controller) this._controller.abort();
        this._controller = null;
        this.streaming = false;
    }

    async checkStatus() {
        try {
            const res = await fetch('/api/ai/status', { cache: 'no-store' });
            if (!res.ok) return { status: 'error' };
            return await res.json();
        } catch { return { status: 'offline' }; }
    }
}

// ─── ConversationStore: JS AI conversations in localStorage ───
class ConversationStore {
    static _load() {
        try {
            const data = JSON.parse(localStorage.getItem(ConversationStore.KEY));
            return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        } catch { return {}; }
    }

    static _save(store) {
        try { localStorage.setItem(ConversationStore.KEY, JSON.stringify(store)); return true; }
        catch (err) { log.error('AI', 'Could not save conversations:', err.message); return false; }
    }

    static list() {
        return Object.values(ConversationStore._load())
            .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .map((c) => ({ id: c.id, title: c.title || 'New conversation', messageCount: c.messages.length, updatedAt: c.updatedAt || c.createdAt || 0 }));
    }

    static get(id) {
        const conv = ConversationStore._load()[id];
        return conv && Array.isArray(conv.messages) ? conv : null;
    }

    /** Returns the new conversation, or null when the browser refused to store it. */
    static create(title) {
        const store = ConversationStore._load();
        const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const conv = { id, title, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
        store[id] = conv;
        return ConversationStore._save(store) ? conv : null;
    }

    /** Returns false when the browser refused to store it (storage full). */
    static save(conv) {
        const store = ConversationStore._load();
        conv.updatedAt = Date.now();
        store[conv.id] = conv;
        return ConversationStore._save(store);
    }

    static delete(id) {
        const store = ConversationStore._load();
        delete store[id];
        ConversationStore._save(store);
    }
}
ConversationStore.KEY = 'jsos_ai_conversations';
