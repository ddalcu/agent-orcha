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

export const companyApi = {
  // Companies
  async listCompanies() { return (await _fetch('/api/companies')).json(); },
  async getCompany(id: string) { return (await _fetch(`/api/companies/${id}`)).json(); },
  async createCompany(data: { name: string; issuePrefix: string; description?: string; brandColor?: string }) {
    return (await _fetch('/api/companies', { method: 'POST', ...json(data) })).json();
  },
  async updateCompany(id: string, data: Record<string, unknown>) {
    return (await _fetch(`/api/companies/${id}`, { method: 'PATCH', ...json(data) })).json();
  },
  async deleteCompany(id: string) {
    return (await _fetch(`/api/companies/${id}`, { method: 'DELETE' })).json();
  },

  // Tickets
  async listTickets(companyId: string, filters?: { status?: string; priority?: string; assignee?: string }) {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.priority) params.set('priority', filters.priority);
    if (filters?.assignee) params.set('assignee', filters.assignee);
    const qs = params.toString();
    return (await _fetch(`/api/companies/${companyId}/tickets${qs ? '?' + qs : ''}`)).json();
  },
  async createTicket(companyId: string, data: { title: string; description?: string; priority?: string; assigneeAgent?: string }) {
    return (await _fetch(`/api/companies/${companyId}/tickets`, { method: 'POST', ...json(data) })).json();
  },
  async getTicket(id: string) { return (await _fetch(`/api/companies/tickets/${id}`)).json(); },
  async updateTicket(id: string, data: Record<string, unknown>) {
    return (await _fetch(`/api/companies/tickets/${id}`, { method: 'PATCH', ...json(data) })).json();
  },
  async transitionTicket(id: string, status: string) {
    return (await _fetch(`/api/companies/tickets/${id}/transition`, { method: 'POST', ...json({ status }) })).json();
  },
  async addComment(ticketId: string, content: string, authorName?: string) {
    return (await _fetch(`/api/companies/tickets/${ticketId}/comments`, { method: 'POST', ...json({ content, authorName }) })).json();
  },
  async executeTicket(ticketId: string, agentName?: string) {
    return (await _fetch(`/api/companies/tickets/${ticketId}/execute`, { method: 'POST', ...json({ agentName }) })).json();
  },

  // Routines
  async listRoutines(companyId: string) { return (await _fetch(`/api/companies/${companyId}/routines`)).json(); },
  async createRoutine(companyId: string, data: { name: string; schedule: string; agentName: string; description?: string; timezone?: string; agentInput?: Record<string, unknown> }) {
    return (await _fetch(`/api/companies/${companyId}/routines`, { method: 'POST', ...json(data) })).json();
  },
  async getRoutine(id: string) { return (await _fetch(`/api/companies/routines/${id}`)).json(); },
  async updateRoutine(id: string, data: Record<string, unknown>) {
    return (await _fetch(`/api/companies/routines/${id}`, { method: 'PATCH', ...json(data) })).json();
  },
  async deleteRoutine(id: string) {
    return (await _fetch(`/api/companies/routines/${id}`, { method: 'DELETE' })).json();
  },
  async pauseRoutine(id: string) {
    return (await _fetch(`/api/companies/routines/${id}/pause`, { method: 'POST' })).json();
  },
  async resumeRoutine(id: string) {
    return (await _fetch(`/api/companies/routines/${id}/resume`, { method: 'POST' })).json();
  },
  async triggerRoutine(id: string) {
    return (await _fetch(`/api/companies/routines/${id}/trigger`, { method: 'POST' })).json();
  },
  async getRoutineRuns(id: string) { return (await _fetch(`/api/companies/routines/${id}/runs`)).json(); },
};
