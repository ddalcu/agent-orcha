<script lang="ts">
  import { appStore } from '../../lib/stores/app.svelte.js';
  import { companyStore } from '../../lib/stores/company.svelte.js';
  import type { TabId } from '../../lib/types/index.js';

  interface Props {
    onselect?: () => void;
  }
  let { onselect }: Props = $props();

  const coreTabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'agents', label: 'Agents', icon: 'fa-robot' },
    { id: 'knowledge', label: 'Knowledge', icon: 'fa-brain' },
    { id: 'graph', label: 'Graph', icon: 'fa-network-wired' },
    { id: 'tools', label: 'Tools', icon: 'fa-wrench' },
    { id: 'monitor', label: 'Monitor', icon: 'fa-tasks' },
    { id: 'llm', label: 'LLM', icon: 'fa-microchip' },
    { id: 'ide', label: 'IDE', icon: 'fa-code' },
    { id: 'p2p', label: 'P2P', icon: 'fa-share-nodes' },
  ];

  const companyTabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'companies', label: 'Companies', icon: 'fa-building' },
    { id: 'tickets', label: 'Tickets', icon: 'fa-ticket' },
    { id: 'routines', label: 'Routines', icon: 'fa-clock-rotate-left' },
  ];

  let companyExpanded = $state(
    appStore.activeTab === 'companies' || appStore.activeTab === 'tickets' || appStore.activeTab === 'routines'
  );

  function selectTab(id: TabId) {
    appStore.setTab(id);
    onselect?.();
  }

  function toggleCompanySection() {
    companyExpanded = !companyExpanded;
  }

  function selectCompanyTab(id: TabId) {
    companyExpanded = true;
    selectTab(id);
  }

  const isCompanyTab = $derived(
    appStore.activeTab === 'companies' || appStore.activeTab === 'tickets' || appStore.activeTab === 'routines'
  );

  // Auto-expand when a company tab is active
  $effect(() => {
    if (isCompanyTab) companyExpanded = true;
  });
</script>

<div class="flex flex-col h-full flex-1 min-h-0">
  <div class="sidebar-brand">
    <img src="/assets/logo.png" alt="Agent Orcha" class="sidebar-logo">
    <span>Agent Orcha</span>
  </div>
  <nav class="flex-1 overflow-y-auto">
    {#each coreTabs as tab}
      <button
        class="tab-btn"
        class:active={appStore.activeTab === tab.id}
        onclick={() => selectTab(tab.id)}
      >
        <i class="fas {tab.icon} tab-icon"></i>
        <span>{tab.label}</span>
      </button>
    {/each}

    <div class="nav-separator"></div>

    <button
      class="tab-btn company-header"
      class:active={isCompanyTab}
      onclick={toggleCompanySection}
    >
      <i class="fas fa-building tab-icon"></i>
      <span>Company</span>
      <i class="fas fa-chevron-right company-chevron" class:expanded={companyExpanded}></i>
    </button>

    {#if companyExpanded}
      {#if companyStore.selectedCompany}
        <div class="company-badge">
          {#if companyStore.selectedCompany.brandColor}
            <span class="company-dot" style:background={companyStore.selectedCompany.brandColor}></span>
          {/if}
          <span class="company-name">{companyStore.selectedCompany.name}</span>
        </div>
      {/if}

      {#each companyTabs as tab}
        <button
          class="tab-btn sub-tab"
          class:active={appStore.activeTab === tab.id}
          onclick={() => selectCompanyTab(tab.id)}
        >
          <i class="fas {tab.icon} tab-icon"></i>
          <span>{tab.label}</span>
        </button>
      {/each}
    {/if}
  </nav>
</div>

<style>
  .nav-separator {
    height: 1px;
    background: var(--border);
    margin: 8px 12px;
  }
  .company-header {
    position: relative;
  }
  .company-chevron {
    margin-left: auto;
    font-size: 0.6rem;
    opacity: 0.5;
    transition: transform 0.15s ease;
  }
  .company-chevron.expanded {
    transform: rotate(90deg);
  }
  .sub-tab {
    padding-left: 2.2rem !important;
    font-size: 0.82rem;
  }
  .company-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 12px 2px 2.2rem;
    font-size: 0.72rem;
    color: var(--text-2);
    overflow: hidden;
  }
  .company-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .company-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
