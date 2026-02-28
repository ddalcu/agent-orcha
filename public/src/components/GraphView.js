import { Component } from "../utils/Component.js";
import { api } from "../services/ApiService.js";

const TYPE_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#14b8a6",
  "#a855f7",
  "#84cc16",
  "#e11d48",
  "#0ea5e9",
  "#d946ef",
  "#22c55e",
];

const SESSION_KEY = "graphView:positions";

export class GraphView extends Component {
  constructor() {
    super();
    this.network = null;
    this.nodes = null; // vis.DataSet
    this.edges = null; // vis.DataSet
    this.selectedNodeId = null;
    this.typeColorMap = new Map();
    this.colorIndex = 0;
    this.expandedNodes = new Set();
  }

  async connectedCallback() {
    super.connectedCallback();
    await this.checkGraphConnection();
  }

  disconnectedCallback() {
    this.savePositions();
    if (this.network) {
      this.network.destroy();
      this.network = null;
    }
  }

  savePositions() {
    if (!this.network || !this.nodes) return;
    const positions = this.network.getPositions();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(positions));
  }

  loadPositions() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  getColorForType(type) {
    if (this.typeColorMap.has(type)) return this.typeColorMap.get(type);
    const color = TYPE_COLORS[this.colorIndex % TYPE_COLORS.length];
    this.colorIndex++;
    this.typeColorMap.set(type, color);
    return color;
  }

  async checkGraphConnection() {
    try {
      await api.getGraphConfig();
      await this.loadFullGraph();
    } catch (e) {
      console.error("Failed to check graph config:", e);
      this.renderError("Failed to connect to server");
    }
  }

  renderError(message) {
    const main = this.querySelector("#graphContainer");
    main.innerHTML = `
            <div class="flex items-center justify-center h-full">
                <div class="text-center p-8">
                    <i class="fas fa-exclamation-circle text-4xl text-red-400 mb-4"></i>
                    <p class="text-red-300">${message}</p>
                </div>
            </div>
        `;
  }

  async loadFullGraph() {
    try {
      const data = await api.getGraphFull(300);
      if (this.network) {
        this.mergeData(data);
      } else {
        this.initGraph(data);
      }
    } catch (e) {
      console.error("Failed to load full graph:", e);
      this.renderError("Failed to load graph data: " + e.message);
    }
  }

  async expandNode(nodeId) {
    if (!nodeId) return;
    try {
      const beforeCount = this.nodes.length;
      const data = await api.getGraphNeighbors(nodeId);
      if (this.network) {
        this.mergeData(data);
      }

      if (this.nodes.length > beforeCount) {
        this.expandedNodes.add(nodeId);
      }
    } catch (e) {
      console.error("Failed to expand node:", e);
    }
  }

  collapseNode(nodeId) {
    // Remove from expanded FIRST to prevent infinite recursion
    // (child neighbors that are also expanded won't recurse back here)
    this.expandedNodes.delete(nodeId);

    const neighborIds = this.edges
      .get()
      .filter((e) => e.from === nodeId || e.to === nodeId)
      .map((e) => (e.from === nodeId ? e.to : e.from));

    // Recursively collapse expanded children first
    for (const nid of neighborIds) {
      if (this.expandedNodes.has(nid)) {
        this.collapseNode(nid);
      }
    }

    // Re-query neighbors after recursive collapses may have changed the graph
    const currentNeighborIds = this.edges
      .get()
      .filter((e) => e.from === nodeId || e.to === nodeId)
      .map((e) => (e.from === nodeId ? e.to : e.from));

    const removableNodes = currentNeighborIds.filter((nid) => {
      if (this.expandedNodes.has(nid)) return false;
      const allEdges = this.edges
        .get()
        .filter((e) => e.from === nid || e.to === nid);
      return allEdges.every((e) => e.from === nodeId || e.to === nodeId);
    });

    if (removableNodes.length > 0) {
      const removeSet = new Set(removableNodes);
      const edgesToRemove = this.edges
        .get()
        .filter((e) => removeSet.has(e.from) || removeSet.has(e.to));
      this.edges.remove(edgesToRemove.map((e) => e.id));
      this.nodes.remove(removableNodes);
    }
  }

  /**
   * Convert API nodes to vis.js node format.
   */
  toVisNodes(apiNodes) {
    return (apiNodes || []).map((n) => {
      if (n.type === "KnowledgeBase") {
        return {
          id: n.id,
          label: n.name || n.id,
          title: n.description || n.name,
          shape: "dot",
          size: 30,
          color: {
            background: "#3b82f6",
            border: "#60a5fa",
            highlight: { background: "#60a5fa", border: "#93c5fd" },
            hover: { background: "#60a5fa", border: "#93c5fd" },
          },
          borderWidth: 3,
          font: { color: "#e2e8f0", size: 16, bold: { color: "#e2e8f0" } },
          _type: n.type,
          _name: n.name,
          _description: n.description,
          _properties: n.properties || {},
        };
      }

      const color = this.getColorForType(n.type);
      return {
        id: n.id,
        label: this.truncate(n.name || n.id, 20),
        title: n.description || n.name,
        shape: "dot",
        size: 12,
        color: {
          background: color,
          border: color,
          highlight: { background: color, border: "#e2e8f0" },
          hover: { background: color, border: "#e2e8f0" },
        },
        font: { color: "#e2e8f0", size: 12 },
        _type: n.type,
        _name: n.name,
        _description: n.description,
        _properties: n.properties || {},
      };
    });
  }

  /**
   * Convert API edges to vis.js edge format.
   */
  toVisEdges(apiEdges) {
    return (apiEdges || []).map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      label: e.type,
      title: e.description || e.type,
      arrows: "to",
      color: { color: "#475569", highlight: "#60a5fa", hover: "#64748b" },
      font: { color: "#64748b", size: 9, strokeWidth: 0 },
      smooth: { type: "continuous" },
      width: 1.5,
      // Store original data
      _type: e.type,
      _description: e.description,
    }));
  }

  initGraph(data) {
    const container = this.querySelector("#graphContainer");
    if (!container) return;

    const saved = this.loadPositions();
    const visNodes = this.toVisNodes(data.nodes);
    const visEdges = this.toVisEdges(data.edges);

    // Restore saved positions so nodes don't all start from center
    if (saved) {
      for (const node of visNodes) {
        if (saved[node.id]) {
          node.x = saved[node.id].x;
          node.y = saved[node.id].y;
        }
      }
    }

    this.nodes = new vis.DataSet([
      ...new Map(visNodes.map((n) => [n.id, n])).values(),
    ]);
    this.edges = new vis.DataSet([
      ...new Map(visEdges.map((e) => [e.id, e])).values(),
    ]);

    const hasPositions = saved && visNodes.some((n) => n.x !== undefined);

    this.network = new vis.Network(
      container,
      { nodes: this.nodes, edges: this.edges },
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
          smooth: { type: "continuous" },
        },
      },
    );

    // Save positions periodically as physics settles
    //this.network.on('stabilized', () => this.savePositions());
    //this.network.on('dragEnd', () => this.savePositions());

    this.network.on("click", (params) => {
      if (params.nodes.length > 0) {
        this.onNodeClicked(params.nodes[0]);
      } else {
        this.querySelector("#sidebar")?.classList.add("hidden");
        this.selectedNodeId = null;
      }
    });

    this.network.on("doubleClick", (params) => {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        if (this.expandedNodes.has(nodeId)) {
          this.collapseNode(nodeId);
        } else {
          this.expandNode(nodeId);
        }
      }
    });
  }

  /**
   * Merge new data into existing graph. vis.js DataSet handles dedup by id.
   * Physics smoothly repositions existing nodes — no full re-render.
   */
  mergeData(data) {
    const newNodes = this.toVisNodes(data.nodes).filter(
      (n) => !this.nodes.get(n.id),
    );
    const newEdges = this.toVisEdges(data.edges).filter(
      (e) => !this.edges.get(e.id),
    );

    if (newNodes.length > 0) this.nodes.add(newNodes);
    if (newEdges.length > 0) this.edges.add(newEdges);
  }

  onNodeClicked(nodeId) {
    this.selectedNodeId = nodeId;
    this.showSidebar(nodeId);
  }

  showSidebar(nodeId) {
    const sidebar = this.querySelector("#sidebar");
    const sidebarContent = this.querySelector("#sidebarContent");
    sidebar.classList.remove("hidden");

    const nodeData = this.nodes.get(nodeId);
    if (!nodeData) return;

    const type = nodeData._type || "Unknown";
    const props = nodeData._properties || {};
    const propKeys = Object.keys(props);

    const coreProps = [
      { key: "name", val: nodeData._name },
      { key: "description", val: nodeData._description },
    ].filter((p) => p.val);

    sidebarContent.innerHTML = `
            <div class="mb-2">
                <h3 class="text-sm font-bold text-white">${this.escapeHtml(type)}</h3>
                <span class="text-xs text-gray-500 font-mono">${this.escapeHtml(nodeId)}</span>
            </div>
            <div class="space-y-1">
                ${[
                  ...coreProps.map((p) => this.renderProperty(p.key, p.val)),
                  ...propKeys.map((key) =>
                    this.renderProperty(key, props[key]),
                  ),
                ].join("")}
                ${
                  coreProps.length === 0 && propKeys.length === 0
                    ? '<p class="text-xs text-gray-500 italic">No properties</p>'
                    : ""
                }
            </div>
        `;
  }

  renderProperty(key, val) {
    const displayVal =
      typeof val === "string"
        ? val.length > 120
          ? val.substring(0, 120) + "..."
          : val
        : JSON.stringify(val);
    return `
            <div class="bg-dark-bg rounded px-2 py-1 border border-dark-border">
                <span class="text-xs text-gray-500">${this.escapeHtml(key)}: </span>
                <span class="text-xs text-gray-200 break-words">${this.escapeHtml(displayVal)}</span>
            </div>
        `;
  }

  truncate(text, max) {
    if (!text) return "";
    return text.length > max ? text.substring(0, max) + ".." : text;
  }

  escapeHtml(text) {
    if (text === null || text === undefined) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  postRender() {
    // Graph initialized in checkGraphConnection on connectedCallback
  }

  template() {
    return `
            <div class="h-full flex flex-col">
                <div class="flex-1 min-h-0 relative">
                    <div id="graphContainer" class="h-full w-full rounded-lg graph-canvas"></div>
                    <div id="sidebar" class="hidden absolute top-2 right-2 w-64 max-h-72 overflow-y-auto bg-dark-surface rounded-lg border border-dark-border shadow-lg opacity-90">
                        <div id="sidebarContent" class="p-3"></div>
                    </div>
                </div>
            </div>
        `;
  }
}

customElements.define("graph-view", GraphView);
