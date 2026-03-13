
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';
import { escapeHtml as sharedEscapeHtml } from '../utils/card.js';

const STATUS_CONFIG = {
    submitted: { label: 'Submitted', color: 'gray', icon: 'fa-clock' },
    working: { label: 'Working', color: 'blue', icon: 'fa-spinner fa-spin' },
    completed: { label: 'Completed', color: 'green', icon: 'fa-check-circle' },
    failed: { label: 'Failed', color: 'red', icon: 'fa-times-circle' },
    canceled: { label: 'Canceled', color: 'yellow', icon: 'fa-ban' },
    'input-required': { label: 'Input Required', color: 'amber', icon: 'fa-question-circle' },
};

export class MonitorView extends Component {
    constructor() {
        super();
        this.tasks = [];
        this.selectedTask = null;
        this.pollInterval = null;
        this.filterStatus = '';
        this.filterKind = '';
        this.eventSource = null;
    }

    async connectedCallback() {
        super.connectedCallback();
        this.loadTasks();
        this.pollInterval = setInterval(() => this.loadTasks(), 3000);
    }

    disconnectedCallback() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.closeEventSource();
    }

    closeEventSource() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    async loadTasks() {
        try {
            const params = new URLSearchParams();
            if (this.filterStatus) params.set('status', this.filterStatus);
            if (this.filterKind) params.set('kind', this.filterKind);
            const tasks = await api.getTasks(params.toString());
            this.tasks = tasks;
            this.renderTaskList();

            if (this.selectedTask) {
                const updated = tasks.find(t => t.id === this.selectedTask.id);
                if (updated) {
                    // Preserve events and metrics from SSE — list API doesn't include them
                    if (this.selectedTask.events?.length && !updated.events?.length) {
                        updated.events = this.selectedTask.events;
                    }
                    if (this.selectedTask.metrics && !updated.metrics) {
                        updated.metrics = this.selectedTask.metrics;
                    }
                    this.selectedTask = updated;
                    this.renderDetailPanel();
                }
            }
        } catch (e) {
            console.error('Failed to load tasks:', e);
        }
    }

    renderTaskList() {
        const container = this.querySelector('#tasksListContainer');
        if (!container) return;

        if (!this.tasks.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-tasks text-4xl mb-4 text-muted"></i>
                    <p class="text-lg mb-2">No tasks found</p>
                    <p class="text-sm">Submit a task via the API to see it here.</p>
                </div>`;
            return;
        }

        container.innerHTML = `
            <div class="space-y-2">
                ${this.tasks.map(task => {
                    const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.submitted;
                    const isSelected = this.selectedTask?.id === task.id;
                    const elapsed = this.formatElapsed(task);
                    return `
                        <div class="task-row card ${isSelected ? 'active' : ''}" data-task-id="${task.id}">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-3 min-w-0">
                                    <i class="fas ${cfg.icon} text-${cfg.color} text-sm flex-shrink-0"></i>
                                    <div class="min-w-0">
                                        <div class="flex items-center gap-2">
                                            <span class="font-medium text-primary truncate">${task.target}</span>
                                            <span class="badge badge-${kindBadgeVariant(task.kind)}">${task.kind}</span>
                                        </div>
                                        <div class="text-xs text-muted mt-1 truncate">${task.id}</div>
                                    </div>
                                </div>
                                <div class="flex items-center gap-3 flex-shrink-0">
                                    <span class="text-xs text-muted">${elapsed}</span>
                                    <span class="badge badge-pill badge-${cfg.color}">${cfg.label}</span>
                                </div>
                            </div>
                        </div>`;
                }).join('')}
            </div>`;

        container.querySelectorAll('.task-row').forEach(row => {
            row.addEventListener('click', () => {
                this.selectTask(row.dataset.taskId);
            });
        });
    }

    async selectTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return;

        this.selectedTask = task;
        this.renderTaskList();

        // Fetch full task with events
        try {
            const full = await api.getTask(taskId);
            this.selectedTask = full;
        } catch { /* fall back to list data */ }

        const detailArea = this.querySelector('#taskDetailArea');
        detailArea.classList.remove('hidden');
        this.renderDetailPanel();

        this.closeEventSource();
        if (!['completed', 'failed', 'canceled'].includes(task.status)) {
            this.startSSE(taskId);
        }
    }

    renderDetailPanel() {
        const task = this.selectedTask;
        if (!task) return;

        const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.submitted;
        const created = new Date(task.createdAt).toLocaleString();
        const updated = new Date(task.updatedAt).toLocaleString();
        const completed = task.completedAt ? new Date(task.completedAt).toLocaleString() : '-';

        this.querySelector('#detailHeader').innerHTML = `
            <div>
                <div class="flex items-center gap-2">
                    <i class="fas ${cfg.icon} text-${cfg.color}"></i>
                    <span class="font-medium text-primary">${task.target}</span>
                    <span class="badge badge-pill badge-${cfg.color}">${cfg.label}</span>
                </div>
                <div class="text-xs text-muted mt-1">${task.id}</div>
            </div>`;

        this.querySelector('#detailMeta').innerHTML = `
            <div class="grid grid-cols-4 gap-4 text-sm">
                <div><span class="text-muted block text-xs">Kind</span><span class="text-primary">${task.kind}</span></div>
                <div><span class="text-muted block text-xs">Created</span><span class="text-primary">${created}</span></div>
                <div><span class="text-muted block text-xs">Updated</span><span class="text-primary">${updated}</span></div>
                <div><span class="text-muted block text-xs">Completed</span><span class="text-primary">${completed}</span></div>
            </div>`;

        // Metrics section (react-loop telemetry)
        const metricsContainer = this.querySelector('#detailMetrics');
        if (task.metrics) {
            const m = task.metrics;
            metricsContainer.innerHTML = `
                <div class="panel-dim">
                    <div class="flex items-center gap-2 mb-3">
                        <i class="fas fa-chart-line text-accent text-sm"></i>
                        <span class="text-sm font-medium text-secondary">React-Loop Metrics</span>
                    </div>
                    <div class="grid grid-cols-6 gap-4 text-sm">
                        <div><span class="text-muted block text-xs">Iteration</span><span class="text-primary font-mono">${m.iteration}</span></div>
                        <div><span class="text-muted block text-xs">Messages</span><span class="text-primary font-mono">${m.messageCount}</span></div>
                        <div><span class="text-muted block text-xs">Images</span><span class="text-primary font-mono">${m.imageCount}</span></div>
                        <div><span class="text-muted block text-xs">Context Size</span><span class="text-primary font-mono">${formatContextSize(m.contextChars)}</span></div>
                        <div><span class="text-muted block text-xs">Input Tokens</span><span class="text-primary font-mono">${m.inputTokens ? m.inputTokens.toLocaleString() : '-'}</span></div>
                        <div><span class="text-muted block text-xs">Output Tokens</span><span class="text-primary font-mono">${m.outputTokens ? m.outputTokens.toLocaleString() : '-'}</span></div>
                    </div>
                </div>`;
        } else {
            metricsContainer.innerHTML = '';
        }

        this.querySelector('#detailInput').innerHTML = `
            <details>
                <summary class="text-sm font-medium text-secondary">
                    <i class="fas fa-chevron-right text-xs mr-1 chevron-icon"></i> Input
                </summary>
                <pre class="mt-2 panel-sm text-xs text-primary overflow-x-auto">${escapeHtml(JSON.stringify(task.input, null, 2))}</pre>
            </details>`;

        const resultContainer = this.querySelector('#detailResult');
        if (task.error) {
            resultContainer.innerHTML = `
                <div>
                    <span class="text-sm font-medium text-red block mb-2">Error</span>
                    <pre class="badge-outline-red rounded-lg p-3 text-xs overflow-x-auto">${escapeHtml(task.error)}</pre>
                </div>`;
        } else if (task.result) {
            resultContainer.innerHTML = `
                <details open>
                    <summary class="text-sm font-medium text-secondary">
                        <i class="fas fa-chevron-right text-xs mr-1 chevron-icon"></i> Result
                    </summary>
                    <pre class="mt-2 panel-sm text-xs text-primary overflow-x-auto overflow-y-auto monitor-scroll-panel">${escapeHtml(JSON.stringify(task.result, null, 2))}</pre>
                </details>`;
        } else {
            resultContainer.innerHTML = `<div class="text-sm text-muted italic">Awaiting result...</div>`;
        }

        const inputReqContainer = this.querySelector('#detailInputRequest');
        if (task.status === 'input-required' && task.inputRequest) {
            inputReqContainer.innerHTML = `
                <div class="interrupt-prompt">
                    <div class="flex items-center gap-2 mb-3">
                        <i class="fas fa-question-circle text-amber"></i>
                        <span class="text-sm font-medium text-amber">Input Required</span>
                    </div>
                    <p class="text-sm text-primary mb-3">${escapeHtml(task.inputRequest.question)}</p>
                    <div class="flex gap-2">
                        <input id="respondInput" type="text" placeholder="Type your response..." class="input flex-1 text-sm" />
                        <button id="respondBtn" class="btn btn-accent btn-sm">Send</button>
                    </div>
                </div>`;
            this.querySelector('#respondBtn').addEventListener('click', () => this.handleRespond());
            this.querySelector('#respondInput').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.handleRespond();
            });
        } else {
            inputReqContainer.innerHTML = '';
        }

        // Actions
        const actionsContainer = this.querySelector('#detailActions');
        if (['submitted', 'working', 'input-required'].includes(task.status)) {
            actionsContainer.innerHTML = `
                <button id="cancelBtn" class="btn btn-danger btn-sm">
                    <i class="fas fa-ban"></i> Cancel Task
                </button>`;
            this.querySelector('#cancelBtn').addEventListener('click', () => this.handleCancel());
        } else {
            actionsContainer.innerHTML = '';
        }

        // Activity feed (events + LLM output)
        this.renderActivityFeed();
    }

    renderActivityFeed() {
        const container = this.querySelector('#detailActivity');
        const events = this.selectedTask?.events;
        if (!events?.length) {
            container.innerHTML = '';
            return;
        }

        const rows = events.map(evt => {
            const time = new Date(evt.timestamp).toLocaleTimeString();
            if (evt.type === 'tool_start') {
                const inputStr = typeof evt.input === 'string' ? evt.input : JSON.stringify(evt.input ?? {});
                const truncInput = inputStr.length > 120 ? inputStr.slice(0, 120) + '...' : inputStr;
                return `<div class="monitor-event">
                    <span class="monitor-event-time">${time}</span>
                    <span class="text-xs"><i class="fas fa-play text-blue mr-1"></i><span class="text-blue-300 font-medium">${escapeHtml(evt.tool)}</span> <span class="text-muted">${escapeHtml(truncInput)}</span></span>
                </div>`;
            }
            if (evt.type === 'tool_end') {
                let outputStr = '';
                if (Array.isArray(evt.output)) {
                    outputStr = evt.output.map(p => p.type === 'image' ? `[image ${formatContextSize(p.bytes)}]` : p.text || '').join(' ');
                } else if (typeof evt.output === 'string') {
                    outputStr = evt.output;
                }
                const truncOutput = outputStr.length > 200 ? outputStr.slice(0, 200) + '...' : outputStr;
                return `<div class="monitor-event">
                    <span class="monitor-event-time">${time}</span>
                    <span class="text-xs"><i class="fas fa-check text-green mr-1"></i><span class="text-green-300 font-medium">${escapeHtml(evt.tool)}</span> <span class="text-secondary">${escapeHtml(truncOutput)}</span></span>
                </div>`;
            }
            if (evt.type === 'thinking') {
                const truncContent = (evt.content || '').length > 200 ? evt.content.slice(0, 200) + '...' : evt.content;
                return `<div class="monitor-event">
                    <span class="monitor-event-time">${time}</span>
                    <span class="text-xs"><i class="fas fa-brain text-purple mr-1"></i><span class="text-purple-300">${escapeHtml(truncContent)}</span></span>
                </div>`;
            }
            if (evt.type === 'content') {
                const truncContent = (evt.content || '').length > 300 ? evt.content.slice(0, 300) + '...' : evt.content;
                return `<div class="monitor-event">
                    <span class="monitor-event-time">${time}</span>
                    <span class="text-xs"><i class="fas fa-comment text-secondary mr-1"></i><span class="text-primary">${escapeHtml(truncContent)}</span></span>
                </div>`;
            }
            return '';
        }).join('');

        container.innerHTML = `
            <details open>
                <summary class="text-sm font-medium text-secondary">
                    <i class="fas fa-chevron-right text-xs mr-1 chevron-icon"></i>
                    Activity (${events.length} events)
                </summary>
                <div class="mt-2 panel-sm overflow-y-auto monitor-scroll-panel">
                    ${rows}
                </div>
            </details>`;

        // Auto-scroll to bottom
        const feed = container.querySelector('.overflow-y-auto');
        if (feed) feed.scrollTop = feed.scrollHeight;
    }

    async handleCancel() {
        if (!this.selectedTask) return;
        try {
            await api.cancelTask(this.selectedTask.id);
            await this.loadTasks();
        } catch (e) {
            console.error('Failed to cancel task:', e);
        }
    }

    async handleRespond() {
        if (!this.selectedTask) return;
        const input = this.querySelector('#respondInput');
        const response = input?.value?.trim();
        if (!response) return;

        try {
            await api.respondToTask(this.selectedTask.id, response);
            await this.loadTasks();
        } catch (e) {
            console.error('Failed to respond to task:', e);
        }
    }

    startSSE(taskId) {
        this.closeEventSource();
        this.eventSource = api.streamTask(taskId);

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'status' && this.selectedTask?.id === taskId) {
                    this.loadTasks();
                }
                if (data.type === 'metrics' && this.selectedTask?.id === taskId) {
                    this.selectedTask.metrics = data.metrics;
                    this.renderDetailPanel();
                }
                if (data.type === 'events' && this.selectedTask?.id === taskId) {
                    if (!this.selectedTask.events) this.selectedTask.events = [];
                    this.selectedTask.events.push(...data.events);
                    this.renderActivityFeed();
                }
                if (data.type === 'done') {
                    this.closeEventSource();
                }
            } catch {
                // ignore parse errors
            }
        };

        this.eventSource.onerror = () => {
            this.closeEventSource();
        };
    }

    formatElapsed(task) {
        const end = task.completedAt || Date.now();
        const ms = end - task.createdAt;
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${(ms / 60000).toFixed(1)}m`;
    }

    postRender() {
        this.querySelector('#closeDetailBtn').addEventListener('click', () => {
            this.querySelector('#taskDetailArea').classList.add('hidden');
            this.selectedTask = null;
            this.closeEventSource();
            this.renderTaskList();
        });

        this.querySelector('#refreshBtn').addEventListener('click', () => this.loadTasks());

        this.querySelector('#filterStatus').addEventListener('change', (e) => {
            this.filterStatus = e.target.value;
            this.loadTasks();
        });

        this.querySelector('#filterKind').addEventListener('change', (e) => {
            this.filterKind = e.target.value;
            this.loadTasks();
        });
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-6 view-panel">
                <div class="flex items-center justify-between border-b pb-4">
                    <div>
                        <h2 class="text-lg font-semibold text-primary">Monitor</h2>
                        <p class="text-xs text-muted mt-1">Track async task execution in real time</p>
                    </div>
                    <div class="flex items-center gap-3">
                        <select id="filterKind" class="select text-sm">
                            <option value="">All kinds</option>
                            <option value="agent">Agent</option>
                            <option value="workflow">Workflow</option>
                            <option value="llm">LLM</option>
                        </select>
                        <select id="filterStatus" class="select text-sm">
                            <option value="">All statuses</option>
                            <option value="submitted">Submitted</option>
                            <option value="working">Working</option>
                            <option value="completed">Completed</option>
                            <option value="failed">Failed</option>
                            <option value="canceled">Canceled</option>
                            <option value="input-required">Input Required</option>
                        </select>
                        <button id="refreshBtn" class="btn-ghost" title="Refresh">
                            <i class="fas fa-sync-alt text-sm"></i>
                        </button>
                    </div>
                </div>

                <div id="tasksListContainer"></div>

                <div id="taskDetailArea" class="hidden border-t pt-4 space-y-4">
                    <div class="panel-dim">
                        <div class="flex items-center justify-between">
                            <div id="detailHeader"></div>
                            <button id="closeDetailBtn" class="btn-ghost"><i class="fas fa-times"></i></button>
                        </div>
                    </div>

                    <div id="detailMeta" class="panel-dim"></div>
                    <div id="detailMetrics"></div>
                    <div id="detailInputRequest"></div>
                    <div id="detailInput"></div>
                    <div id="detailResult"></div>
                    <div id="detailActivity"></div>
                    <div id="detailActions"></div>
                </div>
            </div>
        `;
    }
}

function escapeHtml(str) {
    return sharedEscapeHtml(str);
}

function kindBadgeVariant(kind) {
    const map = { agent: 'blue', workflow: 'purple', llm: 'emerald' };
    return map[kind] || 'gray';
}

function formatContextSize(chars) {
    if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M`;
    if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)}K`;
    return `${chars}`;
}

customElements.define('monitor-view', MonitorView);
