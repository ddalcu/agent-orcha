
import { Component } from '../utils/Component.js';
import { store } from '../store.js';
import './NavBar.js';
import './AgentsView.js';
import './WorkflowsView.js';
import './KnowledgeView.js';
import './GraphView.js';
import './McpView.js';
import './SkillsView.js';
import './MonitorView.js';
import './IdeView.js';
import './LocalLlmView.js';

export class AppRoot extends Component {
    postRender() {
        this._checkAuth();

        window.addEventListener('auth:required', () => this._showLogin());

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

    async _checkAuth() {
        try {
            const res = await fetch('/api/auth/check');
            const data = await res.json();
            if (data.required && !data.authenticated) {
                this._showLogin();
            }
            if (data.required && data.authenticated) {
                this._showLogoutButton();
            }
            this._checkVnc();
            this._checkLlmConfig();
        } catch {
            // Server unreachable — will fail on actual API calls
        }
    }

    _showLogin() {
        if (this.querySelector('#auth-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'auth-overlay';
        overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70';
        overlay.innerHTML = `
            <div class="bg-[#1e1e2e] border border-[#313244] rounded-lg shadow-xl w-full max-w-sm mx-4 p-6">
                <h2 class="text-xl font-semibold text-gray-100 mb-4">
                    <i class="fas fa-lock mr-2 text-blue-400"></i>Authentication Required
                </h2>
                <div id="auth-error" class="hidden text-red-400 text-sm mb-3"></div>
                <input id="auth-password" type="password" placeholder="Password"
                    class="w-full bg-[#11111b] border border-[#313244] rounded px-3 py-2 text-gray-100
                           focus:outline-none focus:border-blue-500 mb-4" />
                <button id="auth-submit"
                    class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4
                           rounded transition-colors">
                    Sign In
                </button>
            </div>
        `;
        this.appendChild(overlay);

        const passwordInput = overlay.querySelector('#auth-password');
        const submitBtn = overlay.querySelector('#auth-submit');
        const errorDiv = overlay.querySelector('#auth-error');

        const submit = async () => {
            const password = passwordInput.value;
            if (!password) return;

            submitBtn.disabled = true;
            submitBtn.textContent = 'Signing in...';

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password }),
                });

                if (res.ok) {
                    this._hideLogin();
                    this._showLogoutButton();
                    this.switchTab(store.get('activeTab'));
                } else {
                    errorDiv.textContent = 'Invalid password';
                    errorDiv.classList.remove('hidden');
                    passwordInput.value = '';
                    passwordInput.focus();
                }
            } catch {
                errorDiv.textContent = 'Connection error';
                errorDiv.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Sign In';
            }
        };

        submitBtn.addEventListener('click', submit);
        passwordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
        });
        passwordInput.focus();
    }

    _hideLogin() {
        const overlay = this.querySelector('#auth-overlay');
        if (overlay) overlay.remove();
    }

    async _checkVnc() {
        try {
            const res = await fetch('/api/vnc/status');
            const data = await res.json();
            if (data.enabled) this._showVncButton();
        } catch { /* ignore */ }
    }

    _showVncButton() {
        if (this.querySelector('#vnc-desktop-btn')) return;
        const actions = this.querySelector('#header-actions');
        if (!actions) return;

        const btn = document.createElement('button');
        btn.id = 'vnc-desktop-btn';
        btn.className = 'text-gray-400 hover:text-white transition-colors';
        btn.title = 'View Browser Desktop';
        btn.innerHTML = '<i class="fas fa-desktop"></i>';
        btn.addEventListener('click', () => {
            window.open('/vnc', 'vnc-desktop', 'width=1300,height=760,menubar=no,toolbar=no');
        });
        actions.appendChild(btn);
    }

    _showLogoutButton() {
        if (this.querySelector('#auth-logout-btn')) return;
        const actions = this.querySelector('#header-actions');
        if (!actions) return;

        const btn = document.createElement('button');
        btn.id = 'auth-logout-btn';
        btn.className = 'text-gray-400 hover:text-white transition-colors';
        btn.title = 'Logout';
        btn.innerHTML = '<i class="fas fa-right-from-bracket"></i>';
        btn.addEventListener('click', async () => {
            await fetch('/api/auth/logout', { method: 'POST' });
            btn.remove();
            this._showLogin();
        });
        actions.appendChild(btn);
    }

    async _checkLlmConfig() {
        try {
            const res = await fetch('/api/llm/readiness');
            const data = await res.json();
            if (!data.ready) this._showLlmSetupModal(data.issues);
        } catch { /* ignore */ }
    }

    _showLlmSetupModal(issues) {
        if (this.querySelector('#llm-setup-overlay')) return;

        const issueList = (issues || [])
            .map(i => `<li class="flex items-start gap-2"><i class="fas fa-circle text-[5px] text-amber-400 mt-1.5 flex-shrink-0"></i><span>${i}</span></li>`)
            .join('');

        const overlay = document.createElement('div');
        overlay.id = 'llm-setup-overlay';
        overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70';
        overlay.innerHTML = `
            <div class="bg-[#1e1e2e] border border-[#313244] rounded-lg shadow-xl w-full max-w-md mx-4 p-8 text-center">
                <div class="w-14 h-14 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto mb-5">
                    <i class="fas fa-microchip text-2xl text-amber-400"></i>
                </div>
                <h2 class="text-xl font-semibold text-gray-100 mb-2">LLM Setup Required</h2>
                <p class="text-sm text-gray-400 mb-4">
                    Your models aren't ready yet. Head to the <strong class="text-gray-200">LLM</strong> tab to get started.
                </p>
                ${issueList ? `<ul class="text-xs text-gray-500 text-left space-y-1 mb-6 bg-[#11111b] rounded-lg p-3">${issueList}</ul>` : ''}
                <button id="llm-setup-go"
                    class="w-full bg-amber-600 hover:bg-amber-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors">
                    <i class="fas fa-arrow-right mr-2"></i>Go to LLM
                </button>
            </div>
        `;
        this.appendChild(overlay);

        overlay.querySelector('#llm-setup-go').addEventListener('click', () => {
            overlay.remove();
            store.set('activeTab', 'llm');
            window.location.hash = 'llm';
        });
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
            case 'graph': el = document.createElement('graph-view'); break;
            case 'mcp': el = document.createElement('mcp-view'); break;
            case 'skills': el = document.createElement('skills-view'); break;
            case 'monitor': el = document.createElement('monitor-view'); break;
            case 'llm': el = document.createElement('local-llm-view'); break;
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
                <div class="hidden sm:block mb-4 flex-shrink-0">
                    <div id="app-header" class="flex items-center justify-between">
                        <div>
                            <h1 class="text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                                Agent Orcha
                            </h1>
                        </div>
                        <div id="header-actions" class="flex items-center gap-3"></div>
                    </div>
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
