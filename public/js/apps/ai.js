// ─── JS AI: Gemini chat with streaming answers, conversation history and message editing ───

'use strict';

// A small Markdown renderer for model output. Everything is escaped before any tag is added.
const Markdown = {
    render(source) {
        const text = String(source || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
        const codeBlocks = [];
        const body = text.replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (_, info, code) => {
            const lang = info.trim().split(/\s+/)[0] || '';
            // A fence indented under a list item keeps that indentation in the source; strip it.
            const codeLines = code.replace(/\n$/, '').split('\n');
            const indents = codeLines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
            const pad = indents.length ? Math.min(...indents) : 0;
            const dedented = codeLines.map((l) => l.slice(pad)).join('\n').replace(/\s+$/, '');
            const index = codeBlocks.push(
                '<div class="ai-code-block"><div class="ai-code-lang"><span>' + (escapeHtml(lang) || 'code') +
                '</span><button type="button" class="ai-code-copy">Copy</button></div><pre><code>' +
                escapeHtml(dedented) + '</code></pre></div>'
            ) - 1;
            return '\u0000' + index + '\u0000';
        });

        const out = [];
        const lines = body.split('\n');
        let paragraph = [];
        let quote = [];
        let table = [];
        const lists = [];          // open lists: { type, indent }
        let pendingBlank = false;

        const flushParagraph = () => {
            if (!paragraph.length) return;
            out.push('<p>' + Markdown.inline(paragraph.join('\n')).replace(/\n/g, '<br>') + '</p>');
            paragraph = [];
        };
        const flushQuote = () => {
            if (!quote.length) return;
            out.push('<blockquote>' + Markdown.inline(quote.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
            quote = [];
        };
        const flushTable = () => {
            if (!table.length) return;
            const rows = table;
            table = [];
            if (rows.length >= 2 && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(rows[1])) {
                const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => Markdown.inline(c.trim()));
                let html = '<table><thead><tr>' + cells(rows[0]).map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
                for (const row of rows.slice(2)) html += '<tr>' + cells(row).map((c) => '<td>' + c + '</td>').join('') + '</tr>';
                out.push(html + '</tbody></table>');
            } else {
                paragraph.push(...rows);
                flushParagraph();
            }
        };
        const closeLists = (toIndent) => {
            while (lists.length && lists[lists.length - 1].indent > toIndent) out.push('</li></' + lists.pop().type + '>');
        };
        const flushAll = () => { flushParagraph(); flushQuote(); flushTable(); closeLists(-1); };

        for (const line of lines) {
            const codeMatch = line.match(/^\s*\u0000(\d+)\u0000\s*$/);
            if (codeMatch) { flushAll(); out.push(codeBlocks[Number(codeMatch[1])]); pendingBlank = false; continue; }

            if (!line.trim()) { flushParagraph(); flushQuote(); flushTable(); pendingBlank = true; continue; }

            if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); pendingBlank = false; continue; }

            const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
            if (listMatch) {
                flushParagraph(); flushQuote(); flushTable();
                const indent = listMatch[1].length;
                const type = /\d/.test(listMatch[2]) ? 'ol' : 'ul';
                // A numbered list interrupted by a code block or paragraph continues from its own number.
                const number = type === 'ol' ? parseInt(listMatch[2], 10) : 0;
                const openTag = '<' + type + (number > 1 ? ' start="' + number + '"' : '') + '><li>';
                closeLists(indent);
                const top = lists[lists.length - 1];
                if (top && Math.abs(top.indent - indent) <= 1) {
                    if (top.type !== type) { out.push('</li></' + lists.pop().type + '>'); lists.push({ type, indent }); out.push(openTag); }
                    else out.push('</li><li>');
                } else {
                    lists.push({ type, indent });
                    out.push(openTag);
                }
                out.push(Markdown.inline(listMatch[3]));
                pendingBlank = false;
                continue;
            }

            // Text indented under an open list item continues that item.
            const top = lists[lists.length - 1];
            if (top && !pendingBlank && /^\s{2,}\S/.test(line)) { out.push('<br>' + Markdown.inline(line.trim())); continue; }
            closeLists(-1);
            pendingBlank = false;

            const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
            if (heading) {
                flushParagraph(); flushQuote(); flushTable();
                const level = Math.min(heading[1].length, 3);
                out.push('<h' + level + '>' + Markdown.inline(heading[2]) + '</h' + level + '>');
                continue;
            }

            if (/^\s*>/.test(line)) { flushParagraph(); flushTable(); quote.push(line.replace(/^\s*>\s?/, '')); continue; }
            flushQuote();

            if (/^\s*\|/.test(line)) { flushParagraph(); table.push(line); continue; }
            flushTable();

            paragraph.push(line);
        }
        flushAll();
        return out.join('').replace(/\u0000(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)] || '');
    },

    inline(text) {
        let s = escapeHtml(text);
        const codes = [];
        s = s.replace(/`([^`\n]+)`/g, (_, code) => '\u0001' + (codes.push('<code class="ai-inline-code">' + code + '</code>') - 1) + '\u0001');
        s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        s = s.replace(/\*\*(\S(?:[^*\n]*?\S)?)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/__(\S(?:[^_\n]*?\S)?)__/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^*\w])\*(\S(?:[^*\n]*?\S)?)\*(?!\w)/g, '$1<em>$2</em>');
        s = s.replace(/(^|[^_\w])_(\S(?:[^_\n]*?\S)?)_(?!\w)/g, '$1<em>$2</em>');
        s = s.replace(/~~(\S(?:[^~\n]*?\S)?)~~/g, '<del>$1</del>');
        return s.replace(/\u0001(\d+)\u0001/g, (_, index) => codes[Number(index)]);
    },
};

class JSAIApp extends BaseApp {
    constructor(desktop) {
        super(desktop, 'ai-window', 'ai-icon');
        this.client = new JSAIClient();
        this.conversation = null;
        this._selectedId = null;
        this._streamingEl = null;
        this._fullText = '';
        this._notice = null;
        this._renderFrame = 0;
        this.els = {
            lobby: $('ai-lobby'), chat: $('ai-chat'), messages: $('ai-messages'), input: $('ai-input'), form: $('ai-form'),
            sendBtn: $('ai-send-btn'), stopBtn: $('ai-stop-btn'), backBtn: $('ai-back-btn'), convTitle: $('ai-conv-title'),
            convList: $('ai-conv-list'), newBtn: $('ai-new-btn'), delBtn: $('ai-del-btn'),
            statusText: $('ai-status-text'), model: $('ai-model'), announcer: $('ai-announcer'),
        };
        this._bindClient();
        this._bindUI();
    }

    onLaunch() {
        this._showLobby();
        this._checkStatus();
    }

    onRestore() {
        if (this.conversation) this.els.input.focus({ preventScroll: true });
    }

    onClose() {
        this._leaveConversation();
        this._showLobby();
    }

    async _checkStatus() {
        const status = await this.client.checkStatus();
        this.els.model.textContent = status.model ? '(' + status.model + ')' : '';
        if (status.status === 'ok') return;
        this.els.statusText.textContent = 'Unavailable';
        this.desktop.showErrorDialog(status.status === 'missing-key'
            ? 'JS AI is not configured: the server has no Gemini API key. Add GEMINI_API_KEY to the server environment and restart it.'
            : 'JS AI could not reach the server. Check that it is running.');
    }

    // ─── Client events ───
    _bindClient() {
        // Tokens arrive faster than frames: render at most once per frame, and only follow the
        // answer down when the reader is already at the bottom.
        this.client.onToken = (chunk, fullText) => {
            this._fullText = fullText;
            if (!this._streamingEl || this._renderFrame) return;
            this._renderFrame = requestAnimationFrame(() => {
                this._renderFrame = 0;
                if (!this._streamingEl) return;
                const stick = this._isNearBottom();
                this._streamingEl.querySelector('.ai-message-content').innerHTML = Markdown.render(this._fullText);
                if (stick) this._scrollToBottom();
            });
        };
        this.client.onNotice = (text) => { this._notice = text; };
        this.client.onComplete = (fullText) => this._finishAssistant(fullText, this._notice);
        this.client.onError = (message, partial) => {
            if (partial) this._finishAssistant(partial, 'Stopped: ' + message);
            else this._discardAssistant();
            this.desktop.showErrorDialog(message);
        };
    }

    // ─── UI events ───
    _bindUI() {
        this.els.newBtn.addEventListener('click', () => {
            const conv = ConversationStore.create('New conversation');
            if (!conv) { this.desktop.showErrorDialog('Conversations cannot be saved: browser storage is full or blocked.'); return; }
            this._openConversation(conv.id);
        });
        this.els.delBtn.addEventListener('click', () => this._deleteSelected());
        this.els.backBtn.addEventListener('click', () => this._backToLobby());
        this.els.form.addEventListener('submit', (e) => { e.preventDefault(); this._sendMessage(); });
        this.els.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this._sendMessage(); }
        });
        this.els.stopBtn.addEventListener('click', () => this._stop());
        this.els.convList.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this._selectedId) { e.preventDefault(); this._openConversation(this._selectedId); }
            if (e.key === 'Delete' && this._selectedId) { e.preventDefault(); this._deleteSelected(); }
        });
        // Copy buttons on code blocks (delegated: blocks are re-rendered while streaming)
        this.els.messages.addEventListener('click', async (e) => {
            const button = e.target.closest('.ai-code-copy');
            if (!button) return;
            const code = button.closest('.ai-code-block').querySelector('code');
            const ok = await copyText(code ? code.textContent : '');
            this.desktop.showToast(ok ? 'Code copied!' : 'Could not copy');
        });
    }

    async _deleteSelected() {
        if (!this._selectedId) return;
        const ok = await this.desktop.showConfirmDialog('Delete this conversation? This cannot be undone.', { okLabel: 'Delete' });
        if (!ok) return;
        ConversationStore.delete(this._selectedId);
        this._selectedId = null;
        this._showLobby();
    }

    // ─── Lobby ───
    _showLobby() {
        this.els.lobby.hidden = false;
        this.els.chat.hidden = true;
        this._selectedId = null;
        this.els.delBtn.disabled = true;
        this.els.convList.innerHTML = '';

        const conversations = ConversationStore.list();
        if (!conversations.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-conv-empty';
            empty.textContent = 'No conversations yet! Press + to start one.';
            this.els.convList.appendChild(empty);
            return;
        }
        conversations.forEach((conv, index) => {
            const item = document.createElement('div');
            item.className = 'ai-conv-item';
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', 'false');
            item.tabIndex = 0;
            item.style.animationDelay = (Math.min(index, 8) * 0.06) + 's';   // rows below the fold appear at once

            const icon = document.createElement('div');
            icon.className = 'ai-conv-item-icon';
            icon.textContent = '✨';
            const info = document.createElement('div');
            info.className = 'ai-conv-item-info';
            const name = document.createElement('div');
            name.className = 'ai-conv-item-name';
            name.textContent = conv.title;
            const meta = document.createElement('div');
            meta.className = 'ai-conv-item-meta';
            meta.textContent = conv.messageCount + ' message' + (conv.messageCount === 1 ? '' : 's') + ' · ' + new Date(conv.updatedAt).toLocaleDateString();
            info.append(name, meta);
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'ai-conv-item-open';
            open.textContent = 'Open ▶';
            open.addEventListener('click', (e) => { e.stopPropagation(); this._openConversation(conv.id); });
            item.append(icon, info, open);

            item.addEventListener('click', () => this._select(item, conv.id));
            item.addEventListener('focus', () => this._select(item, conv.id));
            item.addEventListener('dblclick', () => this._openConversation(conv.id));
            this.els.convList.appendChild(item);
        });
    }

    _select(item, id) {
        for (const el of this.els.convList.querySelectorAll('.ai-conv-item')) {
            el.classList.remove('selected');
            el.setAttribute('aria-selected', 'false');
        }
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
        this._selectedId = id;
        this.els.delBtn.disabled = false;
    }

    _openConversation(id) {
        const conv = ConversationStore.get(id);
        if (!conv) { this._showLobby(); return; }
        this.conversation = conv;
        this.els.lobby.hidden = true;
        this.els.chat.hidden = false;
        this.els.convTitle.textContent = conv.title;
        this._setStreaming(false);
        this._renderAllMessages();
        this.els.input.focus({ preventScroll: true });
    }

    _leaveConversation() {
        if (this.client.streaming) this._stop();
        // A conversation that never got a message would only clutter the list.
        if (this.conversation && !this.conversation.messages.length) ConversationStore.delete(this.conversation.id);
        this.conversation = null;
        this._streamingEl = null;
        this._fullText = '';
        this._notice = null;
        this.els.messages.innerHTML = '';
        this.els.input.value = '';
        this._setStreaming(false);
    }

    _backToLobby() {
        this._leaveConversation();
        this._showLobby();
    }

    // ─── Sending & streaming ───
    _sendMessage() {
        const text = this.els.input.value.trim();
        if (!text || !this.conversation || this.client.streaming) return;
        const conv = this.conversation;
        conv.messages.push({ role: 'user', content: text, timestamp: Date.now() });
        if (conv.messages.filter((m) => m.role === 'user').length === 1) {
            const chars = [...text];   // by code point, so an emoji is never cut in half
            conv.title = chars.length > 60 ? chars.slice(0, 60).join('') + '…' : text;
            this.els.convTitle.textContent = conv.title;
        }
        if (!ConversationStore.save(conv)) this.desktop.showToast('Storage is full — this conversation is not being saved');
        this._appendUserMessage(text, conv.messages.length - 1);
        this.els.input.value = '';
        this._notice = null;
        this._fullText = '';
        this._setStreaming(true);
        this._streamingEl = this._appendAssistantPlaceholder();
        this._scrollToBottom();
        this.client.chat(conv.messages.map((m) => ({ role: m.role, content: m.content })));
    }

    _stop() {
        this.client.abort();
        if (this._fullText) this._finishAssistant(this._fullText, 'Stopped');
        else this._discardAssistant();
    }

    _finishAssistant(text, notice) {
        cancelAnimationFrame(this._renderFrame);
        this._renderFrame = 0;
        const conv = this.conversation;
        if (conv && text) {
            const entry = { role: 'assistant', content: text, timestamp: Date.now() };
            if (notice) entry.notice = notice;
            conv.messages.push(entry);
            if (!ConversationStore.save(conv)) this.desktop.showToast('Storage is full — this conversation is not being saved');
        }
        if (text) this.els.announcer.textContent = text;   // one announcement for screen readers
        if (this._streamingEl) {
            const el = this._streamingEl;
            el.classList.remove('streaming');
            const content = el.querySelector('.ai-message-content');
            if (text) content.innerHTML = Markdown.render(text);
            else { content.innerHTML = ''; content.textContent = notice || 'No answer was returned.'; content.classList.add('ai-thinking'); }
            if (text && notice) el.appendChild(this._noticeEl(notice));
            el.appendChild(this._timeEl(Date.now()));
        }
        this._streamingEl = null;
        this._fullText = '';
        this._notice = null;
        this._setStreaming(false);
    }

    _discardAssistant() {
        cancelAnimationFrame(this._renderFrame);
        this._renderFrame = 0;
        if (this._streamingEl) this._streamingEl.remove();
        this._streamingEl = null;
        this._fullText = '';
        this._notice = null;
        this._setStreaming(false);
    }

    _setStreaming(active) {
        this.els.sendBtn.disabled = active;
        // readOnly rather than disabled: a disabled field drops focus and closes the phone keyboard.
        this.els.input.readOnly = active;
        this.els.stopBtn.hidden = !active;
        this.els.statusText.textContent = active ? 'Generating…' : 'Ready';
        if (!active && this.conversation) this.els.input.focus({ preventScroll: true });
    }

    // ─── Rendering ───
    _scrollToBottom() { this.els.messages.scrollTop = this.els.messages.scrollHeight; }

    _isNearBottom() {
        const el = this.els.messages;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }

    _timeEl(timestamp) {
        const time = document.createElement('div');
        time.className = 'ai-message-time';
        time.textContent = formatTime(timestamp);
        return time;
    }

    _noticeEl(text) {
        const notice = document.createElement('div');
        notice.className = 'ai-message-notice';
        notice.textContent = text;
        return notice;
    }

    _appendUserMessage(text, index, timestamp) {
        const div = document.createElement('div');
        div.className = 'ai-message ai-message-user';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'ai-edit-btn';
        edit.innerHTML = '&#9998;';
        edit.title = 'Edit and resend from here';
        edit.setAttribute('aria-label', 'Edit and resend from here');
        edit.addEventListener('click', () => this._editMessage(index));
        const content = document.createElement('div');
        content.className = 'ai-message-content';
        content.textContent = text;
        div.append(edit, content, this._timeEl(timestamp || Date.now()));
        this.els.messages.appendChild(div);
        this._scrollToBottom();
    }

    _appendAssistantMessage(message) {
        const div = document.createElement('div');
        div.className = 'ai-message ai-message-assistant';
        const content = document.createElement('div');
        content.className = 'ai-message-content';
        content.innerHTML = Markdown.render(message.content);
        div.appendChild(content);
        if (message.notice) div.appendChild(this._noticeEl(message.notice));
        div.appendChild(this._timeEl(message.timestamp));
        this.els.messages.appendChild(div);
    }

    _appendAssistantPlaceholder() {
        const div = document.createElement('div');
        div.className = 'ai-message ai-message-assistant streaming';
        const content = document.createElement('div');
        content.className = 'ai-message-content';
        content.innerHTML = '<span class="ai-thinking">Thinking<span class="ai-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>';
        div.appendChild(content);
        this.els.messages.appendChild(div);
        return div;
    }

    _renderAllMessages() {
        this.els.messages.innerHTML = '';
        this.conversation.messages.forEach((message, index) => {
            if (message.role === 'user') this._appendUserMessage(message.content, index, message.timestamp);
            else if (message.role === 'assistant') this._appendAssistantMessage(message);
        });
        this._scrollToBottom();
    }

    /** Puts a sent message back into the input and drops it and everything after it from the conversation. */
    async _editMessage(index) {
        if (this.client.streaming || !this.conversation) return;
        const message = this.conversation.messages[index];
        if (!message || message.role !== 'user') return;
        const later = this.conversation.messages.length - index - 1;
        if (later > 0) {
            const ok = await this.desktop.showConfirmDialog('Edit this message? The ' + later + ' message' + (later === 1 ? '' : 's') + ' after it will be removed.', { okLabel: 'Edit' });
            if (!ok || this.client.streaming || !this.conversation) return;
        }
        this.conversation.messages = this.conversation.messages.slice(0, index);
        if (!ConversationStore.save(this.conversation)) this.desktop.showToast('Storage is full — this conversation is not being saved');
        this._renderAllMessages();
        this.els.input.value = message.content;
        this.els.input.focus();
    }
}
