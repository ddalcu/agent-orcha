
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

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
                <div class="text-gray-500 text-center py-12">
                    <i class="fas fa-tasks text-4xl mb-4 block text-gray-600"></i>
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
                        <div class="task-row ${isSelected ? `border-indigo-500 bg-indigo-500/10` : 'border-dark-border hover:border-indigo-500/50'} bg-dark-surface border rounded-lg p-3 cursor-pointer transition-colors"
                             data-task-id="${task.id}">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-3 min-w-0">
                                    <i class="fas ${cfg.icon} text-${cfg.color}-400 text-sm flex-shrink-0"></i>
                                    <div class="min-w-0">
                                        <div class="flex items-center gap-2">
                                            <span class="font-medium text-gray-200 truncate">${task.target}</span>
                                            <span class="text-xs px-1.5 py-0.5 rounded ${kindBadgeClass(task.kind)}">${task.kind}</span>
                                        </div>
                                        <div class="text-xs text-gray-500 mt-0.5 truncate">${task.id}</div>
                                    </div>
                                </div>
                                <div class="flex items-center gap-3 flex-shrink-0">
                                    <span class="text-xs text-gray-500">${elapsed}</span>
                                    <span class="text-xs px-2 py-0.5 rounded-full bg-${cfg.color}-500/20 text-${cfg.color}-400">${cfg.label}</span>
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

    selectTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return;

        this.selectedTask = task;
        this.renderTaskList();

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
                    <i class="fas ${cfg.icon} text-${cfg.color}-400"></i>
                    <span class="font-medium text-gray-200">${task.target}</span>
                    <span class="text-xs px-1.5 py-0.5 rounded bg-${cfg.color}-500/20 text-${cfg.color}-400">${cfg.label}</span>
                </div>
                <div class="text-xs text-gray-500 mt-1">${task.id}</div>
            </div>`;

        this.querySelector('#detailMeta').innerHTML = `
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                    <span class="text-gray-500 block text-xs">Kind</span>
                    <span class="text-gray-300">${task.kind}</span>
                </div>
                <div>
                    <span class="text-gray-500 block text-xs">Created</span>
                    <span class="text-gray-300">${created}</span>
                </div>
                <div>
                    <span class="text-gray-500 block text-xs">Updated</span>
                    <span class="text-gray-300">${updated}</span>
                </div>
                <div>
                    <span class="text-gray-500 block text-xs">Completed</span>
                    <span class="text-gray-300">${completed}</span>
                </div>
            </div>`;

        // Input section
        this.querySelector('#detailInput').innerHTML = `
            <details class="group">
                <summary class="cursor-pointer text-sm font-medium text-gray-400 hover:text-gray-300 transition-colors">
                    <i class="fas fa-chevron-right text-xs mr-1 group-open:rotate-90 transition-transform inline-block"></i>
                    Input
                </summary>
                <pre class="mt-2 bg-dark-bg border border-dark-border rounded-lg p-3 text-xs text-gray-300 overflow-x-auto">${escapeHtml(JSON.stringify(task.input, null, 2))}</pre>
            </details>`;

        // Result / Error section
        const resultContainer = this.querySelector('#detailResult');
        if (task.error) {
            resultContainer.innerHTML = `
                <div>
                    <span class="text-sm font-medium text-red-400 block mb-2">Error</span>
                    <pre class="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-300 overflow-x-auto">${escapeHtml(task.error)}</pre>
                </div>`;
        } else if (task.result) {
            resultContainer.innerHTML = `
                <details open class="group">
                    <summary class="cursor-pointer text-sm font-medium text-gray-400 hover:text-gray-300 transition-colors">
                        <i class="fas fa-chevron-right text-xs mr-1 group-open:rotate-90 transition-transform inline-block"></i>
                        Result
                    </summary>
                    <pre class="mt-2 bg-dark-bg border border-dark-border rounded-lg p-3 text-xs text-gray-300 overflow-x-auto max-h-96 custom-scrollbar">${escapeHtml(JSON.stringify(task.result, null, 2))}</pre>
                </details>`;
        } else {
            resultContainer.innerHTML = `
                <div class="text-sm text-gray-500 italic">Awaiting result...</div>`;
        }

        // Input-required section
        const inputReqContainer = this.querySelector('#detailInputRequest');
        if (task.status === 'input-required' && task.inputRequest) {
            inputReqContainer.innerHTML = `
                <div class="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                    <div class="flex items-center gap-2 mb-3">
                        <i class="fas fa-question-circle text-amber-400"></i>
                        <span class="text-sm font-medium text-amber-400">Input Required</span>
                    </div>
                    <p class="text-sm text-gray-300 mb-3">${escapeHtml(task.inputRequest.question)}</p>
                    <div class="flex gap-2">
                        <input id="respondInput" type="text" placeholder="Type your response..."
                            class="flex-1 bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-amber-500" />
                        <button id="respondBtn" class="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-lg transition-colors">
                            Send
                        </button>
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
                <button id="cancelBtn" class="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 text-sm font-medium rounded-lg border border-red-500/30 transition-colors">
                    <i class="fas fa-ban mr-1"></i> Cancel Task
                </button>`;
            this.querySelector('#cancelBtn').addEventListener('click', () => this.handleCancel());
        } else {
            actionsContainer.innerHTML = '';
        }
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
            <div class="space-y-6 h-full overflow-y-auto pb-8 custom-scrollbar">
                <div class="flex items-center justify-between border-b border-dark-border pb-4">
                    <div>
                        <h2 class="text-lg font-semibold text-gray-200">Monitor</h2>
                        <p class="text-xs text-gray-500 mt-1">Track async task execution in real time</p>
                    </div>
                    <div class="flex items-center gap-3">
                        <select id="filterKind" class="bg-dark-surface border border-dark-border rounded-lg px-2 py-1 text-sm text-gray-300 focus:outline-none focus:border-indigo-500">
                            <option value="">All kinds</option>
                            <option value="agent">Agent</option>
                            <option value="workflow">Workflow</option>
                            <option value="llm">LLM</option>
                        </select>
                        <select id="filterStatus" class="bg-dark-surface border border-dark-border rounded-lg px-2 py-1 text-sm text-gray-300 focus:outline-none focus:border-indigo-500">
                            <option value="">All statuses</option>
                            <option value="submitted">Submitted</option>
                            <option value="working">Working</option>
                            <option value="completed">Completed</option>
                            <option value="failed">Failed</option>
                            <option value="canceled">Canceled</option>
                            <option value="input-required">Input Required</option>
                        </select>
                        <button id="refreshBtn" class="p-2 text-gray-400 hover:text-gray-200 transition-colors" title="Refresh">
                            <i class="fas fa-sync-alt text-sm"></i>
                        </button>
                    </div>
                </div>

                <div id="tasksListContainer"></div>

                <div id="taskDetailArea" class="hidden border-t border-dark-border pt-6 space-y-4">
                    <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-4">
                        <div class="flex items-center justify-between">
                            <div id="detailHeader"></div>
                            <button id="closeDetailBtn" class="text-gray-500 hover:text-gray-300 transition-colors">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                    </div>

                    <div id="detailMeta" class="bg-dark-surface/50 border border-dark-border rounded-lg p-4"></div>
                    <div id="detailInputRequest"></div>
                    <div id="detailInput"></div>
                    <div id="detailResult"></div>
                    <div id="detailActions"></div>
                </div>
            </div>
        `;
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function kindBadgeClass(kind) {
    const map = {
        agent: 'bg-blue-500/20 text-blue-400',
        workflow: 'bg-purple-500/20 text-purple-400',
        llm: 'bg-emerald-500/20 text-emerald-400',
    };
    return map[kind] || 'bg-gray-500/20 text-gray-400';
}

customElements.define('monitor-view', MonitorView);
