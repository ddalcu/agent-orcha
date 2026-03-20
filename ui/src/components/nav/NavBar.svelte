<script lang="ts">
  import { appStore } from '../../lib/stores/app.svelte.js';
  import type { TabId } from '../../lib/types/index.js';

  interface Props {
    onselect?: () => void;
  }
  let { onselect }: Props = $props();

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'agents', label: 'Agents', icon: 'fa-robot' },
    { id: 'knowledge', label: 'Knowledge', icon: 'fa-brain' },
    { id: 'graph', label: 'Graph', icon: 'fa-network-wired' },
    { id: 'tools', label: 'Tools', icon: 'fa-wrench' },
    { id: 'monitor', label: 'Monitor', icon: 'fa-tasks' },
    { id: 'llm', label: 'LLM', icon: 'fa-microchip' },
    { id: 'ide', label: 'IDE', icon: 'fa-code' },
    { id: 'p2p', label: 'P2P', icon: 'fa-share-nodes' },
  ];

  function selectTab(id: TabId) {
    appStore.setTab(id);
    onselect?.();
  }
</script>

<div class="flex flex-col h-full flex-1 min-h-0">
  <div class="sidebar-brand">
    <img src="/assets/logo.png" alt="Agent Orcha" class="sidebar-logo">
    <span>Agent Orcha</span>
  </div>
  <nav class="flex-1 overflow-y-auto">
    {#each tabs as tab}
      <button
        class="tab-btn"
        class:active={appStore.activeTab === tab.id}
        onclick={() => selectTab(tab.id)}
      >
        <i class="fas {tab.icon} tab-icon"></i>
        <span>{tab.label}</span>
      </button>
    {/each}
  </nav>
</div>
