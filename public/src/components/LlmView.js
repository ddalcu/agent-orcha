
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
                         <div class="grid grid-cols-2 gap-4 text-sm">
                            <div><span class="text-secondary">Model:</span> <span class="text-primary ml-2">${selected.model}</span></div>
                            <div><span class="text-secondary">Base URL:</span> <span class="text-primary ml-2">${selected.baseUrl || 'Default'}</span></div>
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
            outputEl.classList.add('text-red');
        } finally {
            this.isLoading = false;
            this.updateButtons(false);
            outputEl.classList.remove('text-red');
        }
    }

    postRender() {
        this.querySelector('#runLlm').addEventListener('click', () => this.run(false));
        this.querySelector('#streamLlm').addEventListener('click', () => this.run(true));
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-6">
                <div>
                    <label class="block text-sm font-medium text-primary mb-2">Select LLM</label>
                    <select id="llmSelect" class="select"></select>
                </div>

                <div id="llmInfo" class="panel-dim hidden"></div>

                <div>
                    <label class="block text-sm font-medium text-primary mb-2">Message</label>
                    <textarea id="llmInput" rows="5" class="textarea"></textarea>
                </div>

                <div class="flex gap-3">
                    <button id="runLlm" disabled class="btn btn-accent">Send Message</button>
                    <button id="streamLlm" disabled class="btn btn-accent">Stream</button>
                </div>

                <div>
                    <label class="block text-sm font-medium text-primary mb-2">Output</label>
                    <div id="llmOutput" class="llm-output"></div>
                </div>
            </div>
        `;
    }
}

customElements.define('llm-view', LlmView);
