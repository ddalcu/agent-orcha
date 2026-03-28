<script lang="ts">
  import { appStore } from './lib/stores/app.svelte.js';
  import { api } from './lib/services/api.js';
  import NavBar from './components/nav/NavBar.svelte';
  import LogViewer from './pages/LogViewer.svelte';
  import AgentsPage from './pages/AgentsPage.svelte';
  import KnowledgePage from './pages/KnowledgePage.svelte';
  import GraphPage from './pages/GraphPage.svelte';
  import ToolsPage from './pages/ToolsPage.svelte';
  import MonitorPage from './pages/MonitorPage.svelte';
  import LocalLlmPage from './pages/LocalLlmPage.svelte';
  import IdePage from './pages/IdePage.svelte';
  import P2PPage from './pages/P2PPage.svelte';
  import CompaniesPage from './pages/CompaniesPage.svelte';
  import TicketsPage from './pages/TicketsPage.svelte';
  import RoutinesPage from './pages/RoutinesPage.svelte';

  let showLogin = $state(false);
  let showLogout = $state(false);
  let vncUrl = $state<string | null>(null);
  let sandboxStatus = $state<string>('idle');
  let sandboxError = $state<string | null>(null);
  let version = $state('AgentOrcha');
  let loginError = $state('');
  let loginPassword = $state('');
  let loginSubmitting = $state(false);
  let sidebarOpen = $state(false);
  let llmSetupIssues = $state<string[] | null>(null);
  let vncPollTimer = $state<ReturnType<typeof setInterval> | null>(null);

  $effect(() => {
    checkAuth();
    loadVersion();
    window.addEventListener('auth:required', () => { showLogin = true; });
  });

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/check');
      const data = await res.json();
      if (data.required && !data.authenticated) showLogin = true;
      if (data.required && data.authenticated) showLogout = true;
      checkVnc();
      checkLlmConfig();
    } catch { /* ignore */ }
  }

  async function checkVnc() {
    try {
      const res = await fetch('/api/vnc/status');
      const data = await res.json();
      if (data.enabled) vncUrl = data.url || '/vnc';
      else vncUrl = null;

      if (data.sandbox) {
        sandboxStatus = data.sandbox.status;
        sandboxError = data.sandbox.error;
      }

      // Poll while sandbox is still starting up
      const isStarting = sandboxStatus === 'idle' || sandboxStatus === 'detecting' || sandboxStatus === 'pulling' || sandboxStatus === 'starting';
      if (isStarting && !vncPollTimer) {
        vncPollTimer = setInterval(checkVnc, 3000);
      } else if (!isStarting && vncPollTimer) {
        clearInterval(vncPollTimer);
        vncPollTimer = null;
      }
    } catch { /* ignore */ }
  }

  async function checkLlmConfig() {
    try {
      const res = await fetch('/api/llm/readiness');
      const data = await res.json();
      if (!data.ready) llmSetupIssues = data.issues || [];
    } catch { /* ignore */ }
  }

  async function loadVersion() {
    try {
      const res = await fetch('/health');
      const data = await res.json();
      if (data.version) version = `AgentOrcha v${data.version}`;
    } catch { /* ignore */ }
  }

  async function handleLogin() {
    if (!loginPassword) return;
    loginSubmitting = true;
    loginError = '';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword }),
      });
      if (res.ok) {
        showLogin = false;
        showLogout = true;
      } else {
        loginError = 'Invalid password';
        loginPassword = '';
      }
    } catch {
      loginError = 'Connection error';
    } finally {
      loginSubmitting = false;
    }
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    showLogout = false;
    showLogin = true;
  }

  function openVnc() {
    window.open(vncUrl || '/vnc', 'vnc-desktop', 'width=1300,height=760,menubar=no,toolbar=no');
  }

  function goToLlm() {
    llmSetupIssues = null;
    appStore.setTab('llm');
  }

  function toggleSidebar(forceClose = false) {
    sidebarOpen = forceClose ? false : !sidebarOpen;
  }
</script>

<div class="app-shell">
  <div
    id="sidebar-backdrop"
    class:open={sidebarOpen}
    onclick={() => toggleSidebar(true)}
    role="presentation"
  ></div>

  <div id="app-sidebar" class:open={sidebarOpen}>
    <NavBar onselect={() => toggleSidebar(true)} />
    <div class="sidebar-footer">
      <div id="header-actions" class="flex items-center gap-2">
        {#if sandboxStatus !== 'no-docker'}
          <button
            class="btn-ghost sandbox-btn"
            class:sandbox-starting={sandboxStatus === 'idle' || sandboxStatus === 'detecting' || sandboxStatus === 'pulling' || sandboxStatus === 'starting'}
            class:sandbox-running={sandboxStatus === 'running'}
            class:sandbox-failed={sandboxStatus === 'failed'}
            title={sandboxStatus === 'running' ? 'View Browser Desktop' : sandboxStatus === 'failed' ? `Sandbox failed: ${sandboxError || 'unknown error'}` : `Sandbox: ${sandboxStatus}...`}
            onclick={openVnc}
            disabled={sandboxStatus !== 'running'}
          >
            <i class="fas fa-desktop"></i>
          </button>
        {/if}
        {#if showLogout}
          <button class="btn-ghost" title="Logout" onclick={handleLogout}>
            <i class="fas fa-right-from-bracket"></i>
          </button>
        {/if}
      </div>
      <span id="app-version">{version}</span>
    </div>
  </div>

  <main class="app-main">
    <div class="app-mobile-header">
      <button class="btn-ghost" aria-label="Toggle sidebar" onclick={() => toggleSidebar()}>
        <i class="fas fa-bars text-lg"></i>
      </button>
      <img src="/assets/logo.png" alt="Agent Orcha" class="mobile-logo">
      <span class="text-sm font-semibold text-primary ml-2">Agent Orcha</span>
    </div>

    <div class="app-content">
      {#if appStore.activeTab === 'agents'}
        <AgentsPage />
      {:else if appStore.activeTab === 'knowledge'}
        <KnowledgePage />
      {:else if appStore.activeTab === 'graph'}
        <GraphPage />
      {:else if appStore.activeTab === 'tools'}
        <ToolsPage />
      {:else if appStore.activeTab === 'monitor'}
        <MonitorPage />
      {:else if appStore.activeTab === 'llm'}
        <LocalLlmPage />
      {:else if appStore.activeTab === 'ide'}
        <IdePage />
      {:else if appStore.activeTab === 'p2p'}
        <P2PPage />
      {:else if appStore.activeTab === 'companies'}
        <CompaniesPage />
      {:else if appStore.activeTab === 'tickets'}
        <TicketsPage />
      {:else if appStore.activeTab === 'routines'}
        <RoutinesPage />
      {/if}
    </div>

    <LogViewer />
  </main>
</div>

{#if showLogin}
  <div class="auth-overlay">
    <div class="auth-card">
      <h2><i class="fas fa-lock text-accent"></i> Authentication Required</h2>
      {#if loginError}
        <div class="auth-error visible">{loginError}</div>
      {/if}
      <input
        type="password"
        placeholder="Password"
        class="input"
        bind:value={loginPassword}
        onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && handleLogin()}
      />
      <button class="btn btn-accent w-full mt-3" onclick={handleLogin} disabled={loginSubmitting}>
        {loginSubmitting ? 'Signing in...' : 'Sign In'}
      </button>
    </div>
  </div>
{/if}

{#if llmSetupIssues}
  <div class="auth-overlay">
    <div class="llm-setup-modal">
      <div class="llm-setup-icon">
        <i class="fas fa-microchip text-2xl text-accent"></i>
      </div>
      <h2 class="text-xl font-semibold text-primary mb-2">LLM Setup Required</h2>
      <p class="text-sm text-secondary mb-4">
        Your models aren't ready yet. Head to the <strong class="text-primary">LLM</strong> tab to get started.
      </p>
      {#if llmSetupIssues.length > 0}
        <ul class="text-xs text-muted text-left space-y-1 panel-sm mb-6">
          {#each llmSetupIssues as issue}
            <li class="flex items-start gap-2">
              <i class="fas fa-circle text-2xs text-accent flex-shrink-0 mt-1"></i>
              <span>{issue}</span>
            </li>
          {/each}
        </ul>
      {/if}
      <button class="btn btn-accent w-full" onclick={goToLlm}>
        <i class="fas fa-arrow-right"></i> Go to LLM
      </button>
    </div>
  </div>
{/if}

<style>
  .sandbox-btn {
    position: relative;
  }
  .sandbox-btn.sandbox-starting {
    opacity: 0.5;
    animation: sandbox-pulse 1.5s ease-in-out infinite;
  }
  .sandbox-btn.sandbox-running {
    color: var(--green, #22c55e);
  }
  .sandbox-btn.sandbox-failed {
    color: var(--red, #ef4444);
    opacity: 0.7;
  }
  @keyframes sandbox-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.8; }
  }
</style>
