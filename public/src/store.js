
class Store extends EventTarget {
    constructor() {
        super();
        this.data = {
            activeTab: 'agents',
            agents: [],
            selectedAgent: null,
            chatHistory: [],
            sessionId: 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9),
            workflows: [],
            vectorStores: [],
            llms: [],
            mcpServers: [],
            functions: []
        };
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        this.data[key] = value;
        this.dispatchEvent(new CustomEvent('state-change', { detail: { key, value } }));
    }

    // Helper to update partial state
    update(updates) {
        Object.entries(updates).forEach(([key, value]) => {
            this.data[key] = value;
            this.dispatchEvent(new CustomEvent('state-change', { detail: { key, value } }));
        });
    }
}

export const store = new Store();
