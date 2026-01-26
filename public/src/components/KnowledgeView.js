
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

export class KnowledgeView extends Component {
    async connectedCallback() {
        super.connectedCallback();
        this.loadVectors();
    }

    async loadVectors() {
        try {
            const vectors = await api.getVectorStores();
            const select = this.querySelector('#vectorSelect');
            select.innerHTML = '<option value="">-- Select Vector Store --</option>' +
                vectors.map(v => `<option value="${v.name}">${v.name}</option>`).join('');
        } catch (e) {
            console.error(e);
        }
    }

    async onVectorSelected(name) {
        if (!name) {
            this.querySelector('#vectorInfo').classList.add('hidden');
            this.querySelector('#searchVector').disabled = true;
            return;
        }

        try {
            const info = await api.getVectorStore(name);
            this.renderInfo(info);
            this.querySelector('#searchVector').disabled = false;
        } catch (e) {
            console.error(e);
        }
    }

    renderInfo(info) {
        const el = this.querySelector('#vectorInfo');
        el.classList.remove('hidden');
        el.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div><span class="text-gray-400">Description:</span> <span class="text-gray-200 ml-2">${info.description || 'N/A'}</span></div>
                <div><span class="text-gray-400">Source:</span> <span class="text-gray-200 ml-2">${info.source?.type || 'N/A'}</span></div>
                <div><span class="text-gray-400">Store:</span> <span class="text-gray-200 ml-2">${info.store?.type || 'memory'}</span></div>
            </div>
        `;
    }

    async search() {
        const storeName = this.querySelector('#vectorSelect').value;
        const query = this.querySelector('#vectorQuery').value;
        const k = this.querySelector('#vectorK').value;

        if (!storeName || !query) return;

        const resultsEl = this.querySelector('#vectorResults');
        resultsEl.innerHTML = '<div class="text-gray-400 italic text-center py-8">Searching...</div>';

        try {
            const res = await api.searchVectorStore(storeName, query, k);
            const results = Array.isArray(res) ? res : res.results || [];

            if (results.length === 0) {
                resultsEl.innerHTML = '<div class="text-gray-500 italic text-center py-8">No results found</div>';
                return;
            }

            resultsEl.innerHTML = results.map((r, i) => `
                <div class="mb-4 last:mb-0 bg-dark-bg border border-dark-border rounded-lg p-4">
                    <div class="flex items-center justify-between mb-2 pb-2 border-b border-dark-border">
                        <span class="font-semibold text-gray-200">Result ${i + 1}</span>
                        <span class="text-sm font-mono text-gray-400">Score: ${r.score?.toFixed(3)}</span>
                    </div>
                    <div class="text-sm text-gray-300 mb-3 whitespace-pre-wrap">${this.escapeHtml(r.content)}</div>
                    <div class="text-xs text-gray-500">
                        ${r.metadata ? Object.entries(r.metadata).map(([k, v]) => `<span class="mr-3"><span class="text-gray-600">${k}:</span> ${v}</span>`).join('') : ''}
                    </div>
                </div>
            `).join('');

        } catch (e) {
            resultsEl.innerHTML = `<div class="text-red-400 text-center">Error: ${e.message}</div>`;
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    postRender() {
        this.querySelector('#vectorSelect').addEventListener('change', (e) => this.onVectorSelected(e.target.value));
        this.querySelector('#searchVector').addEventListener('click', () => this.search());
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-8 custom-scrollbar">
                <div>
                    <label class="block text-sm font-medium text-gray-300 mb-2">Select Vector Store</label>
                    <select id="vectorSelect" class="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:ring-2 focus:ring-orange-500"></select>
                </div>

                <div id="vectorInfo" class="bg-dark-surface/50 border border-dark-border rounded-lg p-4 hidden"></div>

                <div>
                    <label class="block text-sm font-medium text-gray-300 mb-2">Search Query</label>
                    <textarea id="vectorQuery" rows="3" class="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-3 text-gray-100 focus:outline-none focus:ring-2 focus:ring-orange-500"></textarea>
                </div>

                <div class="flex items-center gap-4">
                    <button id="searchVector" disabled class="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium px-6 py-2.5 rounded-lg transition-colors">
                        Search
                    </button>
                    <div class="flex items-center gap-2">
                        <label class="text-sm text-gray-400">Results:</label>
                        <input type="number" id="vectorK" value="4" min="1" max="20" class="w-20 bg-dark-surface border border-dark-border rounded-lg px-3 py-2 text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500">
                    </div>
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-300 mb-2">Results</label>
                    <div id="vectorResults" class="bg-dark-surface border border-dark-border rounded-lg p-4 min-h-[200px]">
                        <div class="text-gray-500 italic text-center py-8">Select a vector store to search</div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('knowledge-view', KnowledgeView);
