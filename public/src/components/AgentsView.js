
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';
import { sessionStore } from '../services/SessionStore.js';
import { store } from '../store.js';
import { markdownRenderer } from '../utils/markdown.js';

export class AgentsView extends Component {
    constructor() {
        super();
        this.isLoading = false;
        this.currentAbortController = null;
        this.streamStartTime = null;
        this.streamTimerInterval = null;
        this.streamUsageData = null;
        this.pendingAttachments = [];
    }

    async connectedCallback() {
        super.connectedCallback();
        await Promise.all([this.loadAgents(), this.loadLLMs()]);
        this.restoreActiveSession();
    }

    disconnectedCallback() {
        this.stopStreamTimer();
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
    }

    formatElapsedTime(ms) {
        if (ms < 1000) return `${ms}ms`;
        const seconds = ms / 1000;
        if (seconds < 60) return `${seconds.toFixed(1)}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = (seconds % 60).toFixed(0);
        return `${minutes}m ${remainingSeconds}s`;
    }

    estimateTokens(text) {
        return Math.round((text || '').length / 4);
    }

    cancelCurrentStream() {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
        }
    }

    startStreamTimer(responseId) {
        this.streamStartTime = Date.now();
        this.streamTimerInterval = setInterval(() => {
            const elapsed = Date.now() - this.streamStartTime;
            const bubble = this.querySelector(`#${responseId}`);
            if (!bubble) return;
            const timerEl = bubble.parentElement.querySelector('.stream-elapsed');
            if (timerEl) {
                timerEl.textContent = this.formatElapsedTime(elapsed);
            }
        }, 100);
    }

    stopStreamTimer(responseId, inputMessage, finalContent, wasCancelled) {
        if (this.streamTimerInterval) {
            clearInterval(this.streamTimerInterval);
            this.streamTimerInterval = null;
        }

        const elapsed = this.streamStartTime ? Date.now() - this.streamStartTime : 0;
        this.streamStartTime = null;

        const bubble = this.querySelector(`#${responseId}`);
        if (!bubble) return;

        const wrapper = bubble.parentElement;
        const statusBar = wrapper.querySelector('.stream-status-bar');
        const statsBar = wrapper.querySelector('.stream-stats-bar');

        if (statusBar) statusBar.classList.add('hidden');

        if (statsBar) {
            const elapsedEl = statsBar.querySelector('.stats-elapsed');
            const inputTokensEl = statsBar.querySelector('.stats-input-tokens');
            const outputTokensEl = statsBar.querySelector('.stats-output-tokens');
            const tpsEl = statsBar.querySelector('.stats-tps');

            const usage = this.streamUsageData;
            const hasRealUsage = usage && (usage.input_tokens > 0 || usage.output_tokens > 0);

            const inputTokens = hasRealUsage ? usage.input_tokens : this.estimateTokens(inputMessage);
            const outputTokens = hasRealUsage ? usage.output_tokens : this.estimateTokens(finalContent);
            const prefix = hasRealUsage ? '' : '~';

            if (elapsedEl) elapsedEl.textContent = this.formatElapsedTime(elapsed);
            if (inputTokensEl) inputTokensEl.textContent = `${prefix}${inputTokens} input`;
            if (outputTokensEl) outputTokensEl.textContent = `${prefix}${outputTokens} output`;

            if (tpsEl) {
                const seconds = elapsed / 1000;
                const tps = seconds > 0 ? (outputTokens / seconds).toFixed(1) : 0;
                tpsEl.textContent = `${prefix}${tps} tok/s`;
            }

            this.streamUsageData = null;

            if (wasCancelled) {
                const cancelBadge = document.createElement('span');
                cancelBadge.className = 'text-xs text-amber-400 font-medium ml-2';
                cancelBadge.textContent = 'Cancelled';
                statsBar.appendChild(cancelBadge);
            }

            statsBar.classList.remove('hidden');
        }
    }

    async loadAgents() {
        try {
            const agents = await api.getAgents();
            agents.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            store.set('agents', agents);
        } catch (e) {
            console.error('Failed to load agents', e);
        }
    }

    async loadLLMs() {
        try {
            const llms = await api.getLLMs();
            store.set('llms', llms);
        } catch (e) {
            console.error('Failed to load LLMs', e);
        }
    }

    // --- Sidebar toggle (mobile) ---

    _isMobile() {
        return !window.matchMedia('(min-width: 768px)').matches;
    }

    toggleSidebar(show) {
        const sidebar = this.querySelector('#sidebar');
        const backdrop = this.querySelector('#sidebarBackdrop');
        if (!sidebar || !backdrop) return;

        if (show) {
            sidebar.classList.remove('hidden');
            sidebar.classList.add('flex', 'sidebar-open');
            backdrop.classList.remove('hidden');
        } else {
            sidebar.classList.add('hidden');
            sidebar.classList.remove('flex', 'sidebar-open');
            backdrop.classList.add('hidden');
        }
    }

    // --- Session management ---

    restoreActiveSession() {
        const activeId = sessionStore.getActiveId();
        if (activeId && sessionStore.get(activeId)) {
            this.switchToSession(activeId);
        } else {
            this.showEmptyState();
        }
        this.renderSessionList();
    }

    renderSessionList() {
        const list = this.querySelector('#sessionList');
        if (!list) return;

        const sessions = sessionStore.getAll();
        const activeId = sessionStore.getActiveId();

        if (sessions.length === 0) {
            list.innerHTML = '<div class="text-gray-500 text-sm text-center py-8">No conversations yet</div>';
            return;
        }

        list.innerHTML = sessions.map(s => {
            const isActive = s.id === activeId;
            const isAgent = s.agentType === 'agent';
            const displayName = isAgent ? (s.agentName || 'Agent') : (s.llmName || 'LLM');
            const icon = isAgent ? 'fa-robot' : 'fa-microchip';

            const activeClasses = isActive
                ? 'bg-dark-hover/80 border-l-2 border-l-blue-500'
                : 'hover:bg-dark-hover/40 border-l-2 border-l-transparent';

            return `
                <div data-session-id="${s.id}" class="session-item group flex items-start gap-2 px-3 py-2.5 cursor-pointer rounded-lg mb-0.5 transition-colors ${activeClasses}">
                    <div class="flex-1 min-w-0">
                        <div class="text-sm ${isActive ? 'text-gray-100' : 'text-gray-300'} truncate">${this.escapeHtml(s.title)}</div>
                        <div class="flex items-center gap-1.5 mt-0.5 text-xs text-gray-500">
                            <i class="fas ${icon} text-[10px]"></i>
                            <span class="truncate">${this.escapeHtml(displayName)}</span>
                        </div>
                    </div>
                    <button data-delete-id="${s.id}" class="session-delete-btn flex-shrink-0 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1 mt-0.5" title="Delete">
                        <i class="fas fa-xmark text-xs"></i>
                    </button>
                </div>
            `;
        }).join('');

        // Event listeners
        list.querySelectorAll('.session-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.session-delete-btn')) return;
                this.switchToSession(item.dataset.sessionId);
            });
        });

        list.querySelectorAll('.session-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteSession(btn.dataset.deleteId);
            });
        });
    }

    switchToSession(sessionId) {
        // Abort any running stream
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
        this.isLoading = false;

        const session = sessionStore.get(sessionId);
        if (!session) return;

        sessionStore.setActiveId(sessionId);

        // Update store with this session's agent/LLM
        const agents = store.get('agents') || [];
        const llms = store.get('llms') || [];

        if (session.agentType === 'agent') {
            const agent = agents.find(a => a.name === session.agentName);
            store.set('selectedAgent', agent || null);
            store.set('selectedLlm', null);
            store.set('selectionType', 'agent');
        } else {
            const llm = llms.find(l => l.name === session.llmName);
            store.set('selectedLlm', llm || null);
            store.set('selectedAgent', null);
            store.set('selectionType', 'llm');
        }

        this.restoreMessages(session);
        this.updateChatHeader(session);
        this.renderSessionList();
        this.updateUiState();

        // Close sidebar on mobile after selecting
        if (this._isMobile()) {
            this.toggleSidebar(false);
        }

        const input = this.querySelector('#chatInput');
        if (input) {
            input.disabled = false;
            input.readOnly = false;
            input.classList.remove('cursor-pointer');
            input.focus();
        }
    }

    async restoreMessages(session) {
        const container = this.querySelector('#chatMessages');
        if (!container) return;
        container.innerHTML = '';

        if (session.messages.length === 0) {
            this._appendWelcomeMessage(container);
            return;
        }

        for (const msg of session.messages) {
            if (msg.role === 'user') {
                this.appendMessage('user', msg.content);
            } else {
                this.appendRestoredAssistantMessage(msg.content);
            }
        }

        // Check if server still has this session (survives restarts)
        try {
            const exists = await api.checkSession(session.id);
            if (!exists) {
                this._appendSessionResetBanner(container);
            }
        } catch {
            // Server unreachable — skip banner
        }
    }

    appendRestoredAssistantMessage(content) {
        const container = this.querySelector('#chatMessages');
        const div = document.createElement('div');
        div.className = 'response-wrapper';

        const bubble = document.createElement('div');
        bubble.className = 'flex justify-start';
        bubble.innerHTML = `
            <div class="response-bubble-inner max-w-4xl bg-dark-surface border border-dark-border rounded-3xl px-5 py-3 text-gray-100 text-[15px] leading-relaxed relative group">
                <div class="response-content markdown-content"></div>
            </div>
        `;

        const contentDiv = bubble.querySelector('.response-content');
        const rendered = markdownRenderer.render(content);
        contentDiv.innerHTML = rendered;
        markdownRenderer.highlightCode(contentDiv);

        div.appendChild(bubble);
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    showNewSessionModal() {
        // Remove existing modal if any
        const existing = document.querySelector('#newSessionModal');
        if (existing) existing.remove();

        const agents = store.get('agents') || [];
        const llms = store.get('llms') || [];

        const overlay = document.createElement('div');
        overlay.id = 'newSessionModal';
        overlay.className = 'modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/70';

        let itemsHtml = '';

        if (agents.length > 0) {
            itemsHtml += '<div class="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">Agents</div>';
            itemsHtml += agents.map(a => `
                <button data-type="agent" data-name="${this.escapeHtml(a.name)}" class="modal-pick-item w-full text-left px-4 py-3 hover:bg-dark-hover cursor-pointer transition-colors border-b border-dark-border/50 flex items-center gap-3">
                    <i class="fas fa-robot text-blue-400 text-sm"></i>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-gray-200">${this.escapeHtml(a.name)}</div>
                        <div class="text-xs text-gray-500 truncate">${this.escapeHtml(a.description || '')}</div>
                    </div>
                </button>
            `).join('');
        }

        if (llms.length > 0) {
            itemsHtml += '<div class="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">LLMs</div>';
            itemsHtml += llms.map(l => `
                <button data-type="llm" data-name="${this.escapeHtml(l.name)}" class="modal-pick-item w-full text-left px-4 py-3 hover:bg-dark-hover cursor-pointer transition-colors border-b border-dark-border/50 flex items-center gap-3">
                    <i class="fas fa-microchip text-purple-400 text-sm"></i>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-gray-200">${this.escapeHtml(l.name)}</div>
                        <div class="text-xs text-gray-500 truncate">${this.escapeHtml(l.model || '')}</div>
                    </div>
                </button>
            `).join('');
        }

        if (!itemsHtml) {
            itemsHtml = '<div class="text-gray-500 text-sm text-center py-8">No agents or LLMs available</div>';
        }

        overlay.innerHTML = `
            <div class="modal-content bg-dark-surface border border-dark-border rounded-2xl shadow-2xl w-[420px] max-w-[90vw] max-h-[70vh] flex flex-col overflow-hidden">
                <div class="flex items-center justify-between px-5 py-4 border-b border-dark-border">
                    <h3 class="text-lg font-semibold text-gray-100">New conversation</h3>
                    <button id="closeNewSessionModal" class="text-gray-400 hover:text-gray-200 transition-colors p-1">
                        <i class="fas fa-xmark"></i>
                    </button>
                </div>
                <div class="overflow-y-auto custom-scrollbar flex-1">
                    ${itemsHtml}
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Close on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        overlay.querySelector('#closeNewSessionModal').addEventListener('click', () => overlay.remove());

        // Pick handler
        overlay.querySelectorAll('.modal-pick-item').forEach(item => {
            item.addEventListener('click', () => {
                const type = item.dataset.type;
                const name = item.dataset.name;

                const session = sessionStore.create({
                    agentName: type === 'agent' ? name : null,
                    agentType: type,
                    llmName: type === 'llm' ? name : null
                });

                overlay.remove();
                this.switchToSession(session.id);
            });
        });
    }

    deleteSession(sessionId) {
        sessionStore.delete(sessionId);
        const activeId = sessionStore.getActiveId();

        if (!activeId || activeId === sessionId) {
            // Switch to most recent remaining session
            const sessions = sessionStore.getAll();
            if (sessions.length > 0) {
                this.switchToSession(sessions[0].id);
            } else {
                this.showEmptyState();
                this.renderSessionList();
            }
        } else {
            this.renderSessionList();
        }
    }

    showEmptyState() {
        const container = this.querySelector('#chatMessages');
        if (container) {
            container.innerHTML = `
                <div class="flex-1 flex items-center justify-center h-full">
                    <div class="text-center text-gray-500">
                        <i class="fas fa-comments text-4xl mb-4 text-gray-600"></i>
                        <p class="text-lg">Start a new conversation</p>
                        <p class="text-sm mt-1">Click "New chat" to begin</p>
                    </div>
                </div>
            `;
        }

        this.updateChatHeader(null);

        const input = this.querySelector('#chatInput');
        if (input) {
            input.disabled = false;
            input.readOnly = true;
            input.classList.add('cursor-pointer');
        }

        const btn = this.querySelector('#sendMessageBtn');
        if (btn) btn.disabled = true;
    }

    updateChatHeader(session) {
        const header = this.querySelector('#chatHeader');
        if (!header) return;

        if (!session) {
            header.innerHTML = '<span class="text-gray-500">No conversation selected</span>';
            return;
        }

        const isAgent = session.agentType === 'agent';
        const name = isAgent ? (session.agentName || 'Agent') : (session.llmName || 'LLM');
        const badgeText = isAgent ? 'Agent' : 'LLM';
        const badgeColor = isAgent ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400';
        const icon = isAgent ? 'fa-robot' : 'fa-microchip';

        let extraBadges = '';
        if (isAgent) {
            const agents = store.get('agents') || [];
            const agent = agents.find(a => a.name === session.agentName);
            if (agent) {
                if (agent.publish?.enabled) {
                    const chatUrl = `/chat/${encodeURIComponent(agent.name)}`;
                    extraBadges += `<a href="${chatUrl}" target="_blank" class="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors no-underline" title="Open published chat"><i class="fas fa-globe text-[10px]"></i> Published</a>`;
                }

                const hasMemory = agent.memory === true || (agent.memory && agent.memory.enabled);
                if (hasMemory) {
                    extraBadges += `<span class="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400" title="Persistent memory enabled"><i class="fas fa-brain text-[10px]"></i> Memory</span>`;
                }

                if (agent.tools?.length) {
                    const toolNames = agent.tools.map(t => typeof t === 'string' ? t : t.name);
                    const toolListHtml = toolNames.map(t => `<div class="tools-popover-item">${this.escapeHtml(t)}</div>`).join('');
                    extraBadges += `
                        <span class="tools-badge-wrapper">
                            <span class="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400 cursor-default"><i class="fas fa-wrench text-[10px]"></i> ${toolNames.length} tool${toolNames.length !== 1 ? 's' : ''}</span>
                            <div class="tools-popover">${toolListHtml}</div>
                        </span>`;
                }
            }
        }

        header.innerHTML = `
            <div class="flex items-center gap-2 flex-wrap">
                <i class="fas ${icon} text-sm text-gray-400"></i>
                <span class="font-medium text-gray-200">${this.escapeHtml(name)}</span>
                <span class="text-xs px-2 py-0.5 rounded-full ${badgeColor}">${badgeText}</span>
                ${extraBadges}
            </div>
        `;
    }

    // --- File Attachments ---

    handleFileSelect(e) {
        const files = Array.from(e.target.files);
        e.target.value = '';

        const needsConversion = ['image/webp', 'image/bmp', 'image/tiff'];

        for (const file of files) {
            if (needsConversion.includes(file.type)) {
                this.convertImageToJpeg(file);
            } else {
                const reader = new FileReader();
                reader.onload = () => {
                    const dataUrl = reader.result;
                    const commaIdx = dataUrl.indexOf(',');
                    const base64 = dataUrl.slice(commaIdx + 1);
                    const mediaType = file.type || 'application/octet-stream';

                    this.pendingAttachments.push({ data: base64, mediaType, name: file.name });
                    this.renderAttachmentPreview();
                };
                reader.readAsDataURL(file);
            }
        }
    }

    convertImageToJpeg(file) {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            URL.revokeObjectURL(url);

            const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
            const base64 = dataUrl.split(',')[1];
            this.pendingAttachments.push({ data: base64, mediaType: 'image/jpeg', name: file.name });
            this.renderAttachmentPreview();
        };
        img.src = url;
    }

    renderAttachmentPreview() {
        const preview = this.querySelector('#attachmentPreview');
        if (!preview) return;

        if (this.pendingAttachments.length === 0) {
            preview.classList.add('hidden');
            preview.innerHTML = '';
            return;
        }

        preview.classList.remove('hidden');
        preview.innerHTML = this.pendingAttachments.map((att, i) => {
            const isImage = att.mediaType.startsWith('image/');
            const thumb = isImage
                ? `<img src="data:${att.mediaType};base64,${att.data}" class="w-10 h-10 object-cover rounded">`
                : `<i class="fas fa-file text-gray-400 text-lg"></i>`;
            return `
                <div class="attachment-pill flex items-center gap-2 bg-dark-bg/60 border border-dark-border/50 rounded-lg px-2 py-1.5 text-xs text-gray-400">
                    ${thumb}
                    <span class="max-w-[120px] truncate">${this.escapeHtml(att.name)}</span>
                    <button class="attachment-remove text-gray-500 hover:text-gray-300 ml-1" data-index="${i}">
                        <i class="fas fa-xmark text-xs"></i>
                    </button>
                </div>
            `;
        }).join('');

        preview.querySelectorAll('.attachment-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.currentTarget.dataset.index, 10);
                this.pendingAttachments.splice(idx, 1);
                this.renderAttachmentPreview();
            });
        });
    }

    clearAttachments() {
        this.pendingAttachments = [];
        this.renderAttachmentPreview();
    }

    // --- Messaging ---

    async sendMessage() {
        const input = this.querySelector('#chatInput');
        const message = input.value.trim();
        const selectionType = store.get('selectionType');
        const agent = store.get('selectedAgent');
        const llm = store.get('selectedLlm');
        const activeId = sessionStore.getActiveId();

        const selected = selectionType === 'agent' ? agent : llm;
        const hasAttachments = this.pendingAttachments.length > 0;

        if ((!message && !hasAttachments) || !selected || this.isLoading || !activeId) return;

        // Capture attachments before clearing
        const attachments = hasAttachments ? [...this.pendingAttachments] : null;

        // Add user message (with optional attachment thumbnails)
        this.appendMessage('user', message || '(attached files)', { attachments });
        sessionStore.addMessage(activeId, 'user', message || '(attached files)');
        input.value = '';
        input.style.height = 'auto';
        this.clearAttachments();

        this.isLoading = true;
        this.updateUiState();

        const responseId = 'response-' + Date.now();
        this.createResponseBubble(responseId);

        this.currentAbortController = new AbortController();
        this.streamUsageData = null;
        this.startStreamTimer(responseId);

        let finalContent = '';
        let wasCancelled = false;

        try {
            if (selectionType === 'agent') {
                finalContent = await this.sendAgentMessage(agent, message, responseId, attachments);
            } else if (selectionType === 'llm') {
                finalContent = await this.sendLlmMessage(llm, message, responseId, attachments);
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                wasCancelled = true;
            } else {
                this.updateResponseError(responseId, `Error: ${e.message}`);
            }
        } finally {
            this.stopStreamTimer(responseId, message, finalContent, wasCancelled);
            this.currentAbortController = null;
            this.isLoading = false;
            this.updateUiState();
            input.focus();
        }

        // Persist assistant response
        if (finalContent) {
            sessionStore.addMessage(activeId, 'assistant', finalContent);
        }

        // Re-render sidebar (title/ordering may have changed)
        this.renderSessionList();
    }

    async sendAgentMessage(agent, message, responseId, attachments) {
        const inputVars = agent.inputVariables || ['message'];
        const inputObj = {};
        inputObj[inputVars[0] || 'message'] = message;
        if (attachments) {
            inputObj.attachments = attachments;
        }

        const activeId = sessionStore.getActiveId();
        const res = await api.streamAgent(agent.name, inputObj, activeId, { signal: this.currentAbortController?.signal });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        const bubble = this.querySelector(`#${responseId}`);
        const contentDiv = bubble.querySelector('.response-content');
        const container = this.querySelector('#chatMessages');
        const thinkingState = {
            inThinking: false,
            thinkingSections: [],
            currentSection: null
        };

        let currentContent = '';
        let buffer = '';
        let hasToolCalls = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim() === '') continue;

                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const event = JSON.parse(data);

                        // Handle server-side errors
                        if (event.error) {
                            this.updateResponseError(responseId, `Error: ${event.error}`);
                            return currentContent;
                        }

                        if (event.type === 'content') {
                            currentContent += event.content;
                        }
                        if (event.type === 'tool_start' || event.type === 'tool_end') {
                            hasToolCalls = true;
                        }
                        this.handleStreamEvent(event, responseId, currentContent, thinkingState);
                    } catch (e) {
                        console.error('Error parsing stream event', e, data);
                    }
                }
            }
        }

        // Finalize any remaining thinking pill
        const toolsDiv = bubble.querySelector('.tool-invocations');
        this.finalizeThinkingPill(toolsDiv, thinkingState);

        // If tools were called but no text content was produced, clear loading state
        if (hasToolCalls && !currentContent.trim()) {
            const loadingDots = contentDiv.querySelector('.loading-dots');
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner').classList.remove('py-4');
                bubble.querySelector('.response-bubble-inner').classList.add('py-3');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                contentDiv.innerHTML = '';
            }
        }

        return currentContent;
    }

    async sendLlmMessage(llm, message, responseId, attachments) {
        const activeId = sessionStore.getActiveId();
        const res = await api.streamLLM(llm.name, message, activeId, attachments, { signal: this.currentAbortController?.signal });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        const bubble = this.querySelector(`#${responseId}`);
        const contentDiv = bubble.querySelector('.response-content');
        const loadingDots = contentDiv.querySelector('.loading-dots');
        const container = this.querySelector('#chatMessages');

        if (loadingDots) {
            loadingDots.remove();
            bubble.querySelector('.response-bubble-inner').classList.remove('py-4');
            bubble.querySelector('.response-bubble-inner').classList.add('py-3');
            contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
            contentDiv.innerHTML = '';
        }

        let buffer = '';
        let fullContent = '';
        const thinkingState = {
            inThinking: false,
            thinkingSections: [],
            currentSection: null
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim() === '') continue;

                if (line.startsWith('data: ')) {
                    const data = line.slice(6);

                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);

                        if (parsed.error) {
                            this.updateResponseError(responseId, `Error: ${parsed.error}`);
                            return fullContent;
                        }

                        if (parsed.type === 'usage') {
                            this.streamUsageData = {
                                input_tokens: parsed.input_tokens || 0,
                                output_tokens: parsed.output_tokens || 0,
                                total_tokens: parsed.total_tokens || 0,
                            };
                            continue;
                        }

                        const text = parsed.content || '';

                        if (text) {
                            fullContent += text;
                            this.renderLlmContentStreaming(contentDiv, fullContent, responseId, thinkingState);
                            container.scrollTop = container.scrollHeight;
                        }
                    } catch (e) {
                        console.error('Error parsing stream chunk:', e, data);
                    }
                }
            }
        }

        return fullContent;
    }

    renderLlmContentStreaming(contentDiv, fullContent, responseId, state) {
        const existing = contentDiv.querySelector('.content-text');
        if (existing) {
            const renderedHtml = markdownRenderer.render(fullContent);
            existing.innerHTML = renderedHtml;
            markdownRenderer.highlightCode(existing);
        } else {
            const div = document.createElement('div');
            div.className = 'content-text markdown-content';
            div.innerHTML = markdownRenderer.render(fullContent);
            markdownRenderer.highlightCode(div);
            contentDiv.appendChild(div);
        }
    }

    handleThinkingEvent(event, toolsDiv, thinkingState, container) {
        if (!thinkingState.thinkingContent) {
            thinkingState.thinkingContent = '';
        }
        thinkingState.thinkingContent += event.content;

        // Create pill on first thinking chunk
        if (!thinkingState.thinkingPill) {
            const pill = document.createElement('div');
            pill.className = 'thinking-pill tool-pill inline-flex items-center gap-1.5 bg-dark-bg/50 border border-dark-border/60 rounded-full px-2.5 py-1 text-xs text-purple-400 font-mono';
            pill.innerHTML = `
                <i class="fas fa-brain animate-pulse text-[10px]"></i>
                <span>Thinking...</span>
            `;
            toolsDiv.appendChild(pill);
            thinkingState.thinkingPill = pill;
            container.scrollTop = container.scrollHeight;
        }
    }

    finalizeThinkingPill(toolsDiv, thinkingState) {
        const pill = thinkingState.thinkingPill;
        if (!pill) return;

        const content = thinkingState.thinkingContent || '';
        thinkingState.thinkingPill = null;
        thinkingState.thinkingContent = '';

        pill.className = 'thinking-pill tool-pill relative inline-flex items-center gap-1.5 bg-dark-bg/30 border border-dark-border/50 rounded-full px-2.5 py-1 text-xs text-gray-500 font-mono cursor-pointer hover:bg-dark-bg/60 hover:border-dark-border transition-colors';
        pill.innerHTML = '';

        const pillContent = document.createElement('span');
        pillContent.className = 'inline-flex items-center gap-1.5';
        pillContent.innerHTML = `
            <i class="fas fa-brain text-purple-400 text-[10px]"></i>
            <span>Thinking</span>
        `;
        pill.appendChild(pillContent);

        const popover = document.createElement('div');
        popover.className = 'hidden absolute left-0 bottom-full mb-1 z-50 bg-dark-surface border border-dark-border rounded-lg shadow-xl w-[400px] max-w-[90vw] p-3';

        const popoverContent = document.createElement('div');
        popoverContent.className = 'text-xs text-gray-400 max-h-64 overflow-y-auto markdown-content custom-scrollbar';
        popoverContent.innerHTML = markdownRenderer.render(content);
        markdownRenderer.highlightCode(popoverContent);
        popover.appendChild(popoverContent);
        pill.appendChild(popover);

        pill.addEventListener('mouseenter', () => popover.classList.remove('hidden'));
        pill.addEventListener('mouseleave', () => popover.classList.add('hidden'));
    }

    createResponseBubble(id) {
        const container = this.querySelector('#chatMessages');
        const wrapper = document.createElement('div');
        wrapper.className = 'response-wrapper';

        const div = document.createElement('div');
        div.id = id;
        div.className = 'flex justify-start';
        div.innerHTML = `
            <div class="response-bubble-inner max-w-4xl bg-dark-surface border border-dark-border rounded-3xl px-5 py-4 text-gray-100 text-[15px] leading-relaxed relative group">
                <div class="response-content whitespace-pre-wrap flex items-center">
                    <div class="loading-dots flex gap-1">
                        <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
                        <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce animation-delay-200"></div>
                        <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce animation-delay-400"></div>
                    </div>
                </div>
                <div class="tool-invocations flex flex-wrap gap-1.5 mt-2"></div>
            </div>
        `;

        wrapper.appendChild(div);

        const statusBar = document.createElement('div');
        statusBar.className = 'stream-status-bar flex items-center gap-2 mt-1.5 ml-1 text-xs text-gray-400';
        statusBar.innerHTML = `
            <div class="w-2 h-2 bg-blue-500 rounded-full animate-pulse-dot"></div>
            <span class="stream-status-text">Generating...</span>
            <span class="stream-elapsed text-gray-500">0.0s</span>
            <button class="stream-cancel-btn ml-auto text-gray-500 hover:text-gray-300 text-xs px-2 py-0.5 rounded border border-dark-border hover:border-gray-500 transition-colors">
                Stop
            </button>
        `;
        wrapper.appendChild(statusBar);

        statusBar.querySelector('.stream-cancel-btn').addEventListener('click', () => this.cancelCurrentStream());

        const statsBar = document.createElement('div');
        statsBar.className = 'stream-stats-bar hidden flex items-center gap-3 mt-1.5 ml-1 text-xs text-gray-500';
        statsBar.innerHTML = `
            <span class="flex items-center gap-1">
                <i class="far fa-clock"></i>
                <span class="stats-elapsed"></span>
            </span>
            <span class="text-dark-border">|</span>
            <span class="flex items-center gap-1">
                <i class="fas fa-arrow-up text-[9px]"></i>
                <span class="stats-input-tokens"></span>
            </span>
            <span class="text-dark-border">|</span>
            <span class="flex items-center gap-1">
                <i class="fas fa-arrow-down text-[9px]"></i>
                <span class="stats-output-tokens"></span>
            </span>
            <span class="text-dark-border">|</span>
            <span class="flex items-center gap-1">
                <i class="fas fa-bolt text-[9px]"></i>
                <span class="stats-tps"></span>
            </span>
        `;
        wrapper.appendChild(statsBar);

        container.appendChild(wrapper);
        container.scrollTop = container.scrollHeight;
    }

    handleStreamEvent(event, responseId, currentContent, thinkingState) {
        const bubble = this.querySelector(`#${responseId}`);
        if (!bubble) return;

        const contentDiv = bubble.querySelector('.response-content');
        const toolsDiv = bubble.querySelector('.tool-invocations');
        const loadingDots = contentDiv.querySelector('.loading-dots');
        const container = this.querySelector('#chatMessages');

        if (event.type === 'thinking') {
            this.handleThinkingEvent(event, toolsDiv, thinkingState, container);
        } else if (event.type === 'content') {
            // Finalize any in-progress thinking pill
            this.finalizeThinkingPill(toolsDiv, thinkingState);
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner').classList.remove('py-4');
                bubble.querySelector('.response-bubble-inner').classList.add('py-3');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                contentDiv.innerHTML = '';
            }
            this.renderLlmContentStreaming(contentDiv, currentContent, responseId, thinkingState);
            container.scrollTop = container.scrollHeight;
        } else if (event.type === 'tool_start') {
            this.finalizeThinkingPill(toolsDiv, thinkingState);
            const toolId = `tool-${event.runId}`;
            const toolEl = document.createElement('div');
            toolEl.id = toolId;
            toolEl.className = 'tool-pill inline-flex items-center gap-1.5 bg-dark-bg/50 border border-dark-border/60 rounded-full px-2.5 py-1 text-xs text-gray-400 font-mono';
            toolEl.dataset.toolInput = typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2);
            toolEl.innerHTML = `
                <i class="fas fa-circle-notch animate-spin text-blue-400 text-[10px]"></i>
                <span>${this.escapeHtml(event.tool)}</span>
             `;
            toolsDiv.appendChild(toolEl);
            container.scrollTop = container.scrollHeight;

        } else if (event.type === 'tool_end') {
            const toolId = `tool-${event.runId}`;
            const toolEl = toolsDiv.querySelector(`#${toolId}`);
            if (toolEl) {
                const toolInput = toolEl.dataset.toolInput || '';
                const toolOutput = typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2);

                toolEl.className = 'tool-pill relative inline-flex items-center gap-1.5 bg-dark-bg/30 border border-dark-border/50 rounded-full px-2.5 py-1 text-xs text-gray-500 font-mono cursor-pointer hover:bg-dark-bg/60 hover:border-dark-border transition-colors';
                toolEl.innerHTML = '';

                const pillContent = document.createElement('span');
                pillContent.className = 'inline-flex items-center gap-1.5';
                pillContent.innerHTML = `
                    <i class="fas fa-check text-green-500 text-[10px]"></i>
                    <span>${this.escapeHtml(event.tool)}</span>
                `;
                toolEl.appendChild(pillContent);

                const details = document.createElement('div');
                details.className = 'tool-invocation-details hidden absolute left-0 bottom-full mb-1 z-50 bg-dark-surface border border-dark-border rounded-lg shadow-xl w-[400px] max-w-[90vw]';

                if (toolInput) {
                    const inputSection = document.createElement('div');
                    inputSection.className = 'p-3 border-b border-dark-border/50';
                    inputSection.innerHTML = `<div class="text-xs font-semibold text-gray-400 mb-1">Input</div>`;
                    const inputPre = document.createElement('pre');
                    inputPre.className = 'text-xs text-gray-400 bg-dark-bg/60 rounded-md p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all custom-scrollbar';
                    inputPre.textContent = toolInput;
                    inputSection.appendChild(inputPre);
                    details.appendChild(inputSection);
                }

                const outputSection = document.createElement('div');
                outputSection.className = 'p-3';
                outputSection.innerHTML = `<div class="text-xs font-semibold text-gray-400 mb-1">Output</div>`;
                const outputPre = document.createElement('pre');
                outputPre.className = 'text-xs text-gray-400 bg-dark-bg/60 rounded-md p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all custom-scrollbar';
                outputPre.textContent = toolOutput;
                outputSection.appendChild(outputPre);
                details.appendChild(outputSection);

                toolEl.appendChild(details);

                toolEl.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toolsDiv.querySelectorAll('.tool-invocation-details:not(.hidden)').forEach(d => {
                        if (d !== details) d.classList.add('hidden');
                    });
                    details.classList.toggle('hidden');
                });

                const closeHandler = (e) => {
                    if (!toolEl.contains(e.target)) {
                        details.classList.add('hidden');
                    }
                };
                document.addEventListener('click', closeHandler, { capture: true });
                container.scrollTop = container.scrollHeight;
            }
        } else if (event.type === 'result') {
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner').classList.remove('py-4');
                bubble.querySelector('.response-bubble-inner').classList.add('py-3');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                contentDiv.innerHTML = '';
            }

            const resultContainer = document.createElement('div');
            resultContainer.className = 'bg-dark-bg/50 border border-dark-border rounded-lg p-4';

            const resultPre = document.createElement('pre');
            resultPre.className = 'text-sm text-gray-300 font-mono whitespace-pre-wrap overflow-x-auto';
            resultPre.textContent = JSON.stringify(event.output, null, 2);

            resultContainer.appendChild(resultPre);
            contentDiv.appendChild(resultContainer);

            container.scrollTop = container.scrollHeight;
        } else if (event.type === 'error') {
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner').classList.remove('py-4');
                bubble.querySelector('.response-bubble-inner').classList.add('py-3');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
            }
            const errorDiv = document.createElement('div');
            errorDiv.className = 'text-red-400 text-sm mt-2';
            errorDiv.textContent = `Error: ${event.error}`;
            contentDiv.appendChild(errorDiv);
            container.scrollTop = container.scrollHeight;
        } else if (event.type === 'usage') {
            this.streamUsageData = {
                input_tokens: event.input_tokens || 0,
                output_tokens: event.output_tokens || 0,
                total_tokens: event.total_tokens || 0,
            };
        }
    }

    updateResponseError(id, errorMsg) {
        const bubble = this.querySelector(`#${id}`);
        if (bubble) {
            const content = bubble.querySelector('.response-content');
            content.innerHTML = `<span class="text-red-400">${errorMsg}</span>`;
        }
    }

    updateUiState() {
        const btn = this.querySelector('#sendMessageBtn');
        const input = this.querySelector('#chatInput');
        const hasActiveSession = !!sessionStore.getActiveId();
        if (btn) btn.disabled = this.isLoading || !hasActiveSession;
        if (input) {
            input.disabled = this.isLoading;
            input.readOnly = !hasActiveSession;
            input.classList.toggle('cursor-pointer', !hasActiveSession);
        }
    }

    appendMessage(role, content, metadata = {}) {
        const container = this.querySelector('#chatMessages');
        const isUser = role === 'user';
        const hasError = metadata.error;

        const div = document.createElement('div');
        div.className = isUser ? 'flex justify-end' : 'flex justify-start';

        const bubbleColor = isUser ? 'bg-dark-surface' : (hasError ? 'bg-red-900/20 border-red-900/30' : 'bg-dark-surface');
        const textColor = hasError ? 'text-red-300' : 'text-gray-100';

        // Build attachment thumbnails for user messages
        let attachmentHtml = '';
        if (isUser && metadata.attachments && metadata.attachments.length > 0) {
            const thumbs = metadata.attachments.map(att => {
                if (att.mediaType.startsWith('image/')) {
                    return `<img src="data:${att.mediaType};base64,${att.data}" class="w-16 h-16 object-cover rounded-lg border border-dark-border/50">`;
                }
                return `<div class="flex items-center gap-1.5 bg-dark-bg/60 border border-dark-border/50 rounded-lg px-2 py-1.5 text-xs text-gray-400">
                    <i class="fas fa-file"></i>
                    <span class="max-w-[100px] truncate">${this.escapeHtml(att.name)}</span>
                </div>`;
            }).join('');
            attachmentHtml = `<div class="flex flex-wrap gap-2 mb-2">${thumbs}</div>`;
        }

        div.innerHTML = `
            <div class="max-w-4xl ${bubbleColor} border ${isUser ? 'border-transparent' : 'border-dark-border'} rounded-3xl px-5 py-3 ${textColor} text-[15px] leading-relaxed relative group">
                ${attachmentHtml}
                <div class="whitespace-pre-wrap">${this.escapeHtml(content)}</div>
                ${!isUser && !hasError ? `
                    <button class="copy-btn absolute -bottom-6 left-0 text-gray-500 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity p-1" title="Copy">
                        <i class="far fa-copy"></i>
                    </button>
                ` : ''}
            </div>
        `;

        if (!isUser && !hasError) {
            const btn = div.querySelector('.copy-btn');
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(content);
                btn.innerHTML = '<i class="fas fa-check"></i>';
                setTimeout(() => btn.innerHTML = '<i class="far fa-copy"></i>', 2000);
            });
        }

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    appendLoading() {
        const id = 'loading-' + Date.now();
        const container = this.querySelector('#chatMessages');
        const div = document.createElement('div');
        div.id = id;
        div.className = 'flex justify-start';
        div.innerHTML = `
            <div class="max-w-4xl bg-dark-surface border border-dark-border rounded-3xl px-5 py-4">
                <div class="flex gap-1">
                    <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
                    <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce animation-delay-200"></div>
                    <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce animation-delay-400"></div>
                </div>
            </div>
        `;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return id;
    }

    removeLoading(id) {
        const el = this.querySelector(`#${id}`);
        if (el) el.remove();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    _getRandomWelcomeMessage() {
        const messages = [
            'Awaiting your command, master.',
            'The agents are restless. Give them purpose.',
            'Ready when you are. No pressure... okay, maybe a little.',
            'Spinning up neurons... just kidding, I was already ready.',
            'All systems nominal. Your move, human.',
            'The orchestrator awaits. What shall we build today?',
            'Standing by. The agents are stretching their digital legs.',
            'Another day, another chance to orchestrate greatness.',
            'Agents assembled. Awaiting mission briefing.',
            'The stage is set. You are the conductor.',
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    }

    _appendWelcomeMessage(container) {
        const div = document.createElement('div');
        div.className = 'welcome-container';
        div.innerHTML = `
            <svg class="welcome-orca" viewBox="0 0 220 140" xmlns="http://www.w3.org/2000/svg">
                <!-- Main body -->
                <path class="orca-body" d="
                    M 30,68
                    C 28,58 38,42 58,38
                    C 68,35 74,30 78,18
                    C 80,12 84,12 85,18
                    C 87,28 86,35 92,38
                    C 112,34 148,40 172,54
                    C 176,50 182,44 188,40
                    C 192,38 194,42 190,46
                    C 186,50 184,54 182,56
                    C 186,60 188,66 184,68
                    C 180,70 178,66 176,62
                    C 168,72 142,78 112,76
                    C 82,74 52,70 38,66
                    C 34,64 30,68 30,68 Z
                "/>
                <!-- Dorsal fin accent line -->
                <path class="orca-detail" d="M 72,38 C 74,28 78,18 80,14"/>
                <!-- Belly line -->
                <path class="orca-detail" d="M 42,64 C 62,70 100,74 140,72 C 158,70 170,66 176,62"/>
                <!-- Saddle patch -->
                <path class="orca-patch" d="M 92,40 C 102,38 112,40 108,48 C 104,54 90,50 92,40 Z"/>
                <!-- Eye patch -->
                <path class="orca-patch" d="M 44,52 C 50,48 60,50 56,58 C 52,62 42,58 44,52 Z"/>
                <!-- Eye -->
                <circle class="orca-eye" cx="42" cy="54" r="2.5"/>
                <!-- Pectoral fin -->
                <path class="orca-body" d="M 65,66 C 70,74 64,82 58,76 C 54,72 60,66 65,66 Z"/>
                <!-- Tail detail -->
                <path class="orca-detail" d="M 172,54 C 176,52 180,48 184,44"/>
                <path class="orca-detail" d="M 176,62 C 180,64 184,66 186,64"/>
            </svg>
            <div class="welcome-text">${this._getRandomWelcomeMessage()}</div>
            ${this._renderSampleQuestionChips()}
        `;
        container.appendChild(div);

        div.querySelectorAll('.sample-question-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const input = this.querySelector('#chatInput');
                if (input) {
                    input.value = chip.textContent;
                    input.focus();
                }
            });
        });
    }

    _renderSampleQuestionChips() {
        const agent = store.get('selectedAgent');
        const questions = agent?.sampleQuestions;
        if (!questions || questions.length === 0) return '';

        const chips = questions.map(q =>
            `<button class="sample-question-chip bg-dark-surface border border-dark-border/60 hover:border-gray-500 text-gray-300 text-sm px-4 py-2 rounded-2xl transition-colors text-left">${this.escapeHtml(q)}</button>`
        ).join('');

        return `
            <div class="flex flex-wrap justify-center gap-2 max-w-2xl mt-4">${chips}</div>
        `;
    }

    _appendSessionResetBanner(container) {
        const div = document.createElement('div');
        div.className = 'session-reset-banner';
        div.innerHTML = `
            <div class="session-reset-line"></div>
            <span class="session-reset-label">
                <i class="fas fa-rotate-right"></i>
                Server restarted — new session
            </span>
            <div class="session-reset-line"></div>
        `;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    postRender() {
        const input = this.querySelector('#chatInput');

        // Open new conversation modal when clicking input with no active session
        input.addEventListener('mousedown', (e) => {
            if (!sessionStore.getActiveId()) {
                e.preventDefault();
                this.showNewSessionModal();
            }
        });

        // Auto-resize
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        });

        // Send on enter
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        this.querySelector('#sendMessageBtn').addEventListener('click', () => this.sendMessage());

        // Attach button + file input
        this.querySelector('#attachBtn').addEventListener('click', () => this.querySelector('#fileInput').click());
        this.querySelector('#fileInput').addEventListener('change', (e) => this.handleFileSelect(e));

        // New chat button
        this.querySelector('#newChatBtn').addEventListener('click', () => this.showNewSessionModal());

        // Mobile sidebar toggle
        this.querySelector('#sidebarToggleBtn').addEventListener('click', () => this.toggleSidebar(true));
        this.querySelector('#sidebarBackdrop').addEventListener('click', () => this.toggleSidebar(false));
    }

    template() {
        return `
            <div class="flex h-full relative border border-dark-border rounded-xl overflow-hidden bg-dark-surface/30">
                <!-- Mobile sidebar backdrop -->
                <div id="sidebarBackdrop" class="hidden fixed inset-0 bg-black/50 z-30 md:hidden"></div>

                <!-- Sidebar -->
                <div id="sidebar" class="hidden md:flex w-64 flex-shrink-0 bg-dark-bg md:bg-dark-bg/60 border-r border-dark-border/60 flex-col
                    fixed md:relative inset-y-0 left-0 z-40 md:z-auto">
                    <div class="p-3">
                        <button id="newChatBtn" class="w-full flex items-center justify-center gap-2 px-3 py-2.5 hover:bg-dark-hover rounded-lg text-sm font-medium text-gray-300 transition-colors">
                            <i class="fas fa-plus text-xs text-blue-400"></i>
                            <span>New chat</span>
                        </button>
                    </div>
                    <div id="sessionList" class="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2"></div>
                </div>

                <!-- Chat Area -->
                <div class="flex-1 flex flex-col min-w-0">
                    <!-- Chat Header -->
                    <div class="flex-shrink-0 flex items-center gap-2 px-3 md:px-5 py-3 border-b border-dark-border/40 text-sm">
                        <button id="sidebarToggleBtn" class="md:hidden text-gray-400 hover:text-gray-200 p-1 -ml-1">
                            <i class="fas fa-bars"></i>
                        </button>
                        <div id="chatHeader" class="flex-1 min-w-0">
                            <span class="text-gray-500">No conversation selected</span>
                        </div>
                    </div>

                    <!-- Chat Messages -->
                    <div id="chatMessages" class="flex-1 overflow-y-auto space-y-4 p-4 pr-2 pb-6 custom-scrollbar"></div>

                    <!-- Input Area -->
                    <div class="p-3 pt-0">
                        <div id="attachmentPreview" class="hidden flex flex-wrap gap-2 px-2 pb-2"></div>
                        <div class="relative bg-dark-surface border border-dark-border/60 rounded-2xl focus-within:border-gray-500 transition-colors">
                            <input type="file" id="fileInput" multiple accept="image/*,.pdf" class="hidden">
                            <textarea id="chatInput" rows="1" readonly
                                class="w-full bg-transparent pl-11 pr-14 py-3 text-gray-100 placeholder-gray-500 resize-none focus:outline-none max-h-[200px] cursor-pointer"
                                placeholder="Ask anything"></textarea>

                            <div class="absolute bottom-2 left-2 flex items-center">
                                <button id="attachBtn" type="button"
                                    class="text-gray-500 hover:text-gray-300 p-1.5 rounded-lg hover:bg-dark-hover transition-colors"
                                    title="Attach files">
                                    <i class="fas fa-plus text-sm"></i>
                                </button>
                            </div>

                            <div class="absolute bottom-2 right-2 flex items-center gap-2">
                                <button id="sendMessageBtn" disabled
                                    class="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white p-2 rounded-lg transition-all shadow-lg shadow-blue-900/20">
                                    <i class="fas fa-paper-plane text-sm"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('agents-view', AgentsView);
