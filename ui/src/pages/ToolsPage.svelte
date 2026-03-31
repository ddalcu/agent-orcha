<!-- NOTE: This page is disabled for now — nav tab hidden in NavBar.svelte. Kept for future redesign. -->
<script lang="ts">
  import { api } from '../lib/services/api.js';
  import type { Agent } from '../lib/types/index.js';

  type ToolType = 'mcp' | 'function' | 'knowledge' | 'builtin' | 'sandbox' | 'workspace';

  interface ToolItem {
    name: string;
    description: string;
  }

  interface ToolsData {
    mcp: Record<string, ToolItem[]>;
    function: ToolItem[];
    knowledge: Record<string, ToolItem[]>;
    builtin: ToolItem[];
    sandbox: ToolItem[];
    workspace: ToolItem[];
  }

  const TAB_DEFS: { id: ToolType; label: string }[] = [
    { id: 'mcp', label: 'MCP' },
    { id: 'function', label: 'Functions' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'builtin', label: 'Built-in' },
    { id: 'sandbox', label: 'Sandbox' },
    { id: 'workspace', label: 'Workspace' },
  ];

  const CHIP_CLASS: Record<ToolType, string> = {
    mcp: 'tool-chip-mcp',
    function: 'tool-chip-function',
    knowledge: 'tool-chip-knowledge',
    builtin: 'tool-chip-builtin',
    sandbox: 'tool-chip-sandbox',
    workspace: 'tool-chip-workspace',
  };

  let activeTab: ToolType = $state('mcp');
  let searchQuery = $state('');
  let loading = $state(true);
  let error = $state('');

  let toolsData = $state<ToolsData | null>(null);
  let agentMap = $state<Map<string, string[]>>(new Map());

  loadContent();

  async function loadContent() {
    loading = true;
    error = '';
    try {
      const [tools, agents]: [ToolsData, Agent[]] = await Promise.all([
        api.getTools(),
        api.getAgents(),
      ]);
      toolsData = tools;
      agentMap = buildAgentToolMap(agents);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function buildAgentToolMap(agents: Agent[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const agent of agents) {
      const refs = (agent.tools || []).map((t) => (typeof t === 'string' ? t : (t as { name: string }).name));
      for (const ref of refs) {
        const existing = map.get(ref);
        if (existing) {
          existing.push(agent.name);
        } else {
          map.set(ref, [agent.name]);
        }
      }
    }
    return map;
  }

  function getAgentsForTool(type: ToolType, toolName: string, group?: string): string[] {
    switch (type) {
      case 'mcp':
        return agentMap.get(`mcp:${group}`) || [];
      case 'knowledge':
        return agentMap.get(`knowledge:${group}`) || [];
      case 'function':
        return agentMap.get(`function:${toolName}`) || [];
      case 'builtin':
        return agentMap.get(`builtin:${toolName}`) || [];
      case 'sandbox':
        return agentMap.get(`sandbox:${toolName}`) || [];
      case 'workspace':
        return agentMap.get(`workspace:${toolName}`) || [];
      default:
        return [];
    }
  }

  // Flat list for non-grouped types
  function getFlatTools(type: 'function' | 'builtin' | 'sandbox' | 'workspace'): ToolItem[] {
    if (!toolsData) return [];
    return toolsData[type];
  }

  // Grouped data for MCP and Knowledge
  function getGroupedTools(type: 'mcp' | 'knowledge'): Record<string, ToolItem[]> {
    if (!toolsData) return {};
    return toolsData[type];
  }

  // Counts per tab
  let tabCounts = $derived.by<Record<ToolType, number>>(() => {
    if (!toolsData) return { mcp: 0, function: 0, knowledge: 0, builtin: 0, sandbox: 0, workspace: 0 };
    const mcpCount = Object.values(toolsData.mcp).reduce((s, t) => s + t.length, 0);
    const knowledgeCount = Object.values(toolsData.knowledge).reduce((s, t) => s + t.length, 0);
    return {
      mcp: mcpCount,
      function: toolsData.function.length,
      knowledge: knowledgeCount,
      builtin: toolsData.builtin.length,
      sandbox: toolsData.sandbox.length,
      workspace: toolsData.workspace.length,
    };
  });

  function matchesSearch(tool: ToolItem, agents: string[]): boolean {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return tool.name.toLowerCase().includes(q)
      || tool.description.toLowerCase().includes(q)
      || agents.some((a) => a.toLowerCase().includes(q));
  }
</script>

<div class="space-y-4 h-full overflow-y-auto pb-6 view-panel">
  <!-- Tab bar -->
  <div class="tool-picker-inline-tabs" style="border-bottom: 1px solid var(--border); margin-bottom: var(--sp-4);">
    {#each TAB_DEFS as tab}
      <button
        class="tool-picker-inline-tab"
        class:active={activeTab === tab.id}
        onclick={() => { activeTab = tab.id; }}
      >
        {tab.label}
        {#if toolsData}
          <span class="badge badge-gray" style="margin-left: 4px; font-size: 10px;">{tabCounts[tab.id]}</span>
        {/if}
      </button>
    {/each}
  </div>

  <!-- Search -->
  <div style="padding: 0 var(--sp-2);">
    <input
      type="text"
      class="input"
      placeholder="Filter tools by name, description, or agent..."
      bind:value={searchQuery}
    />
  </div>

  {#if loading}
    <div class="text-muted text-center py-4">Loading...</div>
  {:else if error}
    <div class="text-red text-center">Error: {error}</div>
  {:else if toolsData}
    <!-- MCP tab: accordion per server -->
    {#if activeTab === 'mcp'}
      {@const groups = getGroupedTools('mcp')}
      {#if Object.keys(groups).length === 0}
        <div class="text-muted text-center py-4">No MCP servers configured</div>
      {:else}
        {#each Object.entries(groups) as [serverName, tools]}
          {@const agents = getAgentsForTool('mcp', '', serverName)}
          {@const filtered = tools.filter((t) => matchesSearch(t, agents))}
          {#if !searchQuery || filtered.length > 0}
            <div class="mcp-accordion">
              <div class="mcp-accordion-header">
                <div class="flex-1">
                  <div class="font-medium text-primary">{serverName}</div>
                  <div class="text-xs text-muted mt-1">{tools.length} tool{tools.length !== 1 ? 's' : ''}</div>
                </div>
                {#if agents.length > 0}
                  <div class="flex flex-wrap gap-1 mr-3">
                    {#each agents as agentName}
                      <span class="badge badge-accent badge-pill">{agentName}</span>
                    {/each}
                  </div>
                {/if}
              </div>
              <div class="p-4 pt-3 border-t">
                {#if filtered.length === 0}
                  <div class="text-muted text-sm py-2">No matching tools</div>
                {:else}
                  <div class="grid-auto mt-1">
                    {#each filtered as tool (tool.name)}
                      <div class="mcp-tool-card">
                        <div class="tool-name">{tool.name}</div>
                        <div class="text-xs text-muted line-clamp-2">{tool.description || ''}</div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      {/if}

    <!-- Knowledge tab: grouped by store -->
    {:else if activeTab === 'knowledge'}
      {@const groups = getGroupedTools('knowledge')}
      {#if Object.keys(groups).length === 0}
        <div class="text-muted text-center py-4">No knowledge stores configured</div>
      {:else}
        {#each Object.entries(groups) as [storeName, tools]}
          {@const agents = getAgentsForTool('knowledge', '', storeName)}
          {@const filtered = tools.filter((t) => matchesSearch(t, agents))}
          {#if !searchQuery || filtered.length > 0}
            <div class="mcp-accordion">
              <div class="mcp-accordion-header">
                <div class="flex-1">
                  <div class="font-medium text-primary">{storeName}</div>
                  <div class="text-xs text-muted mt-1">{tools.length} tool{tools.length !== 1 ? 's' : ''}</div>
                </div>
                {#if agents.length > 0}
                  <div class="flex flex-wrap gap-1 mr-3">
                    {#each agents as agentName}
                      <span class="badge badge-accent badge-pill">{agentName}</span>
                    {/each}
                  </div>
                {/if}
              </div>
              <div class="p-4 pt-3 border-t">
                {#if filtered.length === 0}
                  <div class="text-muted text-sm py-2">No matching tools</div>
                {:else}
                  <div class="grid-auto mt-1">
                    {#each filtered as tool (tool.name)}
                      <div class="mcp-tool-card">
                        <div class="tool-name">{tool.name}</div>
                        <div class="text-xs text-muted line-clamp-2">{tool.description || ''}</div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      {/if}

    <!-- Flat tabs: function, builtin, sandbox, workspace -->
    {:else}
      {@const tools = getFlatTools(activeTab as 'function' | 'builtin' | 'sandbox' | 'workspace')}
      {@const filtered = tools.filter((t) => {
        const agents = getAgentsForTool(activeTab, t.name);
        return matchesSearch(t, agents);
      })}
      {#if filtered.length === 0}
        <div class="text-muted text-center py-4">
          {tools.length === 0 ? 'No tools available' : 'No matching tools'}
        </div>
      {:else}
        <div class="grid-auto">
          {#each filtered as tool (tool.name)}
            {@const agents = getAgentsForTool(activeTab, tool.name)}
            <div class="mcp-tool-card">
              <div class="tool-name">{tool.name}</div>
              <div class="text-xs text-muted line-clamp-2">{tool.description || ''}</div>
              {#if agents.length > 0}
                <div class="flex flex-wrap gap-1 mt-2">
                  {#each agents as agentName}
                    <span class="badge badge-accent badge-pill">{agentName}</span>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
</div>
