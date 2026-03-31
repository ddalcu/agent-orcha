<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/services/api.ts';
  import { appStore } from '../lib/stores/app.svelte.js';
  import { escapeHtml, timeAgo, formatDuration } from '../lib/utils/format.ts';
  import KnowledgeComposer from './KnowledgeComposer.svelte';

  interface KnowledgeStore {
    name: string;
    description?: string;
    status: string;
    isIndexing?: boolean;
    hasGraph?: boolean;
    store?: string;
    source?: { type?: string; path?: string };
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

  // CRUD form state
  let showForm = $state(false);
  let editingStore = $state<KnowledgeStore | null>(null);
  let createMode = $state<'pick' | 'easy' | 'advanced'>('pick');
  let composerRef: ReturnType<typeof KnowledgeComposer> | undefined = $state();
  let composerData = $state<Record<string, any>>({});
  let formError = $state('');
  let formSaving = $state(false);

  // Easy mode state
  let easyName = $state('');
  let easySourceType = $state<'directory' | 'web'>('directory');
  let easyUrl = $state('');

  // Delete confirmation
  let showDeleteConfirm = $state(false);

  // File upload
  let uploading = $state(false);
  let uploadError = $state('');
  let uploadSuccess = $state('');
  let dragOver = $state(false);
  let fileInput: HTMLInputElement;

  const isIndexing = $derived(
    selectedStore != null && (selectedStore.isIndexing === true || selectedStore.status === 'indexing')
  );
  const isIndexed = $derived(selectedStore?.status === 'indexed');
  const isError = $derived(selectedStore?.status === 'error');
  const isFileSource = $derived(
    selectedStore?.source?.type === 'file' || selectedStore?.source?.type === 'directory'
  );

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
    uploadError = '';
    uploadSuccess = '';
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

  // --- CRUD Functions ---

  function openCreate() {
    editingStore = null;
    createMode = 'pick';
    composerData = {};
    easyName = '';
    easySourceType = 'directory';
    easyUrl = '';
    formError = '';
    showForm = true;
  }

  async function openEdit(store: KnowledgeStore) {
    editingStore = store;
    formError = '';

    try {
      const config = await api.getKnowledgeStore(store.name);
      composerData = config;
      showForm = true;
    } catch (e) {
      console.error('Failed to load config for editing:', e);
    }
  }

  async function handleEasySubmit() {
    formError = '';
    const name = easyName.trim();

    if (!name) { formError = 'Name is required'; return; }
    if (easySourceType === 'web' && !easyUrl.trim()) { formError = 'URL is required'; return; }

    const config: Record<string, any> = {
      name,
      description: `Knowledge store for ${name}`,
      splitter: { type: 'recursive', chunkSize: 1000, chunkOverlap: 200 },
      embedding: 'default',
      search: { defaultK: 4 },
    };

    if (easySourceType === 'directory') {
      config.source = { type: 'directory' };
    } else {
      config.source = { type: 'web', url: easyUrl.trim() };
      config.loader = { type: 'html' };
    }

    formSaving = true;
    try {
      const res = await api.createKnowledgeStore(config);
      if (res.error) { formError = res.error; return; }

      showForm = false;
      await loadStores();
      const found = stores.find(s => s.name === name);
      if (found) selectStore(found);
    } catch (e: unknown) {
      formError = e instanceof Error ? e.message : 'Failed to save';
    } finally {
      formSaving = false;
    }
  }

  async function handleAdvancedSubmit() {
    formError = '';

    if (!composerRef) return;
    const config = composerRef.getData();

    if (!config.name?.trim()) {
      formError = 'Name is required';
      return;
    }

    if (config.source?.type === 'web' && !config.source?.url?.trim()) {
      formError = 'URL is required for web sources';
      return;
    }

    if (config.source?.type === 'database') {
      if (!config.source?.connectionString?.trim()) { formError = 'Connection string is required'; return; }
      if (!config.source?.query?.trim()) { formError = 'SQL query is required'; return; }
    }

    formSaving = true;

    try {
      if (editingStore) {
        const res = await api.updateKnowledgeStore(editingStore.name, config);
        if (res.error) { formError = res.error; return; }
      } else {
        const res = await api.createKnowledgeStore(config);
        if (res.error) { formError = res.error; return; }
      }

      showForm = false;
      await loadStores();

      const name = config.name.trim();
      const found = stores.find(s => s.name === name);
      if (found) selectStore(found);
    } catch (e: unknown) {
      formError = e instanceof Error ? e.message : 'Failed to save';
    } finally {
      formSaving = false;
    }
  }

  async function handleDelete() {
    if (!selectedStore) return;

    try {
      const res = await api.deleteKnowledgeStore(selectedStore.name);
      if (res.error) {
        console.error('Delete failed:', res.error);
        return;
      }

      showDeleteConfirm = false;
      selectedStore = null;
      await loadStores();
    } catch (e) {
      console.error('Failed to delete knowledge store:', e);
    }
  }

  // --- File Upload ---

  async function uploadFiles(files: FileList | File[]) {
    if (!selectedStore || !files.length) return;

    uploading = true;
    uploadError = '';
    uploadSuccess = '';

    try {
      const res = await api.uploadKnowledgeFiles(selectedStore.name, files);
      if (res.error) {
        uploadError = res.error;
      } else {
        uploadSuccess = `Uploaded ${res.files.length} file(s)`;
        setTimeout(() => { uploadSuccess = ''; }, 5000);
      }
    } catch (e: unknown) {
      uploadError = e instanceof Error ? e.message : 'Upload failed';
    } finally {
      uploading = false;
    }
  }

  function handleFileDrop(e: DragEvent) {
    const files = e.dataTransfer?.files;
    if (files?.length) uploadFiles(files);
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) uploadFiles(input.files);
    input.value = '';
  }

  function clickFileInput() {
    fileInput?.click();
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
    <div class="kb-sidebar-bottom">
      <button class="kb-new-store-btn" onclick={openCreate}>
        <i class="fas fa-database text-xs text-blue"></i>
        <span>New knowledge store</span>
      </button>
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
        <div class="flex items-center gap-2">
          <button class="btn-ghost text-sm" onclick={() => openEdit(selectedStore!)}>
            <i class="fas fa-pen"></i>
          </button>
          <button class="btn-ghost text-sm kb-delete-btn" onclick={() => showDeleteConfirm = true}>
            <i class="fas fa-trash"></i>
          </button>
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

      <!-- File upload zone (file/directory sources only) -->
      {#if isFileSource}
        <div class="mb-6">
          <h3 class="text-sm font-semibold text-primary mb-3">Upload Files</h3>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="upload-zone"
            class:drag-over={dragOver}
            onclick={clickFileInput}
            onkeydown={(e) => { if (e.key === 'Enter') clickFileInput(); }}
            ondragover={(e) => { e.preventDefault(); dragOver = true; }}
            ondragleave={() => { dragOver = false; }}
            ondrop={(e) => { e.preventDefault(); dragOver = false; handleFileDrop(e); }}
            role="button"
            tabindex="0"
          >
            {#if uploading}
              <span class="spinner-sm"></span>
              <p class="text-sm text-secondary mt-2">Uploading...</p>
            {:else}
              <i class="fas fa-cloud-upload-alt"></i>
              <p class="text-sm text-secondary mt-2">Drag & drop files here, or click to select</p>
            {/if}
            <input
              bind:this={fileInput}
              type="file"
              multiple
              class="upload-file-input"
              onchange={handleFileSelect}
            />
          </div>
          {#if uploadError}
            <div class="text-red text-xs mt-1">{uploadError}</div>
          {/if}
          {#if uploadSuccess}
            <div class="text-green text-xs mt-1">{uploadSuccess}</div>
          {/if}
        </div>
      {/if}

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

<!-- Create/Edit Modal -->
{#if showForm}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-overlay" role="presentation" onclick={() => showForm = false}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog">

      {#if editingStore}
        <!-- Edit mode — always advanced -->
        <h3>Edit Knowledge Store</h3>
        {#if formError}
          <div class="form-error">{formError}</div>
        {/if}
        <KnowledgeComposer bind:this={composerRef} bind:data={composerData} />
        <div class="form-actions">
          <button class="btn btn-ghost" onclick={() => showForm = false}>Cancel</button>
          <button class="btn btn-accent" onclick={handleAdvancedSubmit} disabled={formSaving}>
            {#if formSaving}<span class="spinner-sm"></span> Saving...{:else}Save{/if}
          </button>
        </div>

      {:else if createMode === 'pick'}
        <!-- Mode picker -->
        <h3>New Knowledge Store</h3>
        <p class="text-sm text-secondary mb-4">How would you like to create your knowledge store?</p>
        <div class="create-mode-options">
          <button class="create-mode-card" onclick={() => { createMode = 'easy'; }}>
            <i class="fas fa-bolt"></i>
            <span class="create-mode-title">Easy</span>
            <span class="create-mode-desc">Quick setup with sensible defaults. Just name it and pick a source.</span>
          </button>
          <button class="create-mode-card" onclick={() => { showForm = false; appStore.pendingAction = { type: 'create', resourceType: 'knowledge' }; appStore.setTab('ide'); }}>
            <i class="fas fa-code"></i>
            <span class="create-mode-title">Advanced</span>
            <span class="create-mode-desc">Open the IDE editor with full control over the configuration.</span>
          </button>
        </div>

      {:else if createMode === 'easy'}
        <!-- Easy mode -->
        <div class="flex items-center gap-2 mb-4">
          <button class="btn-ghost text-xs" onclick={() => { createMode = 'pick'; formError = ''; }}>
            <i class="fas fa-arrow-left"></i>
          </button>
          <h3 class="mb-0">New Knowledge Store</h3>
        </div>

        {#if formError}
          <div class="form-error">{formError}</div>
        {/if}

        <label class="form-label">
          Name
          <input class="input" type="text" bind:value={easyName} placeholder="my-docs" />
        </label>

        <label class="form-label">
          Source
          <div class="easy-source-toggle">
            <button
              class="easy-source-btn"
              class:active={easySourceType === 'directory'}
              onclick={() => { easySourceType = 'directory'; }}
            >
              <i class="fas fa-folder"></i> Files
            </button>
            <button
              class="easy-source-btn"
              class:active={easySourceType === 'web'}
              onclick={() => { easySourceType = 'web'; }}
            >
              <i class="fas fa-globe"></i> Web
            </button>
          </div>
        </label>

        {#if easySourceType === 'web'}
          <label class="form-label">
            URL
            <input class="input" type="text" bind:value={easyUrl} placeholder="https://example.com/docs" />
          </label>
        {:else}
          <p class="text-xs text-muted">Upload files after creation via the upload zone.</p>
        {/if}

        <div class="form-actions">
          <button class="btn btn-ghost" onclick={() => showForm = false}>Cancel</button>
          <button class="btn btn-accent" onclick={handleEasySubmit} disabled={formSaving || !easyName.trim()}>
            {#if formSaving}<span class="spinner-sm"></span> Creating...{:else}Create{/if}
          </button>
        </div>

      {/if}
    </div>
  </div>
{/if}

<!-- Delete Confirmation Modal -->
{#if showDeleteConfirm}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-overlay" role="presentation" onclick={() => showDeleteConfirm = false}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog">
      <h3>Delete Knowledge Store</h3>
      <p class="text-sm text-secondary mb-4">
        Are you sure you want to delete <strong>"{selectedStore?.name}"</strong>?
        This will remove the configuration, indexed data, and metadata cache. This cannot be undone.
      </p>
      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => showDeleteConfirm = false}>Cancel</button>
        <button class="btn btn-danger" onclick={handleDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.5rem; width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; }
  .modal-card h3 { margin-bottom: 1rem; font-size: 1.05rem; color: var(--text-1); }
  .form-error { background: rgba(217,83,79,0.15); color: var(--red); padding: 0.5rem; border-radius: 6px; font-size: 0.82rem; margin-bottom: 0.75rem; }
  .form-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }

  .upload-zone {
    border: 2px dashed var(--border);
    border-radius: 8px;
    padding: 1.5rem;
    text-align: center;
    color: var(--text-3);
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
  }
  .upload-zone:hover { border-color: var(--text-3); }
  .upload-zone.drag-over { border-color: var(--accent); background: rgba(94, 106, 210, 0.05); }
  .upload-zone i { font-size: 1.5rem; margin-bottom: 0.25rem; display: block; }
  .upload-file-input { display: none; }

  .kb-delete-btn { color: var(--text-3); }
  .kb-delete-btn:hover { color: var(--red); }

  .kb-sidebar-bottom {
    margin-top: auto;
    padding-top: var(--sp-3);
    padding-bottom: 10px;
    position: sticky;
    bottom: 0;
    background: var(--bg);
  }
  .kb-new-store-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    padding: var(--sp-1h) var(--sp-2);
    border-radius: var(--radius-lg);
    font-size: var(--text-xs);
    color: var(--text-2);
    border: 1px dashed var(--border-60);
    background: transparent;
    cursor: pointer;
  }
  .kb-new-store-btn:hover {
    background: var(--hover);
    color: var(--text-1);
    border-color: var(--text-2);
  }

  .create-mode-options {
    display: flex;
    gap: 0.75rem;
  }
  .create-mode-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1.25rem 1rem;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    text-align: center;
    color: var(--text-2);
  }
  .create-mode-card:hover {
    border-color: var(--accent);
    background: var(--hover);
    color: var(--text-1);
  }
  .create-mode-card i {
    font-size: 1.25rem;
    color: var(--accent);
  }
  .create-mode-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-1);
  }
  .create-mode-desc {
    font-size: 0.72rem;
    color: var(--text-3);
    line-height: 1.3;
  }

  .form-label { display: block; font-size: 0.82rem; color: var(--text-2); margin-bottom: 0.75rem; }
  .form-label .input { display: block; width: 100%; margin-top: 0.25rem; }

  .easy-source-toggle {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .easy-source-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text-2);
    font-size: 0.82rem;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .easy-source-btn:hover {
    border-color: var(--text-3);
  }
  .easy-source-btn.active {
    border-color: var(--accent);
    background: rgba(94, 106, 210, 0.1);
    color: var(--text-1);
  }

  .mb-0 { margin-bottom: 0; }
</style>
