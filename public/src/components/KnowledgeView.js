
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';
import { resourceCard, badge, statusDot as sharedStatusDot, escapeHtml } from '../utils/card.js';

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
            container.innerHTML = '<div class="text-muted italic text-center py-4">No knowledge stores configured</div>';
            return;
        }

        container.innerHTML = this.stores.map(store => {
            const isSelected = this.selectedStore?.name === store.name;
            return resourceCard({
                id: store.name,
                selected: isSelected,
                content: `
                    <div class="flex items-center justify-between mb-2">
                        <span class="font-semibold text-primary text-sm truncate">${escapeHtml(store.name)}</span>
                        ${this.statusDot(store)}
                    </div>
                    <div class="flex items-center gap-2 mb-2 flex-wrap">
                        ${this.kindBadge(store)}
                        ${this.sourceTypeBadge(store.source?.type)}
                        ${this.storeBadge(store.store)}
                    </div>
                    <div class="text-xs text-secondary">
                        ${store.status === 'indexed' ? this.formatCounts(store) : store.status === 'error' ? 'Error' : 'Not indexed'}
                        ${store.defaultK ? `<span class="ml-2 text-muted">K=${store.defaultK}</span>` : ''}
                    </div>
                    ${store.lastIndexedAt ? `<div class="text-xs text-muted mt-1">${this.timeAgo(store.lastIndexedAt)}</div>` : ''}
                `,
                className: 'knowledge-card p-4',
            });
        }).join('');

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
                container.innerHTML = '<div class="text-muted italic text-center py-4">Select a knowledge store to view details</div>';
            }
            return;
        }

        const store = this.selectedStore;
        const isIndexing = store.isIndexing || store.status === 'indexing';
        const isIndexed = store.status === 'indexed';
        const isError = store.status === 'error';

        container.innerHTML = `
            <div class="flex items-start justify-between mb-6">
                <div>
                    <h2 class="text-lg font-bold text-primary mb-1">${this.escapeHtml(store.name)}</h2>
                    <p class="text-sm text-secondary">${this.escapeHtml(store.description || 'No description')}</p>
                    <div class="flex items-center gap-2 mt-2">
                        ${this.kindBadge(store)}
                        ${this.statusBadge(store)}
                    </div>
                </div>
                <button id="indexBtn" class="btn btn-accent btn-sm" ${isIndexing ? 'disabled' : ''}>
                    ${isIndexing
                        ? '<span class="spinner-sm"></span> Indexing...'
                        : isIndexed ? '<i class="fas fa-sync-alt"></i> Re-index' : '<i class="fas fa-play"></i> Index'}
                </button>
            </div>

            ${isError && store.errorMessage ? `
            <div class="badge-outline-red rounded-lg p-3 mb-4">
                <div class="text-red text-sm"><i class="fas fa-exclamation-triangle mr-2"></i>${this.escapeHtml(store.errorMessage)}</div>
            </div>` : ''}

            <div id="progressSection" class="${isIndexing ? '' : 'hidden'} mb-6">
                <div class="panel">
                    <div class="flex items-center justify-between mb-2">
                        <span id="progressPhase" class="text-sm text-primary">Preparing...</span>
                        <span id="progressElapsed" class="text-xs text-muted font-mono"></span>
                    </div>
                    <div class="progress-track">
                        <div id="progressBar" class="progress-fill transition-all"></div>
                    </div>
                    <div id="progressMessage" class="text-xs text-muted mt-1"></div>
                </div>
            </div>

            <div class="grid grid-cols-4 gap-3 mb-6">
                ${this.statCard('Documents', store.documentCount, 'fa-file-alt')}
                ${this.statCard('Chunks', store.chunkCount, 'fa-puzzle-piece')}
                ${store.hasGraph ? this.statCard('Entities', store.entityCount, 'fa-project-diagram') : ''}
                ${store.hasGraph ? this.statCard('Edges', store.edgeCount, 'fa-bezier-curve') : ''}
                ${store.hasGraph ? this.statCard('Communities', store.communityCount, 'fa-layer-group') : ''}
            </div>

            <div class="grid grid-cols-2 gap-3 mb-6 text-sm">
                <div class="panel-sm"><span class="text-muted">Source Type</span><div class="text-primary mt-1">${store.source?.type || 'N/A'}</div></div>
                <div class="panel-sm"><span class="text-muted">Store</span><div class="text-primary mt-1">${this.storeBadge(store.store)}</div></div>
                <div class="panel-sm"><span class="text-muted">Default K</span><div class="text-primary mt-1">${store.defaultK ?? 'N/A'}</div></div>
                <div class="panel-sm"><span class="text-muted">Embedding</span><div class="text-primary mt-1">${store.embeddingModel || 'default'}</div></div>
                <div class="panel-sm"><span class="text-muted">Last Indexed</span><div class="text-primary mt-1">${store.lastIndexedAt ? this.timeAgo(store.lastIndexedAt) : 'Never'}
                    ${store.lastIndexDurationMs ? `<span class="text-muted text-xs ml-1">(${this.formatDuration(store.lastIndexDurationMs)})</span>` : ''}
                </div></div>
            </div>

            <div class="border-t pt-4">
                <h3 class="text-sm font-semibold text-primary mb-3">Search</h3>
                <div class="space-y-3">
                    <textarea id="searchQuery" rows="3" placeholder="Enter search query..."
                        class="textarea text-sm" ${!isIndexed ? 'disabled' : ''}></textarea>
                    <div class="flex items-center gap-3">
                        <button id="searchBtn" class="btn btn-accent btn-sm" ${!isIndexed ? 'disabled' : ''}>Search</button>
                        <div class="flex items-center gap-2">
                            <label class="text-xs text-secondary">Results:</label>
                            <input type="number" id="searchK" value="${store.defaultK ?? 4}" min="1" max="20" class="input text-sm">
                        </div>
                    </div>
                    <div id="searchResults">
                        ${!isIndexed ? '<div class="text-muted italic text-center py-4 text-sm">Index this store to enable search</div>' : ''}
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

        resultsEl.innerHTML = '<div class="text-secondary italic text-center py-4 text-sm">Searching...</div>';

        try {
            const res = await api.searchKnowledgeStore(this.selectedStore.name, query, k);
            const results = Array.isArray(res) ? res : res.results || [];

            if (results.length === 0) {
                resultsEl.innerHTML = '<div class="text-muted italic text-center py-4 text-sm">No results found</div>';
                return;
            }

            resultsEl.innerHTML = results.map((r, i) => `
                <div class="panel-sm mb-3">
                    <div class="flex items-center justify-between mb-2 pb-2 border-b">
                        <span class="font-medium text-primary text-sm">Result ${i + 1}</span>
                        <span class="text-xs font-mono text-secondary">Score: ${r.score?.toFixed(3)}</span>
                    </div>
                    <div class="text-sm text-primary mb-2 whitespace-pre-wrap">${this.escapeHtml(r.content)}</div>
                    <div class="text-xs text-muted">
                        ${r.metadata ? Object.entries(r.metadata).map(([k, v]) => `<span class="mr-3"><span class="text-muted">${k}:</span> ${v}</span>`).join('') : ''}
                    </div>
                </div>
            `).join('');

        } catch (e) {
            resultsEl.innerHTML = `<div class="text-red text-center text-sm">Error: ${e.message}</div>`;
        }
    }

    // --- Helpers ---

    statusDot(store) {
        const status = store.isIndexing || store.status === 'indexing' ? 'indexing' : store.status || 'not_indexed';
        return `<span class="status-dot status-dot-${status}"></span>`;
    }

    kindBadge(store) {
        return store.hasGraph
            ? '<span class="badge badge-outline-purple">graph</span>'
            : '<span class="badge badge-outline-blue">vector</span>';
    }

    storeBadge(type) {
        return `<span class="badge badge-gray">${this.escapeHtml(type || 'memory')}</span>`;
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
        return `<span class="text-xs text-muted"><i class="fas ${icons[type] || 'fa-question'} mr-1"></i>${type}</span>`;
    }

    statusBadge(store) {
        if (store.isIndexing || store.status === 'indexing') return '<span class="badge badge-outline-orange">indexing</span>';
        const badges = {
            indexed: '<span class="badge badge-outline-green">indexed</span>',
            error: '<span class="badge badge-outline-red">error</span>',
            not_indexed: '<span class="badge badge-gray">not indexed</span>',
        };
        return badges[store.status] || badges.not_indexed;
    }

    statCard(label, value, icon) {
        return `
            <div class="stat-card">
                <div class="text-muted text-xs mb-1"><i class="fas ${icon} mr-1"></i>${label}</div>
                <div class="stat-value">${value ?? 0}</div>
            </div>
        `;
    }

    formatCounts(store) {
        if (store.hasGraph) {
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
        return escapeHtml(text);
    }

    postRender() {
        this.querySelector('#refreshListBtn')?.addEventListener('click', () => this.loadStores());
        this.querySelector('#kbSidebarToggle')?.addEventListener('click', () => {
            this.querySelector('#kbSidebar')?.classList.toggle('hidden');
        });
    }

    template() {
        return `
            <div class="kb-shell">
                <button id="kbSidebarToggle" class="mobile-fab">
                    <i class="fas fa-list text-sm"></i>
                </button>
                <div id="kbSidebar" class="kb-sidebar">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="section-title">Stores</h3>
                        <button id="refreshListBtn" class="btn-ghost text-xs"><i class="fas fa-sync-alt"></i></button>
                    </div>
                    <div id="knowledgeCards" class="space-y-2">
                        <div class="text-muted italic text-center py-4 text-sm">Loading...</div>
                    </div>
                </div>
                <div class="kb-detail" id="knowledgeDetail">
                    <div class="text-muted italic text-center py-4">Select a knowledge store to view details</div>
                </div>
            </div>
        `;
    }
}

customElements.define('knowledge-view', KnowledgeView);
