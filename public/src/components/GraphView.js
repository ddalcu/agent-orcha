
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

export class GraphView extends Component {
    constructor() {
        super();
        this.neo4jd3 = null;
        this.selectedNode = null;
        this.lockedNodes = new Set();
        this.typeLabelProperty = new Map(); // nodeType -> propertyName to display
    }

    async connectedCallback() {
        super.connectedCallback();
        await this.checkNeo4jConnection();
    }

    // Reorder labels so the specific type comes first (not "Entity")
    // neo4jd3 uses labels[0] for color and icon lookup
    fixLabels(data) {
        const graph = data?.results?.[0]?.data?.[0]?.graph;
        if (!graph?.nodes) return data;

        for (const node of graph.nodes) {
            if (Array.isArray(node.labels) && node.labels.length > 1) {
                const specific = node.labels.filter(l => l !== 'Entity');
                const entity = node.labels.filter(l => l === 'Entity');
                node.labels = [...specific, ...entity];
            }
        }
        return data;
    }

    async checkNeo4jConnection() {
        try {
            const config = await api.getNeo4jConfig();
            if (!config.configured) {
                this.renderNotConfigured();
            } else {
                this.bindEvents();
                await this.loadKnowledgeBases();
            }
        } catch (e) {
            console.error('Failed to check Neo4j config:', e);
            this.renderError('Failed to connect to server');
        }
    }

    renderNotConfigured() {
        const main = this.querySelector('#graphMain');
        main.innerHTML = `
            <div class="flex items-center justify-center h-full">
                <div class="text-center max-w-2xl p-8 bg-dark-surface rounded-lg border border-dark-border">
                    <i class="fas fa-database text-6xl text-gray-500 mb-4"></i>
                    <h2 class="text-2xl font-bold mb-4">Neo4j Not Configured</h2>
                    <p class="text-gray-400 mb-6">
                        To use the Graph visualization, configure Neo4j connection via environment variables:
                    </p>
                    <div class="bg-dark-bg p-4 rounded border border-dark-border text-left font-mono text-sm">
                        <div class="text-gray-300">NEO4J_URI=bolt://localhost:7687</div>
                        <div class="text-gray-300">NEO4J_USERNAME=neo4j</div>
                        <div class="text-gray-300">NEO4J_PASSWORD=your-password</div>
                    </div>
                    <p class="text-gray-500 mt-6 text-sm">
                        Set these environment variables and restart the server.
                    </p>
                </div>
            </div>
        `;
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
            const data = await api.getGraphData('MATCH (kb:KnowledgeBase) RETURN kb LIMIT 100');
            this.initGraph(this.fixLabels(data));
        } catch (e) {
            console.error('Failed to load knowledge bases:', e);
            this.renderError('Failed to load graph data: ' + e.message);
        }
    }

    async loadFullGraph() {
        try {
            const data = this.fixLabels(await api.getGraphData('MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 300'));
            if (this.neo4jd3) {
                this.neo4jd3.updateWithNeo4jData(data);
                this.updateCounts();
            } else {
                this.initGraph(data);
            }
        } catch (e) {
            console.error('Failed to load full graph:', e);
        }
    }

    async expandNode(nodeData) {
        if (!nodeData) return;

        // Query for all relationships connected to this node
        const entityId = nodeData.properties?.id || '';
        if (!entityId) return;

        try {
            const data = this.fixLabels(await api.getGraphData(
                `MATCH (n:Entity {id: "${entityId}"})-[r]-(m) RETURN n, r, m LIMIT 50`
            ));
            if (this.neo4jd3) {
                this.neo4jd3.updateWithNeo4jData(data);
                this.updateCounts();
            }
        } catch (e) {
            console.error('Failed to expand node:', e);
        }
    }

    initGraph(data) {
        const container = this.querySelector('#neo4jd3');
        if (!container) return;
        container.innerHTML = '';

        const self = this;

        this.neo4jd3 = new Neo4jd3(container, {
            neo4jData: data,
            infoPanel: false,
            colors: [
                '#3b82f6', // blue
                '#10b981', // emerald
                '#f59e0b', // amber
                '#ef4444', // red
                '#8b5cf6', // violet
                '#ec4899', // pink
                '#06b6d4', // cyan
                '#f97316', // orange
                '#14b8a6', // teal
                '#a855f7', // purple
                '#84cc16', // lime
                '#e11d48', // rose
                '#0ea5e9', // sky
                '#d946ef', // fuchsia
                '#22c55e', // green
                '#eab308', // yellow
            ],
            highlight: [
                {
                    class: 'KnowledgeBase',
                    property: 'name',
                    value: '*'
                }
            ],
            icons: {
                'KnowledgeBase': 'database',
                'Post': 'file-text',
                'Author': 'user',
                'User': 'user',
                'Creator': 'user',
                'Client': 'user',
                'Gig': 'briefcase',
                'Ticket': 'ticket',
                'Project': 'sitemap',
                'Property': 'home',
                'Owner': 'user',
                'Listing': 'shopping-bag',
                'Business': 'building',
                'Survey': 'bar-chart',
                'Game': 'trophy',
                'Division': 'clone',
                'Court': 'map-marker',
                'Event': 'calendar',
                'Chore': 'tasks',
                'Family': 'home',
                'Topic': 'tag'
            },
            minCollision: 110,
            nodeRadius: 50,
            relationshipColor: '#64748b',
            zoomFit: true,
            onNodeClick: function(d) {
                self.onNodeClicked(d);
            },
            onNodeDoubleClick: function(d) {
                //self.toggleLock(d);
                self.expandNode(d);
            }
        });

        this.updateCounts();
    }

    onNodeClicked(d) {
        // Deselect previous node
        if (this.selectedNode) {
            d3.selectAll('.node').each(function(nodeData) {
                if (nodeData.id === d.id) return;
                d3.select(this).classed('selected', false);
            });
        }

        this.selectedNode = d;

        // Select clicked node
        d3.selectAll('.node').each(function(nodeData) {
            d3.select(this).classed('selected', nodeData.id === d.id);
        });

        this.showSidebar(d);
    }

    showSidebar(d) {
        const sidebar = this.querySelector('#sidebar');
        const sidebarContent = this.querySelector('#sidebarContent');
        sidebar.classList.remove('hidden');

        const labels = d.labels || [];
        const type = labels[0] || 'Unknown';
        const props = d.properties || {};
        const propKeys = Object.keys(props);
        const isLocked = this.lockedNodes.has(d.id);
        const currentLabelProp = this.typeLabelProperty.get(type) || '';

        sidebarContent.innerHTML = `
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-bold text-white">${type}</h3>
                <button id="closeSidebar" class="text-gray-400 hover:text-white">
                    <i class="fas fa-times text-lg"></i>
                </button>
            </div>

            <div class="mb-4 pb-4 border-b border-dark-border">
                <span class="text-xs text-gray-500 font-mono">ID: ${d.id}</span>
            </div>

            <div class="mb-4 pb-4 border-b border-dark-border">
                <label class="block text-xs text-gray-400 mb-2 uppercase tracking-wider">Display property <span class="normal-case text-gray-500">(all ${type} nodes)</span></label>
                <select id="nodeLabelSelect" class="w-full bg-dark-bg border border-dark-border rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500">
                    <option value="" ${!currentLabelProp ? 'selected' : ''}>Default (ID)</option>
                    ${propKeys.map(key => {
                        const val = props[key];
                        const display = typeof val === 'string' ? val.substring(0, 40) : String(val);
                        return `<option value="${key}" ${currentLabelProp === key ? 'selected' : ''}>${key}: ${this.escapeHtml(display)}</option>`;
                    }).join('')}
                </select>
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
                    ${propKeys.length > 0
                        ? propKeys.map(key => {
                            const val = props[key];
                            const displayVal = typeof val === 'string'
                                ? (val.length > 200 ? val.substring(0, 200) + '...' : val)
                                : JSON.stringify(val);
                            return `
                                <div class="bg-dark-bg rounded p-3 border border-dark-border">
                                    <div class="text-xs text-gray-500 mb-1">${this.escapeHtml(key)}</div>
                                    <div class="text-sm text-gray-200 break-words">${this.escapeHtml(displayVal)}</div>
                                </div>
                            `;
                        }).join('')
                        : '<p class="text-sm text-gray-500 italic">No properties</p>'
                    }
                </div>
            </div>
        `;

        // Bind sidebar events
        this.querySelector('#closeSidebar').addEventListener('click', () => this.hideSidebar());

        this.querySelector('#lockNode').addEventListener('click', () => {
            this.toggleLock(d);
            this.showSidebar(d); // Re-render sidebar to update button state
        });

        this.querySelector('#expandNode').addEventListener('click', () => {
            this.expandNode(d);
        });

        this.querySelector('#nodeLabelSelect').addEventListener('change', (e) => {
            const propName = e.target.value;
            this.changeNodeLabel(d, propName);
        });
    }

    hideSidebar() {
        const sidebar = this.querySelector('#sidebar');
        sidebar.classList.add('hidden');
        this.selectedNode = null;
        d3.selectAll('.node').classed('selected', false);
    }

    toggleLock(d) {
        if (this.lockedNodes.has(d.id)) {
            // Unlock
            this.lockedNodes.delete(d.id);
            d.fx = null;
            d.fy = null;

            // Remove visual indicator
            d3.selectAll('.node').each(function(nodeData) {
                if (nodeData.id === d.id) {
                    d3.select(this).select('.ring').classed('locked', false);
                }
            });
        } else {
            // Lock at current position
            this.lockedNodes.add(d.id);
            d.fx = d.x;
            d.fy = d.y;

            // Add visual indicator
            d3.selectAll('.node').each(function(nodeData) {
                if (nodeData.id === d.id) {
                    d3.select(this).select('.ring').classed('locked', true);
                }
            });
        }
    }

    changeNodeLabel(d, propertyName) {
        const nodeType = (d.labels && d.labels[0]) || 'Unknown';

        if (propertyName) {
            this.typeLabelProperty.set(nodeType, propertyName);
        } else {
            this.typeLabelProperty.delete(nodeType);
        }

        const container = this.querySelector('#neo4jd3');
        if (!container) return;

        // Apply to ALL nodes of the same type
        d3.select(container).selectAll('.node').each(function(nodeData) {
            const type = (nodeData.labels && nodeData.labels[0]) || 'Unknown';
            if (type !== nodeType) return;

            // Try .node-label first, fall back to last text element
            const nodeGroup = d3.select(this);
            let labelEl = nodeGroup.select('.node-label');
            if (labelEl.empty()) {
                const texts = nodeGroup.selectAll('text');
                if (texts.size() > 1) {
                    labelEl = d3.select(texts.nodes()[texts.size() - 1]);
                } else if (texts.size() === 1) {
                    const t = texts;
                    if (t.classed('icon')) return;
                    labelEl = t;
                } else {
                    return;
                }
            }

            const max = 11;
            if (propertyName && nodeData.properties[propertyName] !== undefined) {
                const val = String(nodeData.properties[propertyName]);
                labelEl.text(val.length > max ? val.substring(0, max) + '..' : val);
            } else {
                const name = (nodeData.properties && nodeData.properties.name) || nodeData.id;
                labelEl.text(name.length > max ? name.substring(0, max) + '..' : name);
            }
        });
    }

    updateCounts() {
        const nodeCountEl = this.querySelector('#nodeCount');
        const relCountEl = this.querySelector('#relationshipCount');
        if (!nodeCountEl || !relCountEl) return;

        // Count from the SVG elements
        const nodeCount = d3.selectAll('.node').size();
        const relCount = d3.selectAll('.relationship').size();
        nodeCountEl.textContent = `${nodeCount} nodes`;
        relCountEl.textContent = `${relCount} relationships`;
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    bindEvents() {
        this.querySelector('#loadKnowledgeBases')?.addEventListener('click', () => this.loadKnowledgeBases());
        this.querySelector('#loadFullGraph')?.addEventListener('click', () => this.loadFullGraph());
        this.querySelector('#clearGraph')?.addEventListener('click', () => {
            const container = this.querySelector('#neo4jd3');
            if (container) container.innerHTML = '';
            this.neo4jd3 = null;
            this.hideSidebar();
            this.updateCounts();
        });
    }

    postRender() {
        // Events bound in checkNeo4jConnection -> bindEvents after template is ready
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
                        <div id="neo4jd3" class="h-full w-full rounded-lg graph-canvas"></div>
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
