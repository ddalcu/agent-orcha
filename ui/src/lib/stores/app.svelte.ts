import type { Agent, Workflow, LLM, TabId } from '../types/index.js';

const VALID_TABS: TabId[] = ['agents', 'knowledge', 'graph', 'mcp', 'monitor', 'llm', 'ide'];

function getInitialTab(): TabId {
  const hash = window.location.hash.replace('#', '') as TabId;
  return VALID_TABS.includes(hash) ? hash : 'agents';
}

class AppStore {
  activeTab = $state<TabId>(getInitialTab());
  agents = $state<Agent[]>([]);
  workflows = $state<Workflow[]>([]);
  llms = $state<LLM[]>([]);
  selectedAgent = $state<Agent | null>(null);
  selectedLlm = $state<LLM | null>(null);
  selectedWorkflow = $state<Workflow | null>(null);
  selectionType = $state<'agent' | 'llm' | 'workflow'>('agent');
  defaultLlmName = $state<string | null>(null);

  constructor() {
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace('#', '') as TabId;
      if (VALID_TABS.includes(hash) && hash !== this.activeTab) {
        this.activeTab = hash;
      }
    });
  }

  setTab(tab: TabId) {
    this.activeTab = tab;
    window.location.hash = tab;
  }
}

export const appStore = new AppStore();
