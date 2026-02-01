
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

        // Sync visual state when tab changes externally (browser back/forward)
        store.addEventListener('state-change', (e) => {
            if (e.detail.key === 'activeTab') {
                this.updateActiveState(e.detail.value);
            }
        });

        // Initialize state
        this.updateActiveState(store.get('activeTab'));
    }

    updateActiveState(activeId) {
        this.querySelectorAll('.tab-btn').forEach(btn => {
            const tabId = btn.dataset.tab;
            const color = btn.dataset.color;
            const isActive = tabId === activeId;

            if (isActive) {
                btn.classList.add(`border-${color}-500`, `text-${color}-400`);
                btn.classList.remove('border-transparent', 'text-gray-400', 'hover:text-gray-300');
            } else {
                btn.classList.remove(`border-${color}-500`, `text-${color}-400`);
                btn.classList.add('border-transparent', 'text-gray-400', 'hover:text-gray-300');
            }
        });
    }

    template() {
        return `
            <div class="border-b border-dark-border mb-6">
                <nav class="flex space-x-8 overflow-x-auto">
                    ${this.tabs.map(tab => `
                        <button class="tab-btn group flex items-center gap-2 border-b-2 border-transparent text-gray-400 hover:text-gray-300 pb-3 px-1 font-medium transition-colors"
                            data-tab="${tab.id}" data-color="${tab.color}">
                            <i class="fas ${tab.icon} text-sm group-hover:scale-110 transition-transform"></i>
                            <span>${tab.label}</span>
                        </button>
                    `).join('')}
                </nav>
            </div>
        `;
    }
}

customElements.define('nav-bar', NavBar);
