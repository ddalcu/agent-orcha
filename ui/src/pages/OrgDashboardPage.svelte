<script lang="ts">
  import { orgStore } from '../lib/stores/org.svelte.js';
  import { orgApi } from '../lib/services/org-api.js';
  import { appStore } from '../lib/stores/app.svelte.js';
  import type { CEORun, HeartbeatConfig } from '../lib/types/index.js';
  import { renderMarkdown, highlightCode } from '../lib/services/markdown.js';

  let hbConfig = $state<HeartbeatConfig | null>(null);
  let hbSchedule = $state('*/30 * * * *');
  let hbEnabled = $state(false);
  let showHbConfig = $state(false);
  let wakingCEO = $state(false);

  let lastLoadedOrgId: string | undefined;

  $effect(() => {
    const orgId = appStore.routeOrgId;
    if (orgId && orgId !== lastLoadedOrgId) {
      lastLoadedOrgId = orgId;
      (async () => {
        await orgStore.selectOrgById(orgId);
        if (orgStore.selectedOrg) {
          await orgStore.loadDashboard();
          await loadHeartbeatConfig();
        }
      })();
    }
  });

  async function loadHeartbeatConfig() {
    if (!orgStore.selectedOrg) return;
    hbConfig = await orgApi.getHeartbeatConfig(orgStore.selectedOrg.id);
    hbSchedule = hbConfig?.schedule || '*/30 * * * *';
    hbEnabled = hbConfig?.enabled === 1;
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function wakeCEO() {
    if (!orgStore.selectedOrg) return;
    wakingCEO = true;
    try {
      await orgApi.triggerHeartbeat(orgStore.selectedOrg.id);
      // Poll dashboard to show progress (CEO runs in background)
      startPolling();
    } catch (err) {
      console.error('Wake CEO failed:', err);
      wakingCEO = false;
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      await orgStore.loadDashboard();
      // Stop polling once CEO is no longer working
      if (orgStore.dashboard?.ceo.status !== 'working') {
        stopPolling();
        wakingCEO = false;
      }
    }, 3000);
    // Safety timeout — stop after 5 minutes regardless
    setTimeout(() => { stopPolling(); wakingCEO = false; }, 300000);
  }

  async function forceStopCEO() {
    if (!orgStore.selectedOrg) return;
    try {
      await orgApi.forceStopCEO(orgStore.selectedOrg.id);
      stopPolling();
      wakingCEO = false;
      await orgStore.loadDashboard();
    } catch (err) {
      console.error('Force stop failed:', err);
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function saveHeartbeatConfig() {
    if (!orgStore.selectedOrg) return;
    await orgApi.configureHeartbeat(orgStore.selectedOrg.id, {
      enabled: hbEnabled,
      schedule: hbSchedule,
    });
    await loadHeartbeatConfig();
    showHbConfig = false;
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  function formatDate(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatCost(usd: number): string {
    if (usd === 0) return '$0';
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
  }

  function formatTokens(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  }

  const SCHEDULE_LABELS: Record<string, string> = {
    '* * * * *': 'Every 1 min',
    '*/5 * * * *': 'Every 5 min',
    '*/10 * * * *': 'Every 10 min',
    '*/30 * * * *': 'Every 30 min',
    '0 */2 * * *': 'Every 2 hours',
    '0 */6 * * *': 'Every 6 hours',
    '0 */12 * * *': 'Every 12 hours',
    '0 0 * * *': 'Every 24 hours',
  };

  function statusColor(status: string): string {
    const colors: Record<string, string> = {
      backlog: 'var(--text-3)', todo: 'var(--cyan)', in_progress: 'var(--accent)',
      in_review: 'var(--orange)', blocked: 'var(--red)', done: 'var(--green)', cancelled: 'var(--text-3)',
    };
    return colors[status] || 'var(--text-3)';
  }

  let expandedRunId = $state<string | null>(null);

  let activeRunTaskId = $derived(
    orgStore.dashboard?.runs.find(r => r.status === 'running')?.taskId || ''
  );

  // Live feed for active CEO run
  interface LiveEntry { type: string; content: string; tool?: string; time: string }
  let liveFeed = $state<LiveEntry[]>([]);
  let liveEventSource: EventSource | null = null;
  let liveFeedEl = $state<HTMLElement | null>(null);

  $effect(() => {
    const taskId = activeRunTaskId;
    if (taskId && !liveEventSource) {
      connectLiveStream(taskId);
    } else if (!taskId && liveEventSource) {
      disconnectLiveStream();
    }
  });

  function connectLiveStream(taskId: string) {
    disconnectLiveStream();
    liveFeed = [];
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    liveEventSource = es;

    es.onmessage = (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'events' && data.events) {
          for (const evt of data.events) {
            const time = new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            if (evt.type === 'content' && evt.content) {
              liveFeed = [...liveFeed, { type: 'content', content: evt.content, time }];
            } else if (evt.type === 'tool_start' && evt.tool) {
              const inputStr = typeof evt.input === 'string' ? evt.input : JSON.stringify(evt.input || {});
              liveFeed = [...liveFeed, { type: 'tool_start', content: inputStr, tool: evt.tool, time }];
            } else if (evt.type === 'tool_end' && evt.tool) {
              const outputStr = typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.output || '');
              liveFeed = [...liveFeed, { type: 'tool_end', content: outputStr, tool: evt.tool, time }];
            } else if (evt.type === 'thinking' && evt.content) {
              liveFeed = [...liveFeed, { type: 'thinking', content: evt.content, time }];
            }
          }
          // Auto-scroll
          requestAnimationFrame(() => {
            if (liveFeedEl) liveFeedEl.scrollTop = liveFeedEl.scrollHeight;
          });
        }
        if (data.type === 'status' && (data.status === 'completed' || data.status === 'failed' || data.status === 'canceled')) {
          disconnectLiveStream();
          orgStore.loadDashboard();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      disconnectLiveStream();
    };
  }

  function disconnectLiveStream() {
    if (liveEventSource) {
      liveEventSource.close();
      liveEventSource = null;
    }
  }

  function renderMd(node: HTMLElement, text: string) {
    function update(t: string) {
      node.innerHTML = renderMarkdown(t);
      highlightCode(node);
    }
    update(text);
    return { update };
  }
</script>

<div class="space-y-4 h-full overflow-y-auto pb-6 view-panel">
  {#if !orgStore.selectedOrg}
    <div class="empty-state">
      <i class="fas fa-chart-line empty-icon"></i>
      <p>Select an organization to view its dashboard.</p>
      <button class="btn btn-accent btn-sm" onclick={() => appStore.setTab('organizations')}>
        Go to Organizations
      </button>
    </div>
  {:else if !orgStore.dashboard}
    <div class="empty-state">
      <i class="fas fa-spinner fa-spin empty-icon"></i>
      <p>Loading dashboard...</p>
    </div>
  {:else}
    {@const d = orgStore.dashboard}
    <div class="page-header">
      <h2 class="page-title">
        <i class="fas fa-chart-line"></i> Dashboard
        <span class="title-org">({orgStore.selectedOrg.name})</span>
      </h2>
      <button class="btn btn-ghost btn-sm" onclick={() => orgStore.loadDashboard()}>
        <i class="fas fa-sync-alt"></i> Refresh
      </button>
    </div>

    <!-- CEO Status Card -->
    <div class="ceo-status-card">
      <div class="ceo-header">
        <div class="ceo-icon-wrap" class:working={d.ceo.status === 'working'}>
          <i class="fas fa-crown"></i>
        </div>
        <div class="ceo-info">
          <div class="ceo-label">
            {d.ceo.configured ? (d.ceo.type === 'agent' ? `Agent CEO: ${d.ceo.agentName}` : 'Claude Code CEO') : 'No CEO Configured'}
          </div>
          <div class="ceo-meta">
            {#if d.ceo.configured}
              <span class="ceo-status-badge" class:idle={d.ceo.status === 'idle'} class:working={d.ceo.status === 'working'}>
                {d.ceo.status}
              </span>
              {#if d.ceo.lastRunAt}
                <span>Last active: {formatDate(d.ceo.lastRunAt)}</span>
              {/if}
              {#if d.ceo.heartbeatEnabled && d.ceo.heartbeatSchedule}
                <span class="hb-badge"><i class="fas fa-heartbeat"></i> {SCHEDULE_LABELS[d.ceo.heartbeatSchedule] || d.ceo.heartbeatSchedule}</span>
              {/if}
            {/if}
          </div>
        </div>
        <div class="ceo-actions">
          {#if d.ceo.status === 'working' && activeRunTaskId}
            <button class="btn btn-ghost btn-sm live-btn" onclick={() => appStore.setTab('monitor')} title="View live in Monitor">
              <i class="fas fa-eye"></i> View Live
            </button>
            <button class="btn btn-ghost btn-sm stop-btn" onclick={forceStopCEO} title="Force stop CEO">
              <i class="fas fa-stop"></i> Stop
            </button>
          {/if}
          {#if d.ceo.configured && d.ceo.status !== 'working'}
            <button class="btn btn-accent btn-sm" onclick={wakeCEO} disabled={wakingCEO}>
              {#if wakingCEO}
                <i class="fas fa-spinner fa-spin"></i> Waking...
              {:else}
                <i class="fas fa-bolt"></i> Wake CEO
              {/if}
            </button>
          {/if}
          <button class="btn btn-ghost btn-sm" onclick={() => { showHbConfig = !showHbConfig; }} title="Heartbeat settings">
            <i class="fas fa-cog"></i>
          </button>
        </div>
      </div>

      {#if showHbConfig && d.ceo.configured}
        <div class="hb-config">
          <label class="form-check">
            <input type="checkbox" bind:checked={hbEnabled} />
            <span>Enable heartbeat</span>
          </label>
          {#if hbEnabled}
            <select class="input input-sm" bind:value={hbSchedule}>
              <option value="* * * * *">Every 1 min</option>
              <option value="*/5 * * * *">Every 5 min</option>
              <option value="*/10 * * * *">Every 10 min</option>
              <option value="*/30 * * * *">Every 30 min</option>
              <option value="0 */2 * * *">Every 2 hours</option>
              <option value="0 */6 * * *">Every 6 hours</option>
              <option value="0 */12 * * *">Every 12 hours</option>
              <option value="0 0 * * *">Every 24 hours</option>
            </select>
          {/if}
          <button class="btn btn-accent btn-sm" onclick={saveHeartbeatConfig}>Save</button>
        </div>
      {/if}

      {#if activeRunTaskId || liveFeed.length > 0}
        <div class="live-feed-section">
          <h4>
            <i class="fas fa-satellite-dish"></i>
            {#if d.ceo.status === 'working'}
              Live
            {:else}
              Last Run Output
            {/if}
          </h4>
          <div class="live-feed" bind:this={liveFeedEl}>
            {#each liveFeed as entry}
              <div class="live-entry" class:live-tool-start={entry.type === 'tool_start'} class:live-tool-end={entry.type === 'tool_end'} class:live-thinking={entry.type === 'thinking'}>
                <span class="live-time">{entry.time}</span>
                {#if entry.type === 'tool_start'}
                  <span class="live-icon"><i class="fas fa-play"></i></span>
                  <span class="live-tool-name">{entry.tool}</span>
                  <span class="live-tool-detail">{entry.content.length > 150 ? entry.content.slice(0, 150) + '...' : entry.content}</span>
                {:else if entry.type === 'tool_end'}
                  <span class="live-icon"><i class="fas fa-check"></i></span>
                  <span class="live-tool-name">{entry.tool}</span>
                  <span class="live-tool-result">{entry.content.length > 200 ? entry.content.slice(0, 200) + '...' : entry.content}</span>
                {:else if entry.type === 'thinking'}
                  <span class="live-icon"><i class="fas fa-brain"></i></span>
                  <span class="live-thinking-text">{entry.content.length > 200 ? entry.content.slice(0, 200) + '...' : entry.content}</span>
                {:else}
                  <span class="live-icon"><i class="fas fa-comment"></i></span>
                  <span class="live-content">{entry.content}</span>
                {/if}
              </div>
            {/each}
            {#if d.ceo.status === 'working' && liveFeed.length === 0}
              <div class="live-waiting"><i class="fas fa-spinner fa-spin"></i> Waiting for CEO output...</div>
            {/if}
          </div>
        </div>
      {/if}

      {#if d.ceo.lastRunSummary && d.ceo.status !== 'working'}
        <div class="ceo-summary">
          <h4>Latest Status Report</h4>
          <div class="summary-text markdown-body" use:renderMd={d.ceo.lastRunSummary}></div>
        </div>
      {/if}
    </div>

    <!-- Stats Grid -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">{d.tickets.total}</div>
        <div class="stat-label">Tickets</div>
        <div class="stat-breakdown">
          {#each Object.entries(d.tickets.byStatus) as [status, count]}
            <span class="stat-chip" style:color={statusColor(status)}>{count} {status.replace(/_/g, ' ')}</span>
          {/each}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-value">{d.runStats.totalRuns}</div>
        <div class="stat-label">CEO Runs</div>
        <div class="stat-breakdown">
          <span class="stat-chip">{d.runStats.last24hRuns} last 24h</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-value">{formatTokens(d.runStats.totalInputTokens + d.runStats.totalOutputTokens)}</div>
        <div class="stat-label">CEO Tokens</div>
        <div class="stat-breakdown">
          <span class="stat-chip">{formatCost(d.runStats.totalCost)} total</span>
          <span class="stat-chip">{formatCost(d.runStats.last7dCost)} last 7d</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-value">{d.agents.total}</div>
        <div class="stat-label">Org Members</div>
        <div class="stat-breakdown">
          {#each d.agents.members.slice(0, 3) as m}
            <span class="stat-chip">{m.agentName} ({m.role})</span>
          {/each}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-value">{d.taskStats.totalTasks}</div>
        <div class="stat-label">Agent Tasks</div>
        <div class="stat-breakdown">
          <span class="stat-chip">{formatTokens(d.taskStats.totalInputTokens + d.taskStats.totalOutputTokens)} tokens</span>
        </div>
      </div>
    </div>

    <!-- CEO Runs Log -->
    {#if d.runs.length > 0}
      <div class="section">
        <h3 class="section-title"><i class="fas fa-history"></i> CEO Activity</h3>
        <div class="runs-list">
          {#each d.runs as run}
            <button class="run-row" onclick={() => { expandedRunId = expandedRunId === run.id ? null : run.id; }}>
              <span class="run-type">{run.type}</span>
              <span class="run-status" class:completed={run.status === 'completed'} class:failed={run.status === 'failed'} class:running={run.status === 'running'}>
                {run.status}
              </span>
              <span class="run-meta">{formatDuration(run.durationMs)}</span>
              <span class="run-meta">{formatTokens(run.inputTokens + run.outputTokens)} tok</span>
              <span class="run-meta">{formatCost(run.costUsd)}</span>
              <span class="run-meta">{formatDate(run.startedAt)}</span>
              <span class="run-trigger">{run.triggerSource}</span>
              {#if run.status === 'running' && run.taskId}
                <span class="run-live" onclick={(e) => { e.stopPropagation(); appStore.setTab('monitor'); }} onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); appStore.setTab('monitor'); } }} role="button" tabindex="-1"><i class="fas fa-eye"></i></span>
              {/if}
            </button>
            {#if expandedRunId === run.id}
              <div class="run-detail">
                {#if run.summary}
                  <div class="run-summary markdown-body" use:renderMd={run.summary}></div>
                {/if}
                {#if run.error}
                  <div class="run-error">{run.error}</div>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/if}

    <!-- Recent Tickets -->
    {#if d.tickets.recentlyUpdated.length > 0}
      <div class="section">
        <h3 class="section-title">
          <i class="fas fa-ticket"></i> Recent Tickets
          <button class="btn btn-ghost btn-xs" onclick={() => appStore.setTab('tickets', orgStore.selectedOrg!.id)}>
            View all
          </button>
        </h3>
        <div class="recent-tickets">
          {#each d.tickets.recentlyUpdated as ticket}
            <div class="recent-ticket">
              <span class="rt-id">{ticket.identifier}</span>
              <span class="rt-title">{ticket.title}</span>
              <span class="rt-status" style:color={statusColor(ticket.status)}>{ticket.status.replace(/_/g, ' ')}</span>
              {#if ticket.assigneeAgent}
                <span class="rt-agent"><i class="fas fa-robot"></i> {ticket.assigneeAgent}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Agent Task Stats -->
    {#if d.taskStats.byAgent.length > 0}
      <div class="section">
        <h3 class="section-title"><i class="fas fa-robot"></i> Agent Performance</h3>
        <div class="agent-stats">
          {#each d.taskStats.byAgent as agent}
            <div class="agent-stat-row">
              <span class="as-name">{agent.name}</span>
              <span class="as-count">{agent.count} tasks</span>
              <span class="as-tokens">{formatTokens(agent.inputTokens + agent.outputTokens)} tokens</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page-header { display: flex; align-items: center; justify-content: space-between; }
  .page-title { font-size: 1.2rem; font-weight: 600; color: var(--text-1); display: flex; align-items: center; gap: 0.5rem; }
  .title-org { color: var(--text-3); font-size: 0.85rem; font-weight: 400; }
  .empty-state { text-align: center; padding: 3rem 1rem; color: var(--text-2); }
  .empty-icon { font-size: 2.5rem; opacity: 0.3; margin-bottom: 1rem; }

  /* CEO Status */
  .ceo-status-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem;
  }
  .ceo-header { display: flex; align-items: center; gap: 0.75rem; }
  .ceo-icon-wrap {
    width: 40px; height: 40px; border-radius: 50%; background: var(--hover);
    display: flex; align-items: center; justify-content: center;
    color: var(--accent); font-size: 1.1rem; flex-shrink: 0;
  }
  .ceo-icon-wrap.working { animation: pulse-glow 1.5s ease-in-out infinite; }
  @keyframes pulse-glow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(var(--accent-rgb, 99,102,241), 0.4); }
    50% { box-shadow: 0 0 0 8px rgba(var(--accent-rgb, 99,102,241), 0); }
  }
  .ceo-info { flex: 1; min-width: 0; }
  .ceo-label { font-weight: 600; color: var(--text-1); font-size: 0.92rem; }
  .ceo-meta { display: flex; align-items: center; gap: 0.6rem; font-size: 0.72rem; color: var(--text-3); flex-wrap: wrap; margin-top: 0.2rem; }
  .ceo-status-badge { font-weight: 700; text-transform: uppercase; font-size: 0.65rem; letter-spacing: 0.05em; }
  .ceo-status-badge.idle { color: var(--text-3); }
  .ceo-status-badge.working { color: var(--green); }
  .hb-badge { color: var(--cyan); }
  .ceo-actions { display: flex; gap: 0.25rem; flex-shrink: 0; }

  .hb-config {
    margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border);
    display: flex; align-items: flex-end; gap: 0.5rem; flex-wrap: wrap;
  }
  .form-check { display: flex; align-items: center; gap: 0.4rem; font-size: 0.82rem; color: var(--text-2); cursor: pointer; }
  .form-check input[type="checkbox"] { accent-color: var(--accent); }
  .ceo-summary { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
  .ceo-summary h4 { font-size: 0.72rem; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.3rem; }
  .summary-text { font-size: 0.82rem; color: var(--text-1); line-height: 1.5; max-height: 300px; overflow-y: auto; }

  /* Stats Grid */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.75rem; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 0.75rem; text-align: center;
  }
  .stat-value { font-size: 1.5rem; font-weight: 700; color: var(--text-1); }
  .stat-label { font-size: 0.72rem; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.3rem; }
  .stat-breakdown { display: flex; flex-wrap: wrap; gap: 0.25rem; justify-content: center; }
  .stat-chip { font-size: 0.65rem; background: var(--hover); padding: 1px 6px; border-radius: 4px; }

  /* Sections */
  .section { margin-top: 0.5rem; }
  .section-title {
    font-size: 0.85rem; font-weight: 600; color: var(--text-2);
    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;
  }

  /* CEO Runs */
  .runs-list { display: flex; flex-direction: column; gap: 2px; }
  .run-row {
    display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.6rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    cursor: pointer; font: inherit; color: inherit; text-align: left; width: 100%;
  }
  .run-row:hover { border-color: var(--accent); }
  .run-type { font-size: 0.72rem; font-weight: 600; color: var(--accent); text-transform: uppercase; min-width: 65px; }
  .run-status { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; min-width: 65px; }
  .run-status.completed { color: var(--green); }
  .run-status.failed { color: var(--red); }
  .run-status.running { color: var(--cyan); }
  .run-meta { font-size: 0.7rem; color: var(--text-3); }
  .run-trigger { font-size: 0.65rem; color: var(--text-3); margin-left: auto; background: var(--hover); padding: 1px 5px; border-radius: 3px; }
  .run-live { color: var(--green); font-size: 0.75rem; cursor: pointer; padding: 2px 4px; }
  .run-live:hover { color: var(--text-1); }
  .live-btn { color: var(--green); }
  .stop-btn { color: var(--red); }
  .stop-btn:hover { color: var(--text-1); background: rgba(239,68,68,0.15); }

  /* Live Feed */
  .live-feed-section { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
  .live-feed-section h4 { font-size: 0.72rem; color: var(--green); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; display: flex; align-items: center; gap: 0.4rem; }
  .live-feed { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .live-entry { display: flex; align-items: flex-start; gap: 0.4rem; font-size: 0.78rem; padding: 0.2rem 0; line-height: 1.4; }
  .live-time { color: var(--text-3); font-size: 0.65rem; min-width: 60px; flex-shrink: 0; padding-top: 1px; }
  .live-icon { width: 14px; flex-shrink: 0; text-align: center; font-size: 0.65rem; padding-top: 2px; }
  .live-entry.live-tool-start .live-icon { color: var(--cyan); }
  .live-entry.live-tool-end .live-icon { color: var(--green); }
  .live-entry.live-thinking .live-icon { color: var(--accent); }
  .live-tool-name { color: var(--cyan); font-weight: 600; font-size: 0.72rem; flex-shrink: 0; }
  .live-tool-detail { color: var(--text-3); font-size: 0.72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live-tool-result { color: var(--text-2); font-size: 0.72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live-thinking-text { color: var(--text-3); font-style: italic; font-size: 0.72rem; }
  .live-content { color: var(--text-1); }
  .live-waiting { color: var(--text-3); font-size: 0.78rem; padding: 0.5rem 0; }
  .run-detail { padding: 0.5rem 0.6rem; background: var(--hover-40); border-radius: 6px; margin-bottom: 2px; }
  .run-summary { font-size: 0.82rem; color: var(--text-1); line-height: 1.4; max-height: 300px; overflow-y: auto; }
  .run-error { font-size: 0.82rem; color: var(--red); white-space: pre-wrap; }

  /* Recent Tickets */
  .recent-tickets { display: flex; flex-direction: column; gap: 2px; }
  .recent-ticket {
    display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    font-size: 0.82rem;
  }
  .rt-id { font-size: 0.7rem; color: var(--text-3); font-family: monospace; min-width: 55px; }
  .rt-title { flex: 1; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt-status { font-size: 0.65rem; text-transform: uppercase; font-weight: 600; }
  .rt-agent { font-size: 0.68rem; color: var(--text-2); }

  /* Agent Stats */
  .agent-stats { display: flex; flex-direction: column; gap: 2px; }
  .agent-stat-row {
    display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0.6rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    font-size: 0.82rem;
  }
  .as-name { font-weight: 600; color: var(--text-1); flex: 1; }
  .as-count { font-size: 0.72rem; color: var(--text-3); }
  .as-tokens { font-size: 0.72rem; color: var(--text-3); }
</style>
