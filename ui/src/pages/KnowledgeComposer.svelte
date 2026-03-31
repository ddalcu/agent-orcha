<script lang="ts">
  const KNOWN_SCHEDULES = ['', '*/15 * * * *', '*/30 * * * *', '0 * * * *', '0 */6 * * *', '0 */12 * * *', '0 0 * * *', '0 0 * * 0'];

  // Props — same pattern as AgentComposer
  let {
    data = $bindable<Record<string, any>>({}),
    onchange,
  }: {
    data?: Record<string, any>;
    onchange?: () => void;
  } = $props();

  // Internal state — deep copy of data
  let d = $state<Record<string, any>>({});

  // Form fields derived from internal state
  let formName = $state('');
  let formDesc = $state('');
  let formSourceType = $state<'directory' | 'file' | 'web' | 'database'>('directory');
  let formSourcePath = $state('');
  let formSourcePattern = $state('*');
  let formSourceRecursive = $state(true);
  let formSourceUrl = $state('');
  let formSourceSelector = $state('');
  let formSourceHeaders = $state('');
  let formSourceJsonPath = $state('');
  let formSourceConnStr = $state('');
  let formSourceQuery = $state('');
  let formSourceContentCol = $state('content');
  let formSourceMetadataCols = $state('');
  let formLoaderType = $state('');
  let formSplitterType = $state('recursive');
  let formChunkSize = $state(1000);
  let formChunkOverlap = $state(200);
  let formEmbedding = $state('default');
  let formDefaultK = $state(4);
  let formScoreThreshold = $state('');
  let formReindexSchedule = $state('');

  // Load data into form fields
  function loadFromData(incoming: Record<string, any>) {
    d = JSON.parse(JSON.stringify(incoming));

    formName = d.name || '';
    formDesc = d.description || '';

    const src = d.source || {};
    formSourceType = src.type || 'directory';
    formSourcePath = src.path || '';
    formSourcePattern = src.pattern || '*';
    formSourceRecursive = src.recursive !== false;
    formSourceUrl = src.url || '';
    formSourceSelector = src.selector || '';
    formSourceHeaders = src.headers ? JSON.stringify(src.headers) : '';
    formSourceJsonPath = src.jsonPath || '';
    formSourceConnStr = src.connectionString || '';
    formSourceQuery = src.query || '';
    formSourceContentCol = src.contentColumn || 'content';
    formSourceMetadataCols = Array.isArray(src.metadataColumns)
      ? src.metadataColumns.join(', ')
      : '';

    formLoaderType = d.loader?.type || '';

    formSplitterType = d.splitter?.type || 'recursive';
    formChunkSize = d.splitter?.chunkSize ?? 1000;
    formChunkOverlap = d.splitter?.chunkOverlap ?? 200;

    formEmbedding = d.embedding || 'default';
    formDefaultK = d.search?.defaultK ?? 4;
    formScoreThreshold = d.search?.scoreThreshold != null ? String(d.search.scoreThreshold) : '';

    const rawSchedule = d.reindex?.schedule || '';
    formReindexSchedule = KNOWN_SCHEDULES.includes(rawSchedule) ? rawSchedule : '';
  }

  // Serialize form fields back to a clean config object
  function serializeClean(): Record<string, any> {
    const config: Record<string, any> = {
      name: formName.trim(),
      description: formDesc.trim(),
      splitter: {
        type: formSplitterType,
        chunkSize: formChunkSize,
        chunkOverlap: formChunkOverlap,
      },
    };

    // Source
    switch (formSourceType) {
      case 'directory': {
        const src: Record<string, any> = { type: 'directory' };
        if (formSourcePath.trim()) src.path = formSourcePath.trim();
        if (formSourcePattern.trim() && formSourcePattern.trim() !== '*') src.pattern = formSourcePattern.trim();
        src.recursive = formSourceRecursive;
        config.source = src;
        break;
      }
      case 'file': {
        const src: Record<string, any> = { type: 'file' };
        if (formSourcePath.trim()) src.path = formSourcePath.trim();
        config.source = src;
        break;
      }
      case 'web': {
        const src: Record<string, any> = { type: 'web', url: formSourceUrl.trim() };
        if (formSourceSelector.trim()) src.selector = formSourceSelector.trim();
        if (formSourceJsonPath.trim()) src.jsonPath = formSourceJsonPath.trim();
        if (formSourceHeaders.trim()) {
          try { src.headers = JSON.parse(formSourceHeaders.trim()); } catch { /* invalid JSON, skip */ }
        }
        config.source = src;
        break;
      }
      case 'database': {
        const src: Record<string, any> = {
          type: 'database',
          connectionString: formSourceConnStr.trim(),
          query: formSourceQuery.trim(),
        };
        if (formSourceContentCol.trim()) src.contentColumn = formSourceContentCol.trim();
        if (formSourceMetadataCols.trim()) {
          src.metadataColumns = formSourceMetadataCols.split(',').map((s: string) => s.trim()).filter(Boolean);
        }
        config.source = src;
        break;
      }
    }

    // Loader
    if (formLoaderType) config.loader = { type: formLoaderType };

    // Embedding
    if (formEmbedding.trim()) config.embedding = formEmbedding.trim();

    // Search
    const search: Record<string, any> = {};
    if (formDefaultK) search.defaultK = formDefaultK;
    if (formScoreThreshold) search.scoreThreshold = parseFloat(formScoreThreshold);
    if (Object.keys(search).length > 0) config.search = search;

    // Reindex
    if (formReindexSchedule.trim()) config.reindex = { schedule: formReindexSchedule.trim() };

    // Preserve any extra fields from the original data that we don't edit (e.g. graph, metadata)
    if (d.graph) config.graph = d.graph;
    if (d.metadata) config.metadata = d.metadata;

    return config;
  }

  // Public API — same as AgentComposer
  export function getData(): Record<string, any> {
    return serializeClean();
  }

  function fireChange() {
    onchange?.();
  }

  // Track last-loaded data reference to avoid infinite loops
  let lastLoadedData: Record<string, any> | null = null;

  // Watch for external data changes
  $effect(() => {
    const incoming = data;
    if (incoming && incoming !== lastLoadedData) {
      lastLoadedData = incoming;
      loadFromData(incoming);
    }
  });
</script>

<div class="kc-root overflow-y-auto h-full p-4">
  <!-- Identity -->
  <div class="composer-section space-y-3">
    <h3 class="section-title">Identity</h3>
    <label class="form-label">
      Name
      <input class="input" type="text" bind:value={formName}
        placeholder="my-docs" oninput={fireChange} />
    </label>
    <label class="form-label">
      Description
      <textarea class="input" rows="2" bind:value={formDesc}
        placeholder="Describe this knowledge store..." oninput={fireChange}></textarea>
    </label>
  </div>

  <!-- Source -->
  <div class="composer-section space-y-3">
    <h3 class="section-title">Source</h3>
    <label class="form-label">
      Type
      <select class="input" bind:value={formSourceType} onchange={fireChange}>
        <option value="directory">Directory</option>
        <option value="file">File</option>
        <option value="web">Web</option>
        <option value="database">Database</option>
      </select>
    </label>

    {#if formSourceType === 'directory'}
      <label class="form-label">
        Path
        <input class="input" type="text" bind:value={formSourcePath}
          placeholder="knowledge/{formName || 'store-name'}/" oninput={fireChange} />
        <span class="form-hint">Leave blank to auto-create knowledge/{formName || 'name'}/</span>
      </label>
      <div class="form-row">
        <label class="form-label half">
          Pattern
          <input class="input" type="text" bind:value={formSourcePattern} placeholder="*" oninput={fireChange} />
        </label>
        <label class="form-label half">
          Recursive
          <select class="input" bind:value={formSourceRecursive} onchange={fireChange}>
            <option value={true}>Yes</option>
            <option value={false}>No</option>
          </select>
        </label>
      </div>
    {:else if formSourceType === 'file'}
      <label class="form-label">
        Path
        <input class="input" type="text" bind:value={formSourcePath}
          placeholder="knowledge/{formName || 'store-name'}/" oninput={fireChange} />
        <span class="form-hint">Leave blank to auto-create knowledge/{formName || 'name'}/</span>
      </label>
    {:else if formSourceType === 'web'}
      <label class="form-label">
        URL
        <input class="input" type="text" bind:value={formSourceUrl}
          placeholder="https://example.com/docs" oninput={fireChange} />
      </label>
      <div class="form-row">
        <label class="form-label half">
          CSS Selector
          <input class="input" type="text" bind:value={formSourceSelector}
            placeholder=".content" oninput={fireChange} />
        </label>
        <label class="form-label half">
          JSON Path
          <input class="input" type="text" bind:value={formSourceJsonPath}
            placeholder="data.results" oninput={fireChange} />
        </label>
      </div>
      <label class="form-label">
        Headers (JSON)
        <input class="input" type="text" bind:value={formSourceHeaders}
          placeholder={'{"Authorization": "Bearer ..."}'} oninput={fireChange} />
      </label>
    {:else if formSourceType === 'database'}
      <label class="form-label">
        Connection String
        <input class="input" type="text" bind:value={formSourceConnStr}
          placeholder="sqlite://knowledge/data.db" oninput={fireChange} />
      </label>
      <label class="form-label">
        SQL Query
        <textarea class="input" rows="3" bind:value={formSourceQuery}
          placeholder="SELECT content, title FROM documents" oninput={fireChange}></textarea>
      </label>
      <div class="form-row">
        <label class="form-label half">
          Content Column
          <input class="input" type="text" bind:value={formSourceContentCol}
            placeholder="content" oninput={fireChange} />
        </label>
        <label class="form-label half">
          Metadata Columns
          <input class="input" type="text" bind:value={formSourceMetadataCols}
            placeholder="title, category" oninput={fireChange} />
          <span class="form-hint">Comma-separated</span>
        </label>
      </div>
    {/if}
  </div>

  <!-- Loader & Splitter -->
  <div class="composer-section space-y-3">
    <h3 class="section-title">Processing</h3>
    <label class="form-label">
      Loader Type
      <select class="input" bind:value={formLoaderType} onchange={fireChange}>
        <option value="">Auto-detect</option>
        <option value="text">Text</option>
        <option value="pdf">PDF</option>
        <option value="csv">CSV</option>
        <option value="json">JSON</option>
        <option value="markdown">Markdown</option>
        <option value="html">HTML</option>
      </select>
    </label>
    <div class="form-row">
      <label class="form-label half">
        Splitter
        <select class="input" bind:value={formSplitterType} onchange={fireChange}>
          <option value="recursive">Recursive</option>
          <option value="character">Character</option>
          <option value="token">Token</option>
          <option value="markdown">Markdown</option>
        </select>
      </label>
      <label class="form-label half">
        Chunk Size
        <input class="input" type="number" bind:value={formChunkSize} min="100" max="10000" oninput={fireChange} />
      </label>
    </div>
    <div class="form-row">
      <label class="form-label half">
        Chunk Overlap
        <input class="input" type="number" bind:value={formChunkOverlap} min="0" max="2000" oninput={fireChange} />
      </label>
      <label class="form-label half">
        Embedding
        <input class="input" type="text" bind:value={formEmbedding} placeholder="default" oninput={fireChange} />
      </label>
    </div>
  </div>

  <!-- Search -->
  <div class="composer-section space-y-3">
    <h3 class="section-title">Search</h3>
    <div class="form-row">
      <label class="form-label half">
        Default K
        <input class="input" type="number" bind:value={formDefaultK} min="1" max="50" oninput={fireChange} />
      </label>
      <label class="form-label half">
        Score Threshold
        <input class="input" type="text" bind:value={formScoreThreshold} placeholder="0.3" oninput={fireChange} />
        <span class="form-hint">Optional, 0-1</span>
      </label>
    </div>
  </div>

  <!-- Reindex -->
  <div class="composer-section space-y-3">
    <h3 class="section-title">Reindex</h3>
    <label class="form-label">
      Schedule
      <select class="input" bind:value={formReindexSchedule} onchange={fireChange}>
        <option value="">None</option>
        <option value="*/15 * * * *">Every 15 minutes</option>
        <option value="*/30 * * * *">Every 30 minutes</option>
        <option value="0 * * * *">Every hour</option>
        <option value="0 */6 * * *">Every 6 hours</option>
        <option value="0 */12 * * *">Every 12 hours</option>
        <option value="0 0 * * *">Daily (midnight)</option>
        <option value="0 0 * * 0">Weekly (Sunday midnight)</option>
      </select>
    </label>
  </div>
</div>

<style>
  .kc-root { display: flex; flex-direction: column; gap: var(--sp-3); }
  .form-label { display: block; font-size: 0.82rem; color: var(--text-2); margin-bottom: 0.75rem; }
  .form-label .input { display: block; width: 100%; margin-top: 0.25rem; }
  .form-row { display: flex; gap: 0.75rem; }
  .form-label.half { flex: 1; }
  .form-hint { font-size: 0.7rem; color: var(--text-3); margin-top: 2px; display: block; }
</style>
