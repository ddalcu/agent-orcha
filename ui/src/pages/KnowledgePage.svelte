<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/services/api.ts';
  import { escapeHtml, timeAgo, formatDuration } from '../lib/utils/format.ts';

  interface KnowledgeStore {
    name: string;
    description?: string;
    status: string;
    isIndexing?: boolean;
    hasGraph?: boolean;
    store?: string;
    source?: { type?: string };
    defaultK?: number;
    embeddingModel?: string;
    lastIndexedAt?: string;
    lastIndexDurationMs?: number;
    documentCount?: number;
    chunkCount?: number;
    entityCount?: number;
    edgeCount?: number;
    communityCount?: number;
    errorMessage?: string;
  }

  interface SearchResult {
    content: string;
    score?: number;
    metadata?: Record<string, unknown>;
  }

  let stores = $state<KnowledgeStore[]>([]);
  let selectedStore = $state<KnowledgeStore | null>(null);
  let sidebarVisible = $state(false);

  // Indexing state
  let activeSSE = $state<EventSource | null>(null);
  let indexingStartTime = $state<number | null>(null);
  let elapsedTimer = $state<ReturnType<typeof setInterval> | null>(null);
  let progressPhase = $state('Preparing...');
  let progressMessage = $state('');
  let progressPercent = $state(0);
  let elapsedText = $state('');

  // Search state
  let searchQuery = $state('');
  let searchK = $state(4);
  let searchResults = $state<SearchResult[] | null>(null);
  let searchError = $state('');
  let searching = $state(false);
  let reindexingAll = $state(false);

  const isIndexing = $derived(
    selectedStore != null && (selectedStore.isIndexing === true || selectedStore.status === 'indexing')
  );
  const isIndexed = $derived(selectedStore?.status === 'indexed');
  const isError = $derived(selectedStore?.status === 'error');

  const SOURCE_ICONS: Record<string, string> = {
    directory: 'fa-folder',
    file: 'fa-file',
    database: 'fa-database',
    web: 'fa-globe',
    s3: 'fa-cloud',
  };

  const PHASE_LABELS: Record<string, string> = {
    loading: 'Loading documents...',
    splitting: 'Splitting documents...',
    embedding: 'Creating embeddings...',
    extracting: 'Extracting entities...',
    building: 'Building index...',
    caching: 'Saving to cache...',
    done: 'Complete',
    error: 'Error',
  };

  function cleanupSSE() {
    if (activeSSE) {
      activeSSE.close();
      activeSSE = null;
    }
  }

  function cleanupTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function formatCounts(store: KnowledgeStore): string {
    if (store.hasGraph) {
      return `${store.entityCount || 0} entities, ${store.edgeCount || 0} edges`;
    }
    return `${store.chunkCount || 0} chunks`;
  }

  function selectStore(store: KnowledgeStore) {
    if (selectedStore?.name !== store.name) {
      cleanupSSE();
      cleanupTimer();
      progressPhase = 'Preparing...';
      progressMessage = '';
      progressPercent = 0;
      elapsedText = '';
    }
    selectedStore = store;
    searchResults = null;
    searchError = '';
    searchQuery = '';
    searchK = store.defaultK ?? 4;
    sidebarVisible = false;
    reconnectSSEIfNeeded();
  }

  function reconnectSSEIfNeeded() {
    if (!selectedStore || activeSSE) return;
    const storeIsIndexing = selectedStore.isIndexing || selectedStore.status === 'indexing';
    if (!storeIsIndexing) return;

    const name = selectedStore.name;
    indexingStartTime = Date.now();
    cleanupTimer();
    elapsedTimer = setInterval(() => {
      if (indexingStartTime) {
        elapsedText = formatDuration(Date.now() - indexingStartTime);
      }
    }, 100);

    activeSSE = api.indexKnowledgeStoreStream(name);

    activeSSE.addEventListener('progress', ((event: MessageEvent) => {
      try { updateProgress(JSON.parse(event.data)); } catch { /* malformed SSE */ }
    }) as EventListener);

    activeSSE.addEventListener('error', ((event: MessageEvent) => {
      if (event.data) {
        try { updateProgress(JSON.parse(event.data)); } catch { /* malformed SSE */ }
      }
      onIndexingComplete();
    }) as EventListener);

    activeSSE.onerror = () => {
      onIndexingComplete();
    };
  }

  function updateProgress(data: { progress: number; phase: string; message?: string }) {
    progressPercent = data.progress;
    progressPhase = PHASE_LABELS[data.phase] || data.phase;
    progressMessage = data.message || '';

    if (data.phase === 'done' || data.phase === 'error') {
      onIndexingComplete();
    }
  }

  function onIndexingComplete() {
    cleanupSSE();
    cleanupTimer();
    setTimeout(() => loadStores(), 500);
  }

  async function loadStores() {
    try {
      stores = await api.getKnowledgeStores();
      if (selectedStore) {
        const updated = stores.find(s => s.name === selectedStore!.name);
        if (updated) {
          selectedStore = updated;
          searchK = updated.defaultK ?? searchK;
          reconnectSSEIfNeeded();
        }
      }
    } catch (e) {
      console.error('Failed to load knowledge stores:', e);
    }
  }

  async function reindexAll() {
    if (reindexingAll || stores.length === 0) return;
    reindexingAll = true;

    try {
      // Index stores sequentially to avoid overloading the embedding model
      for (const s of stores) {
        stores = stores.map(st => st.name === s.name ? { ...st, isIndexing: true, status: 'indexing' } : st);
        if (selectedStore?.name === s.name) {
          selectedStore = stores.find(st => st.name === s.name) ?? selectedStore;
        }

        try {
          await api.indexKnowledgeStore(s.name);
          await new Promise<void>((resolve) => {
            const sse = api.indexKnowledgeStoreStream(s.name);
            const done = (status: string) => {
              sse.close();
              stores = stores.map(st => st.name === s.name ? { ...st, isIndexing: false, status } : st);
              if (selectedStore?.name === s.name) {
                selectedStore = stores.find(st => st.name === s.name) ?? selectedStore;
              }
              resolve();
            };
            sse.addEventListener('progress', ((event: MessageEvent) => {
              try {
                const data = JSON.parse(event.data);
                if (data.phase === 'done') done('indexed');
                else if (data.phase === 'error') done('error');
              } catch { /* malformed SSE */ }
            }) as EventListener);
            sse.addEventListener('error', (() => done('error')) as EventListener);
            sse.onerror = () => done('error');
          });
        } catch (e) {
          console.error(`Failed to re-index "${s.name}":`, e);
          stores = stores.map(st => st.name === s.name ? { ...st, isIndexing: false, status: 'error' } : st);
        }
      }
    } finally {
      reindexingAll = false;
      await loadStores();
    }
  }

  async function startIndexing() {
    if (!selectedStore) return;
    const name = selectedStore.name;

    try {
      await api.indexKnowledgeStore(name);

      selectedStore = { ...selectedStore, isIndexing: true, status: 'indexing' };
      // Update in stores array too
      stores = stores.map(s => s.name === name ? selectedStore! : s);

      indexingStartTime = Date.now();
      cleanupTimer();
      elapsedTimer = setInterval(() => {
        if (indexingStartTime) {
          elapsedText = formatDuration(Date.now() - indexingStartTime);
        }
      }, 100);

      cleanupSSE();
      activeSSE = api.indexKnowledgeStoreStream(name);

      activeSSE.addEventListener('progress', ((event: MessageEvent) => {
        const data = JSON.parse(event.data);
        updateProgress(data);
      }) as EventListener);

      activeSSE.addEventListener('error', ((event: MessageEvent) => {
        if (event.data) {
          const data = JSON.parse(event.data);
          updateProgress(data);
        }
        onIndexingComplete();
      }) as EventListener);

      activeSSE.onerror = () => {
        onIndexingComplete();
      };
    } catch (e) {
      console.error('Failed to start indexing:', e);
    }
  }

  async function search() {
    if (!selectedStore || !searchQuery.trim()) return;

    searching = true;
    searchError = '';
    searchResults = null;

    try {
      const res = await api.searchKnowledgeStore(selectedStore.name, searchQuery, searchK);
      const results = Array.isArray(res) ? res : res.results || [];
      searchResults = results;
    } catch (e: unknown) {
      searchError = e instanceof Error ? e.message : 'Unknown error';
    } finally {
      searching = false;
    }
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      search();
    }
  }

  function getStatusDotClass(store: KnowledgeStore): string {
    const status = (store.isIndexing || store.status === 'indexing') ? 'indexing' : store.status || 'not_indexed';
    return `status-dot status-dot-${status}`;
  }

  onMount(() => {
    loadStores();
  });

  onDestroy(() => {
    cleanupSSE();
    cleanupTimer();
  });
</script>

<div class="kb-shell">
  <!-- Mobile toggle -->
  <button class="mobile-sidebar-toggle" aria-label="Toggle stores sidebar" onclick={() => sidebarVisible = !sidebarVisible}>
    <i class="fas fa-list text-sm"></i>
  </button>

  <!-- Sidebar -->
  <div class="kb-sidebar" class:visible={sidebarVisible}>
    <div class="flex items-center justify-between mb-3">
      <h3 class="section-title">Stores</h3>
      <div class="flex items-center gap-2">
        <button class="btn btn-accent btn-sm" disabled={reindexingAll || stores.length === 0} onclick={reindexAll}>
          {#if reindexingAll}
            <span class="spinner-sm"></span> Re-indexing...
          {:else}
            <i class="fas fa-sync-alt"></i> Re-index all
          {/if}
        </button>
        <button class="btn-ghost text-xs" aria-label="Refresh stores" onclick={() => loadStores()}>
          <i class="fas fa-sync-alt"></i>
        </button>
      </div>
    </div>

    <div class="space-y-2">
      {#if stores.length === 0}
        <div class="text-muted italic text-center py-4 text-sm">No knowledge stores configured</div>
      {:else}
        {#each stores as store (store.name)}
          <button
            type="button"
            class="card p-4 w-full text-left"
            class:active={selectedStore?.name === store.name}
            onclick={() => selectStore(store)}
          >
            <div class="flex items-center justify-between mb-2">
              <span class="font-semibold text-primary text-sm truncate">{store.name}</span>
              <span class={getStatusDotClass(store)}></span>
            </div>
            <div class="flex items-center gap-2 mb-2 flex-wrap">
              {#if store.hasGraph}
                <span class="badge badge-outline-purple">graph</span>
              {:else}
                <span class="badge badge-outline-blue">vector</span>
              {/if}
              {#if store.source?.type}
                <span class="text-xs text-muted">
                  <i class="fas {SOURCE_ICONS[store.source.type] || 'fa-question'} mr-1"></i>{store.source.type}
                </span>
              {/if}
              <span class="badge badge-gray">{store.store || 'memory'}</span>
            </div>
            <div class="text-xs text-secondary">
              {#if store.status === 'indexed'}
                {formatCounts(store)}
              {:else if store.status === 'error'}
                Error
              {:else}
                Not indexed
              {/if}
              {#if store.defaultK}
                <span class="ml-2 text-muted">K={store.defaultK}</span>
              {/if}
            </div>
            {#if store.lastIndexedAt}
              <div class="text-xs text-muted mt-1">{timeAgo(store.lastIndexedAt)}</div>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <!-- Detail panel -->
  <div class="kb-detail">
    {#if !selectedStore}
      <div class="text-muted italic text-center py-4">Select a knowledge store to view details</div>
    {:else}
      <div class="flex items-start justify-between mb-6">
        <div>
          <h2 class="text-lg font-bold text-primary mb-1">{selectedStore.name}</h2>
          <p class="text-sm text-secondary">{selectedStore.description || 'No description'}</p>
          <div class="flex items-center gap-2 mt-2">
            {#if selectedStore.hasGraph}
              <span class="badge badge-outline-purple">graph</span>
            {:else}
              <span class="badge badge-outline-blue">vector</span>
            {/if}
            {#if isIndexing}
              <span class="badge badge-outline-orange">indexing</span>
            {:else if isIndexed}
              <span class="badge badge-outline-green">indexed</span>
            {:else if isError}
              <span class="badge badge-outline-red">error</span>
            {:else}
              <span class="badge badge-gray">not indexed</span>
            {/if}
          </div>
        </div>
        <button class="btn btn-accent btn-sm" disabled={isIndexing} onclick={startIndexing}>
          {#if isIndexing}
            <span class="spinner-sm"></span> Indexing...
          {:else if isIndexed}
            <i class="fas fa-sync-alt"></i> Re-index
          {:else}
            <i class="fas fa-play"></i> Index
          {/if}
        </button>
      </div>

      <!-- Error message -->
      {#if isError && selectedStore.errorMessage}
        <div class="badge-outline-red rounded-lg p-3 mb-4">
          <div class="text-red text-sm"><i class="fas fa-exclamation-triangle mr-2"></i>{selectedStore.errorMessage}</div>
        </div>
      {/if}

      <!-- Progress section -->
      {#if isIndexing}
        <div class="mb-6">
          <div class="panel">
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm text-primary">{progressPhase}</span>
              <span class="text-xs text-muted font-mono">{elapsedText}</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill transition-all" style:width="{progressPercent}%"></div>
            </div>
            {#if progressMessage}
              <div class="text-xs text-muted mt-1">{progressMessage}</div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Stats grid -->
      <div class="grid grid-cols-4 gap-3 mb-6">
        <div class="stat-card">
          <div class="text-muted text-xs mb-1"><i class="fas fa-file-alt mr-1"></i>Documents</div>
          <div class="stat-value">{selectedStore.documentCount ?? 0}</div>
        </div>
        <div class="stat-card">
          <div class="text-muted text-xs mb-1"><i class="fas fa-puzzle-piece mr-1"></i>Chunks</div>
          <div class="stat-value">{selectedStore.chunkCount ?? 0}</div>
        </div>
        {#if selectedStore.hasGraph}
          <div class="stat-card">
            <div class="text-muted text-xs mb-1"><i class="fas fa-project-diagram mr-1"></i>Entities</div>
            <div class="stat-value">{selectedStore.entityCount ?? 0}</div>
          </div>
          <div class="stat-card">
            <div class="text-muted text-xs mb-1"><i class="fas fa-bezier-curve mr-1"></i>Edges</div>
            <div class="stat-value">{selectedStore.edgeCount ?? 0}</div>
          </div>
          <div class="stat-card">
            <div class="text-muted text-xs mb-1"><i class="fas fa-layer-group mr-1"></i>Communities</div>
            <div class="stat-value">{selectedStore.communityCount ?? 0}</div>
          </div>
        {/if}
      </div>

      <!-- Info grid -->
      <div class="grid grid-cols-2 gap-3 mb-6 text-sm">
        <div class="panel-sm">
          <span class="text-muted">Source Type</span>
          <div class="text-primary mt-1">{selectedStore.source?.type || 'N/A'}</div>
        </div>
        <div class="panel-sm">
          <span class="text-muted">Store</span>
          <div class="text-primary mt-1">
            <span class="badge badge-gray">{selectedStore.store || 'memory'}</span>
          </div>
        </div>
        <div class="panel-sm">
          <span class="text-muted">Default K</span>
          <div class="text-primary mt-1">{selectedStore.defaultK ?? 'N/A'}</div>
        </div>
        <div class="panel-sm">
          <span class="text-muted">Embedding</span>
          <div class="text-primary mt-1">{selectedStore.embeddingModel || 'default'}</div>
        </div>
        <div class="panel-sm">
          <span class="text-muted">Last Indexed</span>
          <div class="text-primary mt-1">
            {selectedStore.lastIndexedAt ? timeAgo(selectedStore.lastIndexedAt) : 'Never'}
            {#if selectedStore.lastIndexDurationMs}
              <span class="text-muted text-xs ml-1">({formatDuration(selectedStore.lastIndexDurationMs)})</span>
            {/if}
          </div>
        </div>
      </div>

      <!-- Search section -->
      <div class="border-t pt-4">
        <h3 class="text-sm font-semibold text-primary mb-3">Search</h3>
        <div class="space-y-3">
          <textarea
            rows="3"
            placeholder="Enter search query..."
            class="textarea text-sm"
            disabled={!isIndexed}
            bind:value={searchQuery}
            onkeydown={handleSearchKeydown}
          ></textarea>
          <div class="flex items-center gap-3">
            <button class="btn btn-accent btn-sm" disabled={!isIndexed} onclick={search}>Search</button>
            <div class="flex items-center gap-2">
              <label for="searchK" class="text-xs text-secondary">Results:</label>
              <input id="searchK" type="number" class="input text-sm" min="1" max="20" bind:value={searchK}>
            </div>
          </div>
          <div>
            {#if searching}
              <div class="text-secondary italic text-center py-4 text-sm">Searching...</div>
            {:else if searchError}
              <div class="text-red text-center text-sm">Error: {searchError}</div>
            {:else if searchResults !== null && searchResults.length === 0}
              <div class="text-muted italic text-center py-4 text-sm">No results found</div>
            {:else if searchResults !== null}
              {#each searchResults as result, i}
                <div class="panel-sm mb-3">
                  <div class="flex items-center justify-between mb-2 pb-2 border-b">
                    <span class="font-medium text-primary text-sm">Result {i + 1}</span>
                    <span class="text-xs font-mono text-secondary">Score: {result.score?.toFixed(3)}</span>
                  </div>
                  <div class="text-sm text-primary mb-2 whitespace-pre-wrap">{result.content}</div>
                  {#if result.metadata}
                    <div class="text-xs text-muted">
                      {#each Object.entries(result.metadata) as [key, val]}
                        <span class="mr-2"><span class="text-muted">{key}:</span> {val}</span>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            {:else if !isIndexed}
              <div class="text-muted italic text-center py-4 text-sm">Index this store to enable search</div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
