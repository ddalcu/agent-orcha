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
            <div class="standalone-container">
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
                            <input type="file" id="fileInput" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.go,.rs,.rb,.php,.sql,.sh,.log,.ini,.toml,.env" class="hidden">
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

                <div id="canvasPane" class="canvas-pane hidden">
                    <div class="canvas-header">
                        <span id="canvasTitle" class="canvas-title">Canvas</span>
                        <div class="canvas-toggle">
                            <button class="canvas-toggle-btn active" data-view="preview">Preview</button>
                            <button class="canvas-toggle-btn" data-view="code">Code</button>
                        </div>
                        <button id="canvasPublishBtn" class="canvas-publish-btn" title="Publish">
                            <i class="fas fa-arrow-up-from-bracket text-xs"></i>
                        </button>
                        <button id="canvasCloseBtn" class="canvas-close-btn">
                            <i class="fas fa-xmark"></i>
                        </button>
                    </div>
                    <div class="canvas-body custom-scrollbar">
                        <div id="canvasPreviewView" class="canvas-preview markdown-content"></div>
                        <iframe id="canvasHtmlView" class="canvas-iframe hidden" sandbox="allow-scripts allow-same-origin"></iframe>
                        <pre id="canvasCodeView" class="canvas-code hidden"><code></code></pre>
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

        // Canvas controls
        this.querySelector('#canvasCloseBtn').addEventListener('click', () => this.closeCanvas());
        this.querySelector('#canvasPublishBtn').addEventListener('click', () => this.showPublishModal());
        this.querySelectorAll('.canvas-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => this.toggleCanvasView(btn.dataset.view));
        });

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

    // --- Loop ---

    _parseLoopCommand(message) {
        const match = message.match(/^\/loop\s+(\d+)(m|h)\s+(.+)$/is);
        if (!match) return null;
        const amount = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        const prompt = match[3].trim();
        if (!amount || !prompt) return null;
        const ms = unit === 'h' ? amount * 3600000 : amount * 60000;
        return { ms, prompt, label: `${amount}${unit}` };
    }

    _startLoop(ms, prompt, label) {
        this._stopLoop();
        this._loopPrompt = prompt;
        this._loopLabel = label;
        this._loopInterval = setInterval(() => {
            if (!this.isLoading) this._sendLoopMessage(this._loopPrompt);
        }, ms);
        this._appendSystemMessage(`Loop started — will run every ${label}: "${prompt}". Type /stop to cancel.`);
        // Run immediately
        this._sendLoopMessage(prompt);
    }

    _stopLoop() {
        if (this._loopInterval) {
            clearInterval(this._loopInterval);
            this._loopInterval = null;
            this._appendSystemMessage('Loop stopped.');
        }
        this._loopPrompt = null;
        this._loopLabel = null;
    }

    async _sendLoopMessage(prompt) {
        if (this.isLoading) return;

        const sampleQDiv = this.querySelector('#sampleQuestions');
        if (sampleQDiv) sampleQDiv.remove();

        this.appendUserMessage(`[loop] ${prompt}`);

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
            finalContent = await this.streamAgent(prompt, responseId, null);
        } catch (e) {
            if (e.name === 'AbortError') wasCancelled = true;
            else this.updateResponseError(responseId, `Error: ${e.message}`);
        } finally {
            this.stopStreamTimer(responseId, prompt, finalContent, wasCancelled);
            this.currentAbortController = null;
            this.isLoading = false;
            this.updateUiState();
        }
    }

    _appendSystemMessage(text) {
        const container = this.querySelector('#chatMessages');
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'system-message';
        div.innerHTML = `<i class="fas fa-rotate text-xs"></i> <span>${this.escapeHtml(text)}</span>`;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    // --- Messaging ---

    async sendMessage() {
        const input = this.querySelector('#chatInput');
        const message = input.value.trim();
        const hasAttachments = this.pendingAttachments.length > 0;

        if ((!message && !hasAttachments) || this.isLoading) return;

        // Handle /loop and /stop commands
        if (message.toLowerCase() === '/stop') {
            input.value = '';
            this._stopLoop();
            return;
        }
        const loop = this._parseLoopCommand(message);
        if (loop) {
            input.value = '';
            input.style.height = 'auto';
            this._startLoop(loop.ms, loop.prompt, loop.label);
            return;
        }

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
        const thinkingState = { inThinking: false, thinkingSections: [], currentSection: null, thinkingContent: '', thinkingPill: null };

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

                // Intercept canvas tools
                if (event.tool === 'canvas_write' && toolInput) {
                    try {
                        const parsed = JSON.parse(toolInput);
                        this.openCanvas(parsed.content, parsed.title, parsed.format || 'markdown', parsed.language, parsed.mode);
                    } catch {}
                } else if (event.tool === 'canvas_append' && toolInput) {
                    try {
                        const parsed = JSON.parse(toolInput);
                        this.appendCanvas(parsed.content);
                    } catch {}
                }

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

                this._attachClickDetails(toolEl, details, toolsDiv, container);
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

    _attachClickDetails(pillEl, detailsEl, toolsDiv, container) {
        pillEl.addEventListener('click', (e) => {
            if (detailsEl.contains(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            toolsDiv.querySelectorAll('.tool-invocation-details.visible').forEach(d => {
                if (d !== detailsEl) d.classList.remove('visible');
            });
            const wasHidden = !detailsEl.classList.contains('visible');
            detailsEl.classList.toggle('visible');
            if (wasHidden && container) {
                const pillRect = pillEl.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const spaceRight = containerRect.right - pillRect.left;
                if (spaceRight < 420) {
                    detailsEl.style.right = '0';
                    detailsEl.style.left = 'auto';
                } else {
                    detailsEl.style.left = '0';
                    detailsEl.style.right = 'auto';
                }
            }
        });
        document.addEventListener('click', (e) => {
            if (!pillEl.contains(e.target)) detailsEl.classList.remove('visible');
        }, { capture: true });
    }

    finalizeThinkingPill(toolsDiv, thinkingState) {
        const container = this.querySelector('#chatMessages');
        const pill = thinkingState.thinkingPill;
        if (!pill) return;

        const content = thinkingState.thinkingContent || '';
        thinkingState.thinkingPill = null;
        thinkingState.thinkingContent = '';

        pill.className = 'tool-pill done thinking';
        pill.innerHTML = '';

        const pillContent = document.createElement('span');
        pillContent.className = 'inline-flex items-center gap-1';
        pillContent.innerHTML = '<i class="fas fa-brain text-purple text-2xs"></i><span>Thinking</span>';
        pill.appendChild(pillContent);

        const details = document.createElement('div');
        details.className = 'tool-invocation-details';

        const section = document.createElement('div');
        section.className = 'tool-detail-section';
        const pre = document.createElement('div');
        pre.className = 'tool-detail-pre markdown-content custom-scrollbar';
        pre.innerHTML = this.renderMarkdown(content);
        this.highlightCode(pre);
        section.appendChild(pre);
        details.appendChild(section);
        pill.appendChild(details);

        this._attachClickDetails(pill, details, toolsDiv, container);
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

    // --- Canvas ---

    openCanvas(content, title, format, language, mode) {
        const pane = this.querySelector('#canvasPane');
        const container = this.querySelector('.standalone-container');
        if (!pane || !container) return;

        pane.classList.remove('hidden');
        container.classList.add('canvas-open');

        if (title) pane.querySelector('#canvasTitle').textContent = title;

        this._canvasContent = content;
        this._canvasFormat = format;
        this._canvasLanguage = language;

        this._renderCanvasContent(pane, content, format, language);

        const defaultMode = mode || (format === 'code' ? 'code' : 'preview');
        this.toggleCanvasView(defaultMode);
    }

    appendCanvas(content) {
        const pane = this.querySelector('#canvasPane');
        if (!pane || !this._canvasContent) return;

        this._canvasContent += content;
        this._renderCanvasContent(pane, this._canvasContent, this._canvasFormat, this._canvasLanguage);
    }

    _renderCanvasContent(pane, content, format, language) {
        const previewEl = pane.querySelector('#canvasPreviewView');
        const htmlEl = pane.querySelector('#canvasHtmlView');
        const codeEl = pane.querySelector('#canvasCodeView code');

        // Reset visibility — toggleCanvasView will set the right one
        previewEl.classList.add('hidden');
        htmlEl.classList.add('hidden');
        pane.querySelector('#canvasCodeView').classList.add('hidden');

        if (format === 'html') {
            // Live HTML rendering in sandboxed iframe
            htmlEl.srcdoc = content;
            // Code view shows HTML source
            codeEl.textContent = content;
            codeEl.className = 'language-html';
        } else if (format === 'code') {
            // Code format — preview IS the syntax-highlighted code
            const lang = language || 'plaintext';
            codeEl.textContent = content;
            codeEl.className = `language-${lang}`;
            // Preview shows the same highlighted code (no markdown rendering)
            previewEl.innerHTML = '';
            const pre = document.createElement('pre');
            pre.className = 'canvas-code';
            const code = document.createElement('code');
            code.className = `language-${lang}`;
            code.textContent = content;
            pre.appendChild(code);
            previewEl.appendChild(pre);
            if (typeof hljs !== 'undefined') hljs.highlightElement(code);
        } else {
            // Markdown — render as rich text
            previewEl.innerHTML = this.renderMarkdown(content);
            this.highlightCode(previewEl);
            codeEl.textContent = content;
            codeEl.className = 'language-markdown';
        }

        codeEl.removeAttribute('data-highlighted');
        if (typeof hljs !== 'undefined') hljs.highlightElement(codeEl);
    }

    showPublishModal() {
        if (!this._canvasContent) return;

        const existing = document.querySelector('#canvasPublishModal');
        if (existing) existing.remove();

        const defaultKey = 'canvas-' + Date.now().toString(36);

        const overlay = document.createElement('div');
        overlay.id = 'canvasPublishModal';
        overlay.className = 'modal-backdrop';
        overlay.innerHTML = `
            <div class="modal-content modal-content-sm">
                <div class="modal-header">
                    <h3 class="text-lg font-semibold text-primary">Publish Canvas</h3>
                    <button id="closePublishModal" class="modal-close-btn">
                        <i class="fas fa-xmark"></i>
                    </button>
                </div>
                <div class="p-4 flex flex-col gap-3">
                    <div>
                        <label class="text-xs text-muted block mb-1">Page name</label>
                        <input id="publishKey" type="text" class="input w-full" value="${defaultKey}" placeholder="my-page">
                    </div>
                    <div id="publishResult" class="hidden">
                        <label class="text-xs text-muted block mb-1">Published URL</label>
                        <div class="flex gap-2">
                            <input id="publishUrl" type="text" class="input w-full" readonly>
                            <button id="copyPublishUrl" class="btn btn-sm">
                                <i class="fas fa-copy"></i>
                            </button>
                        </div>
                    </div>
                    <div id="publishError" class="hidden text-sm text-red"></div>
                    <button id="doPublishBtn" class="btn btn-accent w-full">
                        <i class="fas fa-arrow-up-from-bracket text-xs"></i>
                        <span>Publish</span>
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        overlay.querySelector('#closePublishModal').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#doPublishBtn').addEventListener('click', () => this._publishToHtmlHost(overlay));
        overlay.querySelector('#copyPublishUrl')?.addEventListener('click', () => {
            const urlInput = overlay.querySelector('#publishUrl');
            navigator.clipboard.writeText(urlInput.value);
            const icon = overlay.querySelector('#copyPublishUrl i');
            icon.className = 'fas fa-check text-green';
            setTimeout(() => { icon.className = 'fas fa-copy'; }, 1500);
        });
        overlay.querySelector('#publishKey').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._publishToHtmlHost(overlay);
        });
    }

    _buildPublishHtml() {
        const content = this._canvasContent;
        const format = this._canvasFormat;
        const title = this.querySelector('#canvasTitle')?.textContent || 'Canvas';

        if (format === 'html') {
            return content;
        }

        if (format === 'code') {
            const lang = this._canvasLanguage || 'plaintext';
            const escaped = this.escapeHtml(content);
            return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${this.escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
<style>body{background:#1b1c28;margin:0;padding:24px}pre{margin:0}code{font-size:14px}</style>
</head><body><pre><code class="language-${lang}">${escaped}</code></pre>
<script>hljs.highlightAll()<\/script></body></html>`;
        }

        // Markdown — render to HTML
        const rendered = this.renderMarkdown(content);
        return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${this.escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:48rem;margin:0 auto;padding:24px;line-height:1.7;color:#e8e8ec;background:#1b1c28}
a{color:#5e6ad2}pre{background:#25262f;padding:16px;border-radius:8px;overflow-x:auto}code{font-size:14px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #2e2f3a;padding:8px 12px;text-align:left}
blockquote{border-left:3px solid #5e6ad2;margin:0;padding:0 16px;color:#8f8f96}
img{max-width:100%;border-radius:8px}h1,h2,h3,h4{margin-top:1.5em;margin-bottom:0.5em}</style>
</head><body>${rendered}</body></html>`;
    }

    async _publishToHtmlHost(overlay) {
        const keyInput = overlay.querySelector('#publishKey');
        const resultDiv = overlay.querySelector('#publishResult');
        const errorDiv = overlay.querySelector('#publishError');
        const btn = overlay.querySelector('#doPublishBtn');
        const key = keyInput.value.trim();

        if (!key) {
            errorDiv.textContent = 'Please enter a page name';
            errorDiv.classList.remove('hidden');
            return;
        }

        errorDiv.classList.add('hidden');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-circle-notch animate-spin text-xs"></i> <span>Publishing...</span>';

        try {
            const html = this._buildPublishHtml();
            const res = await fetch('/api/publish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value: html }),
            });

            if (!res.ok) {
                const err = await res.text();
                throw new Error(err || `HTTP ${res.status}`);
            }

            const url = `https://htmlhost.jax.workers.dev/render/${key}`;
            overlay.querySelector('#publishUrl').value = url;
            resultDiv.classList.remove('hidden');
            btn.innerHTML = '<i class="fas fa-check text-xs"></i> <span>Published</span>';
            btn.classList.remove('btn-accent');
            btn.classList.add('btn');
        } catch (e) {
            errorDiv.textContent = `Failed to publish: ${e.message}`;
            errorDiv.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-arrow-up-from-bracket text-xs"></i> <span>Publish</span>';
        }
    }

    closeCanvas() {
        const pane = this.querySelector('#canvasPane');
        const container = this.querySelector('.standalone-container');
        if (pane) pane.classList.add('hidden');
        if (container) container.classList.remove('canvas-open');
    }

    toggleCanvasView(mode) {
        const pane = this.querySelector('#canvasPane');
        if (!pane) return;

        const previewEl = pane.querySelector('#canvasPreviewView');
        const htmlEl = pane.querySelector('#canvasHtmlView');
        const codeEl = pane.querySelector('#canvasCodeView');

        pane.querySelectorAll('.canvas-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === mode);
        });

        if (mode === 'code') {
            previewEl.classList.add('hidden');
            htmlEl.classList.add('hidden');
            codeEl.classList.remove('hidden');
        } else {
            codeEl.classList.add('hidden');
            if (this._canvasFormat === 'html') {
                previewEl.classList.add('hidden');
                htmlEl.classList.remove('hidden');
            } else {
                htmlEl.classList.add('hidden');
                previewEl.classList.remove('hidden');
            }
        }
    }

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
