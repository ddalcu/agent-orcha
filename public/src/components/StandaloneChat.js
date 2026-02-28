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
            this.innerHTML = '<div class="flex items-center justify-center h-screen text-gray-400">Invalid agent URL</div>';
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
                this.innerHTML = '<div class="flex items-center justify-center h-screen text-gray-400">Agent not found or not published</div>';
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
            this.innerHTML = '<div class="flex items-center justify-center h-screen text-gray-400">Failed to load agent</div>';
        }
    }

    // --- Password overlay ---

    renderPasswordOverlay() {
        this.innerHTML = `
            <div class="flex items-center justify-center h-screen">
                <div class="bg-dark-surface border border-dark-border rounded-2xl p-8 w-[380px] max-w-[90vw] fade-in">
                    <div class="text-center mb-6">
                        <i class="fas fa-lock text-2xl text-gray-500 mb-3"></i>
                        <h2 class="text-lg font-semibold text-gray-100">${this.escapeHtml(this.agentConfig.name)}</h2>
                        <p class="text-sm text-gray-400 mt-1">This agent requires a password</p>
                    </div>
                    <div id="authError" class="hidden text-sm text-red-400 text-center mb-3"></div>
                    <div class="relative">
                        <input id="passwordInput" type="password"
                            class="w-full bg-dark-bg border border-dark-border rounded-xl px-4 py-3 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-500 transition-colors"
                            placeholder="Enter password">
                    </div>
                    <button id="authBtn"
                        class="w-full mt-4 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white py-3 rounded-xl font-medium transition-all">
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
            ? `<p class="text-xs text-gray-500 truncate">${this.escapeHtml(this.agentConfig.description)}</p>`
            : '';

        this.innerHTML = `
            <div class="flex flex-col h-screen max-w-4xl mx-auto">
                <!-- Header -->
                <div class="flex-shrink-0 flex items-center gap-3 px-5 py-4 border-b border-dark-border/40">
                    <i class="fas fa-robot text-blue-400"></i>
                    <div class="min-w-0">
                        <h1 class="text-sm font-semibold text-gray-100">${this.escapeHtml(this.agentConfig.name)}</h1>
                        ${desc}
                    </div>
                </div>

                <!-- Messages -->
                <div id="chatMessages" class="flex-1 overflow-y-auto space-y-4 p-4 pr-2 pb-6">
                    ${this.renderSampleQuestions()}
                </div>

                <!-- Input -->
                <div class="p-3 pt-0">
                    <div id="attachmentPreview" class="hidden flex flex-wrap gap-2 px-2 pb-2"></div>
                    <div class="relative bg-dark-surface border border-dark-border/60 rounded-2xl focus-within:border-gray-500 transition-colors">
                        <input type="file" id="fileInput" multiple accept="image/*,.pdf" class="hidden">
                        <textarea id="chatInput" rows="1"
                            class="w-full bg-transparent pl-11 pr-14 py-3 text-gray-100 placeholder-gray-500 resize-none focus:outline-none max-h-[200px]"
                            placeholder="Type a message..."></textarea>
                        <div class="absolute bottom-2 left-2 flex items-center">
                            <button id="attachBtn" type="button"
                                class="text-gray-500 hover:text-gray-300 p-1.5 rounded-lg hover:bg-dark-hover transition-colors"
                                title="Attach files">
                                <i class="fas fa-plus text-sm"></i>
                            </button>
                        </div>
                        <div class="absolute bottom-2 right-2 flex items-center gap-2">
                            <button id="sendBtn"
                                class="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white p-2 rounded-lg transition-all shadow-lg shadow-blue-900/20">
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
            `<button class="sample-question-chip bg-dark-surface border border-dark-border/60 hover:border-gray-500 text-gray-300 text-sm px-4 py-2 rounded-2xl transition-colors text-left">${this.escapeHtml(q)}</button>`
        ).join('');

        return `
            <div id="sampleQuestions" class="flex-1 flex flex-col items-center justify-center gap-4">
                <p class="text-gray-500 text-sm">Try asking</p>
                <div class="flex flex-wrap justify-center gap-2 max-w-2xl px-4">${chips}</div>
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
                bubble.querySelector('.response-bubble-inner').classList.remove('py-4');
                bubble.querySelector('.response-bubble-inner').classList.add('py-3');
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
                bubble.querySelector('.response-bubble-inner').classList.remove('py-4');
                bubble.querySelector('.response-bubble-inner').classList.add('py-3');
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
                    inputSection.innerHTML = '<div class="text-xs font-semibold text-gray-400 mb-1">Input</div>';
                    const inputPre = document.createElement('pre');
                    inputPre.className = 'text-xs text-gray-400 bg-dark-bg/60 rounded-md p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all';
                    inputPre.textContent = toolInput;
                    inputSection.appendChild(inputPre);
                    details.appendChild(inputSection);
                }

                const outputSection = document.createElement('div');
                outputSection.className = 'p-3';
                outputSection.innerHTML = '<div class="text-xs font-semibold text-gray-400 mb-1">Output</div>';
                const outputPre = document.createElement('pre');
                outputPre.className = 'text-xs text-gray-400 bg-dark-bg/60 rounded-md p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all';
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

                document.addEventListener('click', (e) => {
                    if (!toolEl.contains(e.target)) details.classList.add('hidden');
                }, { capture: true });
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
        popoverContent.innerHTML = this.renderMarkdown(content);
        this.highlightCode(popoverContent);
        popover.appendChild(popoverContent);
        pill.appendChild(popover);

        pill.addEventListener('mouseenter', () => popover.classList.remove('hidden'));
        pill.addEventListener('mouseleave', () => popover.classList.add('hidden'));
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
            <div class="max-w-4xl bg-dark-surface border border-transparent rounded-3xl px-5 py-3 text-gray-100 text-[15px] leading-relaxed">
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

        statusBar.querySelector('.stream-cancel-btn').addEventListener('click', () => {
            if (this.currentAbortController) this.currentAbortController.abort();
        });

        const statsBar = document.createElement('div');
        statsBar.className = 'stream-stats-bar hidden flex items-center gap-3 mt-1.5 ml-1 text-xs text-gray-500';
        statsBar.innerHTML = `
            <span class="flex items-center gap-1"><i class="far fa-clock"></i><span class="stats-elapsed"></span></span>
            <span class="text-dark-border">|</span>
            <span class="flex items-center gap-1"><i class="fas fa-arrow-up text-[9px]"></i><span class="stats-input-tokens"></span></span>
            <span class="text-dark-border">|</span>
            <span class="flex items-center gap-1"><i class="fas fa-arrow-down text-[9px]"></i><span class="stats-output-tokens"></span></span>
            <span class="text-dark-border">|</span>
            <span class="flex items-center gap-1"><i class="fas fa-bolt text-[9px]"></i><span class="stats-tps"></span></span>
        `;
        wrapper.appendChild(statsBar);

        container.appendChild(wrapper);
        container.scrollTop = container.scrollHeight;
    }

    updateResponseError(id, errorMsg) {
        const bubble = this.querySelector(`#${id}`);
        if (bubble) {
            bubble.querySelector('.response-content').innerHTML = `<span class="text-red-400">${this.escapeHtml(errorMsg)}</span>`;
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
                const badge = document.createElement('span');
                badge.className = 'text-xs text-amber-400 font-medium ml-2';
                badge.textContent = 'Cancelled';
                statsBar.appendChild(badge);
            }

            statsBar.classList.remove('hidden');
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
