
export class ApiService {
    async getAgents() {
        const res = await fetch('/api/agents');
        return res.json();
    }

    async invokeAgent(name, input, sessionId) {
        // Kept for backward compatibility if needed, but UI now uses stream
        const res = await fetch(`/api/agents/${name}/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input, sessionId })
        });
        return res.json();
    }

    async streamAgent(name, input, sessionId) {
        return fetch(`/api/agents/${name}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input, sessionId })
        });
    }

    async getWorkflows() {
        const res = await fetch('/api/workflows');
        return res.json();
    }

    async getWorkflow(name) {
        const res = await fetch(`/api/workflows/${name}`);
        return res.json();
    }

    async startWorkflowStream(name, input) {
        return fetch(`/api/workflows/${name}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input })
        });
    }

    async getKnowledgeStores() {
        const res = await fetch('/api/knowledge');
        return res.json();
    }

    async getKnowledgeStore(name) {
        const res = await fetch(`/api/knowledge/${name}`);
        return res.json();
    }

    async searchKnowledgeStore(name, query, k) {
        const res = await fetch(`/api/knowledge/${name}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, k })
        });
        return res.json();
    }

    async getKnowledgeStatus(name) {
        const res = await fetch(`/api/knowledge/${name}/status`);
        return res.json();
    }

    async indexKnowledgeStore(name) {
        const res = await fetch(`/api/knowledge/${name}/index`, {
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
        const res = await fetch('/api/llm');
        return res.json();
    }

    async chatLLM(name, message) {
        const res = await fetch(`/api/llm/${name}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        return res.json();
    }

    async streamLLM(name, message) {
        return fetch(`/api/llm/${name}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
    }

    async getMCPServers() {
        const res = await fetch('/api/mcp');
        return res.json();
    }

    async getMCPTools(serverName) {
        const res = await fetch(`/api/mcp/${serverName}/tools`);
        return res.json();
    }

    async executeMcpTool(serverName, toolName, args) {
        const res = await fetch(`/api/mcp/${serverName}/call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: toolName, arguments: args })
        });
        return res.json();
    }

    async getFunctions() {
        const res = await fetch('/api/functions');
        return res.json();
    }

    async getFunction(name) {
        const res = await fetch(`/api/functions/${name}`);
        return res.json();
    }

    async executeFunction(name, args) {
        const res = await fetch(`/api/functions/${name}/call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ arguments: args })
        });
        return res.json();
    }
    async getFileTree() {
        const res = await fetch('/api/files/tree');
        return res.json();
    }

    async readFile(filePath) {
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
        return res.json();
    }

    async writeFile(filePath, content) {
        const res = await fetch('/api/files/write', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, content })
        });
        return res.json();
    }

    async getNeo4jConfig() {
        const res = await fetch('/api/graph/config');
        return res.json();
    }

    async getGraphData(cypherQuery) {
        const res = await fetch('/api/graph/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: cypherQuery })
        });
        return res.json();
    }
}

export const api = new ApiService();
