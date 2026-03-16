<script lang="ts">
  import { api } from '../lib/services/api.js';

  type McpServer = { name: string; transport: string };
  type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
  type McpFunction = { name: string; description?: string; schema?: Record<string, unknown> };

  type SelectedItem = {
    type: 'tool' | 'function';
    item: McpTool | McpFunction;
    serverName?: string;
  };

  let source: 'mcp' | 'functions' = $state('mcp');
  let servers: McpServer[] = $state([]);
  let functions: McpFunction[] = $state([]);
  let loading = $state(true);
  let error = $state('');

  // Accordion open state per server name
  let openAccordions: Record<string, boolean> = $state({});
  // Tools loaded per server (lazy)
  let serverTools: Record<string, McpTool[]> = $state({});
  let serverToolsLoading: Record<string, boolean> = $state({});

  // Selection & execution
  let selectedItem: SelectedItem | null = $state(null);
  let argsInput = $state('{}');
  let executing = $state(false);
  let output = $state('');
  let outputError = $state(false);
  let showOutput = $state(false);

  loadContent();

  async function loadContent() {
    loading = true;
    error = '';
    selectedItem = null;

    try {
      if (source === 'mcp') {
        servers = await api.getMCPServers();
        functions = [];
      } else {
        functions = await api.getFunctions();
        servers = [];
      }
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function switchTab(tab: 'mcp' | 'functions') {
    source = tab;
    showOutput = false;
    output = '';
    outputError = false;
    loadContent();
  }

  function toggleAccordion(serverName: string) {
    openAccordions[serverName] = !openAccordions[serverName];

    // Lazy-load tools on first open
    if (openAccordions[serverName] && !serverTools[serverName] && !serverToolsLoading[serverName]) {
      serverToolsLoading[serverName] = true;
      api.getMCPTools(serverName).then((tools: McpTool[]) => {
        serverTools[serverName] = tools;
        serverToolsLoading[serverName] = false;
      }).catch(() => {
        serverTools[serverName] = [];
        serverToolsLoading[serverName] = false;
      });
    }
  }

  async function selectTool(tool: McpTool, serverName: string) {
    selectedItem = { type: 'tool', item: tool, serverName };
    const schema = tool.inputSchema || {};
    argsInput = JSON.stringify(generateJsonFromSchema(schema), null, 2);
    showOutput = false;
    output = '';
    outputError = false;
  }

  async function selectFunction(func: McpFunction) {
    let schema = func.schema || {};

    // Fetch full details if schema missing
    if (!func.schema) {
      try {
        const fullFunc = await api.getFunction(func.name);
        schema = fullFunc.schema || {};
        func = fullFunc;
      } catch {
        // fall back to empty schema
      }
    }

    selectedItem = { type: 'function', item: func };
    argsInput = JSON.stringify(generateJsonFromSchema(schema), null, 2);
    showOutput = false;
    output = '';
    outputError = false;
  }

  async function execute() {
    if (!selectedItem) return;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsInput || '{}');
    } catch {
      showOutput = true;
      output = 'Error: Invalid JSON arguments';
      outputError = true;
      return;
    }

    executing = true;
    showOutput = true;
    output = 'Running...';
    outputError = false;

    try {
      let result: Record<string, unknown>;
      if (selectedItem.type === 'tool') {
        result = await api.executeMcpTool(selectedItem.serverName!, selectedItem.item.name, args);
      } else {
        result = await api.executeFunction(selectedItem.item.name, args);
      }

      if (result.error) {
        throw new Error(result.error as string);
      }

      output = typeof result.content === 'string' ? result.content : JSON.stringify(result, null, 2);
    } catch (e: unknown) {
      output = 'Error: ' + (e instanceof Error ? e.message : String(e));
      outputError = true;
    } finally {
      executing = false;
    }
  }

  // --- Schema → placeholder generation ---

  function generateJsonFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (!schema) return {};

    // Handle $ref
    if (schema.$ref && schema.definitions) {
      const refName = (schema.$ref as string).split('/').pop();
      if (refName && (schema.definitions as Record<string, unknown>)[refName]) {
        schema = (schema.definitions as Record<string, unknown>)[refName] as Record<string, unknown>;
      }
    }

    if (schema.properties) {
      return generateFromProperties(schema);
    }

    if (schema.shape) {
      return generateFromZodShape(schema.shape as Record<string, unknown>);
    }

    return {};
  }

  function generateFromProperties(schema: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;

    for (const [key, prop] of Object.entries(properties)) {
      result[key] = getJsonSchemaPlaceholder(prop);
    }
    return result;
  }

  function getJsonSchemaPlaceholder(prop: Record<string, unknown>): unknown {
    if (prop.default !== undefined) return prop.default;

    const type = prop.type as string;
    switch (type) {
      case 'string':
        if (prop.enum && (prop.enum as string[]).length > 0) return (prop.enum as string[])[0];
        if (prop.description) return `<${prop.description}>`;
        return '';
      case 'number':
      case 'integer':
        return 0;
      case 'boolean':
        return false;
      case 'array':
        if (prop.items) {
          const exampleItem = getJsonSchemaPlaceholder(prop.items as Record<string, unknown>);
          return [exampleItem];
        }
        return [];
      case 'object':
        if (prop.properties) return generateFromProperties(prop);
        return {};
      default:
        return '';
    }
  }

  function generateFromZodShape(shape: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, fieldSchema] of Object.entries(shape)) {
      result[key] = getZodPlaceholder(fieldSchema as Record<string, unknown>);
    }
    return result;
  }

  function getZodPlaceholder(fieldSchema: Record<string, unknown>): unknown {
    if (!fieldSchema) return '';
    const def = fieldSchema._def as Record<string, unknown> | undefined;
    if (!def) return '';

    const typeName = def.typeName as string;

    if (typeName === 'ZodOptional' || typeName === 'ZodDefault') {
      if (def.defaultValue !== undefined) return (def.defaultValue as () => unknown)();
      const inner = (def.innerType as Record<string, unknown>)?._def;
      if (inner) return getZodPlaceholder({ _def: inner });
      return '';
    }

    switch (typeName) {
      case 'ZodString': return (def.description as string) || '';
      case 'ZodNumber': return 0;
      case 'ZodBoolean': return false;
      case 'ZodArray': return [];
      case 'ZodObject':
        if (def.shape) return generateFromZodShape((def.shape as () => Record<string, unknown>)());
        return {};
      case 'ZodEnum': {
        const values = def.values as string[];
        return values?.length > 0 ? values[0] : '';
      }
      default: return '';
    }
  }
</script>

<div class="space-y-6 h-full overflow-y-auto pb-6 view-panel">
  <div class="mcp-tabs">
    <button class="mcp-tab" class:active={source === 'mcp'} onclick={() => switchTab('mcp')}>MCP Servers</button>
    <button class="mcp-tab" class:active={source === 'functions'} onclick={() => switchTab('functions')}>Internal Functions</button>
  </div>

  {#if loading}
    <div class="text-muted text-center py-4">Loading...</div>
  {:else if error}
    <div class="text-red text-center">Error: {error}</div>
  {:else if source === 'mcp'}
    {#if servers.length === 0}
      <div class="text-muted text-center py-4">No servers configured</div>
    {:else}
      {#each servers as server (server.name)}
        <div class="mcp-accordion">
          <div class="mcp-accordion-header" onclick={() => toggleAccordion(server.name)}
               role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && toggleAccordion(server.name)}>
            <div class="flex-1">
              <div class="font-medium text-primary">{server.name}</div>
              <div class="text-xs text-muted mt-1">{server.transport}</div>
            </div>
            <svg class="text-secondary transition-transform" class:log-chevron-open={openAccordions[server.name]}
                 width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
            </svg>
          </div>

          {#if openAccordions[server.name]}
            <div class="p-4 pt-3 border-t">
              {#if serverToolsLoading[server.name]}
                <div class="text-muted text-sm py-2">Loading tools...</div>
              {:else if !serverTools[server.name]?.length}
                <div class="text-muted text-sm py-2">No tools available</div>
              {:else}
                <div class="grid-auto mt-3">
                  {#each serverTools[server.name] as tool (tool.name)}
                    <div class="mcp-tool-card" class:active={selectedItem?.type === 'tool' && selectedItem?.item.name === tool.name && selectedItem?.serverName === server.name}
                         onclick={() => selectTool(tool, server.name)}
                         role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && selectTool(tool, server.name)}>
                      <div class="tool-name">{tool.name}</div>
                      <div class="text-xs text-muted line-clamp-2">{tool.description || ''}</div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  {:else}
    {#if functions.length === 0}
      <div class="text-muted text-center py-4">No functions available</div>
    {:else}
      <div class="grid-auto">
        {#each functions as func (func.name)}
          <div class="mcp-tool-card" class:active={selectedItem?.type === 'function' && selectedItem?.item.name === func.name}
               onclick={() => selectFunction(func)}
               role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && selectFunction(func)}>
            <div class="tool-name">{func.name}</div>
            <div class="text-xs text-muted line-clamp-2">{func.description || ''}</div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  {#if selectedItem}
    <div class="border-t pt-4">
      <div class="panel-dim mb-4">
        <div class="font-medium text-accent">{selectedItem.item.name}</div>
        <div class="text-xs text-muted mt-1">{selectedItem.item.description || ''}</div>
      </div>

      <div class="mb-4">
        <label class="block text-sm font-medium text-primary mb-2" for="mcp-args-input">Arguments (JSON)</label>
        <textarea id="mcp-args-input" bind:value={argsInput} rows="6" class="textarea font-mono text-sm"></textarea>
      </div>

      <button class="btn btn-accent" onclick={execute} disabled={executing}>
        {executing ? 'Executing...' : 'Execute'}
      </button>

      {#if showOutput}
        <div class="mt-4">
          <span class="block text-sm font-medium text-primary mb-2">Output</span>
          <div class="llm-output" class:text-red={outputError}>{output}</div>
        </div>
      {/if}
    </div>
  {/if}
</div>
