<script lang="ts">
  import { orgStore } from '../lib/stores/org.svelte.js';
  import { orgApi } from '../lib/services/org-api.js';
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
  let createAutoExecute = $state(true);
  let createError = $state('');

  // Detail view
  let selectedTicket = $state<Ticket | null>(null);
  let activity = $state<TicketActivity[]>([]);
  let commentText = $state('');

  let lastLoadedOrgId: string | undefined;

  $effect(() => {
    const orgId = appStore.routeOrgId;
    if (orgId && orgId !== lastLoadedOrgId) {
      lastLoadedOrgId = orgId;
      (async () => {
        await orgStore.selectOrgById(orgId);
        if (orgStore.selectedOrg) {
          await orgStore.loadTickets();
        }
        agents = await api.getAgents();

        // Deep-link: open ticket detail if itemId in route
        if (appStore.routeItemId && orgStore.selectedOrg) {
          const ticket = orgStore.tickets.find(t => t.id === appStore.routeItemId);
          if (ticket) await openDetail(ticket);
        }
      })();
    }
  });

  async function applyFilters() {
    await orgStore.loadTickets({
      status: filterStatus || undefined,
      priority: filterPriority || undefined,
    });
  }

  async function handleCreateTicket() {
    if (!orgStore.selectedOrg) return;
    createError = '';
    try {
      const ticket = await orgApi.createTicket(orgStore.selectedOrg.id, {
        title: createTitle,
        description: createDesc,
        priority: createPriority,
        assigneeAgent: createAssignee,
      });

      // Auto-execute if enabled and an agent is assigned
      if (createAutoExecute && createAssignee) {
        try {
          await orgApi.executeTicket(ticket.id);
        } catch (err) {
          // Ticket was created, just log the execution error
          console.warn('Auto-execute failed:', err);
        }
      }

      showCreate = false;
      createTitle = '';
      createDesc = '';
      createPriority = 'medium';
      createAssignee = '';
      createAutoExecute = true;
      await orgStore.loadTickets();
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
    }
  }

  async function openDetail(ticket: Ticket) {
    const data = await orgApi.getTicket(ticket.id);
    selectedTicket = data;
    activity = data.activity || [];
    // Push ticket ID into route
    if (orgStore.selectedOrg) {
      appStore.setTab('tickets', orgStore.selectedOrg.id, ticket.id);
    }
  }

  async function closeDetail() {
    selectedTicket = null;
    activity = [];
    // Pop back to ticket list route
    if (orgStore.selectedOrg) {
      appStore.setTab('tickets', orgStore.selectedOrg.id);
    }
    await orgStore.loadTickets();
  }

  async function transitionStatus(id: string, status: string) {
    await orgApi.transitionTicket(id, status);
    if (selectedTicket?.id === id) {
      await openDetail(selectedTicket);
    }
    await orgStore.loadTickets();
  }

  async function addComment() {
    if (!selectedTicket || !commentText.trim()) return;
    await orgApi.addComment(selectedTicket.id, commentText.trim(), 'User');
    commentText = '';
    await openDetail(selectedTicket);
  }

  async function replyAndExecute() {
    if (!selectedTicket || !commentText.trim()) return;
    const input = commentText.trim();
    // Post the comment first so the agent can see it in the activity
    await orgApi.addComment(selectedTicket.id, input, 'User');
    commentText = '';
    try {
      await orgApi.executeTicket(selectedTicket.id, undefined, input);
      await openDetail(selectedTicket);
      await orgStore.loadTickets();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('Reply & Execute failed:', msg);
      await openDetail(selectedTicket);
    }
  }

  async function executeTicket() {
    if (!selectedTicket) return;
    try {
      await orgApi.executeTicket(selectedTicket.id);
      await openDetail(selectedTicket);
      await orgStore.loadTickets();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      activity = [...activity, { id: '', ticketId: '', type: 'task_event', content: `Error: ${msg}`, authorType: 'system', authorName: 'System', oldValue: '', newValue: '', metadata: '{}', createdAt: new Date().toISOString() }];
    }
  }

  async function submitToCEO() {
    if (!selectedTicket) return;
    try {
      await orgApi.submitToCEO(selectedTicket.id);
      await openDetail(selectedTicket);
      await orgStore.loadTickets();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      activity = [...activity, { id: '', ticketId: '', type: 'task_event', content: `CEO Error: ${msg}`, authorType: 'system', authorName: 'System', oldValue: '', newValue: '', metadata: '{}', createdAt: new Date().toISOString() }];
    }
  }

  async function requestCEOReview() {
    if (!selectedTicket) return;
    try {
      // Get latest agent output from activity
      const agentComments = activity.filter(a => a.type === 'comment' && a.authorType === 'agent');
      const lastOutput = agentComments.length > 0 ? agentComments[agentComments.length - 1].content : '';
      await orgApi.requestCEOReview(selectedTicket.id, lastOutput);
      await openDetail(selectedTicket);
      await orgStore.loadTickets();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      activity = [...activity, { id: '', ticketId: '', type: 'task_event', content: `CEO Review Error: ${msg}`, authorType: 'system', authorName: 'System', oldValue: '', newValue: '', metadata: '{}', createdAt: new Date().toISOString() }];
    }
  }

  let hasCEO = $derived(orgStore.selectedOrg?.ceoType ? true : false);

  function viewInMonitor(taskId: string) {
    appStore.setTab('monitor');
  }

  interface Attachment { url: string; type: string; name: string }

  function getAttachments(item: TicketActivity): Attachment[] {
    try {
      const meta = JSON.parse(item.metadata || '{}');
      return meta.attachments || [];
    } catch { return []; }
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

<div class="space-y-4 h-full overflow-y-auto pb-6 view-panel">
  {#if !orgStore.selectedOrg}
    <div class="empty-state">
      <i class="fas fa-building empty-icon"></i>
      <p>Select an organization first to view tickets.</p>
      <button class="btn btn-accent btn-sm" onclick={() => appStore.setTab('organizations')}>
        Go to Organizations
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

        {#if hasCEO && selectedTicket.status !== 'done' && selectedTicket.status !== 'cancelled'}
          <button class="btn btn-ghost btn-sm ceo-btn" onclick={submitToCEO} title="Submit to CEO for triage">
            <i class="fas fa-crown"></i> Submit to CEO
          </button>
        {/if}

        {#if hasCEO && (selectedTicket.status === 'in_review' || selectedTicket.status === 'done')}
          <button class="btn btn-ghost btn-sm ceo-btn" onclick={requestCEOReview} title="Request CEO review">
            <i class="fas fa-crown"></i> CEO Review
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
              {#each getAttachments(item) as att}
                <div class="activity-attachment">
                  {#if att.type === 'image'}
                    <a href={att.url} target="_blank" rel="noopener">
                      <img src={att.url} alt={att.name} class="attachment-img" />
                    </a>
                  {:else if att.type === 'audio'}
                    <audio controls src={att.url} class="attachment-audio">
                      <track kind="captions" />
                    </audio>
                  {:else if att.type === 'video'}
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <video controls src={att.url} class="attachment-video"></video>
                  {:else}
                    <a href={att.url} target="_blank" rel="noopener" class="attachment-link">
                      <i class="fas fa-file"></i> {att.name}
                    </a>
                  {/if}
                </div>
              {/each}
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
          <div class="comment-actions">
            <button class="btn btn-ghost btn-sm" onclick={addComment} disabled={!commentText.trim()} title="Add comment">
              <i class="fas fa-paper-plane"></i>
            </button>
            {#if selectedTicket?.assigneeAgent}
              <button class="btn btn-accent btn-sm" onclick={replyAndExecute} disabled={!commentText.trim()} title="Add comment and re-execute agent with it">
                <i class="fas fa-play"></i> Reply & Execute
              </button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {:else}
    <!-- Ticket List View -->
    <div class="page-header">
      <h2 class="page-title">
        <i class="fas fa-ticket"></i> Tickets
        <span class="title-org">({orgStore.selectedOrg.issuePrefix})</span>
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

    {#if orgStore.tickets.length === 0}
      <div class="empty-state">
        <i class="fas fa-ticket empty-icon"></i>
        <p>No tickets yet.</p>
      </div>
    {:else}
      <div class="ticket-list">
        {#each orgStore.tickets as ticket}
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
  <div class="modal-overlay" role="presentation">
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
      <label class="form-check">
        <input type="checkbox" bind:checked={createAutoExecute} disabled={!createAssignee} />
        <span>Auto-execute with assigned agent</span>
      </label>
      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => { showCreate = false; }}>Cancel</button>
        <button class="btn btn-accent" onclick={handleCreateTicket} disabled={!createTitle}>Create</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-header { display: flex; align-items: center; justify-content: space-between; }
  .page-title { font-size: 1.2rem; font-weight: 600; color: var(--text-1); display: flex; align-items: center; gap: 0.5rem; }
  .title-org { color: var(--text-3); font-size: 0.85rem; font-weight: 400; }
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
  .activity-attachment { margin-top: 0.5rem; }
  .attachment-img { max-width: 100%; max-height: 300px; border-radius: 6px; cursor: pointer; border: 1px solid var(--border); }
  .attachment-img:hover { border-color: var(--accent); }
  .attachment-audio { width: 100%; max-width: 400px; height: 36px; }
  .attachment-video { max-width: 100%; max-height: 300px; border-radius: 6px; border: 1px solid var(--border); }
  .attachment-link { color: var(--accent); font-size: 0.82rem; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
  .attachment-link:hover { text-decoration: underline; }
  .activity-empty { color: var(--text-3); font-size: 0.82rem; padding: 0.5rem 0; }

  .comment-box { display: flex; gap: 0.5rem; align-items: flex-end; }
  .comment-box textarea { flex: 1; }
  .comment-actions { display: flex; flex-direction: column; gap: 0.25rem; }

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
  .form-check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; color: var(--text-2); margin-bottom: 0.5rem; cursor: pointer; }
  .form-check input[type="checkbox"] { accent-color: var(--accent); }
  .form-check input:disabled + span { opacity: 0.4; }

  .ceo-btn { color: var(--accent); }
  .ceo-btn:hover { color: var(--text-1); }
</style>
