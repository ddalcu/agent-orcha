import type { Agent, Workflow, LLM, TabId } from '../types/index.js';

const VALID_TABS: TabId[] = ['agents', 'knowledge', 'graph', 'tools', 'monitor', 'llm', 'ide'];

function getInitialTab(): TabId {
  let hash = window.location.hash.replace('#', '') as string;
  if (hash === 'mcp') hash = 'tools';
  return VALID_TABS.includes(hash as TabId) ? hash as TabId : 'agents';
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
      let hash = window.location.hash.replace('#', '') as string;
      if (hash === 'mcp') hash = 'tools';
      if (VALID_TABS.includes(hash as TabId) && hash !== this.activeTab) {
        this.activeTab = hash as TabId;
      }
    });
  }

  setTab(tab: TabId) {
    this.activeTab = tab;
    window.location.hash = tab;
  }
}

export const appStore = new AppStore();
