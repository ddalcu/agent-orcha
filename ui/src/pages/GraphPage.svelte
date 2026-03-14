<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/services/api.ts';
  import { escapeHtml } from '../lib/utils/format.ts';

  declare const vis: any;

  const TYPE_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#a855f7',
    '#84cc16', '#e11d48', '#0ea5e9', '#d946ef', '#22c55e',
  ];

  const SESSION_KEY = 'graphView:positions';

  interface NodeData {
    id: string;
    label: string;
    title?: string;
    shape: string;
    size: number;
    color: unknown;
    borderWidth?: number;
    font: unknown;
    x?: number;
    y?: number;
    _type: string;
    _name: string;
    _description?: string;
    _properties: Record<string, unknown>;
  }

  interface EdgeData {
    id: string;
    from: string;
    to: string;
    label: string;
    title?: string;
    arrows: string;
    color: unknown;
    font: unknown;
    smooth: unknown;
    width: number;
    _type: string;
    _description?: string;
  }

  interface ApiNode {
    id: string;
    name?: string;
    type: string;
    description?: string;
    properties?: Record<string, unknown>;
  }

  interface ApiEdge {
    id: string;
    source: string;
    target: string;
    type: string;
    description?: string;
  }

  let graphContainer = $state<HTMLDivElement>(undefined!);
  let network: any = null;
  let nodes: any = null;
  let edges: any = null;
  let selectedNodeId = $state<string | null>(null);
  let typeColorMap = new Map<string, string>();
  let colorIndex = 0;
  let expandedNodes = new Set<string>();

  // Sidebar state
  let sidebarVisible = $state(false);
  let sidebarType = $state('');
  let sidebarId = $state('');
  let sidebarProperties = $state<Array<{ key: string; val: string }>>([]);

  // Error state
  let errorMessage = $state('');

  function getColorForType(type: string): string {
    if (typeColorMap.has(type)) return typeColorMap.get(type)!;
    const color = TYPE_COLORS[colorIndex % TYPE_COLORS.length];
    colorIndex++;
    typeColorMap.set(type, color);
    return color;
  }

  function truncate(text: string | undefined, max: number): string {
    if (!text) return '';
    return text.length > max ? text.substring(0, max) + '..' : text;
  }

  function truncateValue(val: unknown): string {
    const displayVal = typeof val === 'string'
      ? val.length > 120 ? val.substring(0, 120) + '...' : val
      : JSON.stringify(val);
    return displayVal;
  }

  function savePositions() {
    if (!network || !nodes) return;
    const positions = network.getPositions();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(positions));
  }

  function loadPositions(): Record<string, { x: number; y: number }> | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function toVisNodes(apiNodes: ApiNode[]): NodeData[] {
    return (apiNodes || []).map((n) => {
      if (n.type === 'KnowledgeBase') {
        return {
          id: n.id,
          label: n.name || n.id,
          title: n.description || n.name,
          shape: 'dot',
          size: 30,
          color: {
            background: '#3b82f6',
            border: '#60a5fa',
            highlight: { background: '#60a5fa', border: '#93c5fd' },
            hover: { background: '#60a5fa', border: '#93c5fd' },
          },
          borderWidth: 3,
          font: { color: '#e2e8f0', size: 16, bold: { color: '#e2e8f0' } },
          _type: n.type,
          _name: n.name || '',
          _description: n.description,
          _properties: n.properties || {},
        };
      }

      const color = getColorForType(n.type);
      return {
        id: n.id,
        label: truncate(n.name || n.id, 20),
        title: n.description || n.name,
        shape: 'dot',
        size: 12,
        color: {
          background: color,
          border: color,
          highlight: { background: color, border: '#e2e8f0' },
          hover: { background: color, border: '#e2e8f0' },
        },
        font: { color: '#e2e8f0', size: 12 },
        _type: n.type,
        _name: n.name || '',
        _description: n.description,
        _properties: n.properties || {},
      };
    });
  }

  function toVisEdges(apiEdges: ApiEdge[]): EdgeData[] {
    return (apiEdges || []).map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      label: e.type,
      title: e.description || e.type,
      arrows: 'to',
      color: { color: '#2e2f3a', highlight: '#5e6ad2', hover: '#3f404a' },
      font: { color: '#5c5c64', size: 9, strokeWidth: 0 },
      smooth: { type: 'continuous' },
      width: 1.5,
      _type: e.type,
      _description: e.description,
    }));
  }

  function mergeData(data: { nodes: ApiNode[]; edges: ApiEdge[] }) {
    const newNodes = toVisNodes(data.nodes).filter((n) => !nodes.get(n.id));
    const newEdges = toVisEdges(data.edges).filter((e) => !edges.get(e.id));

    if (newNodes.length > 0) nodes.add(newNodes);
    if (newEdges.length > 0) edges.add(newEdges);
  }

  function initGraph(data: { nodes: ApiNode[]; edges: ApiEdge[] }) {
    if (!graphContainer) return;

    const saved = loadPositions();
    const visNodes = toVisNodes(data.nodes);
    const visEdges = toVisEdges(data.edges);

    if (saved) {
      for (const node of visNodes) {
        if (saved[node.id]) {
          node.x = saved[node.id].x;
          node.y = saved[node.id].y;
        }
      }
    }

    nodes = new vis.DataSet([
      ...new Map(visNodes.map((n: NodeData) => [n.id, n])).values(),
    ]);
    edges = new vis.DataSet([
      ...new Map(visEdges.map((e: EdgeData) => [e.id, e])).values(),
    ]);

    network = new vis.Network(
      graphContainer,
      { nodes, edges },
      {
        physics: {
          stabilization: false,
          barnesHut: {
            gravitationalConstant: -10000,
            centralGravity: 1.5,
            springLength: 340,
            springConstant: 0.02,
            damping: 0.3,
            avoidOverlap: 0.8,
          },
        },
        interaction: {
          hover: true,
          tooltipDelay: 200,
          navigationButtons: false,
          keyboard: false,
        },
        edges: {
          smooth: { type: 'continuous' },
        },
      },
    );

    network.on('click', (params: { nodes: string[] }) => {
      if (params.nodes.length > 0) {
        onNodeClicked(params.nodes[0]);
      } else {
        sidebarVisible = false;
        selectedNodeId = null;
      }
    });

    network.on('doubleClick', (params: { nodes: string[] }) => {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        if (expandedNodes.has(nodeId)) {
          collapseNode(nodeId);
        } else {
          expandNode(nodeId);
        }
      }
    });
  }

  function onNodeClicked(nodeId: string) {
    selectedNodeId = nodeId;
    showSidebar(nodeId);
  }

  function showSidebar(nodeId: string) {
    const nodeData = nodes.get(nodeId);
    if (!nodeData) return;

    sidebarType = nodeData._type || 'Unknown';
    sidebarId = nodeId;

    const props = nodeData._properties || {};
    const propKeys = Object.keys(props);

    const coreProps: Array<{ key: string; val: string }> = [];
    if (nodeData._name) coreProps.push({ key: 'name', val: truncateValue(nodeData._name) });
    if (nodeData._description) coreProps.push({ key: 'description', val: truncateValue(nodeData._description) });

    const extraProps = propKeys.map((key) => ({
      key,
      val: truncateValue(props[key]),
    }));

    sidebarProperties = [...coreProps, ...extraProps];
    sidebarVisible = true;
  }

  async function expandNode(nodeId: string) {
    if (!nodeId) return;
    try {
      const beforeCount = nodes.length;
      const data = await api.getGraphNeighbors(nodeId);
      if (network) {
        mergeData(data);
      }
      if (nodes.length > beforeCount) {
        expandedNodes.add(nodeId);
      }
    } catch (e) {
      console.error('Failed to expand node:', e);
    }
  }

  function collapseNode(nodeId: string) {
    expandedNodes.delete(nodeId);

    const neighborIds = edges
      .get()
      .filter((e: EdgeData) => e.from === nodeId || e.to === nodeId)
      .map((e: EdgeData) => (e.from === nodeId ? e.to : e.from));

    for (const nid of neighborIds) {
      if (expandedNodes.has(nid)) {
        collapseNode(nid);
      }
    }

    const currentNeighborIds = edges
      .get()
      .filter((e: EdgeData) => e.from === nodeId || e.to === nodeId)
      .map((e: EdgeData) => (e.from === nodeId ? e.to : e.from));

    const removableNodes = currentNeighborIds.filter((nid: string) => {
      if (expandedNodes.has(nid)) return false;
      const allEdges = edges
        .get()
        .filter((e: EdgeData) => e.from === nid || e.to === nid);
      return allEdges.every((e: EdgeData) => e.from === nodeId || e.to === nodeId);
    });

    if (removableNodes.length > 0) {
      const removeSet = new Set(removableNodes);
      const edgesToRemove = edges
        .get()
        .filter((e: EdgeData) => removeSet.has(e.from) || removeSet.has(e.to));
      edges.remove(edgesToRemove.map((e: EdgeData) => e.id));
      nodes.remove(removableNodes);
    }
  }

  async function loadFullGraph() {
    try {
      const data = await api.getGraphFull(300);
      if (network) {
        mergeData(data);
      } else {
        initGraph(data);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error('Failed to load graph data:', e);
      errorMessage = 'Failed to load graph data: ' + msg;
    }
  }

  async function checkGraphConnection() {
    try {
      await api.getGraphConfig();
      await loadFullGraph();
    } catch (e) {
      console.error('Failed to check graph config:', e);
      errorMessage = 'Failed to connect to server';
    }
  }

  onMount(() => {
    checkGraphConnection();
  });

  onDestroy(() => {
    savePositions();
    if (network) {
      network.destroy();
      network = null;
    }
  });
</script>

<div class="h-full flex flex-col">
  <div class="flex-1 min-h-0 relative">
    {#if errorMessage}
      <div class="empty-state h-full">
        <i class="fas fa-exclamation-circle text-4xl text-red mb-4"></i>
        <p class="text-red">{errorMessage}</p>
      </div>
    {:else}
      <div bind:this={graphContainer} class="h-full w-full rounded-lg graph-canvas"></div>
    {/if}

    {#if sidebarVisible}
      <div class="graph-sidebar">
        <div class="p-3">
          <div class="mb-2">
            <h3 class="text-sm font-bold text-white">{escapeHtml(sidebarType)}</h3>
            <span class="text-xs text-muted font-mono">{escapeHtml(sidebarId)}</span>
          </div>
          <div class="space-y-1">
            {#if sidebarProperties.length === 0}
              <p class="text-xs text-muted italic">No properties</p>
            {:else}
              {#each sidebarProperties as prop}
                <div class="graph-prop">
                  <span class="text-xs text-muted">{escapeHtml(prop.key)}: </span>
                  <span class="text-xs text-primary break-words">{escapeHtml(prop.val)}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
