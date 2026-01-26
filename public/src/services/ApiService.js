
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

    async getVectorStores() {
        const res = await fetch('/api/vectors');
        return res.json();
    }

    async getVectorStore(name) {
        const res = await fetch(`/api/vectors/${name}`);
        return res.json();
    }

    async searchVectorStore(name, query, k) {
        const res = await fetch(`/api/vectors/${name}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, k })
        });
        return res.json();
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
}

export const api = new ApiService();
