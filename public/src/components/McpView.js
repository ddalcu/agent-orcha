
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
        container.innerHTML = '<div class="text-muted text-center py-4">Loading...</div>';

        try {
            if (this.source === 'mcp') {
                const servers = await api.getMCPServers();
                this.renderServers(servers);
            } else {
                const functions = await api.getFunctions();
                this.renderFunctions(functions);
            }
        } catch (e) {
            container.innerHTML = `<div class="text-red text-center">Error: ${e.message}</div>`;
        }
    }

    async renderServers(servers) {
        const container = this.querySelector('#listContainer');
        if (!servers.length) {
            container.innerHTML = '<div class="text-muted text-center py-4">No servers configured</div>';
            return;
        }

        container.innerHTML = '';

        for (const server of servers) {
            const section = document.createElement('div');
            section.className = 'mcp-accordion';

            section.innerHTML = `
                <div class="mcp-accordion-header" onclick="this.parentElement.querySelector('.tools-grid').classList.toggle('hidden'); this.querySelector('svg').classList.toggle('rotate-180')">
                    <div class="flex-1">
                        <div class="font-medium text-primary">${server.name}</div>
                        <div class="text-xs text-muted mt-1">${server.transport}</div>
                    </div>
                    <svg class="text-secondary transition-transform" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                </div>
                <div class="tools-grid hidden p-4 pt-3 border-t">
                     <div class="text-muted text-sm py-2">Loading tools...</div>
                </div>
             `;

            // Lazy load tools
            api.getMCPTools(server.name).then(tools => {
                const grid = section.querySelector('.tools-grid');
                if (!tools.length) {
                    grid.innerHTML = '<div class="text-muted text-sm py-2">No tools available</div>';
                    return;
                }

                grid.innerHTML = `<div class="grid-auto mt-3">
                    ${tools.map(tool => `
                        <div class="tool-card mcp-tool-card" data-server="${server.name}" data-tool='${JSON.stringify(tool).replace(/'/g, "&#39;")}'>
                            <div class="tool-name">${tool.name}</div>
                            <div class="text-xs text-muted line-clamp-2">${tool.description || ''}</div>
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
            container.innerHTML = '<div class="text-muted text-center py-4">No functions available</div>';
            return;
        }

        container.innerHTML = `<div class="grid-auto">
            ${functions.map(func => `
                <div class="func-card mcp-tool-card" data-func='${JSON.stringify(func).replace(/'/g, "&#39;")}'>
                     <div class="tool-name">${func.name}</div>
                     <div class="text-xs text-muted line-clamp-2">${func.description || ''}</div>
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

    async selectItem(type, item, serverName) {
        this.selectedItem = { type, item, serverName };
        const execArea = this.querySelector('#executionArea');
        execArea.classList.remove('hidden');

        this.querySelector('#selectedName').textContent = item.name;
        this.querySelector('#selectedDesc').textContent = item.description || '';

        // For functions, fetch full details including schema
        let schema = item.inputSchema || item.schema || {};
        if (type === 'function' && !item.schema) {
            try {
                const fullFunc = await api.getFunction(item.name);
                schema = fullFunc.schema || {};
                this.selectedItem.item = fullFunc; // Update with full details
            } catch (e) {
                console.error('Failed to fetch function schema:', e);
            }
        }

        // Generate placeholder JSON
        const placeholder = this.generateJsonFromSchema(schema);
        this.querySelector('#argsInput').value = JSON.stringify(placeholder, null, 2);

        // Highlight
        this.querySelectorAll('.tool-card, .func-card').forEach(el => {
            el.classList.remove('active');
        });
        // (Visual highlight logic omitted for brevity as it requires complex matching)
    }

    generateJsonFromSchema(schema) {
        if (!schema) return {};

        // Handle $ref - resolve the reference
        if (schema.$ref && schema.definitions) {
            const refName = schema.$ref.split('/').pop();
            if (refName && schema.definitions[refName]) {
                schema = schema.definitions[refName];
            }
        }

        // Handle JSON Schema structure (standard format)
        if (schema.type === 'object' && schema.properties) {
            return this.generateFromJsonSchema(schema);
        }

        // Handle MCP tools inputSchema
        if (schema.properties) {
            return this.generateFromJsonSchema(schema);
        }

        // Handle legacy Zod schema structure (shouldn't happen anymore)
        if (schema.shape) {
            return this.generateFromZodShape(schema.shape);
        }

        return {};
    }

    generateFromZodShape(shape) {
        const result = {};

        for (const [key, fieldSchema] of Object.entries(shape)) {
            result[key] = this.getPlaceholderValue(fieldSchema);
        }

        return result;
    }

    generateFromJsonSchema(schema) {
        const result = {};
        const properties = schema.properties || {};

        for (const [key, prop] of Object.entries(properties)) {
            result[key] = this.getJsonSchemaPlaceholder(prop);
        }

        return result;
    }

    getPlaceholderValue(fieldSchema) {
        if (!fieldSchema) return '';

        // Handle Zod schema with _def
        const def = fieldSchema._def;
        if (!def) return '';

        const typeName = def.typeName;

        // Handle optional/default values
        if (typeName === 'ZodOptional' || typeName === 'ZodDefault') {
            const innerDef = def.innerType?._def || def;
            if (def.defaultValue !== undefined) {
                return def.defaultValue();
            }
            return this.getPlaceholderValue({ _def: innerDef });
        }

        // Generate placeholder based on type
        switch (typeName) {
            case 'ZodString':
                return def.description || '';
            case 'ZodNumber':
                return 0;
            case 'ZodBoolean':
                return false;
            case 'ZodArray':
                return [];
            case 'ZodObject':
                if (def.shape) {
                    return this.generateFromZodShape(def.shape());
                }
                return {};
            case 'ZodEnum':
                const values = def.values;
                return values && values.length > 0 ? values[0] : '';
            default:
                return '';
        }
    }

    getJsonSchemaPlaceholder(prop) {
        // Handle default values first
        if (prop.default !== undefined) {
            return prop.default;
        }

        const type = prop.type;

        switch (type) {
            case 'string':
                if (prop.enum && prop.enum.length > 0) {
                    return prop.enum[0];
                }
                // Use description as hint if available
                if (prop.description) {
                    return `<${prop.description}>`;
                }
                return '';
            case 'number':
            case 'integer':
                return 0;
            case 'boolean':
                return false;
            case 'array':
                // If array has items schema, create one example item
                if (prop.items) {
                    const exampleItem = this.getJsonSchemaPlaceholder(prop.items);
                    return [exampleItem];
                }
                return [];
            case 'object':
                if (prop.properties) {
                    return this.generateFromJsonSchema(prop);
                }
                return {};
            default:
                return '';
        }
    }

    postRender() {
        const mcpBtn = this.querySelector('#mcpBtn');
        const funcBtn = this.querySelector('#funcBtn');

        mcpBtn.addEventListener('click', () => {
            this.source = 'mcp';
            mcpBtn.classList.add('active');
            funcBtn.classList.remove('active');
            this.querySelector('#executionArea').classList.add('hidden');
            this.loadContent();
        });

        funcBtn.addEventListener('click', () => {
            this.source = 'functions';
            funcBtn.classList.add('active');
            mcpBtn.classList.remove('active');
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
            outputEl.classList.add('text-red');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Executing...';
        outputArea.classList.remove('hidden');
        outputEl.textContent = 'Running...';
        outputEl.classList.remove('text-red');

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
            outputEl.classList.add('text-red');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Execute';
        }
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-6 view-panel">
                <div class="mcp-tabs">
                    <button id="mcpBtn" class="mcp-tab active">MCP Servers</button>
                    <button id="funcBtn" class="mcp-tab">Internal Functions</button>
                </div>

                <div id="listContainer"></div>

                <div id="executionArea" class="hidden border-t pt-4">
                    <div class="panel-dim mb-4">
                         <div class="font-medium text-accent" id="selectedName"></div>
                         <div class="text-xs text-muted mt-1" id="selectedDesc"></div>
                    </div>

                    <div class="mb-4">
                        <label class="block text-sm font-medium text-primary mb-2">Arguments (JSON)</label>
                        <textarea id="argsInput" rows="6" class="textarea font-mono text-sm"></textarea>
                    </div>

                    <button id="executeBtn" class="btn btn-accent">Execute</button>

                    <div id="outputArea" class="mt-4 hidden">
                        <label class="block text-sm font-medium text-primary mb-2">Output</label>
                        <div id="mcpOutput" class="llm-output"></div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('mcp-view', McpView);
