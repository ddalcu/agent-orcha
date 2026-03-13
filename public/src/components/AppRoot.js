
import { Component } from '../utils/Component.js';
import { store } from '../store.js';
import './NavBar.js';
import './AgentsView.js';
import './KnowledgeView.js';
import './GraphView.js';
import './McpView.js';
import './MonitorView.js';
import './IdeView.js';
import './LocalLlmView.js';
import './LogViewer.js';

export class AppRoot extends Component {
    postRender() {
        this._checkAuth();
        this._loadVersion();

        window.addEventListener('auth:required', () => this._showLogin());

        this.querySelector('#hamburger-btn').addEventListener('click', () => this._toggleSidebar());
        this.querySelector('#sidebar-backdrop').addEventListener('click', () => this._toggleSidebar(true));

        store.addEventListener('state-change', (e) => {
            if (e.detail.key === 'activeTab') {
                this.switchTab(e.detail.value);
                this._toggleSidebar(true);
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
        overlay.className = 'auth-overlay';
        overlay.innerHTML = `
            <div class="auth-card">
                <h2><i class="fas fa-lock text-accent"></i> Authentication Required</h2>
                <div id="auth-error" class="auth-error"></div>
                <input id="auth-password" type="password" placeholder="Password" class="input" />
                <button id="auth-submit" class="btn btn-accent w-full">Sign In</button>
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
                    errorDiv.classList.add('visible');
                    passwordInput.value = '';
                    passwordInput.focus();
                }
            } catch {
                errorDiv.textContent = 'Connection error';
                errorDiv.classList.add('visible');
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
            if (data.enabled) this._showVncButton(data.url);
        } catch { /* ignore */ }
    }

    _showVncButton(vncUrl) {
        if (this.querySelector('#vnc-desktop-btn')) return;
        const actions = this.querySelector('#header-actions');
        if (!actions) return;

        const targetUrl = vncUrl || '/vnc';
        const btn = document.createElement('button');
        btn.id = 'vnc-desktop-btn';
        btn.className = 'btn-ghost';
        btn.title = 'View Browser Desktop';
        btn.innerHTML = '<i class="fas fa-desktop"></i>';
        btn.addEventListener('click', () => {
            window.open(targetUrl, 'vnc-desktop', 'width=1300,height=760,menubar=no,toolbar=no');
        });
        actions.appendChild(btn);
    }

    _showLogoutButton() {
        if (this.querySelector('#auth-logout-btn')) return;
        const actions = this.querySelector('#header-actions');
        if (!actions) return;

        const btn = document.createElement('button');
        btn.id = 'auth-logout-btn';
        btn.className = 'btn-ghost';
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
            .map(i => `<li class="flex items-start gap-2"><i class="fas fa-circle text-2xs text-accent flex-shrink-0 mt-1"></i><span>${i}</span></li>`)
            .join('');

        const overlay = document.createElement('div');
        overlay.id = 'llm-setup-overlay';
        overlay.className = 'auth-overlay';
        overlay.innerHTML = `
            <div class="llm-setup-modal">
                <div class="llm-setup-icon">
                    <i class="fas fa-microchip text-2xl text-accent"></i>
                </div>
                <h2 class="text-xl font-semibold text-primary mb-2">LLM Setup Required</h2>
                <p class="text-sm text-secondary mb-4">
                    Your models aren't ready yet. Head to the <strong class="text-primary">LLM</strong> tab to get started.
                </p>
                ${issueList ? `<ul class="text-xs text-muted text-left space-y-1 panel-sm mb-6">${issueList}</ul>` : ''}
                <button id="llm-setup-go" class="btn btn-accent w-full">
                    <i class="fas fa-arrow-right"></i> Go to LLM
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

    async _loadVersion() {
        try {
            const res = await fetch('/health');
            const data = await res.json();
            const el = this.querySelector('#app-version');
            if (el && data.version) el.textContent = `AgentOrcha v${data.version}`;
        } catch { /* ignore */ }
    }

    switchTab(tabId) {
        const container = this.querySelector('#tabContent');
        if (!container) return;

        container.innerHTML = '';
        let el;
        switch (tabId) {
            case 'agents': el = document.createElement('agents-view'); break;
            case 'knowledge': el = document.createElement('knowledge-view'); break;
            case 'graph': el = document.createElement('graph-view'); break;
            case 'mcp': el = document.createElement('mcp-view'); break;
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

    _toggleSidebar(forceClose) {
        const sidebar = this.querySelector('#app-sidebar');
        const backdrop = this.querySelector('#sidebar-backdrop');
        const open = forceClose ? false : !sidebar.classList.contains('open');
        sidebar.classList.toggle('open', open);
        backdrop.classList.toggle('open', open);
    }

    template() {
        return `
            <div class="app-shell">
                <div id="sidebar-backdrop"></div>
                <div id="app-sidebar">
                    <nav-bar class="flex-1 min-h-0"></nav-bar>
                    <div class="sidebar-footer">
                        <div id="header-actions" class="flex items-center gap-2"></div>
                        <span id="app-version">AgentOrcha</span>
                    </div>
                </div>
                <div class="app-main">
                    <div class="app-mobile-header">
                        <button id="hamburger-btn" class="btn-ghost">
                            <i class="fas fa-bars text-lg"></i>
                        </button>
                        <img src="/assets/logo.png" alt="Agent Orcha" class="mobile-logo">
                        <span class="text-sm font-semibold text-primary ml-2">Agent Orcha</span>
                    </div>
                    <div id="tabContent" class="app-content">
                        <!-- Dynamic Content -->
                    </div>
                    <log-viewer class="flex-shrink-0"></log-viewer>
                </div>
            </div>
        `;
    }
}

customElements.define('app-root', AppRoot);
