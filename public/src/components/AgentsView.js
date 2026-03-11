
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';
import { sessionStore } from '../services/SessionStore.js';
import { streamManager } from '../services/StreamManager.js';
import { escapeHtml as sharedEscapeHtml } from '../utils/card.js';
import { store } from '../store.js';
import { markdownRenderer } from '../utils/markdown.js';

// Survives component remount (tab navigation) but not page refresh
const workflowTasks = new Map();

export class AgentsView extends Component {
    constructor() {
        super();
        this.isLoading = false;
        this.currentAbortController = null;
        this.streamStartTime = null;
        this.streamTimerInterval = null;
        this.streamUsageData = null;
        this.pendingAttachments = [];
        this._streamUnsubscribe = null;
    }

    async connectedCallback() {
        super.connectedCallback();
        await Promise.all([this.loadAgents(), this.loadLLMs(), this.loadWorkflows()]);
        this.restoreActiveSession();
    }

    disconnectedCallback() {
        if (this._streamUnsubscribe) {
            this._streamUnsubscribe();
            this._streamUnsubscribe = null;
        }
        if (this.streamTimerInterval) {
            clearInterval(this.streamTimerInterval);
            this.streamTimerInterval = null;
        }
        this.currentAbortController = null;
        // Workflow streams continue via AbortController — no cleanup needed on tab switch
        // (state is preserved in the module-level workflowTasks map)
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
            return;
        }
        const activeId = sessionStore.getActiveId();
        if (!activeId) return;
        const wfState = workflowTasks.get(activeId);
        if (wfState?.abortController) {
            wfState.abortController.abort();
            return;
        }
        streamManager.cancel(activeId);
    }

    startStreamTimer(responseId, startTime) {
        this.streamStartTime = startTime || Date.now();
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

        if (statusBar) statusBar.remove();

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
                cancelBadge.className = 'badge badge-amber';
                cancelBadge.textContent = 'Cancelled';
                statsBar.appendChild(cancelBadge);
            }

            statsBar.classList.add('visible');
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

    async loadWorkflows() {
        try {
            const workflows = await api.getWorkflows();
            workflows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            store.set('workflows', workflows);
        } catch (e) {
            console.error('Failed to load workflows', e);
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
            sidebar.classList.add('open');
            backdrop.classList.add('visible');
        } else {
            sidebar.classList.remove('open');
            backdrop.classList.remove('visible');
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
            list.innerHTML = '<div class="text-muted text-sm text-center py-8">No conversations yet</div>';
            return;
        }

        list.innerHTML = sessions.map(s => {
            const isActive = s.id === activeId;
            let displayName, icon;
            if (s.agentType === 'workflow') {
                displayName = s.workflowName || 'Workflow';
                icon = 'fa-project-diagram';
            } else if (s.agentType === 'agent') {
                displayName = s.agentName || 'Agent';
                icon = 'fa-robot';
            } else {
                displayName = s.llmName || 'LLM';
                icon = 'fa-microchip';
            }

            return `
                <div data-session-id="${s.id}" class="session-item${isActive ? ' active' : ''}">
                    <div class="flex-1 min-w-0">
                        <div class="text-sm text-primary truncate">${this.escapeHtml(s.title)}</div>
                        <div class="flex items-center gap-1 mt-1 text-xs text-muted">
                            <i class="fas ${icon} text-2xs"></i>
                            <span class="truncate">${this.escapeHtml(displayName)}</span>
                        </div>
                    </div>
                    <button data-delete-id="${s.id}" class="session-delete-btn" title="Delete">
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
        // Detach from current stream rendering (don't abort — let it continue in background)
        if (this._streamUnsubscribe) {
            this._streamUnsubscribe();
            this._streamUnsubscribe = null;
        }
        if (this.streamTimerInterval) {
            clearInterval(this.streamTimerInterval);
            this.streamTimerInterval = null;
        }
        this.streamStartTime = null;
        this.currentAbortController = null;
        this.isLoading = false;

        const session = sessionStore.get(sessionId);
        if (!session) return;

        sessionStore.setActiveId(sessionId);

        // Update store with this session's agent/LLM
        const agents = store.get('agents') || [];
        const llms = store.get('llms') || [];

        if (session.agentType === 'workflow') {
            const workflows = store.get('workflows') || [];
            const wf = workflows.find(w => w.name === session.workflowName);
            store.set('selectedWorkflow', wf || null);
            store.set('selectedAgent', null);
            store.set('selectedLlm', null);
            store.set('selectionType', 'workflow');
        } else if (session.agentType === 'agent') {
            const agent = agents.find(a => a.name === session.agentName);
            store.set('selectedAgent', agent || null);
            store.set('selectedLlm', null);
            store.set('selectedWorkflow', null);
            store.set('selectionType', 'agent');
        } else {
            const llm = llms.find(l => l.name === session.llmName);
            store.set('selectedLlm', llm || null);
            store.set('selectedAgent', null);
            store.set('selectedWorkflow', null);
            store.set('selectionType', 'llm');
        }

        this.restoreMessages(session);
        this.updateChatHeader(session);
        this.renderSessionList();

        // Reconnect to active stream if one exists for this session
        const wfState = workflowTasks.get(sessionId);
        if (wfState && wfState.status !== 'done') {
            this._reconnectWorkflowStream(sessionId);
        } else if (streamManager.isActive(sessionId)) {
            this._reconnectToStream(sessionId);
        }

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
                this.appendRestoredAssistantMessage(msg.content, msg.meta);
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

    appendRestoredAssistantMessage(content, meta) {
        const container = this.querySelector('#chatMessages');
        const div = document.createElement('div');
        div.className = 'response-wrapper';

        const bubble = document.createElement('div');
        bubble.className = 'flex justify-start';
        bubble.innerHTML = `
            <div class="response-bubble-inner group">
                <div class="response-content markdown-content"></div>
                <div class="tool-invocations"></div>
            </div>
        `;

        const contentDiv = bubble.querySelector('.response-content');
        if (content) {
            const rendered = markdownRenderer.render(content);
            contentDiv.innerHTML = rendered;
            markdownRenderer.highlightCode(contentDiv);
        }

        // Render persisted thinking/tool pills
        if (meta) {
            const toolsDiv = bubble.querySelector('.tool-invocations');

            if (meta.thinking) {
                for (const thinkingContent of meta.thinking) {
                    this._createThinkingPill(toolsDiv, thinkingContent);
                }
            }

            if (meta.tools) {
                for (const t of meta.tools) {
                    if (t.output !== undefined) {
                        this._createToolPill(toolsDiv, t.runId, t.tool, t.input, t.output);
                    }
                }
            }

            // Hide empty tool-invocations div
            if (!toolsDiv.children.length) {
                toolsDiv.classList.add('hidden');
            }
        } else {
            bubble.querySelector('.tool-invocations').classList.add('hidden');
        }

        div.appendChild(bubble);

        if (meta?.stats) {
            const s = meta.stats;
            const prefix = s.estimated ? '~' : '';
            const tps = s.elapsed > 0 ? (s.outputTokens / (s.elapsed / 1000)).toFixed(1) : '0';
            const statsBar = document.createElement('div');
            statsBar.className = 'stream-stats-bar visible';
            statsBar.innerHTML = `
                <span class="flex items-center gap-1">
                    <i class="far fa-clock"></i>
                    <span>${this.formatElapsedTime(s.elapsed)}</span>
                </span>
                <span class="divider">|</span>
                <span class="flex items-center gap-1">
                    <i class="fas fa-arrow-up text-2xs"></i>
                    <span>${prefix}${s.inputTokens} input</span>
                </span>
                <span class="divider">|</span>
                <span class="flex items-center gap-1">
                    <i class="fas fa-arrow-down text-2xs"></i>
                    <span>${prefix}${s.outputTokens} output</span>
                </span>
                <span class="divider">|</span>
                <span class="flex items-center gap-1">
                    <i class="fas fa-bolt text-2xs"></i>
                    <span>${prefix}${tps} tok/s</span>
                </span>
            `;
            if (s.cancelled) {
                const badge = document.createElement('span');
                badge.className = 'badge badge-amber';
                badge.textContent = 'Cancelled';
                statsBar.appendChild(badge);
            }
            div.appendChild(statsBar);
        }

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    showNewSessionModal() {
        // Remove existing modal if any
        const existing = document.querySelector('#newSessionModal');
        if (existing) existing.remove();

        const agents = store.get('agents') || [];
        const workflows = store.get('workflows') || [];
        const llms = store.get('llms') || [];

        const overlay = document.createElement('div');
        overlay.id = 'newSessionModal';
        overlay.className = 'modal-backdrop';

        let itemsHtml = '';

        if (agents.length > 0) {
            itemsHtml += '<div class="modal-section-label">Agents</div>';
            itemsHtml += agents.map(a => `
                <button data-type="agent" data-name="${this.escapeHtml(a.name)}" class="modal-pick-item">
                    <i class="fas fa-robot text-blue text-sm"></i>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-primary">${this.escapeHtml(a.name)}</div>
                        <div class="text-xs text-muted truncate">${this.escapeHtml(a.description || '')}</div>
                    </div>
                </button>
            `).join('');
        }

        if (workflows.length > 0) {
            itemsHtml += '<div class="modal-section-label">Workflows</div>';
            itemsHtml += workflows.map(w => `
                <button data-type="workflow" data-name="${this.escapeHtml(w.name)}" class="modal-pick-item">
                    <i class="fas fa-project-diagram text-orange text-sm"></i>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-primary">${this.escapeHtml(w.name)}</div>
                        <div class="text-xs text-muted truncate">${this.escapeHtml(w.description || '')}</div>
                    </div>
                </button>
            `).join('');
        }

        if (llms.length > 0) {
            itemsHtml += '<div class="modal-section-label">LLMs</div>';
            itemsHtml += llms.map(l => `
                <button data-type="llm" data-name="${this.escapeHtml(l.name)}" class="modal-pick-item">
                    <i class="fas fa-microchip text-purple text-sm"></i>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-primary">${this.escapeHtml(l.name)}</div>
                        <div class="text-xs text-muted truncate">${this.escapeHtml(l.model || '')}</div>
                    </div>
                </button>
            `).join('');
        }

        if (!itemsHtml) {
            itemsHtml = '<div class="text-muted text-sm text-center py-8">No agents, workflows or LLMs available</div>';
        }

        overlay.innerHTML = `
            <div class="modal-content modal-content-sm">
                <div class="modal-header">
                    <h3 class="text-lg font-semibold text-primary">New conversation</h3>
                    <button id="closeNewSessionModal" class="modal-close-btn">
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
                    llmName: type === 'llm' ? name : null,
                    workflowName: type === 'workflow' ? name : null
                });

                overlay.remove();
                this.switchToSession(session.id);
            });
        });
    }

    showNewAgentModal() {
        const existing = document.querySelector('#newAgentModal');
        if (existing) existing.remove();

        const agents = store.get('agents') || [];
        const hasArchitect = agents.some(a => a.name === 'architect');

        const overlay = document.createElement('div');
        overlay.id = 'newAgentModal';
        overlay.className = 'modal-backdrop';

        overlay.innerHTML = `
            <div class="modal-content modal-content-sm">
                <div class="modal-header">
                    <h3 class="text-lg font-semibold text-primary">Create a new agent</h3>
                    <button id="closeNewAgentModal" class="modal-close-btn">
                        <i class="fas fa-xmark"></i>
                    </button>
                </div>
                <div class="p-4 flex flex-col gap-3">
                    ${hasArchitect ? `
                    <button id="agentViaArchitect" class="new-agent-option">
                        <div class="new-agent-option-icon bg-blue">
                            <i class="fas fa-comments"></i>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="text-sm font-medium text-primary">Chat with Architect</div>
                            <div class="text-xs text-muted">Describe what you need and the Architect agent will build it for you</div>
                        </div>
                        <i class="fas fa-chevron-right text-xs text-muted"></i>
                    </button>
                    ` : ''}
                    <button id="agentViaIde" class="new-agent-option">
                        <div class="new-agent-option-icon bg-green">
                            <i class="fas fa-code"></i>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="text-sm font-medium text-primary">Create in IDE</div>
                            <div class="text-xs text-muted">Open the IDE editor with a blank agent template</div>
                        </div>
                        <i class="fas fa-chevron-right text-xs text-muted"></i>
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        overlay.querySelector('#closeNewAgentModal').addEventListener('click', () => overlay.remove());

        if (hasArchitect) {
            overlay.querySelector('#agentViaArchitect').addEventListener('click', () => {
                overlay.remove();
                const session = sessionStore.create({
                    agentName: 'architect',
                    agentType: 'agent',
                    llmName: null,
                    workflowName: null,
                });
                this.switchToSession(session.id);
            });
        }

        overlay.querySelector('#agentViaIde').addEventListener('click', () => {
            overlay.remove();
            store.set('activeTab', 'ide');
            window.location.hash = 'ide';
            // Wait for IDE to mount, then trigger the new agent dialog
            setTimeout(() => {
                const ide = document.querySelector('ide-view');
                if (ide && ide._selectResourceType) {
                    ide._selectResourceType('agent');
                }
            }, 200);
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
                    <div class="text-center text-muted">
                        <i class="fas fa-comments text-4xl mb-4 text-muted"></i>
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
            header.innerHTML = '<span class="text-muted">No conversation selected</span>';
            return;
        }

        let name, badgeText, badgeVariant, icon;
        if (session.agentType === 'workflow') {
            name = session.workflowName || 'Workflow';
            badgeText = 'Workflow';
            badgeVariant = 'badge-orange';
            icon = 'fa-project-diagram';
        } else if (session.agentType === 'agent') {
            name = session.agentName || 'Agent';
            badgeText = 'Agent';
            badgeVariant = 'badge-blue';
            icon = 'fa-robot';
        } else {
            name = session.llmName || 'LLM';
            badgeText = 'LLM';
            badgeVariant = 'badge-purple';
            icon = 'fa-microchip';
        }
        const isAgent = session.agentType === 'agent';

        let extraBadges = '';
        if (isAgent) {
            const agents = store.get('agents') || [];
            const agent = agents.find(a => a.name === session.agentName);
            if (agent) {
                if (agent.publish?.enabled) {
                    const chatUrl = `/chat/${encodeURIComponent(agent.name)}`;
                    extraBadges += `<a href="${chatUrl}" target="_blank" class="badge badge-pill badge-green no-underline" title="Open published chat"><i class="fas fa-globe text-2xs"></i> Published</a>`;
                }

                const hasMemory = agent.memory === true || (agent.memory && agent.memory.enabled);
                if (hasMemory) {
                    extraBadges += `<span class="badge badge-pill badge-amber" title="Persistent memory enabled"><i class="fas fa-brain text-2xs"></i> Memory</span>`;
                }

                if (agent.tools?.length) {
                    const toolNames = agent.tools.map(t => typeof t === 'string' ? t : t.name);
                    const toolListHtml = toolNames.map(t => `<div class="tools-popover-item">${this.escapeHtml(t)}</div>`).join('');
                    extraBadges += `
                        <span class="tools-badge-wrapper">
                            <span class="badge badge-pill badge-gray"><i class="fas fa-wrench text-2xs"></i> ${toolNames.length} tool${toolNames.length !== 1 ? 's' : ''}</span>
                            <div class="tools-popover">${toolListHtml}</div>
                        </span>`;
                }
            }
        }

        header.innerHTML = `
            <div class="flex items-center gap-2 flex-wrap">
                <i class="fas ${icon} text-sm text-secondary"></i>
                <span class="font-medium text-primary">${this.escapeHtml(name)}</span>
                <span class="badge badge-pill ${badgeVariant}">${badgeText}</span>
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
            preview.classList.remove('visible');
            preview.innerHTML = '';
            return;
        }

        preview.classList.add('visible');
        preview.innerHTML = this.pendingAttachments.map((att, i) => {
            const isImage = att.mediaType.startsWith('image/');
            const thumb = isImage
                ? `<img src="data:${att.mediaType};base64,${att.data}">`
                : `<i class="fas fa-file text-secondary text-lg"></i>`;
            return `
                <div class="attachment-pill">
                    ${thumb}
                    <span class="truncate attachment-name">${this.escapeHtml(att.name)}</span>
                    <button class="attachment-remove" data-index="${i}">
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

        const hasAttachments = this.pendingAttachments.length > 0;
        if ((!message && !hasAttachments) || this.isLoading || !activeId) return;

        // Handle workflow messages (including interrupt responses)
        if (selectionType === 'workflow') {
            return this._sendWorkflowMessage(message);
        }

        const selected = selectionType === 'agent' ? agent : llm;
        if (!selected) return;

        const attachments = hasAttachments ? [...this.pendingAttachments] : null;

        this.appendMessage('user', message || '(attached files)', { attachments });
        sessionStore.addMessage(activeId, 'user', message || '(attached files)');
        input.value = '';
        input.style.height = 'auto';
        this.clearAttachments();

        this.isLoading = true;
        this.updateUiState();

        const responseId = 'response-' + Date.now();
        this.createResponseBubble(responseId);

        const abortController = new AbortController();
        this.currentAbortController = abortController;
        this.streamUsageData = null;
        this.startStreamTimer(responseId);

        try {
            let response;
            if (selectionType === 'agent') {
                const inputVars = agent.inputVariables || ['message'];
                const inputObj = {};
                inputObj[inputVars[0] || 'message'] = message;
                if (attachments) inputObj.attachments = attachments;
                response = await api.streamAgent(agent.name, inputObj, activeId, { signal: abortController.signal });
            } else {
                response = await api.streamLLM(llm.name, message, activeId, attachments, { signal: abortController.signal });
            }

            streamManager.start(activeId, {
                response,
                abortController,
                streamType: selectionType === 'agent' ? 'agent' : 'llm',
                inputMessage: message,
                responseId,
            });

            this._attachToStream(activeId, responseId);
        } catch (e) {
            const wasCancelled = e.name === 'AbortError';
            if (!wasCancelled) {
                this.updateResponseError(responseId, `Error: ${e.message}`);
            }
            this.stopStreamTimer(responseId, message, '', wasCancelled);
            this.currentAbortController = null;
            this.isLoading = false;
            this.updateUiState();
        }

        this.renderSessionList();
    }

    _attachToStream(sessionId, responseId, initialThinkingState) {
        const state = streamManager.getState(sessionId);
        if (!state) return;

        const thinkingState = initialThinkingState || {
            inThinking: false,
            thinkingSections: [],
            currentSection: null,
            thinkingContent: '',
            thinkingPill: null,
        };

        // For LLM streams, remove loading dots (skip if reconnecting with no content yet)
        if (state.streamType === 'llm') {
            const hasContent = state.content || state.events.length > 0;
            if (hasContent || !initialThinkingState) {
                const bubble = this.querySelector(`#${responseId}`);
                if (bubble) {
                    const contentDiv = bubble.querySelector('.response-content');
                    const loadingDots = contentDiv?.querySelector('.loading-dots');
                    if (loadingDots) {
                        loadingDots.remove();
                        bubble.querySelector('.response-bubble-inner')?.classList.remove('loading');
                        contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                        contentDiv.innerHTML = '';
                    }
                }
            }
        }

        let hasToolCalls = false;

        this._streamUnsubscribe = streamManager.subscribe(sessionId, (event) => {
            if (event.type === '_stream_end') {
                this.streamUsageData = state.usageData;
                const wasCancelled = event.status === 'cancelled';

                if (state.streamType === 'agent') {
                    const bubble = this.querySelector(`#${responseId}`);
                    if (bubble) {
                        const toolsDiv = bubble.querySelector('.tool-invocations');
                        this.finalizeThinkingPill(toolsDiv, thinkingState);
                    }
                    if (hasToolCalls && !state.content.trim()) {
                        const bubble = this.querySelector(`#${responseId}`);
                        if (bubble) {
                            const contentDiv = bubble.querySelector('.response-content');
                            const loadingDots = contentDiv?.querySelector('.loading-dots');
                            if (loadingDots) {
                                loadingDots.remove();
                                bubble.querySelector('.response-bubble-inner')?.classList.remove('loading');
                                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                                contentDiv.innerHTML = '';
                            }
                        }
                    }
                }

                this.stopStreamTimer(responseId, state.inputMessage, state.content, wasCancelled);
                this.currentAbortController = null;
                this.isLoading = false;
                this.updateUiState();
                this.renderSessionList();
                this._streamUnsubscribe = null;

                const input = this.querySelector('#chatInput');
                if (input) input.focus();
                return;
            }

            if (state.streamType === 'agent') {
                if (event.type === 'tool_start' || event.type === 'tool_end') hasToolCalls = true;
                this.handleStreamEvent(event, responseId, state.content, thinkingState);
            } else {
                if (event.type === 'usage') {
                    this.streamUsageData = state.usageData;
                    return;
                }
                if (event.error) {
                    this.updateResponseError(responseId, `Error: ${event.error}`);
                    return;
                }
                if (event.content) {
                    const bubble = this.querySelector(`#${responseId}`);
                    if (bubble) {
                        const contentDiv = bubble.querySelector('.response-content');
                        const loadingDots = contentDiv?.querySelector('.loading-dots');
                        if (loadingDots) {
                            loadingDots.remove();
                            bubble.querySelector('.response-bubble-inner')?.classList.remove('loading');
                            contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                            contentDiv.innerHTML = '';
                        }
                        const container = this.querySelector('#chatMessages');
                        this.renderLlmContentStreaming(contentDiv, state.content, responseId, thinkingState);
                        if (container) container.scrollTop = container.scrollHeight;
                    }
                }
            }
        });
    }

    _reconnectToStream(sessionId) {
        const state = streamManager.getState(sessionId);
        if (!state || state.status !== 'streaming') return false;

        this.createResponseBubble(state.responseId);
        const snapshotState = this._renderStreamSnapshot(state.responseId, state);

        const thinkingState = {
            inThinking: false,
            thinkingSections: [],
            currentSection: null,
            thinkingContent: snapshotState.thinkingContent || '',
            thinkingPill: snapshotState.thinkingPill || null,
        };

        this.streamUsageData = state.usageData;
        this.startStreamTimer(state.responseId, state.startTime);

        this.isLoading = true;
        this.currentAbortController = state.abortController;
        this.updateUiState();

        this._attachToStream(sessionId, state.responseId, thinkingState);
        return true;
    }

    _renderStreamSnapshot(responseId, state) {
        const bubble = this.querySelector(`#${responseId}`);
        if (!bubble) return {};

        const contentDiv = bubble.querySelector('.response-content');
        const toolsDiv = bubble.querySelector('.tool-invocations');

        const hasVisualContent = state.content ||
            state.events.some(e => e.type === 'thinking' || e.type === 'tool_start' || e.type === 'content');
        const loadingDots = contentDiv.querySelector('.loading-dots');
        if (loadingDots && hasVisualContent) {
            loadingDots.remove();
            bubble.querySelector('.response-bubble-inner').classList.remove('loading');
            contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
            contentDiv.innerHTML = '';
        }

        let activeThinkingPill = null;
        let activeThinkingContent = '';

        if (state.streamType === 'agent') {
            const tools = new Map();
            const completedThinking = [];
            let currentThinking = '';
            let lastWasThinking = false;
            let lastReactIteration = null;

            for (const event of state.events) {
                if (event.type === 'thinking') {
                    currentThinking += event.content;
                    lastWasThinking = true;
                } else {
                    if (lastWasThinking && currentThinking) {
                        completedThinking.push(currentThinking);
                        currentThinking = '';
                    }
                    lastWasThinking = false;
                }

                if (event.type === 'tool_start') {
                    tools.set(event.runId, { tool: event.tool, input: event.input, done: false });
                }
                if (event.type === 'tool_end') {
                    const t = tools.get(event.runId);
                    if (t) { t.output = event.output; t.done = true; }
                }
                if (event.type === 'react_iteration') {
                    lastReactIteration = event;
                }
            }

            for (const content of completedThinking) {
                this._createThinkingPill(toolsDiv, content);
            }

            if (lastWasThinking && currentThinking) {
                const pill = document.createElement('div');
                pill.className = 'tool-pill thinking';
                pill.innerHTML = '<i class="fas fa-brain animate-pulse text-2xs"></i><span>Thinking...</span>';
                toolsDiv.appendChild(pill);
                activeThinkingPill = pill;
                activeThinkingContent = currentThinking;
            }

            for (const [runId, t] of tools) {
                if (t.done) {
                    this._createToolPill(toolsDiv, runId, t.tool, t.input, t.output);
                } else {
                    const toolEl = document.createElement('div');
                    toolEl.id = `tool-${runId}`;
                    toolEl.className = 'tool-pill';
                    toolEl.dataset.toolInput = typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2);
                    toolEl.innerHTML = `<i class="fas fa-circle-notch animate-spin text-blue text-2xs"></i><span>${this.escapeHtml(t.tool)}</span>`;
                    toolsDiv.appendChild(toolEl);
                }
            }

            if (lastReactIteration) {
                const wrapper = bubble.closest('.response-wrapper');
                const statusText = wrapper?.querySelector('.stream-status-text');
                if (statusText) {
                    const contextKB = (lastReactIteration.contextChars / 1024).toFixed(1);
                    statusText.textContent = `Iteration ${lastReactIteration.iteration} · ${contextKB} KB context`;
                }
            }
        }

        if (state.content) {
            const div = document.createElement('div');
            div.className = 'content-text markdown-content';
            div.innerHTML = markdownRenderer.render(state.content);
            markdownRenderer.highlightCode(div);
            contentDiv.appendChild(div);
        }

        const container = this.querySelector('#chatMessages');
        if (container) container.scrollTop = container.scrollHeight;

        return { thinkingPill: activeThinkingPill, thinkingContent: activeThinkingContent };
    }

    // --- Workflow chat integration ---

    async _sendWorkflowMessage(message) {
        const activeId = sessionStore.getActiveId();
        const wfState = workflowTasks.get(activeId);

        if (wfState?.interruptState) {
            return this._respondToWorkflowInterrupt(activeId, message);
        }

        const workflow = store.get('selectedWorkflow');
        if (!workflow) return;

        const schema = workflow.inputSchema || {};
        const firstField = Object.keys(schema)[0] || 'input';
        const inputObj = { [firstField]: message };

        const input = this.querySelector('#chatInput');
        this.appendMessage('user', message);
        sessionStore.addMessage(activeId, 'user', message);
        input.value = '';
        input.style.height = 'auto';
        this.clearAttachments();

        const responseId = 'response-' + Date.now();
        this.createResponseBubble(responseId);
        this.isLoading = true;
        this.updateUiState();
        this.startStreamTimer(responseId);

        const abortController = new AbortController();
        workflowTasks.set(activeId, {
            responseId,
            startTime: Date.now(),
            chatOutputFormat: workflow.chatOutputFormat || 'json',
            workflowName: workflow.name,
            abortController,
            interruptState: null,
            status: 'streaming',
            events: [],
            inputMessage: message,
        });

        try {
            const response = await api.startWorkflowStream(workflow.name, inputObj, abortController.signal);
            await this._processWorkflowStream(response, activeId, responseId);
        } catch (e) {
            if (e.name === 'AbortError') {
                this._finishWorkflowStream(activeId, responseId, null, null, true);
            } else {
                this.updateResponseError(responseId, `Error: ${e.message}`);
                this.stopStreamTimer(responseId, message, '', false);
                this.isLoading = false;
                this.updateUiState();
            }
        }

        this.renderSessionList();
    }

    async _respondToWorkflowInterrupt(sessionId, message) {
        const wfState = workflowTasks.get(sessionId);
        if (!wfState?.interruptState) return;

        const { threadId, workflowName } = wfState.interruptState;

        const input = this.querySelector('#chatInput');
        this.appendMessage('user', message);
        sessionStore.addMessage(sessionId, 'user', message);
        input.value = '';
        input.style.height = 'auto';

        const responseId = 'response-' + Date.now();
        this.createResponseBubble(responseId);

        const abortController = new AbortController();
        wfState.responseId = responseId;
        wfState.interruptState = null;
        wfState.status = 'streaming';
        wfState.abortController = abortController;

        this.isLoading = true;
        this.updateUiState();
        this.startStreamTimer(responseId);

        try {
            const response = await api.resumeWorkflowStream(workflowName, threadId, message, abortController.signal);
            await this._processWorkflowStream(response, sessionId, responseId);
        } catch (e) {
            if (e.name === 'AbortError') {
                this._finishWorkflowStream(sessionId, responseId, null, null, true);
            } else {
                this.updateResponseError(responseId, `Error: ${e.message}`);
                this.stopStreamTimer(responseId, message, '', false);
                this.isLoading = false;
                this.updateUiState();
            }
        }

        this.renderSessionList();
    }

    async _processWorkflowStream(response, sessionId, responseId) {
        if (!response.ok) {
            const text = await response.text();
            let msg = `HTTP ${response.status}`;
            try { msg = JSON.parse(text).error || msg; } catch { /* use status */ }
            throw new Error(msg);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') continue;

                try {
                    const update = JSON.parse(payload);
                    this._handleWorkflowStreamEvent(update, sessionId, responseId);
                } catch (e) {
                    console.error('Workflow stream parse error:', e);
                }
            }
        }

        // Process any remaining buffer
        if (buffer.startsWith('data: ')) {
            const payload = buffer.slice(6).trim();
            if (payload && payload !== '[DONE]') {
                try {
                    const update = JSON.parse(payload);
                    this._handleWorkflowStreamEvent(update, sessionId, responseId);
                } catch (e) { /* ignore */ }
            }
        }

        // If stream ended without a result/error event, treat as error
        const wfState = workflowTasks.get(sessionId);
        if (wfState && wfState.status === 'streaming') {
            this._finishWorkflowStream(sessionId, responseId, null, 'Stream ended unexpectedly', false);
        }
    }

    _handleWorkflowStreamEvent(update, sessionId, responseId) {
        const wfState = workflowTasks.get(sessionId);
        if (!wfState) return;

        const bubble = this.querySelector(`#${responseId}`);

        if (update.type === 'status' && bubble) {
            const event = update.data;
            wfState.events.push(event);

            const toolsDiv = bubble.querySelector('.tool-invocations');
            this._renderWorkflowEvent(event, toolsDiv, bubble);

            // Handle interrupt — the stream returns a result with interrupted output
        }

        if (update.type === 'result') {
            const result = update.data;
            // Check if it's an interrupt
            if (result?.output?.interrupted && result?.output?.threadId) {
                this._handleWorkflowInterrupt(sessionId, responseId, result.output);
            } else if (result?.error) {
                this._finishWorkflowStream(sessionId, responseId, null, result.error, false);
            } else {
                this._finishWorkflowStream(sessionId, responseId, result, null, false);
            }
        }

        if (update.type === 'error') {
            this._finishWorkflowStream(sessionId, responseId, null, update.error, false);
        }
    }

    _renderWorkflowEvent(event, toolsDiv, bubble) {
        const contentDiv = bubble.querySelector('.response-content');

        if (event.type === 'step_start') {
            const pill = document.createElement('div');
            pill.id = `wf-step-${event.stepId}`;
            pill.className = 'tool-pill';
            pill.innerHTML = `<i class="fas fa-circle-notch animate-spin text-blue text-2xs"></i><span>${this.escapeHtml(event.stepId)}</span>`;
            toolsDiv.appendChild(pill);
        }

        if (event.type === 'step_complete') {
            const pill = toolsDiv.querySelector(`#wf-step-${event.stepId}`);
            if (pill) {
                pill.className = 'tool-pill done';
                pill.innerHTML = `<i class="fas fa-check text-green text-2xs"></i><span>${this.escapeHtml(event.stepId)}</span>`;
            }
        }

        if (event.type === 'step_error') {
            const pill = toolsDiv.querySelector(`#wf-step-${event.stepId}`);
            if (pill) {
                pill.className = 'tool-pill done';
                pill.innerHTML = `<i class="fas fa-times text-red text-2xs"></i><span>${this.escapeHtml(event.stepId)}</span>`;
            }
        }

        if (event.type === 'tool_call') {
            const toolName = event.message?.replace(/^Calling:?\s*/i, '').split(/\s/)[0] || 'tool';
            const pill = document.createElement('div');
            pill.className = 'tool-pill wf-tool-active';

            const pillContent = document.createElement('span');
            pillContent.className = 'inline-flex items-center gap-1';
            pillContent.innerHTML = `<i class="fas fa-circle-notch animate-spin text-blue text-2xs"></i><span>${this.escapeHtml(toolName)}</span>`;
            pill.appendChild(pillContent);

            // Create details panel (populated on tool_result)
            const details = document.createElement('div');
            details.className = 'tool-invocation-details';
            if (event.toolInput) {
                const inputSection = document.createElement('div');
                inputSection.className = 'tool-detail-section';
                inputSection.innerHTML = '<h4>Input</h4>';
                const inputPre = document.createElement('pre');
                inputPre.className = 'tool-detail-pre custom-scrollbar';
                inputPre.textContent = event.toolInput;
                inputSection.appendChild(inputPre);
                details.appendChild(inputSection);
            }
            pill.appendChild(details);
            pill.addEventListener('click', (e) => {
                if (details.contains(e.target)) return;
                e.preventDefault();
                e.stopPropagation();
                toolsDiv.querySelectorAll('.tool-invocation-details.visible').forEach(d => {
                    if (d !== details) d.classList.remove('visible');
                });
                details.classList.toggle('visible');
            });
            toolsDiv.appendChild(pill);
        }

        if (event.type === 'tool_result') {
            const activePill = toolsDiv.querySelector('.wf-tool-active');
            if (activePill) {
                activePill.classList.remove('wf-tool-active');
                activePill.classList.add('done');
                const icon = activePill.querySelector('i');
                if (icon) icon.className = 'fas fa-check text-green text-2xs';

                // Append output to the details panel
                if (event.toolOutput) {
                    const details = activePill.querySelector('.tool-invocation-details');
                    if (details) {
                        const outputSection = document.createElement('div');
                        outputSection.className = 'tool-detail-section';
                        outputSection.innerHTML = '<h4>Output</h4>';
                        const outputPre = document.createElement('pre');
                        outputPre.className = 'tool-detail-pre custom-scrollbar';
                        outputPre.textContent = event.toolOutput;
                        outputSection.appendChild(outputPre);
                        details.appendChild(outputSection);
                    }
                }
            }
        }

        if (event.type === 'tool_discovery') {
            // Only show the final summary pill (e.g. "35 total tools ready"), skip intermediate progress
            if (event.message?.includes('total tools')) {
                const pill = document.createElement('div');
                pill.className = 'tool-pill done';
                pill.innerHTML = `<i class="fas fa-plug text-purple text-2xs"></i><span>${this.escapeHtml(event.message)}</span>`;
                toolsDiv.appendChild(pill);
            }
            const wrapper = bubble.closest('.response-wrapper');
            const statusText = wrapper?.querySelector('.stream-status-text');
            if (statusText) statusText.textContent = event.message || 'Discovering tools...';
        }

        if (event.type === 'react_iteration' || event.type === 'workflow_start') {
            const wrapper = bubble.closest('.response-wrapper');
            const statusText = wrapper?.querySelector('.stream-status-text');
            if (statusText) statusText.textContent = event.message || 'Processing...';
        }

        // Remove loading dots on first meaningful event
        const loadingDots = contentDiv?.querySelector('.loading-dots');
        if (loadingDots && (event.type === 'step_start' || event.type === 'workflow_start' || event.type === 'tool_call' || event.type === 'tool_discovery' || event.type === 'react_iteration')) {
            loadingDots.remove();
            bubble.querySelector('.response-bubble-inner')?.classList.remove('loading');
            contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
            contentDiv.innerHTML = '';
        }

        const container = this.querySelector('#chatMessages');
        if (container) container.scrollTop = container.scrollHeight;
    }

    _handleWorkflowInterrupt(sessionId, responseId, interruptData) {
        const wfState = workflowTasks.get(sessionId);
        if (!wfState) return;

        wfState.status = 'interrupted';
        const question = interruptData?.question || 'Input required';
        wfState.interruptState = {
            question,
            threadId: interruptData?.threadId,
            workflowName: wfState.workflowName,
        };

        const bubble = this.querySelector(`#${responseId}`);
        if (bubble) {
            const contentDiv = bubble.querySelector('.response-content');
            const loadingDots = contentDiv?.querySelector('.loading-dots');
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner')?.classList.remove('loading');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                contentDiv.innerHTML = '';
            }

            const div = document.createElement('div');
            div.className = 'content-text markdown-content';
            div.innerHTML = markdownRenderer.render(question);
            markdownRenderer.highlightCode(div);
            contentDiv.appendChild(div);

            const wrapper = bubble.closest('.response-wrapper');
            const statusBar = wrapper?.querySelector('.stream-status-bar');
            if (statusBar) {
                const statusText = statusBar.querySelector('.stream-status-text');
                if (statusText) statusText.textContent = 'Waiting for input...';
            }
        }

        sessionStore.addMessage(sessionId, 'assistant', question);

        if (this.streamTimerInterval) {
            clearInterval(this.streamTimerInterval);
            this.streamTimerInterval = null;
        }
        this.isLoading = false;
        this.updateUiState();

        const input = this.querySelector('#chatInput');
        if (input) input.focus();
    }

    _finishWorkflowStream(sessionId, responseId, result, error, wasCancelled) {
        const wfState = workflowTasks.get(sessionId);
        if (!wfState) return;

        wfState.status = 'done';
        wfState.abortController = null;

        const bubble = this.querySelector(`#${responseId}`);
        if (bubble) {
            const contentDiv = bubble.querySelector('.response-content');
            const loadingDots = contentDiv?.querySelector('.loading-dots');
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner')?.classList.remove('loading');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                contentDiv.innerHTML = '';
            }

            if (error) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'text-red text-sm';
                errorDiv.textContent = `Error: ${error}`;
                contentDiv.appendChild(errorDiv);
            } else if (wasCancelled) {
                // No output content for cancelled
            } else if (result?.output) {
                this._renderWorkflowOutput(contentDiv, result.output, wfState.chatOutputFormat);
            }
        }

        let content = '';
        if (error) {
            content = `Error: ${error}`;
        } else if (result?.output) {
            if (wfState.chatOutputFormat === 'text') {
                content = Object.values(result.output).join('\n\n');
            } else {
                content = '```json\n' + JSON.stringify(result.output, null, 2) + '\n```';
            }
        }

        const elapsed = wfState.startTime ? Date.now() - wfState.startTime : 0;
        const meta = {
            thinking: [],
            tools: wfState.events
                .filter(e => e.type === 'step_complete')
                .map(e => ({ runId: e.stepId, tool: e.stepId, input: e.agent || '', output: e.message || 'Completed' })),
            stats: {
                elapsed,
                inputTokens: Math.round((wfState.inputMessage || '').length / 4),
                outputTokens: Math.round(content.length / 4),
                cancelled: wasCancelled,
                estimated: true,
            },
        };
        sessionStore.addMessage(sessionId, 'assistant', content, meta);

        this.stopStreamTimer(responseId, wfState.inputMessage || '', content, wasCancelled);
        this.isLoading = false;
        this.updateUiState();
        this.renderSessionList();

        setTimeout(() => workflowTasks.delete(sessionId), 10000);

        const input = this.querySelector('#chatInput');
        if (input) input.focus();
    }

    _renderWorkflowOutput(contentDiv, output, format) {
        const div = document.createElement('div');
        div.className = 'content-text markdown-content';
        if (format === 'text') {
            div.innerHTML = markdownRenderer.render(Object.values(output).join('\n\n'));
        } else {
            div.innerHTML = markdownRenderer.render('```json\n' + JSON.stringify(output, null, 2) + '\n```');
        }
        markdownRenderer.highlightCode(div);
        contentDiv.appendChild(div);
    }

    _reconnectWorkflowStream(sessionId) {
        const wfState = workflowTasks.get(sessionId);
        if (!wfState || wfState.status === 'done') return false;

        if (wfState.interruptState) {
            this.isLoading = false;
            this.updateUiState();
            return true;
        }

        // Re-create the response bubble and replay cached events
        this.createResponseBubble(wfState.responseId);
        const bubble = this.querySelector(`#${wfState.responseId}`);
        if (bubble && wfState.events.length > 0) {
            const toolsDiv = bubble.querySelector('.tool-invocations');
            for (const event of wfState.events) {
                this._renderWorkflowEvent(event, toolsDiv, bubble);
            }
        }

        this.startStreamTimer(wfState.responseId, wfState.startTime);
        this.isLoading = true;
        this.currentAbortController = null;
        this.updateUiState();

        return true;
    }

    _createThinkingPill(toolsDiv, content) {
        const pill = document.createElement('div');
        pill.className = 'tool-pill done thinking';

        const pillContent = document.createElement('span');
        pillContent.className = 'inline-flex items-center gap-1';
        pillContent.innerHTML = '<i class="fas fa-brain text-purple text-2xs"></i><span>Thinking</span>';
        pill.appendChild(pillContent);

        const popover = document.createElement('div');
        popover.className = 'tool-invocation-details fixed';

        const popoverContent = document.createElement('div');
        popoverContent.className = 'tool-detail-pre markdown-content custom-scrollbar';
        popoverContent.innerHTML = markdownRenderer.render(content);
        markdownRenderer.highlightCode(popoverContent);
        popover.appendChild(popoverContent);
        pill.appendChild(popover);

        pill.addEventListener('mouseenter', () => {
            popover.classList.add('visible');
            const pillRect = pill.getBoundingClientRect();
            popover.style.bottom = (window.innerHeight - pillRect.top + 4) + 'px';
            popover.style.top = 'auto';
            if (pillRect.left + 400 > window.innerWidth - 16) {
                popover.style.left = Math.max(8, pillRect.right - 400) + 'px';
            } else {
                popover.style.left = pillRect.left + 'px';
            }
            popover.style.right = 'auto';
        });
        pill.addEventListener('mouseleave', () => popover.classList.remove('visible'));

        toolsDiv.appendChild(pill);
    }

    _createToolPill(toolsDiv, runId, toolName, input, output) {
        const container = this.querySelector('#chatMessages');
        const toolInput = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
        const toolOutput = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

        const toolEl = document.createElement('div');
        toolEl.id = `tool-${runId}`;
        toolEl.className = 'tool-pill done';

        const pillContent = document.createElement('span');
        pillContent.className = 'inline-flex items-center gap-1';
        pillContent.innerHTML = `<i class="fas fa-check text-green text-2xs"></i><span>${this.escapeHtml(toolName)}</span>`;
        toolEl.appendChild(pillContent);

        const details = document.createElement('div');
        details.className = 'tool-invocation-details';

        if (toolInput) {
            const inputSection = document.createElement('div');
            inputSection.className = 'tool-detail-section';
            inputSection.innerHTML = '<h4>Input</h4>';
            const inputPre = document.createElement('pre');
            inputPre.className = 'tool-detail-pre custom-scrollbar';
            inputPre.textContent = toolInput;
            inputSection.appendChild(inputPre);
            details.appendChild(inputSection);
        }

        const outputSection = document.createElement('div');
        outputSection.className = 'tool-detail-section';
        outputSection.innerHTML = '<h4>Output</h4>';
        const outputPre = document.createElement('pre');
        outputPre.className = 'tool-detail-pre custom-scrollbar';
        outputPre.textContent = toolOutput;
        outputSection.appendChild(outputPre);
        details.appendChild(outputSection);

        toolEl.appendChild(details);

        toolEl.addEventListener('click', (e) => {
            if (details.contains(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            toolsDiv.querySelectorAll('.tool-invocation-details.visible').forEach(d => {
                if (d !== details) d.classList.remove('visible');
            });
            const wasHidden = !details.classList.contains('visible');
            details.classList.toggle('visible');
            if (wasHidden && container) {
                const pillRect = toolEl.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const spaceRight = containerRect.right - pillRect.left;
                if (spaceRight < 420) {
                    details.style.right = '0';
                    details.style.left = 'auto';
                } else {
                    details.style.left = '0';
                    details.style.right = 'auto';
                }
            }
        });

        document.addEventListener('click', (e) => {
            if (!toolEl.contains(e.target)) details.classList.remove('visible');
        }, { capture: true });

        toolsDiv.appendChild(toolEl);
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
            pill.className = 'tool-pill thinking';
            pill.innerHTML = `
                <i class="fas fa-brain animate-pulse text-2xs"></i>
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

        pill.className = 'tool-pill done thinking';
        pill.innerHTML = '';

        const pillContent = document.createElement('span');
        pillContent.className = 'inline-flex items-center gap-1';
        pillContent.innerHTML = `
            <i class="fas fa-brain text-purple text-2xs"></i>
            <span>Thinking</span>
        `;
        pill.appendChild(pillContent);

        const popover = document.createElement('div');
        popover.className = 'tool-invocation-details fixed';

        const popoverContent = document.createElement('div');
        popoverContent.className = 'tool-detail-pre markdown-content custom-scrollbar';
        popoverContent.innerHTML = markdownRenderer.render(content);
        markdownRenderer.highlightCode(popoverContent);
        popover.appendChild(popoverContent);
        pill.appendChild(popover);

        pill.addEventListener('mouseenter', () => {
            popover.classList.add('visible');
            const pillRect = pill.getBoundingClientRect();
            popover.style.bottom = (window.innerHeight - pillRect.top + 4) + 'px';
            popover.style.top = 'auto';
            if (pillRect.left + 400 > window.innerWidth - 16) {
                popover.style.left = Math.max(8, pillRect.right - 400) + 'px';
            } else {
                popover.style.left = pillRect.left + 'px';
            }
            popover.style.right = 'auto';
        });
        pill.addEventListener('mouseleave', () => popover.classList.remove('visible'));
    }

    createResponseBubble(id) {
        const container = this.querySelector('#chatMessages');
        const wrapper = document.createElement('div');
        wrapper.className = 'response-wrapper';

        const div = document.createElement('div');
        div.id = id;
        div.className = 'flex justify-start';
        div.innerHTML = `
            <div class="response-bubble-inner loading group">
                <div class="response-content whitespace-pre-wrap flex items-center">
                    <div class="loading-dots">
                        <div></div>
                        <div></div>
                        <div></div>
                    </div>
                </div>
                <div class="tool-invocations"></div>
            </div>
        `;

        wrapper.appendChild(div);

        const statusBar = document.createElement('div');
        statusBar.className = 'stream-status-bar';
        statusBar.innerHTML = `
            <div class="status-dot-pulse"></div>
            <span class="stream-status-text">Generating...</span>
            <span class="stream-elapsed text-muted">0.0s</span>
            <button class="stream-cancel-btn">Stop</button>
        `;
        wrapper.appendChild(statusBar);

        statusBar.querySelector('.stream-cancel-btn').addEventListener('click', () => this.cancelCurrentStream());

        const statsBar = document.createElement('div');
        statsBar.className = 'stream-stats-bar';
        statsBar.innerHTML = `
            <span class="flex items-center gap-1">
                <i class="far fa-clock"></i>
                <span class="stats-elapsed"></span>
            </span>
            <span class="divider">|</span>
            <span class="flex items-center gap-1">
                <i class="fas fa-arrow-up text-2xs"></i>
                <span class="stats-input-tokens"></span>
            </span>
            <span class="divider">|</span>
            <span class="flex items-center gap-1">
                <i class="fas fa-arrow-down text-2xs"></i>
                <span class="stats-output-tokens"></span>
            </span>
            <span class="divider">|</span>
            <span class="flex items-center gap-1">
                <i class="fas fa-bolt text-2xs"></i>
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
                bubble.querySelector('.response-bubble-inner').classList.remove('loading');
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
            toolEl.className = 'tool-pill';
            toolEl.dataset.toolInput = typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2);
            toolEl.innerHTML = `
                <i class="fas fa-circle-notch animate-spin text-blue text-2xs"></i>
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

                toolEl.className = 'tool-pill done';
                toolEl.innerHTML = '';

                const pillContent = document.createElement('span');
                pillContent.className = 'inline-flex items-center gap-1';
                pillContent.innerHTML = `
                    <i class="fas fa-check text-green text-2xs"></i>
                    <span>${this.escapeHtml(event.tool)}</span>
                `;
                toolEl.appendChild(pillContent);

                const details = document.createElement('div');
                details.className = 'tool-invocation-details';

                if (toolInput) {
                    const inputSection = document.createElement('div');
                    inputSection.className = 'tool-detail-section';
                    inputSection.innerHTML = '<h4>Input</h4>';
                    const inputPre = document.createElement('pre');
                    inputPre.className = 'tool-detail-pre custom-scrollbar';
                    inputPre.textContent = toolInput;
                    inputSection.appendChild(inputPre);
                    details.appendChild(inputSection);
                }

                const outputSection = document.createElement('div');
                outputSection.className = 'tool-detail-section';
                outputSection.innerHTML = '<h4>Output</h4>';
                const outputPre = document.createElement('pre');
                outputPre.className = 'tool-detail-pre custom-scrollbar';
                outputPre.textContent = toolOutput;
                outputSection.appendChild(outputPre);
                details.appendChild(outputSection);

                toolEl.appendChild(details);

                toolEl.addEventListener('click', (e) => {
                    if (details.contains(e.target)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    toolsDiv.querySelectorAll('.tool-invocation-details.visible').forEach(d => {
                        if (d !== details) d.classList.remove('visible');
                    });
                    const wasHidden = !details.classList.contains('visible');
                    details.classList.toggle('visible');
                    if (wasHidden) {
                        const pillRect = toolEl.getBoundingClientRect();
                        const containerRect = container.getBoundingClientRect();
                        const spaceRight = containerRect.right - pillRect.left;
                        if (spaceRight < 420) {
                            details.style.right = '0';
                            details.style.left = 'auto';
                        } else {
                            details.style.left = '0';
                            details.style.right = 'auto';
                        }
                    }
                });

                const closeHandler = (e) => {
                    if (!toolEl.contains(e.target)) {
                        details.classList.remove('visible');
                    }
                };
                document.addEventListener('click', closeHandler, { capture: true });
                container.scrollTop = container.scrollHeight;

                if (event.tool === 'workspace_write' || event.tool === 'workspace_delete') {
                    try {
                        const result = JSON.parse(typeof event.output === 'string' ? event.output : JSON.stringify(event.output));
                        if (result.success && (result.reloaded === 'agent' || result.unloaded === 'agent')) this.loadAgents();
                    } catch { /* ignore parse errors */ }
                }
            }
        } else if (event.type === 'result') {
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner').classList.remove('loading');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                contentDiv.innerHTML = '';
            }

            const resultContainer = document.createElement('div');
            resultContainer.className = 'panel';

            const resultPre = document.createElement('pre');
            resultPre.className = 'text-sm text-primary font-mono whitespace-pre-wrap overflow-x-auto';
            resultPre.textContent = JSON.stringify(event.output, null, 2);

            resultContainer.appendChild(resultPre);
            contentDiv.appendChild(resultContainer);

            container.scrollTop = container.scrollHeight;
        } else if (event.type === 'error') {
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner').classList.remove('loading');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
            }
            const errorDiv = document.createElement('div');
            errorDiv.className = 'text-red text-sm';
            errorDiv.textContent = `Error: ${event.error}`;
            contentDiv.appendChild(errorDiv);
            container.scrollTop = container.scrollHeight;
        } else if (event.type === 'warning') {
            const warningDiv = document.createElement('div');
            warningDiv.className = 'text-yellow text-sm';
            warningDiv.textContent = event.message;
            contentDiv.appendChild(warningDiv);
            container.scrollTop = container.scrollHeight;
        } else if (event.type === 'usage') {
            this.streamUsageData = {
                input_tokens: event.input_tokens || 0,
                output_tokens: event.output_tokens || 0,
                total_tokens: event.total_tokens || 0,
            };
        } else if (event.type === 'react_iteration') {
            const wrapper = bubble.closest('.response-wrapper');
            const statusText = wrapper?.querySelector('.stream-status-text');
            if (statusText) {
                const contextKB = (event.contextChars / 1024).toFixed(1);
                statusText.textContent = `Iteration ${event.iteration} · ${contextKB} KB context`;
            }
        }
    }

    updateResponseError(id, errorMsg) {
        const bubble = this.querySelector(`#${id}`);
        if (bubble) {
            const content = bubble.querySelector('.response-content');
            content.innerHTML = `<span class="text-red">${errorMsg}</span>`;
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

        const bubbleClass = isUser ? 'user-bubble' : (hasError ? 'response-bubble-inner error' : 'response-bubble-inner');

        // Build attachment thumbnails for user messages
        let attachmentHtml = '';
        if (isUser && metadata.attachments && metadata.attachments.length > 0) {
            const thumbs = metadata.attachments.map(att => {
                if (att.mediaType.startsWith('image/')) {
                    return `<img src="data:${att.mediaType};base64,${att.data}" class="attachment-thumb">`;
                }
                return `<div class="attachment-pill">
                    <i class="fas fa-file"></i>
                    <span class="truncate attachment-name">${this.escapeHtml(att.name)}</span>
                </div>`;
            }).join('');
            attachmentHtml = `<div class="flex flex-wrap gap-2 mb-2">${thumbs}</div>`;
        }

        div.innerHTML = `
            <div class="${bubbleClass} group">
                ${attachmentHtml}
                <div class="whitespace-pre-wrap">${this.escapeHtml(content)}</div>
                ${!isUser && !hasError ? `
                    <button class="copy-btn" title="Copy">
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
            <div class="response-bubble-inner loading">
                <div class="loading-dots">
                    <div></div>
                    <div></div>
                    <div></div>
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
        return sharedEscapeHtml(text);
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
        const workflow = store.get('selectedWorkflow');
        const questions = agent?.sampleQuestions || workflow?.sampleQuestions;
        if (!questions || questions.length === 0) return '';

        const chips = questions.map(q =>
            `<button class="sample-question-chip">${this.escapeHtml(q)}</button>`
        ).join('');

        return `
            <div class="sample-questions-wrap">${chips}</div>
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

        // New agent button
        this.querySelector('#newAgentBtn').addEventListener('click', () => this.showNewAgentModal());

        // Mobile sidebar toggle
        this.querySelector('#sidebarToggleBtn').addEventListener('click', () => this.toggleSidebar(true));
        this.querySelector('#sidebarBackdrop').addEventListener('click', () => this.toggleSidebar(false));
    }

    template() {
        return `
            <div class="agent-shell">
                <!-- Mobile sidebar backdrop -->
                <div id="sidebarBackdrop" class="sidebar-backdrop"></div>

                <!-- Sidebar -->
                <div id="sidebar" class="agent-sidebar">
                    <div class="p-3">
                        <button id="newChatBtn" class="new-chat-btn">
                            <i class="fas fa-plus text-xs text-accent"></i>
                            <span>New chat</span>
                        </button>
                    </div>
                    <div id="sessionList" class="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2"></div>
                    <div class="px-3 sidebar-bottom-action">
                        <button id="newAgentBtn" class="sidebar-secondary-btn">
                            <i class="fas fa-robot text-xs text-blue"></i>
                            <span>New agent</span>
                        </button>
                    </div>
                </div>

                <!-- Chat Area -->
                <div class="chat-area">
                    <!-- Chat Header -->
                    <div class="chat-header">
                        <button id="sidebarToggleBtn" class="sidebar-toggle-btn">
                            <i class="fas fa-bars"></i>
                        </button>
                        <div id="chatHeader" class="flex-1 min-w-0">
                            <span class="text-muted">No conversation selected</span>
                        </div>
                    </div>

                    <!-- Chat Messages -->
                    <div id="chatMessages" class="chat-messages custom-scrollbar"></div>

                    <!-- Input Area -->
                    <div class="chat-input-area">
                        <div id="attachmentPreview" class="attachment-preview"></div>
                        <div class="chat-input-wrap">
                            <input type="file" id="fileInput" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.go,.rs,.rb,.php,.sql,.sh,.log,.ini,.toml,.env" class="hidden">
                            <textarea id="chatInput" rows="1" readonly
                                placeholder="Ask anything"></textarea>

                            <div class="chat-input-actions left">
                                <button id="attachBtn" type="button" class="attach-btn" title="Attach files">
                                    <i class="fas fa-plus text-sm"></i>
                                </button>
                            </div>

                            <div class="chat-input-actions right">
                                <button id="sendMessageBtn" disabled class="send-btn">
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
