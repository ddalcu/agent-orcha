
import { Component } from '../utils/Component.js';
import { store } from '../store.js';

export class NavBar extends Component {
    constructor() {
        super();
        this.tabs = [
            { id: 'agents', label: 'Agents', icon: 'fa-robot' },
            { id: 'knowledge', label: 'Knowledge', icon: 'fa-brain' },
            { id: 'graph', label: 'Graph', icon: 'fa-network-wired' },
            { id: 'mcp', label: 'MCP', icon: 'fa-server' },
            { id: 'monitor', label: 'Monitor', icon: 'fa-tasks' },
            { id: 'llm', label: 'LLM', icon: 'fa-microchip' },
            { id: 'ide', label: 'IDE', icon: 'fa-code' }
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
                <div class="sidebar-brand">
                    <img src="/assets/logo.png" alt="Agent Orcha" class="sidebar-logo">
                    <span>Agent Orcha</span>
                </div>
                <nav class="flex-1 overflow-y-auto">
                    ${this.tabs.map(tab => `
                        <button class="tab-btn" data-tab="${tab.id}">
                            <i class="fas ${tab.icon} tab-icon"></i>
                            <span>${tab.label}</span>
                        </button>
                    `).join('')}
                </nav>
            </div>
        `;
    }
}

customElements.define('nav-bar', NavBar);
