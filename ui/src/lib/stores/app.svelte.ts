import type { Agent, Workflow, LLM, TabId } from '../types/index.js';

const SIMPLE_TABS: TabId[] = ['agents', 'knowledge', 'graph', 'tools', 'monitor', 'llm', 'ide', 'p2p', 'companies'];

function parseHash(): { tab: TabId; companyId?: string; itemId?: string } {
  let raw = window.location.hash.replace('#', '');
  if (raw === 'mcp') raw = 'tools';

  // Company-scoped routes:
  //   tickets/{companyId}
  //   tickets/{companyId}/{ticketId}
  //   routines/{companyId}
  //   routines/{companyId}/{routineId}
  const parts = raw.split('/');
  const base = parts[0] as TabId;
  if ((base === 'tickets' || base === 'routines') && parts[1]) {
    return { tab: base, companyId: parts[1], itemId: parts[2] || undefined };
  }
  if (SIMPLE_TABS.includes(base)) {
    return { tab: base };
  }
  return { tab: 'agents' };
}

class AppStore {
  activeTab = $state<TabId>('agents');
  routeCompanyId = $state<string | undefined>(undefined);
  routeItemId = $state<string | undefined>(undefined);
  agents = $state<Agent[]>([]);
  workflows = $state<Workflow[]>([]);
  llms = $state<LLM[]>([]);
  selectedAgent = $state<Agent | null>(null);
  selectedLlm = $state<LLM | null>(null);
  selectedWorkflow = $state<Workflow | null>(null);
  selectionType = $state<'agent' | 'llm' | 'workflow'>('agent');
  defaultLlmName = $state<string | null>(null);

  constructor() {
    const initial = parseHash();
    this.activeTab = initial.tab;
    this.routeCompanyId = initial.companyId;
    this.routeItemId = initial.itemId;

    window.addEventListener('hashchange', () => {
      const parsed = parseHash();
      if (parsed.tab !== this.activeTab || parsed.companyId !== this.routeCompanyId || parsed.itemId !== this.routeItemId) {
        this.activeTab = parsed.tab;
        this.routeCompanyId = parsed.companyId;
        this.routeItemId = parsed.itemId;
      }
    });
  }

  setTab(tab: TabId, companyId?: string, itemId?: string) {
    this.activeTab = tab;
    this.routeCompanyId = companyId;
    this.routeItemId = itemId;
    if (companyId && (tab === 'tickets' || tab === 'routines')) {
      const hash = itemId ? `${tab}/${companyId}/${itemId}` : `${tab}/${companyId}`;
      window.location.hash = hash;
    } else {
      window.location.hash = tab;
    }
  }
}

export const appStore = new AppStore();
