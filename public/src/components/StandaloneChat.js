class StandaloneChat extends HTMLElement {
    constructor() {
        super();
        this.agentName = '';
        this.agentConfig = null;
        this.isLoading = false;
        this.currentAbortController = null;
        this.streamStartTime = null;
        this.streamTimerInterval = null;
        this.streamUsageData = null;
        this.pendingAttachments = [];
    }

    connectedCallback() {
        // Extract agent name from URL: /chat/:agentName
        const parts = window.location.pathname.split('/');
        this.agentName = parts[parts.length - 1] || '';

        if (!this.agentName) {
            this.innerHTML = '<div class="auth-overlay"><span class="text-secondary">Invalid agent URL</span></div>';
            return;
        }

        this.sessionId = sessionStorage.getItem(`chat-session-${this.agentName}`) || this.generateSessionId();
        sessionStorage.setItem(`chat-session-${this.agentName}`, this.sessionId);

        this.loadConfig();
    }

    generateSessionId() {
        return 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    }

    getToken() {
        return sessionStorage.getItem(`chat-token-${this.agentName}`);
    }

    setToken(token) {
        sessionStorage.setItem(`chat-token-${this.agentName}`, token);
    }

    async loadConfig() {
        try {
            const res = await fetch(`/api/chat/${this.agentName}/config`);
            if (!res.ok) {
                this.innerHTML = '<div class="auth-overlay"><span class="text-secondary">Agent not found or not published</span></div>';
                return;
            }
            this.agentConfig = await res.json();
            document.title = `${this.agentConfig.name} — Agent Orcha`;

            if (this.agentConfig.requiresPassword && !this.getToken()) {
                this.renderPasswordOverlay();
            } else {
                this.renderChat();
            }
        } catch {
            this.innerHTML = '<div class="auth-overlay"><span class="text-secondary">Failed to load agent</span></div>';
        }
    }

    // --- Password overlay ---

    renderPasswordOverlay() {
        this.innerHTML = `
            <div class="auth-overlay">
                <div class="auth-card">
                    <div class="text-center mb-6">
                        <i class="fas fa-lock text-2xl text-muted mb-3"></i>
                        <h2 class="text-lg font-semibold text-primary">${this.escapeHtml(this.agentConfig.name)}</h2>
                        <p class="text-sm text-secondary mt-1">This agent requires a password</p>
                    </div>
                    <div id="authError" class="hidden text-sm text-red text-center mb-3"></div>
                    <div class="relative">
                        <input id="passwordInput" type="password" class="input w-full"
                            placeholder="Enter password">
                    </div>
                    <button id="authBtn" class="btn btn-accent w-full mt-4">
                        Continue
                    </button>
                </div>
            </div>
        `;

        const passwordInput = this.querySelector('#passwordInput');
        const authBtn = this.querySelector('#authBtn');

        authBtn.addEventListener('click', () => this.authenticate());
        passwordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.authenticate();
        });
        passwordInput.focus();
    }

    async authenticate() {
        const passwordInput = this.querySelector('#passwordInput');
        const authError = this.querySelector('#authError');
        const password = passwordInput.value;

        if (!password) return;

        try {
            const res = await fetch(`/api/chat/${this.agentName}/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });

            if (!res.ok) {
                authError.textContent = 'Invalid password';
                authError.classList.remove('hidden');
                passwordInput.value = '';
                passwordInput.focus();
                return;
            }

            const { token } = await res.json();
            this.setToken(token);
            this.renderChat();
        } catch {
            authError.textContent = 'Authentication failed';
            authError.classList.remove('hidden');
        }
    }

    // --- Chat UI ---

    renderChat() {
        const desc = this.agentConfig.description
            ? `<p class="text-xs text-muted truncate">${this.escapeHtml(this.agentConfig.description)}</p>`
            : '';

        this.innerHTML = `
            <div class="standalone-shell">
                <!-- Header -->
                <div class="standalone-header">
                    <i class="fas fa-robot text-accent"></i>
                    <div class="min-w-0">
                        <h1 class="text-sm font-semibold text-primary">${this.escapeHtml(this.agentConfig.name)}</h1>
                        ${desc}
                    </div>
                </div>

                <!-- Messages -->
                <div id="chatMessages" class="chat-messages custom-scrollbar">
                    ${this.renderSampleQuestions()}
                </div>

                <!-- Input -->
                <div class="chat-input-area">
                    <div id="attachmentPreview" class="attachment-preview"></div>
                    <div class="chat-input-wrap">
                        <input type="file" id="fileInput" multiple accept="image/*,.pdf" class="hidden">
                        <textarea id="chatInput" rows="1"
                            placeholder="Type a message..."></textarea>
                        <div class="chat-input-actions left">
                            <button id="attachBtn" type="button" class="attach-btn" title="Attach files">
                                <i class="fas fa-plus text-sm"></i>
                            </button>
                        </div>
                        <div class="chat-input-actions right">
                            <button id="sendBtn" class="send-btn">
                                <i class="fas fa-paper-plane text-sm"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.bindChatEvents();
    }

    renderSampleQuestions() {
        const questions = this.agentConfig.sampleQuestions;
        if (!questions || questions.length === 0) return '';

        const chips = questions.map(q =>
            `<button class="sample-question-chip">${this.escapeHtml(q)}</button>`
        ).join('');

        return `
            <div id="sampleQuestions" class="welcome-container">
                <p class="text-muted text-sm">Try asking</p>
                <div class="sample-questions-wrap">${chips}</div>
            </div>
        `;
    }

    bindChatEvents() {
        const input = this.querySelector('#chatInput');
        const sendBtn = this.querySelector('#sendBtn');

        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        sendBtn.addEventListener('click', () => this.sendMessage());

        this.querySelector('#attachBtn').addEventListener('click', () => this.querySelector('#fileInput').click());
        this.querySelector('#fileInput').addEventListener('change', (e) => this.handleFileSelect(e));

        this.querySelectorAll('.sample-question-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                input.value = chip.textContent;
                input.focus();
            });
        });

        input.focus();
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
                    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
                    this.pendingAttachments.push({ data: base64, mediaType: file.type || 'application/octet-stream', name: file.name });
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
            this.pendingAttachments.push({ data: dataUrl.split(',')[1], mediaType: 'image/jpeg', name: file.name });
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
                this.pendingAttachments.splice(parseInt(e.currentTarget.dataset.index, 10), 1);
                this.renderAttachmentPreview();
            });
        });
    }

    // --- Messaging ---

    async sendMessage() {
        const input = this.querySelector('#chatInput');
        const message = input.value.trim();
        const hasAttachments = this.pendingAttachments.length > 0;

        if ((!message && !hasAttachments) || this.isLoading) return;

        const attachments = hasAttachments ? [...this.pendingAttachments] : null;

        const sampleQDiv = this.querySelector('#sampleQuestions');
        if (sampleQDiv) sampleQDiv.remove();

        this.appendUserMessage(message || '(attached files)', attachments);
        input.value = '';
        input.style.height = 'auto';
        this.pendingAttachments = [];
        this.renderAttachmentPreview();

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
            finalContent = await this.streamAgent(message, responseId, attachments);
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
    }

    async streamAgent(message, responseId, attachments) {
        const inputVars = this.agentConfig.inputVariables || ['message'];
        const inputObj = {};
        inputObj[inputVars[0] || 'message'] = message;
        if (attachments) inputObj.attachments = attachments;

        const headers = { 'Content-Type': 'application/json' };
        const token = this.getToken();
        if (token) headers['X-Chat-Token'] = token;

        const res = await fetch(`/api/chat/${this.agentName}/stream`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: inputObj, sessionId: this.sessionId }),
            signal: this.currentAbortController?.signal,
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        const bubble = this.querySelector(`#${responseId}`);
        const contentDiv = bubble.querySelector('.response-content');
        const container = this.querySelector('#chatMessages');
        const thinkingState = { inThinking: false, thinkingSections: [], currentSection: null };

        let currentContent = '';
        let buffer = '';
        let hasToolCalls = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim() === '') continue;
                if (!line.startsWith('data: ')) continue;

                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const event = JSON.parse(data);

                    if (event.error) {
                        this.updateResponseError(responseId, `Error: ${event.error}`);
                        return currentContent;
                    }

                    if (event.type === 'content') currentContent += event.content;
                    if (event.type === 'tool_start' || event.type === 'tool_end') hasToolCalls = true;

                    this.handleStreamEvent(event, responseId, currentContent, thinkingState);
                } catch (e) {
                    console.error('Error parsing stream event', e, data);
                }
            }
        }

        // Finalize any remaining thinking pill
        const toolsDiv = bubble.querySelector('.tool-invocations');
        this.finalizeThinkingPill(toolsDiv, thinkingState);

        // If tools were called but no text content, clear loading state
        if (hasToolCalls && !currentContent.trim()) {
            const loadingDots = contentDiv.querySelector('.loading-dots');
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner').classList.remove('loading');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                contentDiv.innerHTML = '';
            }
        }

        return currentContent;
    }

    // --- Stream event handling ---

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
            this.finalizeThinkingPill(toolsDiv, thinkingState);
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.response-bubble-inner').classList.remove('loading');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                contentDiv.innerHTML = '';
            }
            this.renderContentStreaming(contentDiv, currentContent, responseId, thinkingState);
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

                document.addEventListener('click', (e) => {
                    if (!toolEl.contains(e.target)) details.classList.remove('visible');
                }, { capture: true });
                container.scrollTop = container.scrollHeight;
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

    // --- Markdown streaming renderer ---

    renderContentStreaming(contentDiv, fullContent, responseId, state) {
        const existing = contentDiv.querySelector('.content-text');
        if (existing) {
            existing.innerHTML = this.renderMarkdown(fullContent);
            this.highlightCode(existing);
        } else {
            const div = document.createElement('div');
            div.className = 'content-text markdown-content';
            div.innerHTML = this.renderMarkdown(fullContent);
            this.highlightCode(div);
            contentDiv.appendChild(div);
        }
    }

    handleThinkingEvent(event, toolsDiv, thinkingState, container) {
        if (!thinkingState.thinkingContent) {
            thinkingState.thinkingContent = '';
        }
        thinkingState.thinkingContent += event.content;

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
        popoverContent.innerHTML = this.renderMarkdown(content);
        this.highlightCode(popoverContent);
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

    // --- Bubble rendering ---

    appendUserMessage(content, attachments) {
        const container = this.querySelector('#chatMessages');
        const div = document.createElement('div');
        div.className = 'flex justify-end';

        let attachmentHtml = '';
        if (attachments && attachments.length > 0) {
            const thumbs = attachments.map(att => {
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
            <div class="user-bubble">
                ${attachmentHtml}
                <div class="whitespace-pre-wrap">${this.escapeHtml(content)}</div>
            </div>
        `;

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
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

        statusBar.querySelector('.stream-cancel-btn').addEventListener('click', () => {
            if (this.currentAbortController) this.currentAbortController.abort();
        });

        const statsBar = document.createElement('div');
        statsBar.className = 'stream-stats-bar';
        statsBar.innerHTML = `
            <span class="flex items-center gap-1"><i class="far fa-clock"></i><span class="stats-elapsed"></span></span>
            <span class="divider">|</span>
            <span class="flex items-center gap-1"><i class="fas fa-arrow-up text-2xs"></i><span class="stats-input-tokens"></span></span>
            <span class="divider">|</span>
            <span class="flex items-center gap-1"><i class="fas fa-arrow-down text-2xs"></i><span class="stats-output-tokens"></span></span>
            <span class="divider">|</span>
            <span class="flex items-center gap-1"><i class="fas fa-bolt text-2xs"></i><span class="stats-tps"></span></span>
        `;
        wrapper.appendChild(statsBar);

        container.appendChild(wrapper);
        container.scrollTop = container.scrollHeight;
    }

    updateResponseError(id, errorMsg) {
        const bubble = this.querySelector(`#${id}`);
        if (bubble) {
            bubble.querySelector('.response-content').innerHTML = `<span class="text-red">${this.escapeHtml(errorMsg)}</span>`;
        }
    }

    // --- Timer & stats ---

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

    startStreamTimer(responseId) {
        this.streamStartTime = Date.now();
        this.streamTimerInterval = setInterval(() => {
            const elapsed = Date.now() - this.streamStartTime;
            const bubble = this.querySelector(`#${responseId}`);
            if (!bubble) return;
            const timerEl = bubble.parentElement.querySelector('.stream-elapsed');
            if (timerEl) timerEl.textContent = this.formatElapsedTime(elapsed);
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
                const badge = document.createElement('span');
                badge.className = 'badge badge-amber';
                badge.textContent = 'Cancelled';
                statsBar.appendChild(badge);
            }

            statsBar.classList.add('visible');
        }
    }

    // --- UI state ---

    updateUiState() {
        const btn = this.querySelector('#sendBtn');
        const input = this.querySelector('#chatInput');
        if (btn) btn.disabled = this.isLoading;
        if (input) input.disabled = this.isLoading;
    }

    // --- Markdown helpers ---

    renderMarkdown(text) {
        if (!text) return '';
        try {
            const rawHtml = marked.parse(text);
            return DOMPurify.sanitize(rawHtml, {
                ALLOWED_TAGS: [
                    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'p', 'br', 'strong', 'em', 'u', 's', 'del',
                    'ul', 'ol', 'li',
                    'a', 'code', 'pre',
                    'blockquote', 'hr',
                    'table', 'thead', 'tbody', 'tr', 'th', 'td',
                    'span', 'div'
                ],
                ALLOWED_ATTR: ['href', 'class', 'id', 'target', 'rel'],
                ALLOW_DATA_ATTR: false,
            });
        } catch {
            return this.escapeHtml(text);
        }
    }

    highlightCode(element) {
        if (typeof hljs === 'undefined') return;
        element.querySelectorAll('pre code').forEach(block => {
            block.removeAttribute('data-highlighted');
            hljs.highlightElement(block);
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

customElements.define('standalone-chat', StandaloneChat);
