
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';
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
    }

    async connectedCallback() {
        super.connectedCallback();
        await Promise.all([this.loadAgents(), this.loadLLMs()]);
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
            store.set('agents', agents);

            if (agents.length > 0 && !store.get('selectedAgent') && !store.get('selectedLlm')) {
                store.set('selectedAgent', agents[agents.length - 1]);
                store.set('selectionType', 'agent');
            }

            this.renderAgentDropdown();
            this.updateSelectedAgentUI();
        } catch (e) {
            console.error('Failed to load agents', e);
        }
    }

    async loadLLMs() {
        try {
            const llms = await api.getLLMs();
            store.set('llms', llms);
            this.renderAgentDropdown();
        } catch (e) {
            console.error('Failed to load LLMs', e);
        }
    }

    renderAgentDropdown() {
        const list = this.querySelector('#agentDropdownList');
        const agents = store.get('agents') || [];
        const llms = store.get('llms') || [];
        const selectionType = store.get('selectionType');
        const selectedAgent = store.get('selectedAgent');
        const selectedLlm = store.get('selectedLlm');

        if (!list) return;

        if (agents.length === 0 && llms.length === 0) {
            list.innerHTML = '<div class="text-gray-500 text-sm text-center py-4">No agents or LLMs available</div>';
            return;
        }

        let html = '';

        // Agents section
        if (agents.length > 0) {
            html += '<div class="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider bg-dark-bg/50">Agents</div>';
            html += agents.map(agent => {
                const isSelected = selectionType === 'agent' && selectedAgent?.name === agent.name;
                return `
                    <div data-type="agent" data-name="${agent.name}" class="selection-item px-4 py-3 hover:bg-dark-hover cursor-pointer transition-colors border-b border-dark-border ${isSelected ? 'bg-dark-hover' : ''}">
                        <div class="flex items-start justify-between">
                            <div class="flex-1">
                                <div class="font-medium text-gray-200 mb-0.5">${agent.name}</div>
                                <div class="text-xs text-gray-500 line-clamp-2">${agent.description}</div>
                            </div>
                            ${isSelected ? '<i class="fas fa-check text-blue-400 ml-2 mt-1"></i>' : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        // LLMs section
        if (llms.length > 0) {
            html += '<div class="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider bg-dark-bg/50">LLMs</div>';
            html += llms.map(llm => {
                const isSelected = selectionType === 'llm' && selectedLlm?.name === llm.name;
                return `
                    <div data-type="llm" data-name="${llm.name}" class="selection-item px-4 py-3 hover:bg-dark-hover cursor-pointer transition-colors border-b border-dark-border last:border-b-0 ${isSelected ? 'bg-dark-hover' : ''}">
                        <div class="flex items-start justify-between">
                            <div class="flex-1">
                                <div class="font-medium text-gray-200 mb-0.5">${llm.name}</div>
                                <div class="text-xs text-gray-500 line-clamp-2">${llm.model}</div>
                            </div>
                            ${isSelected ? '<i class="fas fa-check text-blue-400 ml-2 mt-1"></i>' : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        list.innerHTML = html;

        list.querySelectorAll('.selection-item').forEach(item => {
            item.addEventListener('click', () => {
                const type = item.dataset.type;
                const name = item.dataset.name;

                // Check if we're actually switching to a different agent/llm
                const currentType = store.get('selectionType');
                const currentAgent = store.get('selectedAgent');
                const currentLlm = store.get('selectedLlm');
                const currentName = currentType === 'agent' ? currentAgent?.name : currentLlm?.name;

                const isSwitching = !(type === currentType && name === currentName);

                if (type === 'agent') {
                    const agent = agents.find(a => a.name === name);
                    store.set('selectedAgent', agent);
                    store.set('selectedLlm', null);
                    store.set('selectionType', 'agent');
                } else if (type === 'llm') {
                    const llm = llms.find(l => l.name === name);
                    store.set('selectedLlm', llm);
                    store.set('selectedAgent', null);
                    store.set('selectionType', 'llm');
                }

                // Clear chat history when switching
                if (isSwitching) {
                    this.clearChatHistory();
                }

                this.updateSelectedAgentUI();
                this.toggleDropdown(false);
                this.renderAgentDropdown(); // Re-render to update selection checkmark
            });
        });
    }

    updateSelectedAgentUI() {
        const selectionType = store.get('selectionType');
        const agent = store.get('selectedAgent');
        const llm = store.get('selectedLlm');
        const nameEl = this.querySelector('#selectedAgentName');
        const btn = this.querySelector('#sendMessageBtn');

        const selected = selectionType === 'agent' ? agent : llm;

        if (nameEl && selected) {
            nameEl.textContent = selected.name;
        } else if (nameEl) {
            nameEl.textContent = 'Select Agent/LLM';
        }

        if (btn) btn.disabled = !selected || this.isLoading;
    }

    toggleDropdown(show) {
        const dropdown = this.querySelector('#agentDropdown');
        if (dropdown) {
            if (show === undefined) {
                dropdown.classList.toggle('hidden');
            } else if (show) {
                dropdown.classList.remove('hidden');
            } else {
                dropdown.classList.add('hidden');
            }
        }
    }

    async sendMessage() {
        const input = this.querySelector('#chatInput');
        const message = input.value.trim();
        const selectionType = store.get('selectionType');
        const agent = store.get('selectedAgent');
        const llm = store.get('selectedLlm');

        const selected = selectionType === 'agent' ? agent : llm;

        if (!message || !selected || this.isLoading) return;

        // Add user message
        this.appendMessage('user', message);
        input.value = '';
        input.style.height = 'auto';

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
                finalContent = await this.sendAgentMessage(agent, message, responseId);
            } else if (selectionType === 'llm') {
                finalContent = await this.sendLlmMessage(llm, message, responseId);
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
    }

    async sendAgentMessage(agent, message, responseId) {
        const inputVars = agent.inputVariables || ['message'];
        const inputObj = {};
        inputObj[inputVars[0] || 'message'] = message;

        const res = await api.streamAgent(agent.name, inputObj, store.get('sessionId'), { signal: this.currentAbortController?.signal });
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

    async sendLlmMessage(llm, message, responseId) {
        const res = await api.streamLLM(llm.name, message, { signal: this.currentAbortController?.signal });
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
        // Parse content to find think sections and regular text
        const parts = [];
        let pos = 0;
        let thinkIndex = 0;

        while (pos < fullContent.length) {
            const thinkStart = fullContent.indexOf('[THINK]', pos);

            if (thinkStart === -1) {
                // No more think sections, add remaining text
                const text = fullContent.slice(pos).trim();
                if (text) {
                    parts.push({ type: 'text', content: text });
                }
                break;
            }

            // Add text before [THINK]
            if (thinkStart > pos) {
                const text = fullContent.slice(pos, thinkStart).trim();
                if (text) {
                    parts.push({ type: 'text', content: text });
                }
            }

            // Find the end of this think section
            const thinkContentStart = thinkStart + 7; // After [THINK]
            const thinkEnd = fullContent.indexOf('[/THINK]', thinkContentStart);

            if (thinkEnd === -1) {
                // Think section is still streaming
                const thinkContent = fullContent.slice(thinkContentStart).trim();
                parts.push({ type: 'think', content: thinkContent, complete: false, index: thinkIndex });
                thinkIndex++;
                break;
            } else {
                // Complete think section
                const thinkContent = fullContent.slice(thinkContentStart, thinkEnd).trim();
                parts.push({ type: 'think', content: thinkContent, complete: true, index: thinkIndex });
                thinkIndex++;
                pos = thinkEnd + 8; // After [/THINK]
            }
        }

        // Update DOM incrementally instead of rebuilding
        let currentChildIndex = 0;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const existingChild = contentDiv.children[currentChildIndex];

            if (part.type === 'text') {
                if (existingChild && existingChild.classList.contains('content-text')) {
                    // Update existing text element with markdown
                    const renderedHtml = markdownRenderer.render(part.content);
                    existingChild.innerHTML = renderedHtml;
                    markdownRenderer.highlightCode(existingChild);
                } else {
                    // Create new text element
                    const div = document.createElement('div');
                    div.className = 'content-text markdown-content';
                    const renderedHtml = markdownRenderer.render(part.content);
                    div.innerHTML = renderedHtml;
                    markdownRenderer.highlightCode(div);
                    if (existingChild) {
                        contentDiv.insertBefore(div, existingChild);
                    } else {
                        contentDiv.appendChild(div);
                    }
                }
                currentChildIndex++;
            } else if (part.type === 'think') {
                const thinkId = `think-${responseId}-${part.index}`;

                if (existingChild && existingChild.classList.contains('think-section')) {
                    // Update existing think section
                    const label = existingChild.querySelector('.think-label');
                    const content = existingChild.querySelector('.think-content');
                    if (label) {
                        label.textContent = part.complete ? 'Thinking' : 'Thinking...';
                    }
                    if (content) {
                        const renderedHtml = markdownRenderer.render(part.content);
                        content.innerHTML = renderedHtml;
                        content.classList.add('markdown-content');
                        markdownRenderer.highlightCode(content);
                    }
                } else {
                    // Create new think section with event listener
                    const section = document.createElement('div');
                    section.className = 'think-section mb-3 border-l-2 border-blue-500/40 pl-3 py-1';
                    section.dataset.thinkIndex = part.index;

                    const toggle = document.createElement('button');
                    toggle.className = 'think-toggle flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 py-1 cursor-pointer';
                    toggle.dataset.thinkId = thinkId;

                    toggle.innerHTML = `
                        <i class="fas fa-brain text-xs"></i>
                        <span class="font-medium think-label">${part.complete ? 'Thinking' : 'Thinking...'}</span>
                        <i class="fas fa-chevron-right text-[10px] transition-transform think-chevron"></i>
                    `;

                    const thinkContent = document.createElement('div');
                    thinkContent.id = thinkId;
                    thinkContent.className = 'think-content hidden text-sm text-gray-400 markdown-content mt-1 leading-relaxed';
                    const renderedHtml = markdownRenderer.render(part.content);
                    thinkContent.innerHTML = renderedHtml;
                    markdownRenderer.highlightCode(thinkContent);

                    // Add click handler ONCE when creating
                    toggle.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const content = section.querySelector('.think-content');
                        const chevron = section.querySelector('.think-chevron');

                        if (content && chevron) {
                            if (content.classList.contains('hidden')) {
                                content.classList.remove('hidden');
                                chevron.classList.remove('fa-chevron-right');
                                chevron.classList.add('fa-chevron-down');
                            } else {
                                content.classList.add('hidden');
                                chevron.classList.remove('fa-chevron-down');
                                chevron.classList.add('fa-chevron-right');
                            }
                        }
                    });

                    section.appendChild(toggle);
                    section.appendChild(thinkContent);

                    if (existingChild) {
                        contentDiv.insertBefore(section, existingChild);
                    } else {
                        contentDiv.appendChild(section);
                    }
                }
                currentChildIndex++;
            }
        }

        // Remove any extra children
        while (contentDiv.children.length > currentChildIndex) {
            contentDiv.removeChild(contentDiv.lastChild);
        }
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

        // Stream status bar (visible during streaming)
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

        // Wire up cancel button
        statusBar.querySelector('.stream-cancel-btn').addEventListener('click', () => this.cancelCurrentStream());

        // Stats bar (visible after completion)
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

        if (event.type === 'content') {
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

                // Pill content (icon + name)
                const pillContent = document.createElement('span');
                pillContent.className = 'inline-flex items-center gap-1.5';
                pillContent.innerHTML = `
                    <i class="fas fa-check text-green-500 text-[10px]"></i>
                    <span>${this.escapeHtml(event.tool)}</span>
                `;
                toolEl.appendChild(pillContent);

                // Popover details panel (positioned below the pill)
                const details = document.createElement('div');
                details.className = 'tool-invocation-details hidden absolute left-0 top-full mt-1 z-50 bg-dark-surface border border-dark-border rounded-lg shadow-xl w-[400px] max-w-[90vw]';

                // Input section
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

                // Output section
                const outputSection = document.createElement('div');
                outputSection.className = 'p-3';
                outputSection.innerHTML = `<div class="text-xs font-semibold text-gray-400 mb-1">Output</div>`;
                const outputPre = document.createElement('pre');
                outputPre.className = 'text-xs text-gray-400 bg-dark-bg/60 rounded-md p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all custom-scrollbar';
                outputPre.textContent = toolOutput;
                outputSection.appendChild(outputPre);
                details.appendChild(outputSection);

                toolEl.appendChild(details);

                // Toggle popover on click
                toolEl.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Close any other open popovers
                    toolsDiv.querySelectorAll('.tool-invocation-details:not(.hidden)').forEach(d => {
                        if (d !== details) d.classList.add('hidden');
                    });
                    details.classList.toggle('hidden');
                });

                // Close popover when clicking outside
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

            // Display structured output as formatted JSON
            const resultContainer = document.createElement('div');
            resultContainer.className = 'bg-dark-bg/50 border border-dark-border rounded-lg p-4';

            const resultPre = document.createElement('pre');
            resultPre.className = 'text-sm text-gray-300 font-mono whitespace-pre-wrap overflow-x-auto';
            resultPre.textContent = JSON.stringify(event.output, null, 2);

            resultContainer.appendChild(resultPre);
            contentDiv.appendChild(resultContainer);

            // Scroll to bottom
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
        if (btn) btn.disabled = this.isLoading;
        if (input) input.disabled = this.isLoading;
    }

    appendMessage(role, content, metadata = {}) {
        const container = this.querySelector('#chatMessages');
        const isUser = role === 'user';
        const hasError = metadata.error;

        const div = document.createElement('div');
        div.className = isUser ? 'flex justify-end' : 'flex justify-start';

        const bubbleColor = isUser ? 'bg-dark-surface' : (hasError ? 'bg-red-900/20 border-red-900/30' : 'bg-dark-surface');
        const textColor = hasError ? 'text-red-300' : 'text-gray-100';

        div.innerHTML = `
            <div class="max-w-4xl ${bubbleColor} border ${isUser ? 'border-transparent' : 'border-dark-border'} rounded-3xl px-5 py-3 ${textColor} text-[15px] leading-relaxed relative group">
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

    clearChatHistory() {
        const container = this.querySelector('#chatMessages');
        if (!container) return;

        // Clear all messages
        container.innerHTML = '';

        // Add welcome message
        const div = document.createElement('div');
        div.className = 'flex justify-start';
        div.innerHTML = `
            <div class="max-w-4xl bg-dark-surface border border-dark-border rounded-3xl px-5 py-3 text-gray-100 text-[15px] leading-relaxed">
                Welcome to Agent Orcha. Start chatting with your AI agents and LLMs.
            </div>
        `;
        container.appendChild(div);

        // Generate a new session ID for fresh conversation
        store.set('sessionId', 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9));
    }

    postRender() {
        const input = this.querySelector('#chatInput');

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

        // Dropdown toggle
        const selectorBtn = this.querySelector('#agentSelectorBtn');
        const dropdown = this.querySelector('#agentDropdown');

        selectorBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDropdown();
        });

        document.addEventListener('click', (e) => {
            if (!selectorBtn.contains(e.target) && !dropdown.contains(e.target)) {
                this.toggleDropdown(false);
            }
        });
    }

    template() {
        return `
            <div class="flex flex-col h-[calc(100vh-220px)]">
                <!-- Chat Messages -->
                <div id="chatMessages" class="flex-1 overflow-y-auto mb-6 space-y-4 pr-2 custom-scrollbar">
                    <div class="flex justify-start">
                        <div class="max-w-4xl bg-dark-surface border border-dark-border rounded-3xl px-5 py-3 text-gray-100 text-[15px] leading-relaxed">
                            Welcome to Agent Orcha. Start chatting with your AI agents and LLMs.
                        </div>
                    </div>
                </div>

                <!-- Input Area -->
                <div class="border-t border-dark-border pt-4">
                    <div class="relative bg-dark-surface border border-dark-border rounded-2xl focus-within:border-gray-500 transition-colors">
                        <textarea id="chatInput" rows="1"
                            class="w-full bg-transparent px-4 py-3 pr-32 text-gray-100 placeholder-gray-500 resize-none focus:outline-none max-h-[200px]"
                            placeholder="Reply..."></textarea>
                        
                        <div class="absolute bottom-2 right-2 flex items-center gap-2">
                            <!-- Agent Selector -->
                            <div class="relative">
                                <button id="agentSelectorBtn" class="flex items-center gap-2 px-3 py-1.5 bg-dark-bg hover:bg-dark-hover rounded-lg text-sm font-medium text-gray-300 transition-colors">
                                    <span id="selectedAgentName">Select Agent/LLM</span>
                                    <i class="fas fa-chevron-down text-xs text-gray-400"></i>
                                </button>

                                <div id="agentDropdown" class="hidden absolute bottom-full mb-2 right-0 w-80 bg-dark-surface border border-dark-border rounded-xl shadow-2xl overflow-hidden z-10 max-h-96 flex flex-col">
                                    <div id="agentDropdownList" class="overflow-y-auto custom-scrollbar">
                                        <div class="text-gray-500 text-sm text-center py-4">Loading...</div>
                                    </div>
                                </div>
                            </div>

                            <button id="sendMessageBtn" disabled
                                class="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white p-2 rounded-lg transition-all shadow-lg shadow-blue-900/20">
                                <i class="fas fa-paper-plane text-sm"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('agents-view', AgentsView);
