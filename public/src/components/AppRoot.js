
import { Component } from '../utils/Component.js';
import { store } from '../store.js';
import './NavBar.js';
import './AgentsView.js';
import './WorkflowsView.js';
import './KnowledgeView.js';
import './McpView.js';
import './IdeView.js';

export class AppRoot extends Component {
    postRender() {
        store.addEventListener('state-change', (e) => {
            if (e.detail.key === 'activeTab') {
                this.switchTab(e.detail.value);
            }
        });

        // Handle browser back/forward
        window.addEventListener('hashchange', () => {
            const hash = window.location.hash.replace('#', '');
            if (hash && hash !== store.get('activeTab')) {
                store.set('activeTab', hash);
            }
        });

        // Initial tab from hash or default
        const initialTab = store.get('activeTab');
        if (!window.location.hash) {
            window.location.hash = initialTab;
        }
        this.switchTab(initialTab);
    }

    switchTab(tabId) {
        const container = this.querySelector('#tabContent');
        if (!container) return;

        container.innerHTML = '';
        let el;
        switch (tabId) {
            case 'agents': el = document.createElement('agents-view'); break;
            case 'workflows': el = document.createElement('workflows-view'); break;
            case 'knowledge': el = document.createElement('knowledge-view'); break;
            case 'mcp': el = document.createElement('mcp-view'); break;
            case 'ide': el = document.createElement('ide-view'); break;
            default: el = document.createElement('agents-view'); break;
        }

        // Preserve state or re-render? Web Components are cheap to re-create usually,
        // but for chat history we might want to keep it in store (which we do).
        // If we wanted to keep DOM alive we'd hide/show, but replacing is cleaner for now.
        container.appendChild(el);
    }

    template() {
        return `
            <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 h-screen flex flex-col">
                <div class="mb-4 flex-shrink-0">
                    <h1 class="text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                        Agent Orcha
                    </h1>
                    <p class="text-gray-400 mt-2">Declare the system. Orcha handles the REST.</p>
                </div>

                <nav-bar class="flex-shrink-0"></nav-bar>

                <div id="tabContent" class="flex-1 min-h-0 relative">
                    <!-- Dynamic Content -->
                </div>
            </div>
        `;
    }
}

customElements.define('app-root', AppRoot);
