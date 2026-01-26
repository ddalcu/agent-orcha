
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

export class McpView extends Component {
    constructor() {
        super();
        this.source = 'mcp'; // 'mcp' | 'functions'
        this.selectedItem = null;
    }

    async connectedCallback() {
        super.connectedCallback();
        this.loadContent();
    }

    async loadContent() {
        const container = this.querySelector('#listContainer');
        container.innerHTML = '<div class="text-gray-500 text-center py-8">Loading...</div>';

        try {
            if (this.source === 'mcp') {
                const servers = await api.getMCPServers();
                this.renderServers(servers);
            } else {
                const functions = await api.getFunctions();
                this.renderFunctions(functions);
            }
        } catch (e) {
            container.innerHTML = `<div class="text-red-400 text-center">Error: ${e.message}</div>`;
        }
    }

    async renderServers(servers) {
        const container = this.querySelector('#listContainer');
        if (!servers.length) {
            container.innerHTML = '<div class="text-gray-500 text-center py-8">No servers configured</div>';
            return;
        }

        container.innerHTML = '';

        for (const server of servers) {
            const section = document.createElement('div');
            section.className = 'bg-dark-surface/30 border border-dark-border rounded-lg overflow-hidden mb-4';

            // Initial render without tools
            section.innerHTML = `
                <div class="p-4 cursor-pointer hover:bg-dark-surface/50 transition-colors flex items-center justify-between" onclick="this.parentElement.querySelector('.tools-grid').classList.toggle('hidden'); this.querySelector('svg').classList.toggle('rotate-180')">
                    <div class="flex-1">
                        <div class="font-medium text-gray-200">${server.name}</div>
                        <div class="text-xs text-gray-500 mt-0.5">${server.transport}</div>
                    </div>
                    <svg class="w-5 h-5 text-gray-400 transform transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                </div>
                <div class="tools-grid hidden p-4 pt-0 border-t border-dark-border/50">
                     <div class="text-gray-500 text-sm py-2">Loading tools...</div>
                </div>
             `;

            // Lazy load tools
            api.getMCPTools(server.name).then(tools => {
                const grid = section.querySelector('.tools-grid');
                if (!tools.length) {
                    grid.innerHTML = '<div class="text-gray-500 text-sm py-2">No tools available</div>';
                    return;
                }

                grid.innerHTML = `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 mt-4">
                    ${tools.map(tool => `
                        <div class="tool-card bg-dark-bg border border-dark-border hover:border-cyan-500 rounded p-3 cursor-pointer transition-colors" data-server="${server.name}" data-tool='${JSON.stringify(tool).replace(/'/g, "&#39;")}'>
                            <div class="font-medium text-cyan-400 text-sm mb-1">${tool.name}</div>
                            <div class="text-xs text-gray-500 line-clamp-2">${tool.description || ''}</div>
                        </div>
                    `).join('')}
                 </div>`;

                grid.querySelectorAll('.tool-card').forEach(card => {
                    card.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const tool = JSON.parse(card.dataset.tool);
                        this.selectItem('tool', tool, card.dataset.server);
                    });
                });
            });

            container.appendChild(section);
        }
    }

    renderFunctions(functions) {
        const container = this.querySelector('#listContainer');
        if (!functions.length) {
            container.innerHTML = '<div class="text-gray-500 text-center py-8">No functions available</div>';
            return;
        }

        container.innerHTML = `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            ${functions.map(func => `
                <div class="func-card bg-dark-surface border border-dark-border hover:border-cyan-500 rounded-lg p-4 cursor-pointer transition-colors" data-func='${JSON.stringify(func).replace(/'/g, "&#39;")}'>
                     <div class="font-medium text-cyan-400 mb-1">${func.name}</div>
                     <div class="text-xs text-gray-500 line-clamp-2">${func.description || ''}</div>
                </div>
            `).join('')}
        </div>`;

        container.querySelectorAll('.func-card').forEach(card => {
            card.addEventListener('click', () => {
                const func = JSON.parse(card.dataset.func);
                this.selectItem('function', func);
            });
        });
    }

    selectItem(type, item, serverName) {
        this.selectedItem = { type, item, serverName };
        const execArea = this.querySelector('#executionArea');
        execArea.classList.remove('hidden');

        this.querySelector('#selectedName').textContent = item.name;
        this.querySelector('#selectedDesc').textContent = item.description || '';

        // Generate placeholder JSON
        const schema = item.inputSchema || item.schema || {}; // Tool uses inputSchema, Function uses schema
        const placeholder = this.generateJsonFromSchema(schema);
        this.querySelector('#argsInput').value = JSON.stringify(placeholder, null, 2);

        // Highlight
        this.querySelectorAll('.tool-card, .func-card').forEach(el => {
            el.classList.remove('border-cyan-500', 'bg-cyan-500/10');
            el.classList.add('border-dark-border');
        });
        // (Visual highlight logic omitted for brevity as it requires complex matching)
    }

    generateJsonFromSchema(schema) {
        if (!schema || (!schema.properties && !schema.shape)) return {};
        // Very basic generation
        const props = schema.properties || (schema.shape ? this.zodShapeToProps(schema.shape) : {});
        const res = {};
        for (const key in props) {
            res[key] = "";
        }
        return res;
    }

    zodShapeToProps(shape) {
        // Simplified Zod shape handler
        return Object.keys(shape).reduce((acc, k) => { acc[k] = {}; return acc; }, {});
    }

    postRender() {
        const mcpBtn = this.querySelector('#mcpBtn');
        const funcBtn = this.querySelector('#funcBtn');

        mcpBtn.addEventListener('click', () => {
            this.source = 'mcp';
            mcpBtn.classList.replace('bg-dark-surface', 'bg-cyan-600');
            mcpBtn.classList.replace('text-gray-400', 'text-white');
            funcBtn.classList.replace('bg-cyan-600', 'bg-dark-surface');
            funcBtn.classList.replace('text-white', 'text-gray-400');
            this.querySelector('#executionArea').classList.add('hidden');
            this.loadContent();
        });

        funcBtn.addEventListener('click', () => {
            this.source = 'functions';
            funcBtn.classList.replace('bg-dark-surface', 'bg-cyan-600');
            funcBtn.classList.replace('text-gray-400', 'text-white');
            mcpBtn.classList.replace('bg-cyan-600', 'bg-dark-surface');
            mcpBtn.classList.replace('text-white', 'text-gray-400');
            this.querySelector('#executionArea').classList.add('hidden');
            this.loadContent();
        });

        this.querySelector('#executeBtn').addEventListener('click', () => this.execute());
    }

    async execute() {
        const btn = this.querySelector('#executeBtn');
        const outputArea = this.querySelector('#outputArea');
        const outputEl = this.querySelector('#mcpOutput');
        const argsInput = this.querySelector('#argsInput');

        if (!this.selectedItem) return;

        let args = {};
        try {
            args = JSON.parse(argsInput.value || '{}');
        } catch (e) {
            outputArea.classList.remove('hidden');
            outputEl.textContent = 'Error: Invalid JSON arguments';
            outputEl.classList.add('text-red-400');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Executing...';
        outputArea.classList.remove('hidden');
        outputEl.textContent = 'Running...';
        outputEl.classList.remove('text-red-400');

        try {
            let result;
            if (this.selectedItem.type === 'tool') {
                result = await api.executeMcpTool(this.selectedItem.serverName, this.selectedItem.item.name, args);
            } else {
                result = await api.executeFunction(this.selectedItem.item.name, args);
            }

            if (result.error) {
                throw new Error(result.error);
            }

            const content = typeof result.content === 'string' ? result.content : JSON.stringify(result, null, 2);
            outputEl.textContent = content;
        } catch (e) {
            outputEl.textContent = 'Error: ' + e.message;
            outputEl.classList.add('text-red-400');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Execute';
        }
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-8 custom-scrollbar">
                <div class="flex gap-2 border-b border-dark-border pb-4">
                    <button id="mcpBtn" class="px-4 py-2 rounded-lg font-medium bg-cyan-600 text-white transition-colors">MCP Servers</button>
                    <button id="funcBtn" class="px-4 py-2 rounded-lg font-medium bg-dark-surface text-gray-400 hover:bg-dark-hover transition-colors">Internal Functions</button>
                </div>

                <div id="listContainer"></div>

                <div id="executionArea" class="hidden border-t border-dark-border pt-6">
                    <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-4 mb-4">
                         <div class="font-medium text-cyan-400" id="selectedName"></div>
                         <div class="text-xs text-gray-500 mt-1" id="selectedDesc"></div>
                    </div>

                    <div class="mb-4">
                        <label class="block text-sm font-medium text-gray-300 mb-2">Arguments (JSON)</label>
                        <textarea id="argsInput" rows="6" class="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-3 text-gray-100 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"></textarea>
                    </div>

                    <button id="executeBtn" class="bg-cyan-600 hover:bg-cyan-700 text-white font-medium px-6 py-2.5 rounded-lg transition-colors">
                        Execute
                    </button>

                    <div id="outputArea" class="mt-4 hidden">
                        <label class="block text-sm font-medium text-gray-300 mb-2">Output</label>
                        <div id="mcpOutput" class="bg-dark-surface border border-dark-border rounded-lg p-4 min-h-[100px] font-mono text-sm text-gray-300 whitespace-pre-wrap overflow-x-auto"></div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('mcp-view', McpView);
