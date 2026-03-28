<script lang="ts">
  import { onMount } from 'svelte';
  import { companyStore } from '../lib/stores/company.svelte.js';
  import { companyApi } from '../lib/services/company-api.js';
  import { appStore } from '../lib/stores/app.svelte.js';
  import { api } from '../lib/services/api.js';
  import type { Ticket, TicketActivity, Agent } from '../lib/types/index.js';

  const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
  const PRIORITIES = ['low', 'medium', 'high', 'critical'];
  const STATUS_COLORS: Record<string, string> = {
    backlog: 'var(--text-3)', todo: 'var(--cyan)', in_progress: 'var(--accent)',
    in_review: 'var(--orange)', blocked: 'var(--red)', done: 'var(--green)', cancelled: 'var(--text-3)',
  };
  const PRIORITY_COLORS: Record<string, string> = {
    low: 'var(--text-3)', medium: 'var(--cyan)', high: 'var(--orange)', critical: 'var(--red)',
  };

  let agents = $state<Agent[]>([]);
  let filterStatus = $state('');
  let filterPriority = $state('');

  // Create form
  let showCreate = $state(false);
  let createTitle = $state('');
  let createDesc = $state('');
  let createPriority = $state('medium');
  let createAssignee = $state('');
  let createError = $state('');

  // Detail view
  let selectedTicket = $state<Ticket | null>(null);
  let activity = $state<TicketActivity[]>([]);
  let commentText = $state('');

  onMount(async () => {
    if (companyStore.selectedCompany) {
      await companyStore.loadTickets();
    }
    agents = await api.getAgents();
  });

  async function applyFilters() {
    await companyStore.loadTickets({
      status: filterStatus || undefined,
      priority: filterPriority || undefined,
    });
  }

  async function handleCreateTicket() {
    if (!companyStore.selectedCompany) return;
    createError = '';
    try {
      await companyApi.createTicket(companyStore.selectedCompany.id, {
        title: createTitle,
        description: createDesc,
        priority: createPriority,
        assigneeAgent: createAssignee,
      });
      showCreate = false;
      createTitle = '';
      createDesc = '';
      createPriority = 'medium';
      createAssignee = '';
      await companyStore.loadTickets();
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
    }
  }

  async function openDetail(ticket: Ticket) {
    const data = await companyApi.getTicket(ticket.id);
    selectedTicket = data;
    activity = data.activity || [];
  }

  async function closeDetail() {
    selectedTicket = null;
    activity = [];
    await companyStore.loadTickets();
  }

  async function transitionStatus(id: string, status: string) {
    await companyApi.transitionTicket(id, status);
    if (selectedTicket?.id === id) {
      await openDetail(selectedTicket);
    }
    await companyStore.loadTickets();
  }

  async function addComment() {
    if (!selectedTicket || !commentText.trim()) return;
    await companyApi.addComment(selectedTicket.id, commentText.trim(), 'User');
    commentText = '';
    await openDetail(selectedTicket);
  }

  async function executeTicket() {
    if (!selectedTicket) return;
    try {
      await companyApi.executeTicket(selectedTicket.id);
      await openDetail(selectedTicket);
      await companyStore.loadTickets();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      activity = [...activity, { id: '', ticketId: '', type: 'task_event', content: `Error: ${msg}`, authorType: 'system', authorName: 'System', oldValue: '', newValue: '', metadata: '{}', createdAt: new Date().toISOString() }];
    }
  }

  function viewInMonitor(taskId: string) {
    appStore.setTab('monitor');
  }

  function formatDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatStatus(s: string): string {
    return s.replace(/_/g, ' ');
  }
</script>

<div class="page-container">
  {#if !companyStore.selectedCompany}
    <div class="empty-state">
      <i class="fas fa-building empty-icon"></i>
      <p>Select a company first to view tickets.</p>
      <button class="btn btn-accent btn-sm" onclick={() => appStore.setTab('companies')}>
        Go to Companies
      </button>
    </div>
  {:else if selectedTicket}
    <!-- Ticket Detail View -->
    <div class="detail-view">
      <button class="btn btn-ghost btn-sm mb-3" onclick={closeDetail}>
        <i class="fas fa-arrow-left"></i> Back to list
      </button>

      <div class="detail-header">
        <div class="detail-id">{selectedTicket.identifier}</div>
        <h2 class="detail-title">{selectedTicket.title}</h2>
        <div class="detail-badges">
          <span class="badge" style:color={STATUS_COLORS[selectedTicket.status]}>
            {formatStatus(selectedTicket.status)}
          </span>
          <span class="badge" style:color={PRIORITY_COLORS[selectedTicket.priority]}>
            {selectedTicket.priority}
          </span>
          {#if selectedTicket.assigneeAgent}
            <span class="badge"><i class="fas fa-robot"></i> {selectedTicket.assigneeAgent}</span>
          {/if}
        </div>
      </div>

      <div class="detail-actions">
        <!-- Status transitions -->
        <select class="input input-sm" onchange={(e) => transitionStatus(selectedTicket!.id, (e.target as HTMLSelectElement).value)} value={selectedTicket.status}>
          {#each STATUSES as s}
            <option value={s}>{formatStatus(s)}</option>
          {/each}
        </select>

        {#if selectedTicket.assigneeAgent && selectedTicket.status !== 'done' && selectedTicket.status !== 'cancelled'}
          <button class="btn btn-accent btn-sm" onclick={executeTicket}>
            <i class="fas fa-play"></i> Execute
          </button>
        {/if}

        {#if selectedTicket.taskId}
          <button class="btn btn-ghost btn-sm" onclick={() => viewInMonitor(selectedTicket!.taskId)}>
            <i class="fas fa-external-link-alt"></i> View in Monitor
          </button>
        {/if}
      </div>

      {#if selectedTicket.description}
        <div class="detail-section">
          <h4>Description</h4>
          <p class="detail-desc">{selectedTicket.description}</p>
        </div>
      {/if}

      <!-- Activity Feed -->
      <div class="detail-section">
        <h4>Activity</h4>
        <div class="activity-feed">
          {#each activity as item}
            <div class="activity-item" class:comment={item.type === 'comment'} class:event={item.type === 'task_event'}>
              <div class="activity-meta">
                {#if item.type === 'comment'}
                  <i class="fas fa-comment"></i>
                {:else if item.type === 'status_change'}
                  <i class="fas fa-arrow-right"></i>
                {:else if item.type === 'assignment_change'}
                  <i class="fas fa-user-edit"></i>
                {:else}
                  <i class="fas fa-cog"></i>
                {/if}
                <span class="activity-author">{item.authorName}</span>
                <span class="activity-time">{formatDate(item.createdAt)}</span>
              </div>
              <div class="activity-content">{item.content}</div>
            </div>
          {/each}

          {#if activity.length === 0}
            <div class="activity-empty">No activity yet.</div>
          {/if}
        </div>

        <div class="comment-box">
          <textarea
            class="input"
            rows="2"
            placeholder="Add a comment..."
            bind:value={commentText}
            onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); } }}
          ></textarea>
          <button class="btn btn-accent btn-sm" onclick={addComment} disabled={!commentText.trim()}>
            <i class="fas fa-paper-plane"></i>
          </button>
        </div>
      </div>
    </div>
  {:else}
    <!-- Ticket List View -->
    <div class="page-header">
      <h2 class="page-title">
        <i class="fas fa-ticket"></i> Tickets
        <span class="title-company">({companyStore.selectedCompany.issuePrefix})</span>
      </h2>
      <button class="btn btn-accent btn-sm" onclick={() => { showCreate = true; }}>
        <i class="fas fa-plus"></i> New Ticket
      </button>
    </div>

    <div class="filter-bar">
      <select class="input input-sm" bind:value={filterStatus} onchange={applyFilters}>
        <option value="">All statuses</option>
        {#each STATUSES as s}
          <option value={s}>{formatStatus(s)}</option>
        {/each}
      </select>
      <select class="input input-sm" bind:value={filterPriority} onchange={applyFilters}>
        <option value="">All priorities</option>
        {#each PRIORITIES as p}
          <option value={p}>{p}</option>
        {/each}
      </select>
    </div>

    {#if companyStore.tickets.length === 0}
      <div class="empty-state">
        <i class="fas fa-ticket empty-icon"></i>
        <p>No tickets yet.</p>
      </div>
    {:else}
      <div class="ticket-list">
        {#each companyStore.tickets as ticket}
          <button class="ticket-row" onclick={() => openDetail(ticket)}>
            <span class="ticket-id">{ticket.identifier}</span>
            <span class="ticket-title">{ticket.title}</span>
            <span class="ticket-badge" style:color={STATUS_COLORS[ticket.status]}>{formatStatus(ticket.status)}</span>
            <span class="ticket-badge" style:color={PRIORITY_COLORS[ticket.priority]}>{ticket.priority}</span>
            {#if ticket.assigneeAgent}
              <span class="ticket-agent"><i class="fas fa-robot"></i> {ticket.assigneeAgent}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<!-- Create Ticket Modal -->
{#if showCreate}
  <div class="modal-overlay" onclick={() => { showCreate = false; }} role="presentation">
    <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog">
      <h3>New Ticket</h3>
      {#if createError}
        <div class="form-error">{createError}</div>
      {/if}
      <label class="form-label">
        Title
        <input class="input" type="text" bind:value={createTitle} placeholder="What needs to be done?" />
      </label>
      <label class="form-label">
        Description
        <textarea class="input" rows="3" bind:value={createDesc} placeholder="Optional details..."></textarea>
      </label>
      <div class="form-row">
        <label class="form-label half">
          Priority
          <select class="input" bind:value={createPriority}>
            {#each PRIORITIES as p}
              <option value={p}>{p}</option>
            {/each}
          </select>
        </label>
        <label class="form-label half">
          Assign to Agent
          <select class="input" bind:value={createAssignee}>
            <option value="">Unassigned</option>
            {#each agents as a}
              <option value={a.name}>{a.name}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => { showCreate = false; }}>Cancel</button>
        <button class="btn btn-accent" onclick={handleCreateTicket} disabled={!createTitle}>Create</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-container { padding: 1.5rem; max-width: 900px; }
  .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
  .page-title { font-size: 1.2rem; font-weight: 600; color: var(--text-1); display: flex; align-items: center; gap: 0.5rem; }
  .title-company { color: var(--text-3); font-size: 0.85rem; font-weight: 400; }
  .empty-state { text-align: center; padding: 3rem 1rem; color: var(--text-2); }
  .empty-icon { font-size: 2.5rem; opacity: 0.3; margin-bottom: 1rem; }

  .filter-bar { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .filter-bar select { max-width: 160px; }

  .ticket-list { display: flex; flex-direction: column; gap: 2px; }
  .ticket-row {
    display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    cursor: pointer; transition: border-color 0.15s; text-align: left; width: 100%;
    font: inherit; color: inherit;
  }
  .ticket-row:hover { border-color: var(--accent); }
  .ticket-id { font-size: 0.75rem; color: var(--text-3); font-family: monospace; min-width: 60px; }
  .ticket-title { flex: 1; color: var(--text-1); font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ticket-badge { font-size: 0.7rem; text-transform: uppercase; font-weight: 600; }
  .ticket-agent { font-size: 0.72rem; color: var(--text-2); }

  /* Detail view */
  .detail-view { }
  .detail-header { margin-bottom: 1rem; }
  .detail-id { font-size: 0.75rem; color: var(--text-3); font-family: monospace; margin-bottom: 0.25rem; }
  .detail-title { font-size: 1.15rem; font-weight: 600; color: var(--text-1); margin-bottom: 0.5rem; }
  .detail-badges { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .badge { font-size: 0.72rem; text-transform: uppercase; font-weight: 600; background: var(--hover); padding: 2px 8px; border-radius: 4px; display: flex; align-items: center; gap: 4px; }
  .detail-actions { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
  .detail-section { margin-bottom: 1.5rem; }
  .detail-section h4 { font-size: 0.82rem; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  .detail-desc { font-size: 0.88rem; color: var(--text-1); line-height: 1.5; white-space: pre-wrap; }
  .mb-3 { margin-bottom: 0.75rem; }

  /* Activity */
  .activity-feed { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.75rem; }
  .activity-item { padding: 0.5rem 0.75rem; background: var(--hover-40); border-radius: 6px; font-size: 0.82rem; }
  .activity-item.comment { border-left: 2px solid var(--accent); }
  .activity-item.event { border-left: 2px solid var(--cyan); }
  .activity-meta { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; color: var(--text-3); font-size: 0.72rem; }
  .activity-author { font-weight: 600; color: var(--text-2); }
  .activity-time { margin-left: auto; }
  .activity-content { color: var(--text-1); white-space: pre-wrap; line-height: 1.4; }
  .activity-empty { color: var(--text-3); font-size: 0.82rem; padding: 0.5rem 0; }

  .comment-box { display: flex; gap: 0.5rem; align-items: flex-end; }
  .comment-box textarea { flex: 1; }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.5rem; width: 100%; max-width: 460px; }
  .modal-card h3 { margin-bottom: 1rem; font-size: 1.05rem; color: var(--text-1); }
  .form-label { display: block; font-size: 0.82rem; color: var(--text-2); margin-bottom: 0.75rem; }
  .form-label .input { display: block; width: 100%; margin-top: 0.25rem; }
  .form-row { display: flex; gap: 0.75rem; }
  .form-label.half { flex: 1; }
  .form-error { background: rgba(217,83,79,0.15); color: var(--red); padding: 0.5rem; border-radius: 6px; font-size: 0.82rem; margin-bottom: 0.75rem; }
  .form-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
</style>
