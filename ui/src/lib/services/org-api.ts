async function _fetch(url: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:required'));
    throw new Error('Unauthorized');
  }
  return res;
}

function json(body: unknown): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const orgApi = {
  // Organizations
  async listOrgs() { return (await _fetch('/api/organizations')).json(); },
  async getOrg(id: string) { return (await _fetch(`/api/organizations/${id}`)).json(); },
  async createOrg(data: { name: string; issuePrefix: string; description?: string; brandColor?: string }) {
    return (await _fetch('/api/organizations', { method: 'POST', ...json(data) })).json();
  },
  async updateOrg(id: string, data: Record<string, unknown>) {
    return (await _fetch(`/api/organizations/${id}`, { method: 'PATCH', ...json(data) })).json();
  },
  async deleteOrg(id: string) {
    return (await _fetch(`/api/organizations/${id}`, { method: 'DELETE' })).json();
  },

  // Tickets
  async listTickets(orgId: string, filters?: { status?: string; priority?: string; assignee?: string }) {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.priority) params.set('priority', filters.priority);
    if (filters?.assignee) params.set('assignee', filters.assignee);
    const qs = params.toString();
    return (await _fetch(`/api/organizations/${orgId}/tickets${qs ? '?' + qs : ''}`)).json();
  },
  async createTicket(orgId: string, data: { title: string; description?: string; priority?: string; assigneeAgent?: string }) {
    return (await _fetch(`/api/organizations/${orgId}/tickets`, { method: 'POST', ...json(data) })).json();
  },
  async getTicket(id: string) { return (await _fetch(`/api/organizations/tickets/${id}`)).json(); },
  async updateTicket(id: string, data: Record<string, unknown>) {
    return (await _fetch(`/api/organizations/tickets/${id}`, { method: 'PATCH', ...json(data) })).json();
  },
  async transitionTicket(id: string, status: string) {
    return (await _fetch(`/api/organizations/tickets/${id}/transition`, { method: 'POST', ...json({ status }) })).json();
  },
  async addComment(ticketId: string, content: string, authorName?: string) {
    return (await _fetch(`/api/organizations/tickets/${ticketId}/comments`, { method: 'POST', ...json({ content, authorName }) })).json();
  },
  async executeTicket(ticketId: string, agentName?: string, input?: string) {
    return (await _fetch(`/api/organizations/tickets/${ticketId}/execute`, { method: 'POST', ...json({ agentName, input }) })).json();
  },

  // Routines
  async listRoutines(orgId: string) { return (await _fetch(`/api/organizations/${orgId}/routines`)).json(); },
  async createRoutine(orgId: string, data: { name: string; schedule: string; agentName: string; description?: string; timezone?: string; agentInput?: Record<string, unknown> }) {
    return (await _fetch(`/api/organizations/${orgId}/routines`, { method: 'POST', ...json(data) })).json();
  },
  async getRoutine(id: string) { return (await _fetch(`/api/organizations/routines/${id}`)).json(); },
  async updateRoutine(id: string, data: Record<string, unknown>) {
    return (await _fetch(`/api/organizations/routines/${id}`, { method: 'PATCH', ...json(data) })).json();
  },
  async deleteRoutine(id: string) {
    return (await _fetch(`/api/organizations/routines/${id}`, { method: 'DELETE' })).json();
  },
  async pauseRoutine(id: string) {
    return (await _fetch(`/api/organizations/routines/${id}/pause`, { method: 'POST' })).json();
  },
  async resumeRoutine(id: string) {
    return (await _fetch(`/api/organizations/routines/${id}/resume`, { method: 'POST' })).json();
  },
  async triggerRoutine(id: string) {
    return (await _fetch(`/api/organizations/routines/${id}/trigger`, { method: 'POST' })).json();
  },
  async getRoutineRuns(id: string) { return (await _fetch(`/api/organizations/routines/${id}/runs`)).json(); },

  // Org Chart Members
  async listMembers(orgId: string) { return (await _fetch(`/api/organizations/${orgId}/members`)).json(); },
  async getMemberTree(orgId: string) { return (await _fetch(`/api/organizations/${orgId}/members/tree`)).json(); },
  async createMember(orgId: string, data: { agentName: string; title?: string; role?: string; reportsTo?: string | null; position?: number }) {
    return (await _fetch(`/api/organizations/${orgId}/members`, { method: 'POST', ...json(data) })).json();
  },
  async getMember(id: string) { return (await _fetch(`/api/organizations/members/${id}`)).json(); },
  async updateMember(id: string, data: Record<string, unknown>) {
    return (await _fetch(`/api/organizations/members/${id}`, { method: 'PATCH', ...json(data) })).json();
  },
  async deleteMember(id: string) {
    return (await _fetch(`/api/organizations/members/${id}`, { method: 'DELETE' })).json();
  },

  // CEO
  async configureCEO(orgId: string, ceoType: string, ceoConfig?: string) {
    return (await _fetch(`/api/organizations/${orgId}/ceo/configure`, { method: 'POST', ...json({ ceoType, ceoConfig }) })).json();
  },
  async getCEOStatus(orgId: string) {
    return (await _fetch(`/api/organizations/${orgId}/ceo/status`)).json();
  },
  async submitToCEO(ticketId: string) {
    return (await _fetch(`/api/organizations/tickets/${ticketId}/submit-to-ceo`, { method: 'POST' })).json();
  },
  async requestCEOReview(ticketId: string, output?: string) {
    return (await _fetch(`/api/organizations/tickets/${ticketId}/ceo-review`, { method: 'POST', ...json({ output }) })).json();
  },

  // CEO Force Stop
  async forceStopCEO(orgId: string) {
    return (await _fetch(`/api/organizations/${orgId}/ceo/force-stop`, { method: 'POST' })).json();
  },

  // Dashboard
  async getDashboard(orgId: string) {
    return (await _fetch(`/api/organizations/${orgId}/dashboard`)).json();
  },

  // CEO Runs
  async listCEORuns(orgId: string, limit = 20) {
    return (await _fetch(`/api/organizations/${orgId}/ceo/runs?limit=${limit}`)).json();
  },

  // Heartbeat
  async triggerHeartbeat(orgId: string) {
    return (await _fetch(`/api/organizations/${orgId}/ceo/heartbeat/trigger`, { method: 'POST' })).json();
  },
  async getHeartbeatConfig(orgId: string) {
    return (await _fetch(`/api/organizations/${orgId}/ceo/heartbeat/config`)).json();
  },
  async configureHeartbeat(orgId: string, data: { enabled: boolean; schedule: string; timezone?: string }) {
    return (await _fetch(`/api/organizations/${orgId}/ceo/heartbeat/configure`, { method: 'POST', ...json(data) })).json();
  },
};
