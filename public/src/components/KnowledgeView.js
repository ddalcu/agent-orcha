
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

export class KnowledgeView extends Component {
    constructor() {
        super();
        this.stores = [];
        this.selectedStore = null;
        this.activeSSE = null;
        this.indexingStartTime = null;
        this.elapsedTimer = null;
    }

    async connectedCallback() {
        super.connectedCallback();
        this.loadStores();
    }

    disconnectedCallback() {
        this.cleanupSSE();
        this.cleanupTimer();
    }

    cleanupSSE() {
        if (this.activeSSE) {
            this.activeSSE.close();
            this.activeSSE = null;
        }
    }

    cleanupTimer() {
        if (this.elapsedTimer) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }
    }

    async loadStores() {
        try {
            this.stores = await api.getKnowledgeStores();
            this.renderCards();
            if (this.selectedStore) {
                const updated = this.stores.find(s => s.name === this.selectedStore.name);
                if (updated) {
                    this.selectedStore = updated;
                    this.renderDetail();
                    this.reconnectSSEIfNeeded();
                }
            }
        } catch (e) {
            console.error('Failed to load knowledge stores:', e);
        }
    }

    reconnectSSEIfNeeded() {
        if (!this.selectedStore || this.activeSSE) return;

        const isIndexing = this.selectedStore.isIndexing || this.selectedStore.status === 'indexing';
        if (!isIndexing) return;

        const name = this.selectedStore.name;

        this.indexingStartTime = Date.now();
        this.cleanupTimer();
        this.elapsedTimer = setInterval(() => {
            const elapsed = Date.now() - this.indexingStartTime;
            const el = this.querySelector('#progressElapsed');
            if (el) el.textContent = this.formatDuration(elapsed);
        }, 100);

        this.activeSSE = api.indexKnowledgeStoreStream(name);

        this.activeSSE.addEventListener('progress', (event) => {
            const data = JSON.parse(event.data);
            this.updateProgress(data);
        });

        this.activeSSE.addEventListener('error', (event) => {
            if (event.data) {
                const data = JSON.parse(event.data);
                this.updateProgress(data);
            }
            this.onIndexingComplete();
        });

        this.activeSSE.onerror = () => {
            this.onIndexingComplete();
        };
    }

    renderCards() {
        const container = this.querySelector('#knowledgeCards');
        if (!container) return;

        if (this.stores.length === 0) {
            container.innerHTML = '<div class="text-gray-500 italic text-center py-8">No knowledge stores configured</div>';
            return;
        }

        container.innerHTML = this.stores.map(store => `
            <div class="knowledge-card cursor-pointer rounded-lg p-4 border transition-colors
                ${this.selectedStore?.name === store.name
                    ? 'bg-dark-surface border-orange-500'
                    : 'bg-dark-surface/50 border-dark-border hover:border-orange-500/50'}"
                data-name="${store.name}">
                <div class="flex items-center justify-between mb-2">
                    <span class="font-semibold text-gray-100 text-sm truncate">${this.escapeHtml(store.name)}</span>
                    ${this.statusDot(store)}
                </div>
                <div class="flex items-center gap-2 mb-2 flex-wrap">
                    ${this.kindBadge(store.kind)}
                    ${this.sourceTypeBadge(store.source?.type)}
                    ${this.storeBadge(store.store)}
                    ${store.extractionMode ? this.extractionModeBadge(store.extractionMode) : ''}
                </div>
                <div class="text-xs text-gray-500">
                    ${store.status === 'indexed' ? this.formatCounts(store) : store.status === 'error' ? 'Error' : 'Not indexed'}
                    ${store.defaultK ? `<span class="ml-2 text-gray-600">K=${store.defaultK}</span>` : ''}
                </div>
                ${store.lastIndexedAt ? `<div class="text-xs text-gray-600 mt-1">${this.timeAgo(store.lastIndexedAt)}</div>` : ''}
            </div>
        `).join('');

        // Bind click handlers
        container.querySelectorAll('.knowledge-card').forEach(card => {
            card.addEventListener('click', () => {
                const name = card.dataset.name;
                const newStore = this.stores.find(s => s.name === name) || null;
                if (this.selectedStore?.name !== newStore?.name) {
                    this.cleanupSSE();
                    this.cleanupTimer();
                }
                this.selectedStore = newStore;
                this.renderCards();
                this.renderDetail();
                this.reconnectSSEIfNeeded();
            });
        });
    }

    renderDetail() {
        const container = this.querySelector('#knowledgeDetail');
        if (!container || !this.selectedStore) {
            if (container) {
                container.innerHTML = '<div class="text-gray-500 italic text-center py-16">Select a knowledge store to view details</div>';
            }
            return;
        }

        const store = this.selectedStore;
        const isIndexing = store.isIndexing || store.status === 'indexing';
        const isIndexed = store.status === 'indexed';
        const isError = store.status === 'error';

        container.innerHTML = `
            <!-- Header -->
            <div class="flex items-start justify-between mb-6">
                <div>
                    <h2 class="text-lg font-bold text-gray-100 mb-1">${this.escapeHtml(store.name)}</h2>
                    <p class="text-sm text-gray-400">${this.escapeHtml(store.description || 'No description')}</p>
                    <div class="flex items-center gap-2 mt-2">
                        ${this.kindBadge(store.kind)}
                        ${this.statusBadge(store)}
                    </div>
                </div>
                <button id="indexBtn"
                    class="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium px-4 py-2 rounded-lg transition-colors text-sm flex items-center gap-2"
                    ${isIndexing ? 'disabled' : ''}>
                    ${isIndexing
                        ? '<span class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span> Indexing...'
                        : isIndexed ? '<i class="fas fa-sync-alt"></i> Re-index' : '<i class="fas fa-play"></i> Index'}
                </button>
            </div>

            ${isError && store.errorMessage ? `
            <div class="bg-red-900/20 border border-red-800 rounded-lg p-3 mb-4">
                <div class="text-red-400 text-sm"><i class="fas fa-exclamation-triangle mr-2"></i>${this.escapeHtml(store.errorMessage)}</div>
            </div>` : ''}

            <!-- Progress -->
            <div id="progressSection" class="${isIndexing ? '' : 'hidden'} mb-6">
                <div class="bg-dark-surface border border-dark-border rounded-lg p-4">
                    <div class="flex items-center justify-between mb-2">
                        <span id="progressPhase" class="text-sm text-gray-300">Preparing...</span>
                        <span id="progressElapsed" class="text-xs text-gray-500 font-mono"></span>
                    </div>
                    <div class="w-full bg-dark-bg rounded-full h-2">
                        <div id="progressBar" class="bg-orange-500 h-2 rounded-full transition-all duration-300" style="width: 0%"></div>
                    </div>
                    <div id="progressMessage" class="text-xs text-gray-500 mt-1"></div>
                </div>
            </div>

            <!-- Stats -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                ${this.statCard('Documents', store.documentCount, 'fa-file-alt')}
                ${this.statCard('Chunks', store.chunkCount, 'fa-puzzle-piece')}
                ${store.kind === 'graph-rag' ? this.statCard('Entities', store.entityCount, 'fa-project-diagram') : ''}
                ${store.kind === 'graph-rag' ? this.statCard('Edges', store.edgeCount, 'fa-bezier-curve') : ''}
                ${store.kind === 'graph-rag' ? this.statCard('Communities', store.communityCount, 'fa-layer-group') : ''}
            </div>

            <!-- Info Grid -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6 text-sm">
                <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3">
                    <span class="text-gray-500">Source Type</span>
                    <div class="text-gray-200 mt-1">${store.source?.type || 'N/A'}</div>
                </div>
                <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3">
                    <span class="text-gray-500">Store</span>
                    <div class="text-gray-200 mt-1">${this.storeBadge(store.store)}</div>
                </div>
                ${store.extractionMode ? `
                <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3">
                    <span class="text-gray-500">Extraction Mode</span>
                    <div class="text-gray-200 mt-1">${this.extractionModeBadge(store.extractionMode)}</div>
                </div>` : ''}
                <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3">
                    <span class="text-gray-500">Default K</span>
                    <div class="text-gray-200 mt-1">${store.defaultK ?? 'N/A'}</div>
                </div>
                <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3">
                    <span class="text-gray-500">Embedding</span>
                    <div class="text-gray-200 mt-1">${store.embeddingModel || 'default'}</div>
                </div>
                <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3">
                    <span class="text-gray-500">Last Indexed</span>
                    <div class="text-gray-200 mt-1">${store.lastIndexedAt ? this.timeAgo(store.lastIndexedAt) : 'Never'}
                        ${store.lastIndexDurationMs ? `<span class="text-gray-500 text-xs ml-1">(${this.formatDuration(store.lastIndexDurationMs)})</span>` : ''}
                    </div>
                </div>
            </div>

            <!-- Search -->
            <div class="border-t border-dark-border pt-6">
                <h3 class="text-sm font-semibold text-gray-300 mb-3">Search</h3>
                <div class="space-y-3">
                    <textarea id="searchQuery" rows="3" placeholder="Enter search query..."
                        class="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-3 text-gray-100 focus:outline-none focus:ring-2 focus:ring-orange-500 text-sm"
                        ${!isIndexed ? 'disabled' : ''}></textarea>
                    <div class="flex items-center gap-3">
                        <button id="searchBtn"
                            class="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium px-5 py-2 rounded-lg transition-colors text-sm"
                            ${!isIndexed ? 'disabled' : ''}>
                            Search
                        </button>
                        <div class="flex items-center gap-2">
                            <label class="text-xs text-gray-400">Results:</label>
                            <input type="number" id="searchK" value="${store.defaultK ?? 4}" min="1" max="20"
                                class="w-16 bg-dark-surface border border-dark-border rounded-lg px-2 py-1.5 text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500">
                        </div>
                    </div>
                    <div id="searchResults" class="min-h-[100px]">
                        ${!isIndexed ? '<div class="text-gray-600 italic text-center py-6 text-sm">Index this store to enable search</div>' : ''}
                    </div>
                </div>
            </div>
        `;

        // Bind event listeners
        this.querySelector('#indexBtn')?.addEventListener('click', () => this.startIndexing());
        this.querySelector('#searchBtn')?.addEventListener('click', () => this.search());
        this.querySelector('#searchQuery')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.search();
            }
        });
    }

    async startIndexing() {
        if (!this.selectedStore) return;
        const name = this.selectedStore.name;

        try {
            // Start indexing
            await api.indexKnowledgeStore(name);

            // Update UI to show indexing state
            this.selectedStore.isIndexing = true;
            this.selectedStore.status = 'indexing';
            this.renderCards();
            this.renderDetail();

            // Start elapsed timer
            this.indexingStartTime = Date.now();
            this.elapsedTimer = setInterval(() => {
                const elapsed = Date.now() - this.indexingStartTime;
                const el = this.querySelector('#progressElapsed');
                if (el) el.textContent = this.formatDuration(elapsed);
            }, 100);

            // Connect SSE for progress
            this.cleanupSSE();
            this.activeSSE = api.indexKnowledgeStoreStream(name);

            this.activeSSE.addEventListener('progress', (event) => {
                const data = JSON.parse(event.data);
                this.updateProgress(data);
            });

            this.activeSSE.addEventListener('error', (event) => {
                if (event.data) {
                    const data = JSON.parse(event.data);
                    this.updateProgress(data);
                }
                this.onIndexingComplete();
            });

            this.activeSSE.onerror = () => {
                this.onIndexingComplete();
            };

        } catch (e) {
            console.error('Failed to start indexing:', e);
        }
    }

    updateProgress(data) {
        const progressBar = this.querySelector('#progressBar');
        const progressPhase = this.querySelector('#progressPhase');
        const progressMessage = this.querySelector('#progressMessage');
        const progressSection = this.querySelector('#progressSection');

        if (progressSection) progressSection.classList.remove('hidden');
        if (progressBar) progressBar.style.width = `${data.progress}%`;
        if (progressPhase) progressPhase.textContent = this.formatPhase(data.phase);
        if (progressMessage) progressMessage.textContent = data.message || '';

        if (data.phase === 'done' || data.phase === 'error') {
            this.onIndexingComplete();
        }
    }

    onIndexingComplete() {
        this.cleanupSSE();
        this.cleanupTimer();
        // Reload stores to get updated metadata
        setTimeout(() => this.loadStores(), 500);
    }

    async search() {
        if (!this.selectedStore) return;
        const query = this.querySelector('#searchQuery')?.value;
        const k = parseInt(this.querySelector('#searchK')?.value) || 4;

        if (!query) return;

        const resultsEl = this.querySelector('#searchResults');
        if (!resultsEl) return;

        resultsEl.innerHTML = '<div class="text-gray-400 italic text-center py-6 text-sm">Searching...</div>';

        try {
            const res = await api.searchKnowledgeStore(this.selectedStore.name, query, k);
            const results = Array.isArray(res) ? res : res.results || [];

            if (results.length === 0) {
                resultsEl.innerHTML = '<div class="text-gray-500 italic text-center py-6 text-sm">No results found</div>';
                return;
            }

            resultsEl.innerHTML = results.map((r, i) => `
                <div class="mb-3 last:mb-0 bg-dark-bg border border-dark-border rounded-lg p-3">
                    <div class="flex items-center justify-between mb-2 pb-2 border-b border-dark-border">
                        <span class="font-medium text-gray-200 text-sm">Result ${i + 1}</span>
                        <span class="text-xs font-mono text-gray-400">Score: ${r.score?.toFixed(3)}</span>
                    </div>
                    <div class="text-sm text-gray-300 mb-2 whitespace-pre-wrap">${this.escapeHtml(r.content)}</div>
                    <div class="text-xs text-gray-500">
                        ${r.metadata ? Object.entries(r.metadata).map(([k, v]) => `<span class="mr-3"><span class="text-gray-600">${k}:</span> ${v}</span>`).join('') : ''}
                    </div>
                </div>
            `).join('');

        } catch (e) {
            resultsEl.innerHTML = `<div class="text-red-400 text-center text-sm">Error: ${e.message}</div>`;
        }
    }

    // --- Helpers ---

    statusDot(store) {
        if (store.isIndexing || store.status === 'indexing') {
            return '<span class="inline-block w-2.5 h-2.5 rounded-full border-2 border-orange-400 border-t-transparent animate-spin flex-shrink-0"></span>';
        }
        const colors = {
            indexed: 'bg-green-400',
            error: 'bg-red-400',
            not_indexed: 'bg-gray-500',
        };
        return `<span class="inline-block w-2.5 h-2.5 rounded-full ${colors[store.status] || colors.not_indexed} flex-shrink-0"></span>`;
    }

    kindBadge(kind) {
        if (kind === 'graph-rag') {
            return '<span class="text-xs font-medium px-2 py-0.5 rounded bg-purple-900/50 text-purple-300 border border-purple-700/50">graph-rag</span>';
        }
        return '<span class="text-xs font-medium px-2 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-700/50">vector</span>';
    }

    storeBadge(type) {
        const storeType = type || 'memory';
        if (storeType === 'neo4j') {
            return '<span class="text-xs font-medium px-2 py-0.5 rounded bg-green-900/50 text-green-300 border border-green-700/50">neo4j</span>';
        }
        return `<span class="text-xs font-medium px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">${this.escapeHtml(storeType)}</span>`;
    }

    extractionModeBadge(mode) {
        if (mode === 'direct') {
            return '<span class="text-xs font-medium px-2 py-0.5 rounded bg-cyan-900/50 text-cyan-300 border border-cyan-700/50">direct</span>';
        }
        return '<span class="text-xs font-medium px-2 py-0.5 rounded bg-yellow-900/50 text-yellow-300 border border-yellow-700/50">llm</span>';
    }

    sourceTypeBadge(type) {
        if (!type) return '';
        const icons = {
            directory: 'fa-folder',
            file: 'fa-file',
            database: 'fa-database',
            web: 'fa-globe',
            s3: 'fa-cloud',
        };
        return `<span class="text-xs text-gray-500"><i class="fas ${icons[type] || 'fa-question'} mr-1"></i>${type}</span>`;
    }

    statusBadge(store) {
        if (store.isIndexing || store.status === 'indexing') {
            return '<span class="text-xs font-medium px-2 py-0.5 rounded bg-orange-900/50 text-orange-300 border border-orange-700/50">indexing</span>';
        }
        const badges = {
            indexed: '<span class="text-xs font-medium px-2 py-0.5 rounded bg-green-900/50 text-green-300 border border-green-700/50">indexed</span>',
            error: '<span class="text-xs font-medium px-2 py-0.5 rounded bg-red-900/50 text-red-300 border border-red-700/50">error</span>',
            not_indexed: '<span class="text-xs font-medium px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">not indexed</span>',
        };
        return badges[store.status] || badges.not_indexed;
    }

    statCard(label, value, icon) {
        return `
            <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3 text-center">
                <div class="text-gray-500 text-xs mb-1"><i class="fas ${icon} mr-1"></i>${label}</div>
                <div class="text-lg font-bold text-gray-200">${value ?? 0}</div>
            </div>
        `;
    }

    formatCounts(store) {
        if (store.kind === 'graph-rag') {
            return `${store.entityCount || 0} entities, ${store.edgeCount || 0} edges`;
        }
        return `${store.chunkCount || 0} chunks`;
    }

    formatPhase(phase) {
        const labels = {
            loading: 'Loading documents...',
            splitting: 'Splitting documents...',
            embedding: 'Creating embeddings...',
            extracting: 'Extracting entities...',
            building: 'Building index...',
            caching: 'Saving to cache...',
            done: 'Complete',
            error: 'Error',
        };
        return labels[phase] || phase;
    }

    formatDuration(ms) {
        if (ms < 1000) return `${ms}ms`;
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds}s`;
    }

    timeAgo(dateStr) {
        const date = new Date(dateStr);
        const now = new Date();
        const seconds = Math.floor((now - date) / 1000);

        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }

    escapeHtml(text) {
        if (!text) return '';
        return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    postRender() {
        this.querySelector('#refreshListBtn')?.addEventListener('click', () => this.loadStores());
    }

    template() {
        return `
            <div class="flex h-full gap-4">
                <!-- Left sidebar -->
                <div class="w-72 flex-shrink-0 overflow-y-auto custom-scrollbar pr-2">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">Stores</h3>
                        <button id="refreshListBtn" class="text-gray-500 hover:text-gray-300 text-xs">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                    </div>
                    <div id="knowledgeCards" class="space-y-2">
                        <div class="text-gray-500 italic text-center py-8 text-sm">Loading...</div>
                    </div>
                </div>

                <!-- Right detail panel -->
                <div class="flex-1 overflow-y-auto custom-scrollbar pl-2 border-l border-dark-border" id="knowledgeDetail">
                    <div class="text-gray-500 italic text-center py-16">Select a knowledge store to view details</div>
                </div>
            </div>
        `;
    }
}

customElements.define('knowledge-view', KnowledgeView);
