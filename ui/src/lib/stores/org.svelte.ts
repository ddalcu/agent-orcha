import type { Organization, Ticket, Routine, OrgMember, OrgMemberNode, OrgDashboard } from '../types/index.js';
import { orgApi } from '../services/org-api.js';

class OrgStore {
  organizations = $state<Organization[]>([]);
  selectedOrg = $state<Organization | null>(null);
  tickets = $state<Ticket[]>([]);
  routines = $state<Routine[]>([]);
  members = $state<OrgMember[]>([]);
  memberTree = $state<OrgMemberNode[]>([]);
  dashboard = $state<OrgDashboard | null>(null);
  dashboardLoading = $state(false);
  loading = $state(false);
  initialized = false;

  async loadOrgs(): Promise<void> {
    this.organizations = await orgApi.listOrgs();
    this.initialized = true;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.initialized) await this.loadOrgs();
  }

  async selectOrgById(id: string): Promise<void> {
    await this.ensureLoaded();
    const found = this.organizations.find(c => c.id === id);
    if (found && found.id !== this.selectedOrg?.id) {
      this.selectedOrg = found;
      await Promise.all([this.loadTickets(), this.loadRoutines(), this.loadMembers()]);
    }
  }

  selectOrg(org: Organization | null): void {
    this.selectedOrg = org;
    if (org) {
      this.loadTickets();
      this.loadRoutines();
      this.loadMembers();
    } else {
      this.tickets = [];
      this.routines = [];
      this.members = [];
      this.memberTree = [];
    }
  }

  async loadTickets(filters?: { status?: string; priority?: string; assignee?: string }): Promise<void> {
    if (!this.selectedOrg) return;
    this.tickets = await orgApi.listTickets(this.selectedOrg.id, filters);
  }

  async loadRoutines(): Promise<void> {
    if (!this.selectedOrg) return;
    this.routines = await orgApi.listRoutines(this.selectedOrg.id);
  }

  async loadMembers(): Promise<void> {
    if (!this.selectedOrg) return;
    this.members = await orgApi.listMembers(this.selectedOrg.id);
    this.memberTree = await orgApi.getMemberTree(this.selectedOrg.id);
  }

  async loadDashboard(): Promise<void> {
    if (!this.selectedOrg) return;
    this.dashboardLoading = true;
    try {
      this.dashboard = await orgApi.getDashboard(this.selectedOrg.id);
    } finally {
      this.dashboardLoading = false;
    }
  }
}

export const orgStore = new OrgStore();
