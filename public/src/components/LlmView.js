
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

export class LlmView extends Component {
    constructor() {
        super();
        this.isLoading = false;
    }

    async connectedCallback() {
        super.connectedCallback();
        this.loadLLMs();
    }

    async loadLLMs() {
        try {
            const llms = await api.getLLMs();
            const select = this.querySelector('#llmSelect');
            select.innerHTML = '<option value="">-- Select LLM --</option>' +
                llms.map(l => `<option value="${l.name}">${l.name} (${l.model})</option>`).join('');

            select.addEventListener('change', () => {
                const info = this.querySelector('#llmInfo');
                const selected = llms.find(l => l.name === select.value);

                if (selected) {
                    info.classList.remove('hidden');
                    info.innerHTML = `
                         <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                            <div><span class="text-gray-400">Model:</span> <span class="text-gray-200 ml-2">${selected.model}</span></div>
                            <div><span class="text-gray-400">Base URL:</span> <span class="text-gray-200 ml-2">${selected.baseUrl || 'Default'}</span></div>
                        </div>
                    `;
                    this.updateButtons(false);
                } else {
                    info.classList.add('hidden');
                    this.updateButtons(true);
                }
            });
        } catch (e) {
            console.error(e);
        }
    }

    updateButtons(disabled) {
        this.querySelector('#runLlm').disabled = disabled;
        this.querySelector('#streamLlm').disabled = disabled;
    }

    async run(stream) {
        const name = this.querySelector('#llmSelect').value;
        const msg = this.querySelector('#llmInput').value;
        const outputEl = this.querySelector('#llmOutput');

        if (!name || !msg) return;

        this.isLoading = true;
        this.updateButtons(true);
        outputEl.textContent = 'Processing...';

        try {
            if (stream) {
                const res = await api.streamLLM(name, msg);
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                outputEl.textContent = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    outputEl.textContent += decoder.decode(value);
                    outputEl.scrollTop = outputEl.scrollHeight;
                }
            } else {
                const res = await api.chatLLM(name, msg);
                outputEl.textContent = res.output || JSON.stringify(res, null, 2);
            }
        } catch (e) {
            outputEl.textContent = 'Error: ' + e.message;
            outputEl.classList.add('text-red-400');
        } finally {
            this.isLoading = false;
            this.updateButtons(false);
            outputEl.classList.remove('text-red-400');
        }
    }

    postRender() {
        this.querySelector('#runLlm').addEventListener('click', () => this.run(false));
        this.querySelector('#streamLlm').addEventListener('click', () => this.run(true));
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-8 custom-scrollbar">
                <div>
                    <label class="block text-sm font-medium text-gray-300 mb-2">Select LLM</label>
                    <select id="llmSelect" class="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:ring-2 focus:ring-green-500"></select>
                </div>

                <div id="llmInfo" class="bg-dark-surface/50 border border-dark-border rounded-lg p-4 hidden"></div>

                <div>
                    <label class="block text-sm font-medium text-gray-300 mb-2">Message</label>
                    <textarea id="llmInput" rows="5" class="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-3 text-gray-100 focus:outline-none focus:ring-2 focus:ring-green-500"></textarea>
                </div>

                <div class="flex gap-3">
                    <button id="runLlm" disabled class="bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium px-6 py-2.5 rounded-lg transition-colors">
                        Send Message
                    </button>
                    <button id="streamLlm" disabled class="bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium px-6 py-2.5 rounded-lg transition-colors">
                        Stream
                    </button>
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-300 mb-2">Output</label>
                    <div id="llmOutput" class="bg-dark-surface border border-dark-border rounded-lg p-4 min-h-[200px] font-mono text-sm text-gray-300 whitespace-pre-wrap overflow-x-auto"></div>
                </div>
            </div>
        `;
    }
}

customElements.define('llm-view', LlmView);
