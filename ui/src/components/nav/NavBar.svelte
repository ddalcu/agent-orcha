<script lang="ts">
  import { onMount } from "svelte";
  import { appStore } from "../../lib/stores/app.svelte.js";
  import { orgStore } from "../../lib/stores/org.svelte.js";
  import type { TabId, Organization } from "../../lib/types/index.js";

  interface Props {
    onselect?: () => void;
  }
  let { onselect }: Props = $props();

  const coreTabs: { id: TabId; label: string; icon: string }[] = [
    { id: "agents", label: "Agents", icon: "fa-robot" },
    { id: "knowledge", label: "Knowledge", icon: "fa-brain" },
    { id: "graph", label: "Graph", icon: "fa-network-wired" },
    { id: "tools", label: "Tools", icon: "fa-wrench" },
    { id: "monitor", label: "Monitor", icon: "fa-tasks" },
    { id: "llm", label: "LLM", icon: "fa-microchip" },
    { id: "ide", label: "IDE", icon: "fa-code" },
    { id: "p2p", label: "P2P", icon: "fa-share-nodes" },
  ];

  let expandedOrgId = $state<string | null>(null);

  onMount(() => {
    orgStore.loadOrgs().then(() => {
      if (appStore.routeOrgId) {
        expandedOrgId = appStore.routeOrgId;
        orgStore.selectOrgById(appStore.routeOrgId);
      }
    });
  });

  $effect(() => {
    const oid = appStore.routeOrgId;
    if (oid && oid !== expandedOrgId) {
      expandedOrgId = oid;
      orgStore.selectOrgById(oid);
    }
  });

  function selectTab(id: TabId) {
    appStore.setTab(id);
    onselect?.();
  }

  function toggleOrg(org: Organization) {
    if (expandedOrgId === org.id) {
      expandedOrgId = null;
    } else {
      expandedOrgId = org.id;
      orgStore.selectOrg(org);
      appStore.setTab("dashboard", org.id);
      onselect?.();
    }
  }

  function goOrgTab(
    tab: "dashboard" | "tickets" | "routines" | "orgchart",
    org: Organization,
  ) {
    orgStore.selectOrg(org);
    appStore.setTab(tab, org.id);
    onselect?.();
  }

  function openManageOrgs() {
    appStore.setTab("organizations");
    onselect?.();
  }

  function isActiveOrgTab(tab: string, orgId: string): boolean {
    return appStore.activeTab === tab && appStore.routeOrgId === orgId;
  }
</script>

<div class="flex flex-col h-full flex-1 min-h-0">
  <div class="sidebar-brand">
    <img src="/assets/logo.png" alt="Agent Orcha" class="sidebar-logo" />
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
    <div class="co-section-label">ORGANIZATIONS</div>

    {#each orgStore.organizations.filter((o) => o.status === "active") as org}
      {@const isExpanded = expandedOrgId === org.id}

      <button
        class="tab-btn co-row"
        class:co-expanded={isExpanded}
        onclick={() => toggleOrg(org)}
      >
        {#if org.brandColor}
          <span class="co-dot" style:background={org.brandColor}></span>
        {:else}
          <i class="fas fa-building tab-icon"></i>
        {/if}
        <span>{org.name}</span>
        <i class="fas fa-chevron-down co-chevron" class:expanded={isExpanded}
        ></i>
      </button>

      {#if isExpanded}
        <div class="co-children">
          <div class="co-rail"></div>
          <div class="co-items">
            <button
              class="tab-btn co-child"
              class:active={isActiveOrgTab("dashboard", org.id)}
              onclick={() => goOrgTab("dashboard", org)}
            >
              <i class="fas fa-chart-line tab-icon"></i>
              <span>Dashboard</span>
            </button>
            <button
              class="tab-btn co-child"
              class:active={isActiveOrgTab("tickets", org.id)}
              onclick={() => goOrgTab("tickets", org)}
            >
              <i class="fas fa-ticket tab-icon"></i>
              <span>Tickets</span>
              {#if orgStore.tickets.length > 0}
                <span class="co-count">{orgStore.tickets.length}</span>
              {/if}
            </button>
            <button
              class="tab-btn co-child"
              class:active={isActiveOrgTab("routines", org.id)}
              onclick={() => goOrgTab("routines", org)}
            >
              <i class="fas fa-clock-rotate-left tab-icon"></i>
              <span>Routines</span>
              {#if orgStore.routines.length > 0}
                <span class="co-count">{orgStore.routines.length}</span>
              {/if}
            </button>
            <button
              class="tab-btn co-child"
              class:active={isActiveOrgTab("orgchart", org.id)}
              onclick={() => goOrgTab("orgchart", org)}
            >
              <i class="fas fa-sitemap tab-icon"></i>
              <span>Org Chart</span>
              {#if orgStore.members.length > 0}
                <span class="co-count">{orgStore.members.length}</span>
              {/if}
            </button>
          </div>
        </div>
      {/if}
    {/each}

    {#if orgStore.organizations.filter((o) => o.status === "active").length === 0}
      <div class="co-empty">No organizations yet</div>
    {/if}

    <button
      class="tab-btn co-manage"
      class:active={appStore.activeTab === "organizations"}
      onclick={openManageOrgs}
    >
      <i class="fas fa-gear tab-icon"></i>
      <span>Manage</span>
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

  /* ── Organization row: bold when expanded, no background ── */
  .co-row.co-expanded {
    color: var(--text-1);
    font-weight: 600;
    background: transparent;
  }

  /* ── Organization dot (replaces icon) ── */
  .co-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-left: 3px;
    margin-right: 3px;
  }

  /* ── Chevron ── */
  .co-chevron {
    margin-left: auto;
    font-size: 9px;
    opacity: 0.35;
    transition:
      transform 0.2s ease,
      opacity 0.2s ease;
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
