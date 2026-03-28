<script lang="ts">
  import { onMount } from 'svelte';
  import { orgStore } from '../lib/stores/org.svelte.js';
  import { orgApi } from '../lib/services/org-api.js';
  import { appStore } from '../lib/stores/app.svelte.js';
  import { api } from '../lib/services/api.js';
  import type { Routine, RoutineRun, Agent } from '../lib/types/index.js';

  let agents = $state<Agent[]>([]);

  // Create/edit form
  let showForm = $state(false);
  let editingRoutine = $state<Routine | null>(null);
  let formName = $state('');
  let formDesc = $state('');
  let formTimezone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone);
  let formAgent = $state('');
  let formPrompt = $state('');
  let formError = $state('');

  // Schedule builder
  type Frequency = 'every-minute' | 'every-5-min' | 'every-15-min' | 'every-30-min' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';
  let formFrequency = $state<Frequency>('daily');
  let formHour = $state('9');
  let formMinute = $state('0');
  let formDayOfWeek = $state('1'); // Monday
  let formDayOfMonth = $state('1');
  let formCustomCron = $state('');

  const frequencies: { value: Frequency; label: string }[] = [
    { value: 'every-minute', label: 'Every minute' },
    { value: 'every-5-min', label: 'Every 5 minutes' },
    { value: 'every-15-min', label: 'Every 15 minutes' },
    { value: 'every-30-min', label: 'Every 30 minutes' },
    { value: 'hourly', label: 'Every hour' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
    { value: 'custom', label: 'Custom (cron)' },
  ];

  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function buildCron(): string {
    switch (formFrequency) {
      case 'every-minute': return '* * * * *';
      case 'every-5-min': return '*/5 * * * *';
      case 'every-15-min': return '*/15 * * * *';
      case 'every-30-min': return '*/30 * * * *';
      case 'hourly': return `${formMinute} * * * *`;
      case 'daily': return `${formMinute} ${formHour} * * *`;
      case 'weekly': return `${formMinute} ${formHour} * * ${formDayOfWeek}`;
      case 'monthly': return `${formMinute} ${formHour} ${formDayOfMonth} * *`;
      case 'custom': return formCustomCron;
    }
  }

  function parseCronToForm(cron: string) {
    const parts = cron.trim().split(/\s+/);
    if (parts.length < 5) { formFrequency = 'custom'; formCustomCron = cron; return; }

    const [min, hour, dom, , dow] = parts;
    if (cron === '* * * * *') { formFrequency = 'every-minute'; return; }
    if (cron === '*/5 * * * *') { formFrequency = 'every-5-min'; return; }
    if (cron === '*/15 * * * *') { formFrequency = 'every-15-min'; return; }
    if (cron === '*/30 * * * *') { formFrequency = 'every-30-min'; return; }
    if (hour === '*' && dom === '*' && dow === '*') { formFrequency = 'hourly'; formMinute = min!; return; }
    if (dom === '*' && dow === '*') { formFrequency = 'daily'; formMinute = min!; formHour = hour!; return; }
    if (dom === '*' && dow !== '*') { formFrequency = 'weekly'; formMinute = min!; formHour = hour!; formDayOfWeek = dow!; return; }
    if (dow === '*' && dom !== '*') { formFrequency = 'monthly'; formMinute = min!; formHour = hour!; formDayOfMonth = dom!; return; }
    formFrequency = 'custom'; formCustomCron = cron;
  }

  let schedulePreview = $derived(cronToHuman(buildCron()));

  // Detail view
  let selectedRoutine = $state<Routine | null>(null);
  let runs = $state<RoutineRun[]>([]);

  onMount(async () => {
    if (appStore.routeOrgId) {
      await orgStore.selectOrgById(appStore.routeOrgId);
    }
    if (orgStore.selectedOrg) {
      await orgStore.loadRoutines();
    }
    agents = await api.getAgents();

    // Deep-link: open routine detail if itemId in route
    if (appStore.routeItemId && orgStore.selectedOrg) {
      const routine = orgStore.routines.find(r => r.id === appStore.routeItemId);
      if (routine) await openDetail(routine);
    }
  });

  function openCreate() {
    editingRoutine = null;
    formName = '';
    formDesc = '';
    formFrequency = 'daily';
    formHour = '9';
    formMinute = '0';
    formDayOfWeek = '1';
    formDayOfMonth = '1';
    formCustomCron = '';
    formTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    formAgent = '';
    formPrompt = '';
    formError = '';
    showForm = true;
  }

  function openEdit(routine: Routine) {
    editingRoutine = routine;
    formName = routine.name;
    formDesc = routine.description;
    parseCronToForm(routine.schedule);
    formTimezone = routine.timezone;
    formAgent = routine.agentName;
    // Extract prompt from agentInput JSON
    try {
      const parsed = JSON.parse(routine.agentInput || '{}');
      formPrompt = parsed.message || parsed.query || parsed.prompt || (typeof parsed === 'string' ? parsed : '');
    } catch {
      formPrompt = routine.agentInput || '';
    }
    formError = '';
    showForm = true;
  }

  async function handleSubmit() {
    if (!orgStore.selectedOrg) return;
    formError = '';

    const schedule = buildCron();
    if (!schedule.trim()) {
      formError = 'Schedule is required';
      return;
    }

    const agentInput: Record<string, unknown> = formPrompt ? { message: formPrompt } : {};

    try {
      if (editingRoutine) {
        await orgApi.updateRoutine(editingRoutine.id, {
          name: formName,
          description: formDesc,
          schedule,
          timezone: formTimezone,
          agentName: formAgent,
          agentInput,
        });
      } else {
        await orgApi.createRoutine(orgStore.selectedOrg.id, {
          name: formName,
          description: formDesc,
          schedule,
          timezone: formTimezone,
          agentName: formAgent,
          agentInput,
        });
      }
      showForm = false;
      await orgStore.loadRoutines();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    }
  }

  async function toggleStatus(routine: Routine) {
    if (routine.status === 'active') {
      await orgApi.pauseRoutine(routine.id);
    } else {
      await orgApi.resumeRoutine(routine.id);
    }
    await orgStore.loadRoutines();
  }

  async function triggerNow(routine: Routine) {
    await orgApi.triggerRoutine(routine.id);
    if (selectedRoutine?.id === routine.id) {
      await openDetail(routine);
    }
    await orgStore.loadRoutines();
  }

  async function deleteRoutine(routine: Routine) {
    await orgApi.deleteRoutine(routine.id);
    if (selectedRoutine?.id === routine.id) selectedRoutine = null;
    await orgStore.loadRoutines();
  }

  async function openDetail(routine: Routine) {
    const data = await orgApi.getRoutine(routine.id);
    selectedRoutine = data;
    runs = data.runs || [];
    if (orgStore.selectedOrg) {
      appStore.setTab('routines', orgStore.selectedOrg.id, routine.id);
    }
  }

  function closeDetail() {
    selectedRoutine = null;
    runs = [];
    if (orgStore.selectedOrg) {
      appStore.setTab('routines', orgStore.selectedOrg.id);
    }
  }

  function formatDate(iso: string): string {
    if (!iso) return 'Never';
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function cronToHuman(expr: string): string {
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return expr;
    const [min, hour, dom, , dow] = parts;
    const pad = (n: string) => n.padStart(2, '0');
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    if (expr === '* * * * *') return 'Every minute';
    if (min?.startsWith('*/')) return `Every ${min.slice(2)} minutes`;
    if (hour === '*' && dom === '*' && dow === '*') return `Hourly at :${pad(min!)}`;
    if (dom === '*' && dow === '*') return `Daily at ${pad(hour!)}:${pad(min!)}`;
    if (dom === '*' && dow !== '*') {
      const dayName = dayNames[Number(dow)] || dow;
      return `${dayName} at ${pad(hour!)}:${pad(min!)}`;
    }
    if (dow === '*' && dom !== '*') return `Monthly on day ${dom} at ${pad(hour!)}:${pad(min!)}`;
    return expr;
  }
</script>

<div class="space-y-4 h-full overflow-y-auto pb-6 view-panel">
  {#if !orgStore.selectedOrg}
    <div class="empty-state">
      <i class="fas fa-building empty-icon"></i>
      <p>Select an organization first to view routines.</p>
      <button class="btn btn-accent btn-sm" onclick={() => appStore.setTab('organizations')}>
        Go to Organizations
      </button>
    </div>
  {:else if selectedRoutine}
    <!-- Routine Detail View -->
    <div class="detail-view">
      <button class="btn btn-ghost btn-sm mb-3" onclick={closeDetail}>
        <i class="fas fa-arrow-left"></i> Back to list
      </button>

      <div class="detail-header">
        <h2 class="detail-title">{selectedRoutine.name}</h2>
        <div class="detail-badges">
          <span class="badge" class:active={selectedRoutine.status === 'active'} class:paused={selectedRoutine.status === 'paused'}>
            {selectedRoutine.status}
          </span>
          <span class="badge"><i class="fas fa-clock"></i> {cronToHuman(selectedRoutine.schedule)}</span>
          <span class="badge"><i class="fas fa-robot"></i> {selectedRoutine.agentName}</span>
        </div>
      </div>

      {#if selectedRoutine.description}
        <p class="detail-desc">{selectedRoutine.description}</p>
      {/if}

      <div class="detail-meta">
        <div><strong>Schedule:</strong> {selectedRoutine.schedule} ({selectedRoutine.timezone})</div>
        <div><strong>Last triggered:</strong> {formatDate(selectedRoutine.lastTriggeredAt)}</div>
      </div>

      <div class="detail-actions">
        <button class="btn btn-accent btn-sm" onclick={() => triggerNow(selectedRoutine!)}>
          <i class="fas fa-play"></i> Trigger Now
        </button>
        <button class="btn btn-ghost btn-sm" onclick={() => openEdit(selectedRoutine!)}>
          <i class="fas fa-pen"></i> Edit
        </button>
      </div>

      <div class="detail-section">
        <h4>Run History</h4>
        {#if runs.length === 0}
          <div class="empty-small">No runs yet.</div>
        {:else}
          <div class="runs-list">
            {#each runs as run}
              <div class="run-item">
                <span class="run-status" class:completed={run.status === 'completed'} class:failed={run.status === 'failed'} class:triggered={run.status === 'triggered'}>
                  {run.status}
                </span>
                <span class="run-time">{formatDate(run.triggeredAt)}</span>
                {#if run.error}
                  <span class="run-error">{run.error}</span>
                {/if}
                {#if run.taskId}
                  <button class="btn btn-ghost btn-xs" onclick={() => appStore.setTab('monitor')}>
                    <i class="fas fa-external-link-alt"></i> Task
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <!-- Routine List View -->
    <div class="page-header">
      <h2 class="page-title">
        <i class="fas fa-clock-rotate-left"></i> Routines
        <span class="title-org">({orgStore.selectedOrg.issuePrefix})</span>
      </h2>
      <button class="btn btn-accent btn-sm" onclick={openCreate}>
        <i class="fas fa-plus"></i> New Routine
      </button>
    </div>

    {#if orgStore.routines.length === 0}
      <div class="empty-state">
        <i class="fas fa-clock-rotate-left empty-icon"></i>
        <p>No routines yet. Create one to schedule recurring agent tasks.</p>
      </div>
    {:else}
      <div class="routine-list">
        {#each orgStore.routines as routine}
          <div class="routine-row">
            <button class="routine-main" onclick={() => openDetail(routine)}>
              <span class="routine-name">{routine.name}</span>
              <span class="routine-schedule">{cronToHuman(routine.schedule)}</span>
              <span class="routine-agent"><i class="fas fa-robot"></i> {routine.agentName}</span>
              <span class="routine-last">Last: {formatDate(routine.lastTriggeredAt)}</span>
            </button>
            <div class="routine-actions">
              <button
                class="btn btn-ghost btn-xs"
                class:text-green={routine.status === 'active'}
                class:text-muted={routine.status === 'paused'}
                onclick={() => toggleStatus(routine)}
                title={routine.status === 'active' ? 'Pause' : 'Resume'}
              >
                <i class="fas {routine.status === 'active' ? 'fa-pause' : 'fa-play'}"></i>
              </button>
              <button class="btn btn-ghost btn-xs" onclick={() => triggerNow(routine)} title="Trigger now">
                <i class="fas fa-bolt"></i>
              </button>
              <button class="btn btn-ghost btn-xs text-red" onclick={() => deleteRoutine(routine)} title="Delete">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<!-- Create/Edit Routine Modal -->
{#if showForm}
  <div class="modal-overlay" role="presentation">
    <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog">
      <h3>{editingRoutine ? 'Edit Routine' : 'New Routine'}</h3>
      {#if formError}
        <div class="form-error">{formError}</div>
      {/if}
      <label class="form-label">
        Name
        <input class="input" type="text" bind:value={formName} placeholder="Daily report" />
      </label>
      <label class="form-label">
        Description
        <textarea class="input" rows="2" bind:value={formDesc} placeholder="Optional description..."></textarea>
      </label>

      <!-- Schedule Builder -->
      <fieldset class="schedule-fieldset">
        <legend class="schedule-legend">Schedule</legend>
        <label class="form-label">
          Frequency
          <select class="input" bind:value={formFrequency}>
            {#each frequencies as f}
              <option value={f.value}>{f.label}</option>
            {/each}
          </select>
        </label>

        {#if formFrequency === 'weekly'}
          <label class="form-label">
            Day of week
            <select class="input" bind:value={formDayOfWeek}>
              {#each weekdays as day, i}
                <option value={String(i)}>{day}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#if formFrequency === 'monthly'}
          <label class="form-label">
            Day of month
            <select class="input" bind:value={formDayOfMonth}>
              {#each Array.from({ length: 28 }, (_, i) => i + 1) as d}
                <option value={String(d)}>{d}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#if formFrequency === 'daily' || formFrequency === 'weekly' || formFrequency === 'monthly'}
          <div class="form-row">
            <label class="form-label half">
              Hour
              <select class="input" bind:value={formHour}>
                {#each Array.from({ length: 24 }, (_, i) => i) as h}
                  <option value={String(h)}>{String(h).padStart(2, '0')}:00</option>
                {/each}
              </select>
            </label>
            <label class="form-label half">
              Minute
              <select class="input" bind:value={formMinute}>
                {#each Array.from({ length: 60 }, (_, i) => i) as m}
                  <option value={String(m)}>{String(m).padStart(2, '0')}</option>
                {/each}
              </select>
            </label>
          </div>
        {/if}

        {#if formFrequency === 'hourly'}
          <label class="form-label">
            At minute
            <select class="input" bind:value={formMinute}>
              {#each Array.from({ length: 60 }, (_, i) => i) as m}
                <option value={String(m)}>{String(m).padStart(2, '0')}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#if formFrequency === 'custom'}
          <label class="form-label">
            Cron expression
            <input class="input mono" type="text" bind:value={formCustomCron} placeholder="0 9 * * 1-5" />
            <span class="form-hint">min hour day month weekday</span>
          </label>
        {/if}

        <div class="form-row">
          <label class="form-label half">
            Timezone
            <input class="input" type="text" bind:value={formTimezone} placeholder="UTC" />
          </label>
          <div class="schedule-preview half">
            <span class="form-hint">Preview:</span>
            <span class="preview-text">{schedulePreview}</span>
            <span class="preview-cron">{buildCron()}</span>
          </div>
        </div>
      </fieldset>

      <label class="form-label">
        Agent
        <select class="input" bind:value={formAgent}>
          <option value="">Select agent...</option>
          {#each agents as a}
            <option value={a.name}>{a.name}</option>
          {/each}
        </select>
      </label>
      <label class="form-label">
        Prompt
        <textarea class="input" rows="3" bind:value={formPrompt} placeholder="What should the agent do each run?"></textarea>
        <span class="form-hint">The message sent to the agent on each scheduled run</span>
      </label>
      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => { showForm = false; }}>Cancel</button>
        <button class="btn btn-accent" onclick={handleSubmit} disabled={!formName || !formAgent || (formFrequency === 'custom' && !formCustomCron)}>
          {editingRoutine ? 'Save' : 'Create'}
        </button>
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
  .empty-small { color: var(--text-3); font-size: 0.82rem; padding: 0.5rem 0; }

  .routine-list { display: flex; flex-direction: column; gap: 2px; }
  .routine-row {
    display: flex; align-items: center;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    transition: border-color 0.15s;
  }
  .routine-row:hover { border-color: var(--accent); }
  .routine-main {
    flex: 1; display: flex; align-items: center; gap: 0.75rem;
    padding: 0.6rem 0.75rem; cursor: pointer; text-align: left;
    font: inherit; color: inherit; background: none; border: none;
  }
  .routine-name { color: var(--text-1); font-size: 0.88rem; font-weight: 500; min-width: 120px; }
  .routine-schedule { font-size: 0.75rem; color: var(--accent); font-family: monospace; }
  .routine-agent { font-size: 0.72rem; color: var(--text-2); }
  .routine-last { font-size: 0.7rem; color: var(--text-3); margin-left: auto; }
  .routine-actions { display: flex; gap: 0.25rem; padding-right: 0.5rem; }

  /* Detail */
  .detail-view { }
  .detail-header { margin-bottom: 0.75rem; }
  .detail-title { font-size: 1.15rem; font-weight: 600; color: var(--text-1); margin-bottom: 0.5rem; }
  .detail-badges { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .badge { font-size: 0.72rem; text-transform: uppercase; font-weight: 600; background: var(--hover); padding: 2px 8px; border-radius: 4px; display: flex; align-items: center; gap: 4px; color: var(--text-2); }
  .badge.active { color: var(--green); }
  .badge.paused { color: var(--orange); }
  .detail-desc { font-size: 0.88rem; color: var(--text-2); margin-bottom: 0.75rem; line-height: 1.4; }
  .detail-meta { font-size: 0.82rem; color: var(--text-2); margin-bottom: 0.75rem; line-height: 1.6; }
  .detail-actions { display: flex; gap: 0.5rem; margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border); }
  .detail-section { margin-bottom: 1.5rem; }
  .detail-section h4 { font-size: 0.82rem; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  .mb-3 { margin-bottom: 0.75rem; }

  .runs-list { display: flex; flex-direction: column; gap: 4px; }
  .run-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0.6rem; background: var(--hover-40); border-radius: 4px; font-size: 0.82rem; }
  .run-status { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; min-width: 70px; }
  .run-status.completed { color: var(--green); }
  .run-status.failed { color: var(--red); }
  .run-status.triggered { color: var(--cyan); }
  .run-time { color: var(--text-2); }
  .run-error { color: var(--red); font-size: 0.72rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .text-green { color: var(--green); }
  .text-muted { color: var(--text-3); }
  .text-red { color: var(--red); }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.5rem; width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto; }
  .modal-card h3 { margin-bottom: 1rem; font-size: 1.05rem; color: var(--text-1); }
  .form-label { display: block; font-size: 0.82rem; color: var(--text-2); margin-bottom: 0.75rem; }
  .form-label .input { display: block; width: 100%; margin-top: 0.25rem; }
  .form-row { display: flex; gap: 0.75rem; }
  .form-label.half { flex: 1; }
  .form-hint { display: block; font-size: 0.7rem; color: var(--text-3); margin-top: 2px; }
  .form-error { background: rgba(217,83,79,0.15); color: var(--red); padding: 0.5rem; border-radius: 6px; font-size: 0.82rem; margin-bottom: 0.75rem; }
  .form-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
  .mono { font-family: monospace; font-size: 0.82rem; }

  /* Schedule builder */
  .schedule-fieldset { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; margin-bottom: 0.75rem; }
  .schedule-legend { font-size: 0.82rem; color: var(--text-2); font-weight: 500; padding: 0 0.25rem; }
  .schedule-preview { display: flex; flex-direction: column; justify-content: center; gap: 2px; }
  .preview-text { font-size: 0.85rem; color: var(--accent); font-weight: 500; }
  .preview-cron { font-size: 0.7rem; color: var(--text-3); font-family: monospace; }
</style>
