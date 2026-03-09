
import { Component } from '../utils/Component.js';
import { store } from '../store.js';

export class NavBar extends Component {
    constructor() {
        super();
        this.tabs = [
            { id: 'agents', label: 'Agents', icon: 'fa-robot', color: 'blue' },
            { id: 'workflows', label: 'Workflows', icon: 'fa-project-diagram', color: 'purple' },
            { id: 'knowledge', label: 'Knowledge', icon: 'fa-brain', color: 'orange' },
            { id: 'graph', label: 'Graph', icon: 'fa-network-wired', color: 'pink' },
            { id: 'mcp', label: 'MCP', icon: 'fa-server', color: 'cyan' },
            { id: 'monitor', label: 'Monitor', icon: 'fa-tasks', color: 'indigo' },
            { id: 'llm', label: 'LLM', icon: 'fa-microchip', color: 'amber' },
            { id: 'ide', label: 'IDE', icon: 'fa-code', color: 'green' }
        ];
    }

    postRender() {
        this.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tabId = e.currentTarget.dataset.tab;
                window.location.hash = tabId;
                store.set('activeTab', tabId);
                this.updateActiveState(tabId);
            });
        });

        store.addEventListener('state-change', (e) => {
            if (e.detail.key === 'activeTab') {
                this.updateActiveState(e.detail.value);
            }
        });

        this.updateActiveState(store.get('activeTab'));
    }

    updateActiveState(activeId) {
        this.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === activeId);
        });
    }

    template() {
        return `
            <div class="flex flex-col h-full">
                <div class="sidebar-brand px-3 py-4">
                    <span class="text-sm font-semibold text-gray-200 tracking-wide">Agent Orcha</span>
                </div>
                <nav class="flex-1 overflow-y-auto py-1">
                    ${this.tabs.map(tab => `
                        <button class="tab-btn group flex items-center gap-2.5 w-full px-3 py-2 text-xs font-medium transition-all duration-200"
                            data-tab="${tab.id}" data-color="${tab.color}">
                            <i class="fas ${tab.icon} text-xs w-4 text-center transition-transform group-hover:scale-110"></i>
                            <span>${tab.label}</span>
                        </button>
                    `).join('')}
                </nav>
            </div>
        `;
    }
}

customElements.define('nav-bar', NavBar);
