
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

export class WorkflowsView extends Component {
    constructor() {
        super();
        this.isLoading = false;
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

    async loadWorkflows() {
        try {
            const workflows = await api.getWorkflows();
            const select = this.querySelector('#workflowSelect');
            select.innerHTML = '<option value="">-- Select Workflow --</option>' +
                workflows.map(wf => `<option value="${wf.name}">${wf.name} - ${wf.description}</option>`).join('');
        } catch (e) {
            console.error('Failed to load workflows', e);
        }
    }

    async onWorkflowSelected(name) {
        if (!name) {
            this.selectedWorkflow = null;
            this.renderDiagram([]);
            this.querySelector('#workflowInputs').innerHTML = '';
            this.querySelector('#runWorkflow').disabled = true;
            return;
        }

        try {
            const workflow = await api.getWorkflow(name);
            this.selectedWorkflow = workflow;
            this.renderInputs(workflow.input?.schema || {});
            this.renderDiagram(workflow.steps || []);
            this.querySelector('#runWorkflow').disabled = false;
        } catch (e) {
            console.error('Failed to load workflow details', e);
        }
    }

    renderInputs(schema) {
        const container = this.querySelector('#workflowInputs');
        container.innerHTML = '';

        if (Object.keys(schema).length === 0) return;

        container.innerHTML = `
            <label class="block text-sm font-medium text-gray-300 mb-2">Workflow Inputs</label>
            <div class="space-y-2">
                ${Object.entries(schema).map(([key, field]) => `
                    <input type="text" id="wf-${key}" 
                        placeholder="${key}${field.required ? ' *' : ''}${field.default ? ` (default: ${field.default})` : ''}"
                        value="${field.default || ''}"
                        class="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent">
                `).join('')}
            </div>
        `;
    }

    renderDiagram(steps) {
        const container = this.querySelector('#flowDiagram');
        if (!steps.length) {
            container.innerHTML = '<div class="text-gray-500 italic text-center py-8">No steps defined</div>';
            return;
        }

        container.innerHTML = `
            <div class="flex items-center gap-3 flex-nowrap min-w-max">
                <div class="flex flex-col items-center px-5 py-3 bg-green-500/10 border border-green-500/30 rounded-lg min-w-[100px] text-center">
                    <span class="font-semibold text-green-400 text-sm">Input</span>
                </div>
                ${steps.map(step => `
                    <span class="text-gray-600 text-xl flex-shrink-0">→</span>
                    <div id="step-${step.id}" class="step-node flex flex-col items-center px-4 py-3 bg-blue-500/10 border border-blue-500/30 rounded-lg min-w-[120px] text-center transition-all">
                        <span class="font-semibold text-blue-300 text-sm">${step.id}</span>
                        <span class="text-xs text-gray-400 mt-0.5">${step.agent}</span>
                    </div>
                `).join('')}
                <span class="text-gray-600 text-xl flex-shrink-0">→</span>
                <div class="flex flex-col items-center px-5 py-3 bg-green-500/10 border border-green-500/30 rounded-lg min-w-[100px] text-center">
                    <span class="font-semibold text-green-400 text-sm">Output</span>
                </div>
            </div>
        `;
    }

    async runWorkflow() {
        if (!this.selectedWorkflow) return;

        const inputs = {};
        this.querySelectorAll('input[id^="wf-"]').forEach(input => {
            const key = input.id.replace('wf-', '');
            if (input.value) inputs[key] = input.value;
        });

        const outputEl = this.querySelector('#workflowOutput');
        const statusEl = this.querySelector('#workflowStatus');
        const runBtn = this.querySelector('#runWorkflow');

        statusEl.classList.remove('hidden');
        outputEl.textContent = 'Starting workflow...';
        runBtn.disabled = true;

        this.startChartUpdate();

        try {
            const res = await api.startWorkflowStream(this.selectedWorkflow.name, inputs);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;
                        try {
                            const update = JSON.parse(data);
                            this.handleStatusUpdate(update);
                        } catch (e) { }
                    }
                }
            }
        } catch (e) {
            outputEl.textContent = 'Error: ' + e.message;
        } finally {
            runBtn.disabled = false;
            this.stopChartUpdate();
        }
    }

    handleStatusUpdate(update) {
        if (update.type === 'status') {
            const { message, type, stepId } = update.data;
            this.querySelector('#statusMessage').textContent = message;
            this.addLog(message, type);

            if (stepId) {
                const stepEl = this.querySelector(`#step-${stepId}`);
                if (stepEl) {
                    if (type === 'step_start') stepEl.className = stepEl.className.replace('bg-blue-500/10', 'bg-yellow-500/10 animate-pulse').replace('border-blue-500/30', 'border-yellow-500/30');
                    if (type === 'step_complete') stepEl.className = stepEl.className.replace('bg-yellow-500/10 animate-pulse', 'bg-green-500/10').replace('border-yellow-500/30', 'border-green-500/30');
                }
            }
        } else if (update.type === 'result') {
            const outputEl = this.querySelector('#workflowOutput');
            outputEl.textContent = JSON.stringify(update.data.output, null, 2);
        }
    }

    addLog(msg, type) {
        const log = this.querySelector('#statusLog');
        const div = document.createElement('div');
        div.className = 'text-xs font-mono';
        if (type === 'step_error') div.classList.add('text-red-400');
        else if (type === 'step_complete') div.classList.add('text-green-400');
        else div.classList.add('text-gray-400');

        div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    }

    startChartUpdate() {
        const start = Date.now();
        const timeEl = this.querySelector('#statusTime');
        this.chartInterval = setInterval(() => {
            const seconds = Math.floor((Date.now() - start) / 1000);
            timeEl.textContent = `${seconds}s`;
        }, 1000);
    }

    stopChartUpdate() {
        if (this.chartInterval) clearInterval(this.chartInterval);
    }

    postRender() {
        this.querySelector('#workflowSelect').addEventListener('change', (e) => {
            this.onWorkflowSelected(e.target.value);
        });
        this.querySelector('#runWorkflow').addEventListener('click', () => {
            this.runWorkflow();
        });
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-8 custom-scrollbar">
                <div>
                    <label class="block text-sm font-medium text-gray-300 mb-2">Select Workflow</label>
                    <select id="workflowSelect"
                        class="w-full bg-dark-surface border border-dark-border rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent">
                        <option value="">Loading...</option>
                    </select>
                </div>

                <div id="flowDiagram" class="bg-dark-surface border border-dark-border rounded-lg p-6 overflow-x-auto min-h-[120px] flex items-center justify-center">
                    <div class="text-gray-500 italic">Select a workflow</div>
                </div>

                <div id="workflowInputs" class="space-y-3"></div>

                <div id="workflowStatus" class="bg-dark-surface border border-dark-border rounded-lg p-5 hidden">
                    <div class="flex justify-between items-center mb-3">
                        <div id="statusMessage" class="font-medium text-gray-200">Ready</div>
                        <div id="statusTime" class="text-sm text-gray-400">0s</div>
                    </div>
                    <div id="statusLog" class="bg-dark-bg rounded-lg p-3 h-32 overflow-y-auto space-y-1 border border-dark-border"></div>
                </div>

                <button id="runWorkflow" disabled
                    class="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium px-6 py-2.5 rounded-lg transition-colors w-full sm:w-auto">
                    Run Workflow
                </button>

                <div>
                    <label class="block text-sm font-medium text-gray-300 mb-2">Output</label>
                    <div id="workflowOutput"
                        class="bg-dark-surface border border-dark-border rounded-lg p-4 min-h-[200px] font-mono text-sm text-gray-300 whitespace-pre-wrap overflow-x-auto"></div>
                </div>
            </div>
        `;
    }
}

customElements.define('workflows-view', WorkflowsView);
