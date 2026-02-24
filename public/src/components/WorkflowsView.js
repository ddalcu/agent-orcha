
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

const LOG_CONFIG = {
    workflow_start: { icon: 'fa-play', color: 'blue' },
    workflow_complete: { icon: 'fa-check-circle', color: 'green' },
    workflow_error: { icon: 'fa-times-circle', color: 'red' },
    workflow_interrupt: { icon: 'fa-pause-circle', color: 'amber' },
    step_start: { icon: 'fa-arrow-right', color: 'blue' },
    step_complete: { icon: 'fa-check', color: 'green' },
    step_error: { icon: 'fa-exclamation-triangle', color: 'red' },
    tool_discovery: { icon: 'fa-search', color: 'purple' },
    react_iteration: { icon: 'fa-sync-alt', color: 'blue' },
    tool_call: { icon: 'fa-wrench', color: 'cyan' },
    tool_result: { icon: 'fa-reply', color: 'teal' },
};

export class WorkflowsView extends Component {
    constructor() {
        super();
        this.workflows = [];
        this.selectedWorkflow = null;
        this.chartInterval = null;
    }

    async connectedCallback() {
        super.connectedCallback();
        this.loadWorkflows();
    }

    disconnectedCallback() {
        this.stopChartUpdate();
    }

    // ── Data ──

    async loadWorkflows() {
        try {
            this.workflows = await api.getWorkflows();
            this.renderCards();
        } catch (e) {
            console.error('Failed to load workflows', e);
        }
    }

    async selectWorkflow(name) {
        if (this.selectedWorkflow?.name === name) return;

        try {
            const full = await api.getWorkflow(name);
            this.selectedWorkflow = full;
            this.renderCards();
            this.renderDetail();
        } catch (e) {
            console.error('Failed to load workflow details', e);
        }
    }

    // ── Left sidebar: cards ──

    renderCards() {
        const container = this.querySelector('#workflowCards');
        if (!container) return;

        if (!this.workflows.length) {
            container.innerHTML = `
                <div class="text-gray-500 text-center py-12">
                    <i class="fas fa-project-diagram text-4xl mb-4 block text-gray-600"></i>
                    <p class="text-sm">No workflows found</p>
                </div>`;
            return;
        }

        container.innerHTML = this.workflows.map(wf => {
            const isSelected = this.selectedWorkflow?.name === wf.name;
            const isReact = wf.type === 'react';
            const badgeClass = isReact ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400';

            return `
                <div class="workflow-card cursor-pointer rounded-lg p-3 border transition-colors
                    ${isSelected ? 'bg-dark-surface border-purple-500' : 'bg-dark-surface/50 border-dark-border hover:border-purple-500/50'}"
                    data-name="${wf.name}">
                    <div class="flex items-center justify-between mb-1">
                        <span class="font-semibold text-gray-100 text-sm truncate">${this.escapeHtml(wf.name)}</span>
                        <span class="text-xs px-1.5 py-0.5 rounded ${badgeClass} flex-shrink-0">${wf.type || 'steps'}</span>
                    </div>
                    <div class="text-xs text-gray-500 line-clamp-2">${this.escapeHtml(wf.description || 'No description')}</div>
                    <div class="text-xs text-gray-600 mt-1">v${wf.version || '1.0.0'}${!isReact && wf.steps ? ` · ${wf.steps} steps` : ''}</div>
                </div>`;
        }).join('');

        container.querySelectorAll('.workflow-card').forEach(card => {
            card.addEventListener('click', () => this.selectWorkflow(card.dataset.name));
        });
    }

    // ── Right panel: detail ──

    renderDetail() {
        const container = this.querySelector('#workflowDetail');
        if (!container || !this.selectedWorkflow) {
            if (container) container.innerHTML = '<div class="text-gray-500 italic text-center py-12">Select a workflow to view details</div>';
            return;
        }

        const wf = this.selectedWorkflow;
        const isReact = wf.type === 'react';

        container.innerHTML = `
            ${this.buildInfoHtml(wf)}
            ${!isReact ? this.buildDiagramHtml(wf.steps || []) : ''}
            ${this.buildInputsHtml(wf.input?.schema || {})}
            <button id="runWorkflow"
                class="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium px-5 py-2 rounded-lg transition-colors flex items-center gap-2 text-sm">
                <i class="fas fa-play text-xs"></i>
                Run Workflow
            </button>
        `;

        this.querySelector('#runWorkflow')?.addEventListener('click', () => this.runWorkflow());
    }

    buildInfoHtml(wf) {
        const isReact = wf.type === 'react';
        const badgeClass = isReact ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400';

        let metaHtml = '';
        if (isReact) {
            const g = wf.graph || {};
            metaHtml = `
                <div class="grid grid-cols-4 gap-3 mt-3 pt-3 border-t border-dark-border">
                    <div><span class="text-gray-500 text-xs block">Model</span><span class="text-gray-300 text-sm">${this.escapeHtml(g.model || 'default')}</span></div>
                    <div><span class="text-gray-500 text-xs block">Mode</span><span class="text-gray-300 text-sm">${g.executionMode || 'react'}</span></div>
                    <div><span class="text-gray-500 text-xs block">Max Iter</span><span class="text-gray-300 text-sm">${g.maxIterations ?? 10}</span></div>
                    <div><span class="text-gray-500 text-xs block">Tools</span><span class="text-gray-300 text-sm">${g.tools?.mode || 'all'}</span></div>
                </div>`;
        } else {
            const c = wf.config || {};
            metaHtml = `
                <div class="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-dark-border">
                    <div><span class="text-gray-500 text-xs block">Steps</span><span class="text-gray-300 text-sm">${(wf.steps || []).length}</span></div>
                    <div><span class="text-gray-500 text-xs block">On Error</span><span class="text-gray-300 text-sm">${c.onError || 'stop'}</span></div>
                    <div><span class="text-gray-500 text-xs block">Timeout</span><span class="text-gray-300 text-sm">${((c.timeout || 300000) / 1000)}s</span></div>
                </div>`;
        }

        return `
            <div class="bg-dark-surface border border-dark-border rounded-lg p-4">
                <div class="flex items-center gap-3">
                    <i class="fas ${isReact ? 'fa-atom' : 'fa-project-diagram'} text-purple-400"></i>
                    <div class="min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-semibold text-gray-100">${this.escapeHtml(wf.name)}</span>
                            <span class="text-xs px-2 py-0.5 rounded-full ${badgeClass}">${wf.type || 'steps'}</span>
                            <span class="text-xs text-gray-500">v${wf.version || '1.0.0'}</span>
                        </div>
                        <p class="text-xs text-gray-400 mt-0.5">${this.escapeHtml(wf.description || '')}</p>
                    </div>
                </div>
                ${metaHtml}
            </div>`;
    }

    buildDiagramHtml(steps) {
        if (!steps.length) return '';

        const nodes = steps.map(step => `
            <span class="text-gray-600 text-lg flex-shrink-0">&rarr;</span>
            <div id="step-${step.id}" class="step-node flex flex-col items-center px-3 py-2 bg-blue-500/10 border border-blue-500/30 rounded-lg min-w-[100px] text-center transition-all">
                <span class="font-semibold text-blue-300 text-xs">${step.id}</span>
                <span class="text-xs text-gray-400">${step.agent}</span>
            </div>
        `).join('');

        return `
            <div class="bg-dark-surface border border-dark-border rounded-lg p-4 overflow-x-auto">
                <div class="flex items-center gap-2 flex-nowrap min-w-max">
                    <div class="flex flex-col items-center px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg min-w-[80px] text-center">
                        <span class="font-semibold text-green-400 text-xs">Input</span>
                    </div>
                    ${nodes}
                    <span class="text-gray-600 text-lg flex-shrink-0">&rarr;</span>
                    <div class="flex flex-col items-center px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg min-w-[80px] text-center">
                        <span class="font-semibold text-green-400 text-xs">Output</span>
                    </div>
                </div>
            </div>`;
    }

    buildInputsHtml(schema) {
        const entries = Object.entries(schema);
        if (!entries.length) return '';

        const fields = entries.map(([key, field]) => `
            <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3">
                <div class="flex items-center justify-between mb-1">
                    <label class="text-sm font-medium text-gray-300" for="wf-${key}">
                        ${this.escapeHtml(key)}${field.required ? '<span class="text-red-400 ml-1">*</span>' : ''}
                    </label>
                    <span class="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-500">${field.type || 'string'}</span>
                </div>
                <input type="text" id="wf-${key}"
                    placeholder="${field.default ? `Default: ${field.default}` : field.required ? 'Required' : 'Optional'}"
                    value="${field.default || ''}"
                    class="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent">
                ${field.description ? `<p class="text-xs text-gray-500 mt-1">${this.escapeHtml(field.description)}</p>` : ''}
            </div>
        `).join('');

        return `
            <div class="space-y-3">
                <h3 class="text-sm font-semibold text-gray-300 flex items-center gap-2">
                    <i class="fas fa-keyboard text-gray-500 text-xs"></i>
                    Inputs
                </h3>
                ${fields}
            </div>`;
    }

    // ── Execution ──

    async runWorkflow() {
        if (!this.selectedWorkflow) return;

        const inputs = {};
        this.querySelectorAll('input[id^="wf-"]').forEach(input => {
            const key = input.id.replace('wf-', '');
            if (input.value) inputs[key] = input.value;
        });

        const runBtn = this.querySelector('#runWorkflow');
        const logEl = this.querySelector('#statusLog');
        const outputEl = this.querySelector('#workflowOutput');

        logEl.innerHTML = '';
        outputEl.textContent = 'No output yet';
        outputEl.className = outputEl.className.replace('text-gray-300', 'text-gray-500');
        this.querySelector('#statusMessage').textContent = 'Starting...';
        this.querySelector('#statusDot').className = 'inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse';
        if (runBtn) runBtn.disabled = true;

        this.startChartUpdate();

        try {
            const res = await api.startWorkflowStream(this.selectedWorkflow.name, inputs);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                for (const line of chunk.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try { this.handleStatusUpdate(JSON.parse(data)); } catch (e) { }
                }
            }
        } catch (e) {
            this.addLog(`Error: ${e.message}`, 'workflow_error');
            this.querySelector('#statusMessage').textContent = 'Error';
            this.querySelector('#statusDot').className = 'inline-block w-2 h-2 rounded-full bg-red-400';
        } finally {
            if (runBtn) runBtn.disabled = false;
            this.stopChartUpdate();
        }
    }

    handleStatusUpdate(update) {
        if (update.type === 'status') {
            const { message, type, stepId } = update.data;
            const statusMsg = this.querySelector('#statusMessage');
            const statusDot = this.querySelector('#statusDot');

            if (type === 'workflow_complete') {
                statusMsg.textContent = 'Completed';
                statusDot.className = 'inline-block w-2 h-2 rounded-full bg-green-400';
            } else if (type === 'workflow_error') {
                statusMsg.textContent = 'Error';
                statusDot.className = 'inline-block w-2 h-2 rounded-full bg-red-400';
            } else if (type === 'workflow_interrupt') {
                statusMsg.textContent = 'Interrupted — Awaiting input';
                statusDot.className = 'inline-block w-2 h-2 rounded-full bg-amber-400';
            } else {
                statusMsg.textContent = message;
            }

            this.addLog(message, type);

            if (stepId) {
                const stepEl = this.querySelector(`#step-${stepId}`);
                if (stepEl) {
                    if (type === 'step_start') {
                        stepEl.className = stepEl.className
                            .replace('bg-blue-500/10', 'bg-yellow-500/10 animate-pulse')
                            .replace('border-blue-500/30', 'border-yellow-500/30');
                    }
                    if (type === 'step_complete') {
                        stepEl.className = stepEl.className
                            .replace('bg-yellow-500/10 animate-pulse', 'bg-green-500/10')
                            .replace('border-yellow-500/30', 'border-green-500/30');
                    }
                }
            }
        } else if (update.type === 'result') {
            const outputEl = this.querySelector('#workflowOutput');
            outputEl.className = outputEl.className.replace('text-gray-500', 'text-gray-300');
            outputEl.textContent = JSON.stringify(update.data.output || update.data, null, 2);
        }
    }

    addLog(msg, type) {
        const log = this.querySelector('#statusLog');
        const config = LOG_CONFIG[type] || { icon: 'fa-circle', color: 'gray' };

        const div = document.createElement('div');
        div.className = 'text-xs font-mono flex items-start gap-2 py-0.5';

        const time = new Date().toLocaleTimeString();
        div.innerHTML = `
            <span class="text-gray-600 flex-shrink-0">${time}</span>
            <i class="fas ${config.icon} text-${config.color}-400 text-xs mt-0.5 flex-shrink-0 w-3 text-center"></i>
            <span class="text-${config.color}-400">${this.escapeHtml(msg)}</span>
        `;

        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    }

    // ── Timer ──

    startChartUpdate() {
        this.stopChartUpdate();
        const start = Date.now();
        const timeEl = this.querySelector('#statusTime');
        timeEl.textContent = '0s';
        this.chartInterval = setInterval(() => {
            timeEl.textContent = `${Math.floor((Date.now() - start) / 1000)}s`;
        }, 1000);
    }

    stopChartUpdate() {
        if (this.chartInterval) {
            clearInterval(this.chartInterval);
            this.chartInterval = null;
        }
    }

    // ── Helpers ──

    escapeHtml(text) {
        if (!text) return '';
        return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    postRender() {
        // No static event bindings needed — cards and run button bind dynamically
    }

    template() {
        return `
            <div class="flex h-full gap-4">
                <!-- Left sidebar -->
                <div class="w-64 flex-shrink-0 overflow-y-auto custom-scrollbar pr-2">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">Workflows</h3>
                    </div>
                    <div id="workflowCards" class="space-y-2">
                        <div class="text-gray-500 italic text-center py-8 text-sm">Loading...</div>
                    </div>
                </div>

                <!-- Right panel -->
                <div class="flex-1 flex flex-col h-full overflow-hidden pl-4 border-l border-dark-border">
                    <!-- Detail area (scrollable) -->
                    <div id="workflowDetail" class="flex-1 overflow-y-auto custom-scrollbar space-y-3 pb-3 min-h-0">
                        <div class="text-gray-500 italic text-center py-12">Select a workflow to view details</div>
                    </div>

                    <!-- Activity & Output (always visible, pinned bottom) -->
                    <div class="flex-shrink-0 pt-3 border-t border-dark-border space-y-3">
                        <!-- Activity log -->
                        <div>
                            <div class="flex justify-between items-center mb-1.5">
                                <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                                    <i class="fas fa-terminal"></i>
                                    Activity
                                </h3>
                                <div class="flex items-center gap-2">
                                    <span id="statusDot" class="inline-block w-2 h-2 rounded-full bg-gray-600"></span>
                                    <span id="statusMessage" class="text-xs text-gray-500">Idle</span>
                                    <span id="statusTime" class="text-xs font-mono text-gray-600">&mdash;</span>
                                </div>
                            </div>
                            <div id="statusLog" class="bg-dark-bg rounded-lg p-2.5 h-32 overflow-y-auto space-y-0.5 border border-dark-border custom-scrollbar"></div>
                        </div>

                        <!-- Output -->
                        <div>
                            <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                                <i class="fas fa-code"></i>
                                Output
                            </h3>
                            <div id="workflowOutput" class="bg-dark-bg border border-dark-border rounded-lg p-2.5 h-24 font-mono text-xs text-gray-500 whitespace-pre-wrap overflow-auto custom-scrollbar">No output yet</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('workflows-view', WorkflowsView);
