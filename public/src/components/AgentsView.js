
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';
import { store } from '../store.js';
import { markdownRenderer } from '../utils/markdown.js';

export class AgentsView extends Component {
    constructor() {
        super();
        this.isLoading = false;
    }

    async connectedCallback() {
        super.connectedCallback();
        await Promise.all([this.loadAgents(), this.loadLLMs()]);
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

        try {
            if (selectionType === 'agent') {
                await this.sendAgentMessage(agent, message, responseId);
            } else if (selectionType === 'llm') {
                await this.sendLlmMessage(llm, message, responseId);
            }
        } catch (e) {
            this.updateResponseError(responseId, `Error: ${e.message}`);
        } finally {
            this.isLoading = false;
            this.updateUiState();
            input.focus();
        }
    }

    async sendAgentMessage(agent, message, responseId) {
        const inputVars = agent.inputVariables || ['message'];
        const inputObj = {};
        inputObj[inputVars[0] || 'message'] = message;

        const res = await api.streamAgent(agent.name, inputObj, store.get('sessionId'));
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

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split('\n');
            // Keep the last partial line in the buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim() === '') continue;

                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const event = JSON.parse(data);
                        if (event.type === 'content') {
                            currentContent += event.content;
                        }
                        this.handleStreamEvent(event, responseId, currentContent, thinkingState);
                    } catch (e) {
                        console.error('Error parsing stream event', e, data);
                    }
                }
            }
        }
    }

    async sendLlmMessage(llm, message, responseId) {
        const res = await api.streamLLM(llm.name, message);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        const bubble = this.querySelector(`#${responseId}`);
        const contentDiv = bubble.querySelector('.response-content');
        const loadingDots = contentDiv.querySelector('.loading-dots');
        const container = this.querySelector('#chatMessages');

        if (loadingDots) {
            loadingDots.remove();
            bubble.querySelector('.max-w-4xl').classList.remove('py-4');
            bubble.querySelector('.max-w-4xl').classList.add('py-3');
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
                            throw new Error(parsed.error);
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
        const div = document.createElement('div');
        div.id = id;
        div.className = 'flex justify-start';
        div.innerHTML = `
            <div class="max-w-4xl bg-dark-surface border border-dark-border rounded-3xl px-5 py-4 text-gray-100 text-[15px] leading-relaxed relative group">
                <div class="response-content whitespace-pre-wrap flex items-center">
                    <div class="loading-dots flex gap-1">
                        <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
                        <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
                        <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 0.4s"></div>
                    </div>
                </div>
                <div class="tool-invocations space-y-2 mt-2"></div>
            </div>
        `;
        container.appendChild(div);
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
                // Reset padding and remove flex classes
                bubble.querySelector('.max-w-4xl').classList.remove('py-4');
                bubble.querySelector('.max-w-4xl').classList.add('py-3');
                contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
                // Clear any whitespace
                contentDiv.innerHTML = '';
            }
            // Use the same rendering method as LLMs to handle [THINK] tags
            this.renderLlmContentStreaming(contentDiv, currentContent, responseId, thinkingState);
            // Scroll to bottom as content streams in
            container.scrollTop = container.scrollHeight;
        } else if (event.type === 'tool_start') {
            const toolId = `tool-${event.runId}`;
            const toolEl = document.createElement('div');
            toolEl.id = toolId;
            toolEl.className = 'bg-dark-bg/50 border border-dark-border rounded-lg p-2 text-sm text-gray-400 font-mono flex items-center gap-2';
            toolEl.innerHTML = `
                <i class="fas fa-cog animate-spin text-blue-400"></i>
                <span>Using ${event.tool}...</span>
             `;
            toolsDiv.appendChild(toolEl);
            // Scroll to bottom when tool starts
            container.scrollTop = container.scrollHeight;

            // If we have loading dots, keep them until text arrives
        } else if (event.type === 'tool_end') {
            const toolId = `tool-${event.runId}`;
            const toolEl = toolsDiv.querySelector(`#${toolId}`);
            if (toolEl) {
                toolEl.className = 'bg-dark-bg/30 border border-dark-border/50 rounded-lg p-2 text-sm text-gray-500 font-mono flex flex-col gap-1';
                // Success state
                toolEl.innerHTML = `
                    <div class="flex items-center gap-2">
                        <i class="fas fa-check text-green-500"></i>
                        <span>Used ${event.tool}</span>
                    </div>
                `;

                // Add output preview
                const preview = document.createElement('div');
                preview.className = 'text-xs text-gray-600 pl-6 truncate';
                preview.textContent = typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
                toolEl.appendChild(preview);
                // Scroll to bottom when tool ends (output preview added)
                container.scrollTop = container.scrollHeight;
            }
        } else if (event.type === 'result') {
            if (loadingDots) {
                loadingDots.remove();
                bubble.querySelector('.max-w-4xl').classList.remove('py-4');
                bubble.querySelector('.max-w-4xl').classList.add('py-3');
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
                    <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
                    <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 0.4s"></div>
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

        // Clear session ID to start fresh
        store.set('sessionId', null);
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
