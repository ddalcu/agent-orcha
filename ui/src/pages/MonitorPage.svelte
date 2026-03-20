<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api } from '../lib/services/api.js';
  import { escapeHtml, formatContextSize } from '../lib/utils/format.js';

  type TaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'input-required';
  type TaskKind = 'agent' | 'workflow' | 'llm';

  interface TaskEvent {
    timestamp: string;
    type: 'tool_start' | 'tool_end' | 'thinking' | 'content';
    tool?: string;
    input?: unknown;
    output?: unknown;
    content?: string;
  }

  interface TaskMetrics {
    iteration: number;
    messageCount: number;
    imageCount: number;
    contextChars: number;
    inputTokens?: number;
    outputTokens?: number;
  }

  interface TaskP2PMeta {
    direction: 'incoming' | 'outgoing';
    peerId: string;
    peerName: string;
  }

  interface Task {
    id: string;
    target: string;
    kind: TaskKind;
    status: TaskStatus;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    input?: unknown;
    result?: unknown;
    error?: string;
    inputRequest?: { question: string };
    events?: TaskEvent[];
    metrics?: TaskMetrics;
    p2p?: TaskP2PMeta;
  }

  const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
    submitted:        { label: 'Submitted',      color: 'gray',   icon: 'fa-clock' },
    working:          { label: 'Working',         color: 'blue',   icon: 'fa-spinner fa-spin' },
    completed:        { label: 'Completed',       color: 'green',  icon: 'fa-check-circle' },
    failed:           { label: 'Failed',          color: 'red',    icon: 'fa-times-circle' },
    canceled:         { label: 'Canceled',        color: 'yellow', icon: 'fa-ban' },
    'input-required': { label: 'Input Required',  color: 'amber',  icon: 'fa-question-circle' },
  };

  function kindBadgeVariant(kind: string): string {
    const map: Record<string, string> = { agent: 'blue', workflow: 'purple', llm: 'emerald' };
    return map[kind] || 'gray';
  }

  function formatElapsed(task: Task): string {
    const end = task.completedAt || Date.now();
    const ms = end - task.createdAt;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  let tasks: Task[] = $state([]);
  let selectedTask: Task | null = $state(null);
  let filterStatus = $state('');
  let filterKind = $state('');
  let respondText = $state('');

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let eventSource: EventSource | null = null;
  let activityFeedEl: HTMLElement | undefined = $state(undefined);

  // Start polling
  loadTasks();
  pollInterval = setInterval(() => loadTasks(), 3000);

  async function loadTasks() {
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterKind) params.set('kind', filterKind);
      const result: Task[] = await api.getTasks(params.toString());
      tasks = result;

      // Update selected task if still present
      if (selectedTask) {
        const updated = result.find(t => t.id === selectedTask!.id);
        if (updated) {
          // Preserve SSE-sourced events and metrics not in list response
          if (selectedTask.events?.length && !updated.events?.length) {
            updated.events = selectedTask.events;
          }
          if (selectedTask.metrics && !updated.metrics) {
            updated.metrics = selectedTask.metrics;
          }
          selectedTask = updated;
        }
      }
    } catch (e) {
      console.error('Failed to load tasks:', e);
    }
  }

  async function selectTask(taskId: string) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    selectedTask = task;
    respondText = '';

    // Fetch full task with events
    try {
      const full: Task = await api.getTask(taskId);
      selectedTask = full;
    } catch { /* fall back to list data */ }

    closeEventSource();
    if (!['completed', 'failed', 'canceled'].includes(task.status)) {
      startSSE(taskId);
    }
  }

  function closeDetail() {
    selectedTask = null;
    closeEventSource();
  }

  function closeEventSource() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  function startSSE(taskId: string) {
    closeEventSource();
    eventSource = api.streamTask(taskId);

    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'status' && selectedTask?.id === taskId) {
          loadTasks();
        }
        if (data.type === 'metrics' && selectedTask?.id === taskId) {
          selectedTask = { ...selectedTask!, metrics: data.metrics };
        }
        if (data.type === 'events' && selectedTask?.id === taskId) {
          const existing = selectedTask!.events || [];
          selectedTask = { ...selectedTask!, events: [...existing, ...data.events] };
          // Auto-scroll activity feed
          requestAnimationFrame(() => {
            if (activityFeedEl) activityFeedEl.scrollTop = activityFeedEl.scrollHeight;
          });
        }
        if (data.type === 'done') {
          closeEventSource();
        }
      } catch {
        // ignore parse errors
      }
    };

    eventSource.onerror = () => {
      closeEventSource();
    };
  }

  async function handleCancel() {
    if (!selectedTask) return;
    try {
      await api.cancelTask(selectedTask.id);
      await loadTasks();
    } catch (e) {
      console.error('Failed to cancel task:', e);
    }
  }

  async function handleRespond() {
    if (!selectedTask || !respondText.trim()) return;
    try {
      await api.respondToTask(selectedTask.id, respondText.trim());
      respondText = '';
      await loadTasks();
    } catch (e) {
      console.error('Failed to respond to task:', e);
    }
  }

  function handleRespondKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleRespond();
  }

  function truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max) + '...' : str;
  }

  function formatEventInput(input: unknown): string {
    if (typeof input === 'string') return input;
    return JSON.stringify(input ?? {});
  }

  function formatEventOutput(output: unknown): string {
    if (Array.isArray(output)) {
      return output.map((p: Record<string, unknown>) =>
        p.type === 'image' ? `[image ${formatContextSize(p.bytes as number)}]` : (p.text as string) || ''
      ).join(' ');
    }
    if (typeof output === 'string') return output;
    return '';
  }

  onDestroy(() => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    closeEventSource();
  });

  function getStatusConfig(status: string) {
    return STATUS_CONFIG[status] || STATUS_CONFIG.submitted;
  }
</script>

<div class="space-y-6 h-full overflow-y-auto pb-6 view-panel">
  <!-- Header -->
  <div class="monitor-header">
    <div>
      <h2 class="text-lg font-semibold text-primary">Monitor</h2>
      <p class="text-xs text-muted mt-1">Track async task execution in real time</p>
    </div>
    <div class="monitor-filters">
      <select class="select text-sm" bind:value={filterKind} onchange={() => loadTasks()}>
        <option value="">All kinds</option>
        <option value="agent">Agent</option>
        <option value="workflow">Workflow</option>
        <option value="llm">LLM</option>
      </select>
      <select class="select text-sm" bind:value={filterStatus} onchange={() => loadTasks()}>
        <option value="">All statuses</option>
        <option value="submitted">Submitted</option>
        <option value="working">Working</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="canceled">Canceled</option>
        <option value="input-required">Input Required</option>
      </select>
      <button class="btn-ghost" title="Refresh" onclick={() => loadTasks()}>
        <i class="fas fa-sync-alt text-sm"></i>
      </button>
    </div>
  </div>

  <!-- Task list -->
  {#if tasks.length === 0}
    <div class="empty-state">
      <i class="fas fa-tasks text-4xl mb-4 text-muted"></i>
      <p class="text-lg mb-2">No tasks found</p>
      <p class="text-sm">Submit a task via the API to see it here.</p>
    </div>
  {:else}
    <div class="space-y-2">
      {#each tasks as task (task.id)}
        {@const cfg = getStatusConfig(task.status)}
        <div class="task-row card" class:active={selectedTask?.id === task.id}
             onclick={() => selectTask(task.id)}
             role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && selectTask(task.id)}>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3 min-w-0">
              <i class="fas {cfg.icon} text-{cfg.color} text-sm flex-shrink-0"></i>
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-primary truncate">{task.target}</span>
                  <span class="badge badge-{kindBadgeVariant(task.kind)}">{task.kind}</span>
                  {#if task.p2p}
                    <span class="badge badge-{task.p2p.direction === 'incoming' ? 'amber' : 'cyan'}" title="{task.p2p.direction === 'incoming' ? 'From' : 'To'} {task.p2p.peerName}">
                      <i class="fas fa-{task.p2p.direction === 'incoming' ? 'arrow-down' : 'arrow-up'} mr-1"></i>P2P {task.p2p.peerName}
                    </span>
                  {/if}
                </div>
                <div class="text-xs text-muted mt-1 truncate">{task.id}</div>
              </div>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0">
              <span class="text-xs text-muted">{formatElapsed(task)}</span>
              <span class="badge badge-pill badge-{cfg.color}">{cfg.label}</span>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Detail panel -->
  {#if selectedTask}
    {@const cfg = getStatusConfig(selectedTask.status)}
    <div class="border-t pt-4 space-y-4">
      <!-- Detail header -->
      <div class="panel-dim">
        <div class="flex items-center justify-between">
          <div>
            <div class="flex items-center gap-2">
              <i class="fas {cfg.icon} text-{cfg.color}"></i>
              <span class="font-medium text-primary">{selectedTask.target}</span>
              <span class="badge badge-pill badge-{cfg.color}">{cfg.label}</span>
            </div>
            <div class="text-xs text-muted mt-1">{selectedTask.id}</div>
          </div>
          <button class="btn-ghost" onclick={closeDetail} title="Close detail"><i class="fas fa-times"></i></button>
        </div>
      </div>

      <!-- Meta grid -->
      <div class="panel-dim">
        <div class="grid grid-cols-4 gap-4 text-sm">
          <div>
            <span class="text-muted block text-xs">Kind</span>
            <span class="text-primary">{selectedTask.kind}</span>
          </div>
          <div>
            <span class="text-muted block text-xs">Created</span>
            <span class="text-primary">{new Date(selectedTask.createdAt).toLocaleString()}</span>
          </div>
          <div>
            <span class="text-muted block text-xs">Updated</span>
            <span class="text-primary">{new Date(selectedTask.updatedAt).toLocaleString()}</span>
          </div>
          <div>
            <span class="text-muted block text-xs">Completed</span>
            <span class="text-primary">{selectedTask.completedAt ? new Date(selectedTask.completedAt).toLocaleString() : '-'}</span>
          </div>
        </div>
      </div>

      <!-- P2P Info -->
      {#if selectedTask.p2p}
        <div class="panel-dim">
          <div class="flex items-center gap-2 mb-3">
            <i class="fas fa-network-wired text-accent text-sm"></i>
            <span class="text-sm font-medium text-secondary">P2P</span>
          </div>
          <div class="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span class="text-muted block text-xs">Direction</span>
              <span class="text-primary">
                <i class="fas fa-{selectedTask.p2p.direction === 'incoming' ? 'arrow-down text-amber' : 'arrow-up text-cyan'} mr-1"></i>
                {selectedTask.p2p.direction === 'incoming' ? 'Incoming' : 'Outgoing'}
              </span>
            </div>
            <div>
              <span class="text-muted block text-xs">Peer</span>
              <span class="text-primary">{selectedTask.p2p.peerName}</span>
            </div>
            <div>
              <span class="text-muted block text-xs">Peer ID</span>
              <span class="text-primary font-mono text-xs">{selectedTask.p2p.peerId.slice(0, 12)}...</span>
            </div>
          </div>
        </div>
      {/if}

      <!-- React-Loop Metrics -->
      {#if selectedTask.metrics}
        {@const m = selectedTask.metrics}
        <div class="panel-dim">
          <div class="flex items-center gap-2 mb-3">
            <i class="fas fa-chart-line text-accent text-sm"></i>
            <span class="text-sm font-medium text-secondary">React-Loop Metrics</span>
          </div>
          <div class="grid grid-cols-6 gap-4 text-sm">
            <div>
              <span class="text-muted block text-xs">Iteration</span>
              <span class="text-primary font-mono">{m.iteration}</span>
            </div>
            <div>
              <span class="text-muted block text-xs">Messages</span>
              <span class="text-primary font-mono">{m.messageCount}</span>
            </div>
            <div>
              <span class="text-muted block text-xs">Images</span>
              <span class="text-primary font-mono">{m.imageCount}</span>
            </div>
            <div>
              <span class="text-muted block text-xs">Context Size</span>
              <span class="text-primary font-mono">{formatContextSize(m.contextChars)}</span>
            </div>
            <div>
              <span class="text-muted block text-xs">Input Tokens</span>
              <span class="text-primary font-mono">{m.inputTokens ? m.inputTokens.toLocaleString() : '-'}</span>
            </div>
            <div>
              <span class="text-muted block text-xs">Output Tokens</span>
              <span class="text-primary font-mono">{m.outputTokens ? m.outputTokens.toLocaleString() : '-'}</span>
            </div>
          </div>
        </div>
      {/if}

      <!-- Input Required -->
      {#if selectedTask.status === 'input-required' && selectedTask.inputRequest}
        <div class="interrupt-prompt">
          <div class="flex items-center gap-2 mb-3">
            <i class="fas fa-question-circle text-amber"></i>
            <span class="text-sm font-medium text-amber">Input Required</span>
          </div>
          <p class="text-sm text-primary mb-3">{selectedTask.inputRequest.question}</p>
          <div class="flex gap-2">
            <input bind:value={respondText} type="text" placeholder="Type your response..."
                   class="input flex-1 text-sm" onkeydown={handleRespondKeydown} />
            <button class="btn btn-accent btn-sm" onclick={handleRespond}>Send</button>
          </div>
        </div>
      {/if}

      <!-- Input -->
      <details>
        <summary class="text-sm font-medium text-secondary">
          <i class="fas fa-chevron-right text-xs mr-1 chevron-icon"></i> Input
        </summary>
        <pre class="mt-2 panel-sm text-xs text-primary overflow-x-auto">{escapeHtml(JSON.stringify(selectedTask.input, null, 2))}</pre>
      </details>

      <!-- Result / Error -->
      {#if selectedTask.error}
        <div>
          <span class="text-sm font-medium text-red block mb-2">Error</span>
          <pre class="badge-outline-red rounded-lg p-4 text-xs overflow-x-auto">{escapeHtml(selectedTask.error)}</pre>
        </div>
      {:else if selectedTask.result}
        <details open>
          <summary class="text-sm font-medium text-secondary">
            <i class="fas fa-chevron-right text-xs mr-1 chevron-icon"></i> Result
          </summary>
          <pre class="mt-2 panel-sm text-xs text-primary overflow-x-auto overflow-y-auto monitor-scroll-panel">{escapeHtml(JSON.stringify(selectedTask.result, null, 2))}</pre>
        </details>
      {:else}
        <div class="text-sm text-muted italic">Awaiting result...</div>
      {/if}

      <!-- Activity feed -->
      {#if selectedTask.events?.length}
        <details open>
          <summary class="text-sm font-medium text-secondary">
            <i class="fas fa-chevron-right text-xs mr-1 chevron-icon"></i>
            Activity ({selectedTask.events.length} events)
          </summary>
          <div class="mt-2 panel-sm overflow-y-auto monitor-scroll-panel" bind:this={activityFeedEl}>
            {#each selectedTask.events as evt}
              {@const time = new Date(evt.timestamp).toLocaleTimeString()}
              <div class="monitor-event">
                <span class="monitor-event-time">{time}</span>
                <span class="text-xs">
                  {#if evt.type === 'tool_start'}
                    <i class="fas fa-play text-blue mr-1"></i>
                    <span class="text-blue-300 font-medium">{escapeHtml(evt.tool ?? '')}</span>
                    <span class="text-muted">{escapeHtml(truncate(formatEventInput(evt.input), 120))}</span>
                  {:else if evt.type === 'tool_end'}
                    <i class="fas fa-check text-green mr-1"></i>
                    <span class="text-green-300 font-medium">{escapeHtml(evt.tool ?? '')}</span>
                    <span class="text-secondary">{escapeHtml(truncate(formatEventOutput(evt.output), 200))}</span>
                  {:else if evt.type === 'thinking'}
                    <i class="fas fa-brain text-purple mr-1"></i>
                    <span class="text-purple-300">{escapeHtml(truncate(evt.content || '', 200))}</span>
                  {:else if evt.type === 'content'}
                    <i class="fas fa-comment text-secondary mr-1"></i>
                    <span class="text-primary">{escapeHtml(truncate(evt.content || '', 300))}</span>
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        </details>
      {/if}

      <!-- Cancel action -->
      {#if ['submitted', 'working', 'input-required'].includes(selectedTask.status)}
        <div>
          <button class="btn btn-danger btn-sm" onclick={handleCancel}>
            <i class="fas fa-ban"></i> Cancel Task
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
