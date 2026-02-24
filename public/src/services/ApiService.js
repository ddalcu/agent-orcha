
export class ApiService {
    async _fetch(url, options = {}) {
        const res = await fetch(url, options);
        if (res.status === 401) {
            window.dispatchEvent(new CustomEvent('auth:required'));
            throw new Error('Unauthorized');
        }
        return res;
    }

    async getAgents() {
        const res = await this._fetch('/api/agents');
        return res.json();
    }

    async invokeAgent(name, input, sessionId) {
        // Kept for backward compatibility if needed, but UI now uses stream
        const res = await this._fetch(`/api/agents/${name}/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input, sessionId })
        });
        return res.json();
    }

    async streamAgent(name, input, sessionId, { signal } = {}) {
        return this._fetch(`/api/agents/${name}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input, sessionId }),
            signal
        });
    }

    async getWorkflows() {
        const res = await this._fetch('/api/workflows');
        return res.json();
    }

    async getWorkflow(name) {
        const res = await this._fetch(`/api/workflows/${name}`);
        return res.json();
    }

    async startWorkflowStream(name, input) {
        return this._fetch(`/api/workflows/${name}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input })
        });
    }

    async getKnowledgeStores() {
        const res = await this._fetch('/api/knowledge');
        return res.json();
    }

    async getKnowledgeStore(name) {
        const res = await this._fetch(`/api/knowledge/${name}`);
        return res.json();
    }

    async searchKnowledgeStore(name, query, k) {
        const res = await this._fetch(`/api/knowledge/${name}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, k })
        });
        return res.json();
    }

    async getKnowledgeStatus(name) {
        const res = await this._fetch(`/api/knowledge/${name}/status`);
        return res.json();
    }

    async indexKnowledgeStore(name) {
        const res = await this._fetch(`/api/knowledge/${name}/index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        return res.json();
    }

    indexKnowledgeStoreStream(name) {
        return new EventSource(`/api/knowledge/${name}/index/stream`);
    }

    async getLLMs() {
        const res = await this._fetch('/api/llm');
        return res.json();
    }

    async chatLLM(name, message) {
        const res = await this._fetch(`/api/llm/${name}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        return res.json();
    }

    async streamLLM(name, message, { signal } = {}) {
        return this._fetch(`/api/llm/${name}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
            signal
        });
    }

    async getMCPServers() {
        const res = await this._fetch('/api/mcp');
        return res.json();
    }

    async getMCPTools(serverName) {
        const res = await this._fetch(`/api/mcp/${serverName}/tools`);
        return res.json();
    }

    async executeMcpTool(serverName, toolName, args) {
        const res = await this._fetch(`/api/mcp/${serverName}/call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: toolName, arguments: args })
        });
        return res.json();
    }

    async getFunctions() {
        const res = await this._fetch('/api/functions');
        return res.json();
    }

    async getFunction(name) {
        const res = await this._fetch(`/api/functions/${name}`);
        return res.json();
    }

    async executeFunction(name, args) {
        const res = await this._fetch(`/api/functions/${name}/call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ arguments: args })
        });
        return res.json();
    }
    async getSkills() {
        const res = await this._fetch('/api/skills');
        return res.json();
    }

    async getSkill(name) {
        const res = await this._fetch(`/api/skills/${encodeURIComponent(name)}`);
        return res.json();
    }

    async getFileTree() {
        const res = await this._fetch('/api/files/tree');
        return res.json();
    }

    async readFile(filePath) {
        const res = await this._fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
        return res.json();
    }

    async writeFile(filePath, content) {
        const res = await this._fetch('/api/files/write', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, content })
        });
        return res.json();
    }

    async getResourceTemplate(type, name) {
        const res = await this._fetch(`/api/files/template?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`);
        return res.json();
    }

    async createFile(filePath, content = '') {
        const res = await this._fetch('/api/files/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, content })
        });
        return res.json();
    }

    async renameFile(oldPath, newPath) {
        const res = await this._fetch('/api/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPath, newPath })
        });
        return res.json();
    }

    async deleteFile(filePath) {
        const res = await this._fetch('/api/files/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath })
        });
        return res.json();
    }

    async getTasks(queryString = '') {
        const url = queryString ? `/api/tasks?${queryString}` : '/api/tasks';
        const res = await this._fetch(url);
        return res.json();
    }

    async getTask(id) {
        const res = await this._fetch(`/api/tasks/${id}`);
        return res.json();
    }

    async submitAgentTask(agent, input, sessionId) {
        const res = await this._fetch('/api/tasks/agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent, input, sessionId })
        });
        return res.json();
    }

    async submitWorkflowTask(workflow, input) {
        const res = await this._fetch('/api/tasks/workflow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflow, input })
        });
        return res.json();
    }

    async cancelTask(id) {
        const res = await this._fetch(`/api/tasks/${id}/cancel`, {
            method: 'POST'
        });
        return res.json();
    }

    async respondToTask(id, response) {
        const res = await this._fetch(`/api/tasks/${id}/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response })
        });
        return res.json();
    }

    streamTask(id) {
        return new EventSource(`/api/tasks/${id}/stream`);
    }

    async getGraphConfig() {
        const res = await this._fetch('/api/graph/config');
        return res.json();
    }

    async getGraphKnowledgeBases() {
        const res = await this._fetch('/api/graph/knowledge-bases');
        return res.json();
    }

    async getGraphFull(limit = 300) {
        const res = await this._fetch(`/api/graph/full?limit=${limit}`);
        return res.json();
    }

    async getGraphNeighbors(nodeId, depth = 1) {
        const res = await this._fetch(`/api/graph/neighbors/${encodeURIComponent(nodeId)}?depth=${depth}`);
        return res.json();
    }
}

export const api = new ApiService();
