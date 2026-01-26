
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';
import { store } from '../store.js';

export class AgentsView extends Component {
    constructor() {
        super();
        this.isLoading = false;
    }

    async connectedCallback() {
        super.connectedCallback();
        this.loadAgents();
    }

    async loadAgents() {
        try {
            const agents = await api.getAgents();
            store.set('agents', agents);

            if (agents.length > 0 && !store.get('selectedAgent')) {
                store.set('selectedAgent', agents[agents.length - 1]);
            }

            this.renderAgentDropdown();
            this.updateSelectedAgentUI();
        } catch (e) {
            console.error('Failed to load agents', e);
        }
    }

    renderAgentDropdown() {
        const list = this.querySelector('#agentDropdownList');
        const agents = store.get('agents');

        if (!list) return;

        if (agents.length === 0) {
            list.innerHTML = '<div class="text-gray-500 text-sm text-center py-4">No agents available</div>';
            return;
        }

        list.innerHTML = agents.map(agent => `
            <div data-agent="${agent.name}" class="agent-item px-4 py-3 hover:bg-dark-hover cursor-pointer transition-colors border-b border-dark-border last:border-b-0 ${store.get('selectedAgent')?.name === agent.name ? 'bg-dark-hover' : ''}">
                <div class="flex items-start justify-between">
                    <div class="flex-1">
                        <div class="font-medium text-gray-200 mb-0.5">${agent.name}</div>
                        <div class="text-xs text-gray-500 line-clamp-2">${agent.description}</div>
                    </div>
                    ${store.get('selectedAgent')?.name === agent.name ? '<i class="fas fa-check text-blue-400 ml-2 mt-1"></i>' : ''}
                </div>
            </div>
        `).join('');

        list.querySelectorAll('.agent-item').forEach(item => {
            item.addEventListener('click', () => {
                const agentName = item.dataset.agent;
                const agent = agents.find(a => a.name === agentName);
                store.set('selectedAgent', agent);
                this.updateSelectedAgentUI();
                this.toggleDropdown(false);
                this.renderAgentDropdown(); // Re-render to update selection checkmark
            });
        });
    }

    updateSelectedAgentUI() {
        const agent = store.get('selectedAgent');
        const nameEl = this.querySelector('#selectedAgentName');
        const btn = this.querySelector('#sendMessageBtn');

        if (nameEl && agent) nameEl.textContent = agent.name;
        if (btn) btn.disabled = !agent || this.isLoading;
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
        const agent = store.get('selectedAgent');

        if (!message || !agent || this.isLoading) return;

        // Add user message
        this.appendMessage('user', message);
        input.value = '';
        input.style.height = 'auto';

        this.isLoading = true;
        this.updateUiState();

        const responseId = 'response-' + Date.now();
        this.createResponseBubble(responseId);

        try {
            const inputVars = agent.inputVariables || ['message'];
            const inputObj = {};
            inputObj[inputVars[0] || 'message'] = message;

            const res = await api.streamAgent(agent.name, inputObj, store.get('sessionId'));
            const reader = res.body.getReader();
            const decoder = new TextDecoder();

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
                            this.handleStreamEvent(event, responseId, currentContent);
                            if (event.type === 'content') {
                                currentContent += event.content;
                            }
                        } catch (e) {
                            console.error('Error parsing stream event', e, data);
                        }
                    }
                }
            }
        } catch (e) {
            this.updateResponseError(responseId, `Error: ${e.message}`);
        } finally {
            this.isLoading = false;
            this.updateUiState();
            input.focus();
        }
    }

    createResponseBubble(id) {
        const container = this.querySelector('#chatMessages');
        const div = document.createElement('div');
        div.id = id;
        div.className = 'flex justify-start';
        div.innerHTML = `
            <div class="max-w-2xl bg-dark-surface border border-dark-border rounded-3xl px-5 py-4 text-gray-100 text-[15px] leading-relaxed relative group">
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

    handleStreamEvent(event, responseId, currentContent) {
        const bubble = this.querySelector(`#${responseId}`);
        if (!bubble) return;

        const contentDiv = bubble.querySelector('.response-content');
        const toolsDiv = bubble.querySelector('.tool-invocations');
        const loadingDots = contentDiv.querySelector('.loading-dots');

        if (event.type === 'content') {
            if (loadingDots) {
                loadingDots.remove();
                // Reset padding if we removed dots (dots have vertically centered padding usually, text needs standard)
                bubble.querySelector('.max-w-2xl').classList.remove('py-4', 'flex', 'items-center');
                bubble.querySelector('.max-w-2xl').classList.add('py-3');
            }
            contentDiv.textContent += event.content;
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
            }
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
            <div class="max-w-2xl ${bubbleColor} border ${isUser ? 'border-transparent' : 'border-dark-border'} rounded-3xl px-5 py-3 ${textColor} text-[15px] leading-relaxed relative group">
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
            <div class="max-w-2xl bg-dark-surface border border-dark-border rounded-3xl px-5 py-4">
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
                        <div class="max-w-2xl bg-dark-surface border border-dark-border rounded-3xl px-5 py-3 text-gray-100 text-[15px] leading-relaxed">
                            Welcome to Agent Orcha. Start chatting with your AI agents.
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
                                    <span id="selectedAgentName">Select Agent</span>
                                    <i class="fas fa-chevron-down text-xs text-gray-400"></i>
                                </button>

                                <div id="agentDropdown" class="hidden absolute bottom-full mb-2 right-0 w-80 bg-dark-surface border border-dark-border rounded-xl shadow-2xl overflow-hidden z-10 max-h-96 flex flex-col">
                                    <div id="agentDropdownList" class="overflow-y-auto custom-scrollbar">
                                        <div class="text-gray-500 text-sm text-center py-4">Loading agents...</div>
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
