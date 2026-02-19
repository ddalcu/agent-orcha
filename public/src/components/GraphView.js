
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

const TYPE_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#a855f7',
    '#84cc16', '#e11d48', '#0ea5e9', '#d946ef', '#22c55e',
];

export class GraphView extends Component {
    constructor() {
        super();
        this.network = null;
        this.nodes = null;   // vis.DataSet
        this.edges = null;   // vis.DataSet
        this.selectedNodeId = null;
        this.typeColorMap = new Map();
        this.colorIndex = 0;
    }

    async connectedCallback() {
        super.connectedCallback();
        await this.checkGraphConnection();
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
            this.bindEvents();
            await this.loadKnowledgeBases();
        } catch (e) {
            console.error('Failed to check graph config:', e);
            this.renderError('Failed to connect to server');
        }
    }

    renderError(message) {
        const main = this.querySelector('#graphMain');
        main.innerHTML = `
            <div class="flex items-center justify-center h-full">
                <div class="text-center p-8">
                    <i class="fas fa-exclamation-circle text-4xl text-red-400 mb-4"></i>
                    <p class="text-red-300">${message}</p>
                </div>
            </div>
        `;
    }

    async loadKnowledgeBases() {
        try {
            const data = await api.getGraphKnowledgeBases();
            if (this.network) {
                this.mergeData(data);
            } else {
                this.initGraph(data);
            }
        } catch (e) {
            console.error('Failed to load knowledge bases:', e);
            this.renderError('Failed to load graph data: ' + e.message);
        }
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
            console.error('Failed to load full graph:', e);
        }
    }

    async expandNode(nodeId) {
        if (!nodeId) return;
        try {
            const data = await api.getGraphNeighbors(nodeId);
            if (this.network) {
                this.mergeData(data);
            }
        } catch (e) {
            console.error('Failed to expand node:', e);
        }
    }

    /**
     * Convert API nodes to vis.js node format.
     */
    toVisNodes(apiNodes) {
        return (apiNodes || []).map((n) => {
            if (n.type === 'KnowledgeBase') {
                return {
                    id: n.id,
                    label: n.name || n.id,
                    title: n.description || n.name,
                    shape: 'icon',
                    icon: {
                        face: '"Font Awesome 6 Free"',
                        weight: '900',
                        code: '\uf1c0',
                        size: 50,
                        color: '#3b82f6',
                    },
                    font: { color: '#e2e8f0', size: 14 },
                    size: 40,
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
                color: {
                    background: color,
                    border: color,
                    highlight: { background: color, border: '#60a5fa' },
                    hover: { background: color, border: '#94a3b8' },
                },
                font: { color: '#e2e8f0', size: 12 },
                shape: 'dot',
                size: 18,
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
            arrows: 'to',
            color: { color: '#475569', highlight: '#60a5fa', hover: '#64748b' },
            font: { color: '#64748b', size: 9, strokeWidth: 0 },
            smooth: { type: 'continuous' },
            width: 1.5,
            // Store original data
            _type: e.type,
            _description: e.description,
        }));
    }

    initGraph(data) {
        const container = this.querySelector('#graphContainer');
        if (!container) return;

        this.nodes = new vis.DataSet(this.toVisNodes(data.nodes));
        this.edges = new vis.DataSet(this.toVisEdges(data.edges));

        this.network = new vis.Network(container, { nodes: this.nodes, edges: this.edges }, {
            physics: {
                stabilization: false,
                barnesHut: {
                    gravitationalConstant: -3000,
                    springLength: 200,
                    springConstant: 0.02,
                    damping: 0.3,
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
        });

        this.network.on('click', (params) => {
            if (params.nodes.length > 0) {
                this.onNodeClicked(params.nodes[0]);
            } else {
                this.hideSidebar();
            }
        });

        this.network.on('doubleClick', (params) => {
            if (params.nodes.length > 0) {
                this.expandNode(params.nodes[0]);
            }
        });

        this.updateCounts();
    }

    /**
     * Merge new data into existing graph. vis.js DataSet handles dedup by id.
     * Physics smoothly repositions existing nodes — no full re-render.
     */
    mergeData(data) {
        const newNodes = this.toVisNodes(data.nodes).filter((n) => !this.nodes.get(n.id));
        const newEdges = this.toVisEdges(data.edges).filter((e) => !this.edges.get(e.id));

        if (newNodes.length > 0) this.nodes.add(newNodes);
        if (newEdges.length > 0) this.edges.add(newEdges);

        this.updateCounts();
    }

    onNodeClicked(nodeId) {
        this.selectedNodeId = nodeId;
        this.showSidebar(nodeId);
    }

    showSidebar(nodeId) {
        const sidebar = this.querySelector('#sidebar');
        const sidebarContent = this.querySelector('#sidebarContent');
        sidebar.classList.remove('hidden');

        const nodeData = this.nodes.get(nodeId);
        if (!nodeData) return;

        const type = nodeData._type || 'Unknown';
        const props = nodeData._properties || {};
        const propKeys = Object.keys(props);
        const isLocked = nodeData.fixed === true;

        const coreProps = [
            { key: 'name', val: nodeData._name },
            { key: 'description', val: nodeData._description },
        ].filter((p) => p.val);

        sidebarContent.innerHTML = `
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-bold text-white">${this.escapeHtml(type)}</h3>
                <button id="closeSidebar" class="text-gray-400 hover:text-white">
                    <i class="fas fa-times text-lg"></i>
                </button>
            </div>

            <div class="mb-4 pb-4 border-b border-dark-border">
                <span class="text-xs text-gray-500 font-mono">ID: ${this.escapeHtml(nodeId)}</span>
            </div>

            <div class="mb-4 pb-4 border-b border-dark-border flex gap-2">
                <button id="lockNode" class="flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                    isLocked
                        ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                        : 'bg-dark-bg border border-dark-border hover:bg-dark-hover text-gray-300'
                }">
                    <i class="fas ${isLocked ? 'fa-lock' : 'fa-lock-open'} mr-2"></i>
                    ${isLocked ? 'Unlock' : 'Lock'}
                </button>
                <button id="expandNode" class="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors">
                    <i class="fas fa-expand-arrows-alt mr-2"></i>
                    Expand
                </button>
            </div>

            <div>
                <label class="block text-xs text-gray-400 mb-2 uppercase tracking-wider">Properties</label>
                <div class="space-y-2">
                    ${[...coreProps.map((p) => this.renderProperty(p.key, p.val)),
                       ...propKeys.map((key) => this.renderProperty(key, props[key]))
                    ].join('')}
                    ${coreProps.length === 0 && propKeys.length === 0
                        ? '<p class="text-sm text-gray-500 italic">No properties</p>'
                        : ''
                    }
                </div>
            </div>
        `;

        this.querySelector('#closeSidebar').addEventListener('click', () => this.hideSidebar());

        this.querySelector('#lockNode').addEventListener('click', () => {
            this.toggleLock(nodeId);
            this.showSidebar(nodeId);
        });

        this.querySelector('#expandNode').addEventListener('click', () => {
            this.expandNode(nodeId);
        });
    }

    renderProperty(key, val) {
        const displayVal = typeof val === 'string'
            ? (val.length > 200 ? val.substring(0, 200) + '...' : val)
            : JSON.stringify(val);
        return `
            <div class="bg-dark-bg rounded p-3 border border-dark-border">
                <div class="text-xs text-gray-500 mb-1">${this.escapeHtml(key)}</div>
                <div class="text-sm text-gray-200 break-words">${this.escapeHtml(displayVal)}</div>
            </div>
        `;
    }

    hideSidebar() {
        const sidebar = this.querySelector('#sidebar');
        sidebar.classList.add('hidden');
        this.selectedNodeId = null;
        if (this.network) {
            this.network.unselectAll();
        }
    }

    toggleLock(nodeId) {
        const nodeData = this.nodes.get(nodeId);
        if (!nodeData) return;

        if (nodeData.fixed) {
            this.nodes.update({ id: nodeId, fixed: false });
        } else {
            const positions = this.network.getPositions([nodeId]);
            const pos = positions[nodeId];
            this.nodes.update({ id: nodeId, fixed: true, x: pos.x, y: pos.y });
        }
    }

    updateCounts() {
        const nodeCountEl = this.querySelector('#nodeCount');
        const relCountEl = this.querySelector('#relationshipCount');
        if (!nodeCountEl || !relCountEl) return;

        if (this.nodes && this.edges) {
            nodeCountEl.textContent = `${this.nodes.length} nodes`;
            relCountEl.textContent = `${this.edges.length} relationships`;
        } else {
            nodeCountEl.textContent = '0 nodes';
            relCountEl.textContent = '0 relationships';
        }
    }

    truncate(text, max) {
        if (!text) return '';
        return text.length > max ? text.substring(0, max) + '..' : text;
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    bindEvents() {
        this.querySelector('#loadKnowledgeBases')?.addEventListener('click', () => this.loadKnowledgeBases());
        this.querySelector('#loadFullGraph')?.addEventListener('click', () => this.loadFullGraph());
        this.querySelector('#clearGraph')?.addEventListener('click', () => {
            if (this.network) {
                this.network.destroy();
                this.network = null;
                this.nodes = null;
                this.edges = null;
            }
            this.hideSidebar();
            this.updateCounts();
        });
    }

    postRender() {
        // Events bound in checkGraphConnection -> bindEvents after template is ready
    }

    template() {
        return `
            <div class="h-full flex flex-col">
                <div class="flex-shrink-0 mb-3 flex gap-3 items-center">
                    <button id="loadKnowledgeBases" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm">
                        <i class="fas fa-brain mr-1.5"></i>Knowledge Bases
                    </button>
                    <button id="loadFullGraph" class="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors text-sm">
                        <i class="fas fa-project-diagram mr-1.5"></i>Full Graph
                    </button>
                    <button id="clearGraph" class="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white rounded-lg transition-colors text-sm">
                        <i class="fas fa-eraser mr-1.5"></i>Clear
                    </button>
                    <div class="flex-1"></div>
                    <div class="text-xs text-gray-500 flex items-center gap-2">
                        <span id="nodeCount">0 nodes</span>
                        <span>|</span>
                        <span id="relationshipCount">0 relationships</span>
                    </div>
                </div>

                <div class="flex-1 min-h-0 flex">
                    <div id="graphMain" class="flex-1 min-w-0 h-full">
                        <div id="graphContainer" class="h-full w-full rounded-lg graph-canvas"></div>
                    </div>

                    <div id="sidebar" class="hidden w-80 flex-shrink-0 ml-3 bg-dark-surface rounded-lg border border-dark-border overflow-y-auto">
                        <div id="sidebarContent" class="p-4"></div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('graph-view', GraphView);
