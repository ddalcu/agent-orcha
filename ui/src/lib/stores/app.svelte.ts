import type { Agent, Workflow, LLM, TabId } from '../types/index.js';

const SIMPLE_TABS: TabId[] = ['agents', 'knowledge', 'graph', 'tools', 'monitor', 'llm', 'ide', 'p2p', 'organizations'];

function parseHash(): { tab: TabId; orgId?: string; itemId?: string } {
  let raw = window.location.hash.replace('#', '');
  if (raw === 'mcp') raw = 'tools';

  // Organization-scoped routes:
  //   tickets/{orgId}
  //   tickets/{orgId}/{ticketId}
  //   routines/{orgId}
  //   routines/{orgId}/{routineId}
  //   orgchart/{orgId}
  const parts = raw.split('/');
  const base = parts[0] as TabId;
  if ((base === 'tickets' || base === 'routines' || base === 'orgchart' || base === 'dashboard') && parts[1]) {
    return { tab: base, orgId: parts[1], itemId: parts[2] || undefined };
  }
  if (SIMPLE_TABS.includes(base)) {
    return { tab: base };
  }
  return { tab: 'agents' };
}

type PendingAction =
  | { type: 'create'; resourceType: string }
  | { type: 'open'; filePath: string };

class AppStore {
  activeTab = $state<TabId>('agents');
  routeOrgId = $state<string | undefined>(undefined);
  routeItemId = $state<string | undefined>(undefined);
  agents = $state<Agent[]>([]);
  workflows = $state<Workflow[]>([]);
  llms = $state<LLM[]>([]);
  selectedAgent = $state<Agent | null>(null);
  selectedLlm = $state<LLM | null>(null);
  selectedWorkflow = $state<Workflow | null>(null);
  selectionType = $state<'agent' | 'llm' | 'workflow'>('agent');
  defaultLlmName = $state<string | null>(null);
  pendingAction = $state<PendingAction | null>(null);

  constructor() {
    const initial = parseHash();
    this.activeTab = initial.tab;
    this.routeOrgId = initial.orgId;
    this.routeItemId = initial.itemId;

    window.addEventListener('hashchange', () => {
      const parsed = parseHash();
      if (parsed.tab !== this.activeTab || parsed.orgId !== this.routeOrgId || parsed.itemId !== this.routeItemId) {
        this.activeTab = parsed.tab;
        this.routeOrgId = parsed.orgId;
        this.routeItemId = parsed.itemId;
      }
    });
  }

  setTab(tab: TabId, orgId?: string, itemId?: string) {
    this.activeTab = tab;
    this.routeOrgId = orgId;
    this.routeItemId = itemId;
    if (orgId && (tab === 'tickets' || tab === 'routines' || tab === 'orgchart' || tab === 'dashboard')) {
      const hash = itemId ? `${tab}/${orgId}/${itemId}` : `${tab}/${orgId}`;
      window.location.hash = hash;
    } else {
      window.location.hash = tab;
    }
  }
}

export const appStore = new AppStore();
