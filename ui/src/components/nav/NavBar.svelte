<script lang="ts">
  import { onMount } from 'svelte';
  import { appStore } from '../../lib/stores/app.svelte.js';
  import { companyStore } from '../../lib/stores/company.svelte.js';
  import type { TabId, Company } from '../../lib/types/index.js';

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

  let expandedCompanyId = $state<string | null>(null);

  onMount(() => {
    companyStore.loadCompanies().then(() => {
      if (appStore.routeCompanyId) {
        expandedCompanyId = appStore.routeCompanyId;
        companyStore.selectCompanyById(appStore.routeCompanyId);
      }
    });
  });

  $effect(() => {
    const cid = appStore.routeCompanyId;
    if (cid && cid !== expandedCompanyId) {
      expandedCompanyId = cid;
      companyStore.selectCompanyById(cid);
    }
  });

  function selectTab(id: TabId) {
    appStore.setTab(id);
    onselect?.();
  }

  function toggleCompany(company: Company) {
    if (expandedCompanyId === company.id) {
      expandedCompanyId = null;
    } else {
      expandedCompanyId = company.id;
      companyStore.selectCompany(company);
      appStore.setTab('tickets', company.id);
      onselect?.();
    }
  }

  function goCompanyTab(tab: 'tickets' | 'routines', company: Company) {
    companyStore.selectCompany(company);
    appStore.setTab(tab, company.id);
    onselect?.();
  }

  function openManageCompanies() {
    appStore.setTab('companies');
    onselect?.();
  }

  function isActiveCompanyTab(tab: string, companyId: string): boolean {
    return appStore.activeTab === tab && appStore.routeCompanyId === companyId;
  }
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

    <div class="co-separator"></div>
    <div class="co-section-label">COMPANIES</div>

    {#each companyStore.companies.filter(c => c.status === 'active') as company}
      {@const isExpanded = expandedCompanyId === company.id}

      <button
        class="tab-btn co-row"
        class:co-expanded={isExpanded}
        onclick={() => toggleCompany(company)}
      >
        {#if company.brandColor}
          <span class="co-dot" style:background={company.brandColor}></span>
        {:else}
          <i class="fas fa-building tab-icon"></i>
        {/if}
        <span>{company.name}</span>
        <i class="fas fa-chevron-down co-chevron" class:expanded={isExpanded}></i>
      </button>

      {#if isExpanded}
        <div class="co-children">
          <div class="co-rail"></div>
          <div class="co-items">
            <button
              class="tab-btn co-child"
              class:active={isActiveCompanyTab('tickets', company.id)}
              onclick={() => goCompanyTab('tickets', company)}
            >
              <i class="fas fa-ticket tab-icon"></i>
              <span>Tickets</span>
              {#if companyStore.tickets.length > 0}
                <span class="co-count">{companyStore.tickets.length}</span>
              {/if}
            </button>
            <button
              class="tab-btn co-child"
              class:active={isActiveCompanyTab('routines', company.id)}
              onclick={() => goCompanyTab('routines', company)}
            >
              <i class="fas fa-clock-rotate-left tab-icon"></i>
              <span>Routines</span>
              {#if companyStore.routines.length > 0}
                <span class="co-count">{companyStore.routines.length}</span>
              {/if}
            </button>
          </div>
        </div>
      {/if}
    {/each}

    {#if companyStore.companies.filter(c => c.status === 'active').length === 0}
      <div class="co-empty">No companies yet</div>
    {/if}

    <button
      class="tab-btn co-manage"
      class:active={appStore.activeTab === 'companies'}
      onclick={openManageCompanies}
    >
      <i class="fas fa-gear tab-icon"></i>
      <span>Manage Companies</span>
    </button>
  </nav>
</div>

<style>
  /* ── Separator & label ── */
  .co-separator {
    height: 1px;
    background: var(--border-subtle);
    margin: 8px 12px;
  }
  .co-section-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: var(--text-3);
    padding: 4px 12px 6px;
    opacity: 0.7;
  }

  /* ── Company row: bold when expanded, no background ── */
  .co-row.co-expanded {
    color: var(--text-1);
    font-weight: 600;
    background: transparent;
  }

  /* ── Company dot (replaces icon) ── */
  .co-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    /* match .tab-icon width so text aligns */
    margin-left: 3px;
    margin-right: 3px;
  }

  /* ── Chevron ── */
  .co-chevron {
    margin-left: auto;
    font-size: 9px;
    opacity: 0.35;
    transition: transform 0.2s ease, opacity 0.2s ease;
  }
  .co-chevron.expanded {
    transform: rotate(180deg);
    opacity: 0.6;
  }
  .tab-btn:hover .co-chevron {
    opacity: 0.6;
  }

  /* ── Expanded children wrapper ── */
  .co-children {
    display: flex;
    padding-left: 18px;
    margin: 0 0 2px;
  }

  /* ── Vertical connector rail ── */
  .co-rail {
    width: 1px;
    background: var(--border);
    opacity: 0.5;
    margin: 2px 0;
    flex-shrink: 0;
    border-radius: 1px;
  }

  .co-items {
    flex: 1;
    min-width: 0;
    padding-left: 10px;
  }

  /* ── Child tab overrides ── */
  .co-child {
    font-size: 12.5px;
    padding-top: 5px;
    padding-bottom: 5px;
  }

  /* ── Count badge ── */
  .co-count {
    margin-left: auto;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-3);
    background: rgba(255, 255, 255, 0.06);
    min-width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 9px;
    padding: 0 5px;
  }

  /* ── Empty / Manage ── */
  .co-empty {
    font-size: 12px;
    color: var(--text-3);
    padding: 6px 12px;
    opacity: 0.5;
  }
  .co-manage {
    margin-top: 4px;
    opacity: 0.5;
    font-size: 12px;
  }
  .co-manage:hover {
    opacity: 0.85;
  }
</style>
