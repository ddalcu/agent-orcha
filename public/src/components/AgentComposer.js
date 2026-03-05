
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

const TOOL_PREFIXES = {
    'mcp':       'bg-blue-900/50 text-blue-300 border-blue-700/50',
    'knowledge': 'bg-purple-900/50 text-purple-300 border-purple-700/50',
    'function':  'bg-yellow-900/50 text-yellow-300 border-yellow-700/50',
    'builtin':   'bg-green-900/50 text-green-300 border-green-700/50',
    'sandbox':   'bg-orange-900/50 text-orange-300 border-orange-700/50',
    'workspace': 'bg-gray-800 text-gray-400 border-gray-700',
};

export class AgentComposer extends Component {
    constructor() {
        super();
        this._data = {};
        this._llmOptions = [];
        this._mcpServers = [];
        this._knowledgeStores = [];
        this._functions = [];
        this._skills = [];
        this._toolPickerOpen = false;
        this._toolPickerTab = 'mcp';
        this._toolPickerSearch = '';
    }

    set data(val) {
        this._data = JSON.parse(JSON.stringify(val || {}));
        this._loadExternalData().then(() => this._renderComposer());
    }

    getData() {
        this._readFormIntoData();
        return this._serializeClean();
    }

    _emitChange() {
        this.dispatchEvent(new CustomEvent('composer:change', { bubbles: true }));
    }

    async _loadExternalData() {
        try {
            const [llms, mcpServers, knowledgeStores, functions, skills] = await Promise.all([
                api.getLLMs().catch(() => []),
                api.getMCPServers().catch(() => []),
                api.getKnowledgeStores().catch(() => []),
                api.getFunctions().catch(() => []),
                api.getSkills().catch(() => []),
            ]);
            this._llmOptions = Array.isArray(llms) ? llms : (llms.models || []);
            this._mcpServers = Array.isArray(mcpServers) ? mcpServers : (mcpServers.servers || []);
            this._knowledgeStores = Array.isArray(knowledgeStores) ? knowledgeStores : (knowledgeStores.stores || []);
            this._functions = Array.isArray(functions) ? functions : (functions.functions || []);
            this._skills = Array.isArray(skills) ? skills : (skills.skills || []);
        } catch { /* silent */ }
    }

    _renderComposer() {
        let root = this.querySelector('#composerRoot');
        if (!root) {
            this.innerHTML = '<div id="composerRoot" class="overflow-y-auto h-full p-4 space-y-4"></div>';
            root = this.querySelector('#composerRoot');
        }
        root.innerHTML = this._buildHTML();
        this._attachListeners();
    }

    _buildHTML() {
        const d = this._data;
        const llm = d.llm;
        const llmName = typeof llm === 'string' ? llm : (llm?.name || 'default');
        const temp = typeof llm === 'object' ? llm.temperature : undefined;
        const prompt = d.prompt || {};
        const vars = prompt.inputVariables || [];
        const tools = (d.tools || []).map(t => typeof t === 'string' ? t : t.name);
        const mem = d.memory;
        const memEnabled = mem === true || (typeof mem === 'object' && mem?.enabled !== false);
        const memMaxLines = (typeof mem === 'object' && mem?.maxLines) || '';
        const output = d.output || {};
        const outFmt = output.format || 'text';
        const outSchema = output.schema ? JSON.stringify(output.schema, null, 2) : '';
        const pub = d.publish;
        const pubEnabled = pub === true || (typeof pub === 'object' && pub?.enabled);
        const pubPassword = (typeof pub === 'object' && pub?.password) || '';
        const skills = d.skills;
        const isAllSkills = Array.isArray(skills) && skills.length === 1 && skills[0] === '*';
        const selectedSkills = Array.isArray(skills) ? (isAllSkills ? [] : skills) : [];
        const questions = d.sampleQuestions || [];
        const meta = d.metadata ? JSON.stringify(d.metadata, null, 2) : '';

        const llmOptions = this._llmOptions.map(m => {
            const name = typeof m === 'string' ? m : m.name;
            return `<option value="${this._esc(name)}" ${name === llmName ? 'selected' : ''}>${this._esc(name)}</option>`;
        }).join('');

        const toolChips = tools.map(t => {
            const prefix = t.split(':')[0];
            const cls = TOOL_PREFIXES[prefix] || TOOL_PREFIXES['workspace'];
            return `<span class="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border ${cls}">
                ${this._esc(t)}<button class="remove-tool-btn hover:text-white ml-0.5" data-tool="${this._esc(t)}">&times;</button>
            </span>`;
        }).join('');

        const varChips = vars.map(v =>
            `<span class="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-green-900/50 text-green-300 border border-green-700/50">
                ${this._esc(v)}<button class="remove-var-btn hover:text-white ml-0.5" data-var="${this._esc(v)}">&times;</button>
            </span>`
        ).join('');

        const questionRows = questions.map((q, i) =>
            `<div class="flex gap-2">
                <input type="text" data-field="sampleQuestions.${i}" value="${this._esc(q)}"
                       class="composer-input flex-1 bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500" />
                <button class="remove-question-btn text-gray-500 hover:text-red-400 text-xs px-1" data-q-idx="${i}"><i class="fas fa-trash"></i></button>
            </div>`
        ).join('');

        return `
            <!-- Identity & LLM -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Identity</h3>
                    <div>
                        <label class="text-xs text-gray-500 block mb-1">Name</label>
                        <input type="text" data-field="name" value="${this._esc(d.name || '')}"
                               class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500" />
                    </div>
                    <div>
                        <label class="text-xs text-gray-500 block mb-1">Description</label>
                        <input type="text" data-field="description" value="${this._esc(d.description || '')}"
                               class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500" />
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div>
                            <label class="text-xs text-gray-500 block mb-1">Version</label>
                            <input type="text" data-field="version" value="${this._esc(d.version || '1.0.0')}"
                                   class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500" />
                        </div>
                        <div>
                            <label class="text-xs text-gray-500 block mb-1">Max Iterations</label>
                            <input type="number" data-field="maxIterations" value="${d.maxIterations || ''}" min="1" placeholder="Default"
                                   class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500" />
                        </div>
                    </div>
                </div>

                <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">LLM</h3>
                    <div>
                        <label class="text-xs text-gray-500 block mb-1">Model</label>
                        <select data-field="llm.name"
                                class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500">
                            <option value="default" ${llmName === 'default' ? 'selected' : ''}>default</option>
                            ${llmOptions}
                        </select>
                    </div>
                    <div>
                        <label class="text-xs text-gray-500 block mb-1">Temperature <span class="text-gray-600 font-mono" data-temp-display>${temp !== undefined ? temp : '—'}</span></label>
                        <input type="range" data-field="llm.temperature" min="0" max="2" step="0.1" value="${temp !== undefined ? temp : 0.7}"
                               class="w-full accent-gray-500" />
                        <div class="flex justify-between text-xs text-gray-600 mt-0.5">
                            <span>0 Precise</span>
                            <span>2 Creative</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Prompt -->
            <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">System Prompt</h3>
                <textarea data-field="prompt.system" rows="10"
                          class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-gray-500 font-mono resize-y">${this._esc(prompt.system || '')}</textarea>
                <div>
                    <label class="text-xs text-gray-500 block mb-1">Input Variables</label>
                    <div class="flex flex-wrap gap-1.5 mb-2">${varChips}</div>
                    <div class="flex gap-2">
                        <input type="text" id="newVarInput" placeholder="Add variable..."
                               class="flex-1 bg-dark-bg border border-dark-border rounded-lg px-3 py-1.5 text-sm text-gray-100 outline-none focus:border-gray-500" />
                        <button id="addVarBtn" class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-lg transition-colors">Add</button>
                    </div>
                </div>
            </div>

            <!-- Tools & Skills -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Tools</h3>
                    <div class="flex flex-wrap gap-1.5">${toolChips || '<span class="text-xs text-gray-600">No tools added</span>'}</div>
                    <button id="addToolBtn" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                        <i class="fas fa-plus mr-1"></i> Add tool
                    </button>
                    <div id="toolPicker" class="hidden"></div>
                </div>

                <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Skills</h3>
                    <div class="flex gap-3">
                        <label class="inline-flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                            <input type="radio" name="skillsMode" value="none" ${!skills ? 'checked' : ''} class="accent-gray-500 skills-mode-radio" /> None
                        </label>
                        <label class="inline-flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                            <input type="radio" name="skillsMode" value="all" ${isAllSkills ? 'checked' : ''} class="accent-gray-500 skills-mode-radio" /> All
                        </label>
                        <label class="inline-flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                            <input type="radio" name="skillsMode" value="specific" ${(Array.isArray(skills) && !isAllSkills) ? 'checked' : ''} class="accent-gray-500 skills-mode-radio" /> Specific
                        </label>
                    </div>
                    <div id="skillsList" class="${(Array.isArray(skills) && !isAllSkills) ? '' : 'hidden'} space-y-1">
                        ${this._skills.map(s => {
                            const name = typeof s === 'string' ? s : s.name;
                            const checked = selectedSkills.includes(name);
                            return `<label class="flex items-center gap-2 text-xs text-gray-400 cursor-pointer hover:text-gray-300">
                                <input type="checkbox" value="${this._esc(name)}" ${checked ? 'checked' : ''} class="accent-gray-500 skill-checkbox" /> ${this._esc(name)}
                            </label>`;
                        }).join('')}
                        ${this._skills.length === 0 ? '<span class="text-xs text-gray-600">No skills loaded</span>' : ''}
                    </div>
                </div>
            </div>

            <!-- Memory, Output, Publish -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Memory</h3>
                    <label class="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                        <input type="checkbox" data-field="memory.enabled" ${memEnabled ? 'checked' : ''} class="accent-gray-500 composer-input" />
                        Enable persistent memory
                    </label>
                    <div id="memoryFields" class="${memEnabled ? '' : 'hidden'}">
                        <label class="text-xs text-gray-500 block mb-1">Max Lines</label>
                        <input type="number" data-field="memory.maxLines" value="${memMaxLines}" min="1" placeholder="100"
                               class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500" />
                    </div>
                </div>

                <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Output</h3>
                    <div>
                        <label class="text-xs text-gray-500 block mb-1">Format</label>
                        <select data-field="output.format"
                                class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500">
                            <option value="text" ${outFmt === 'text' ? 'selected' : ''}>text</option>
                            <option value="structured" ${outFmt === 'structured' ? 'selected' : ''}>structured</option>
                        </select>
                    </div>
                    <div id="outputSchemaField" class="${outFmt === 'structured' ? '' : 'hidden'}">
                        <label class="text-xs text-gray-500 block mb-1">Schema (JSON)</label>
                        <textarea data-field="output.schema" rows="4"
                                  class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs text-gray-200 outline-none focus:border-gray-500 font-mono resize-y">${this._esc(outSchema)}</textarea>
                        <div id="outputSchemaError" class="hidden text-xs text-red-400 mt-1"></div>
                    </div>
                </div>

                <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Publish</h3>
                    <label class="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                        <input type="checkbox" data-field="publish.enabled" ${pubEnabled ? 'checked' : ''} class="accent-gray-500 composer-input" />
                        Standalone chat page
                    </label>
                    <div id="publishFields" class="${pubEnabled ? '' : 'hidden'}">
                        <label class="text-xs text-gray-500 block mb-1">Password</label>
                        <input type="text" data-field="publish.password" value="${this._esc(pubPassword)}" placeholder="Optional"
                               class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500" />
                    </div>
                </div>
            </div>

            <!-- Integrations -->
            <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                <div class="flex items-center justify-between">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Integrations</h3>
                    <div class="flex gap-1">
                        <button class="add-integration-btn text-xs text-gray-500 hover:text-gray-300 transition-colors" data-integ-type="collabnook"><i class="fas fa-plus mr-1"></i>Collabnook</button>
                        <button class="add-integration-btn text-xs text-gray-500 hover:text-gray-300 transition-colors ml-3" data-integ-type="email"><i class="fas fa-plus mr-1"></i>Email</button>
                    </div>
                </div>
                ${this._renderIntegrations()}
            </div>

            <!-- Triggers -->
            <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                <div class="flex items-center justify-between">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Triggers</h3>
                    <div class="flex gap-1">
                        <button class="add-trigger-btn text-xs text-gray-500 hover:text-gray-300 transition-colors" data-trigger-type="cron"><i class="fas fa-plus mr-1"></i>Cron</button>
                        <button class="add-trigger-btn text-xs text-gray-500 hover:text-gray-300 transition-colors ml-3" data-trigger-type="webhook"><i class="fas fa-plus mr-1"></i>Webhook</button>
                    </div>
                </div>
                ${this._renderTriggers()}
            </div>

            <!-- Sample Questions & Metadata -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Sample Questions</h3>
                    <div class="space-y-2">
                        ${questionRows || '<span class="text-xs text-gray-600">No sample questions</span>'}
                    </div>
                    <button id="addQuestionBtn" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                        <i class="fas fa-plus mr-1"></i> Add question
                    </button>
                </div>

                <div class="bg-dark-surface border border-dark-border rounded-lg p-4 space-y-3">
                    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Metadata</h3>
                    <textarea data-field="metadata" rows="6"
                              class="composer-input w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs text-gray-200 outline-none focus:border-gray-500 font-mono resize-y">${this._esc(meta)}</textarea>
                    <div id="metadataError" class="hidden text-xs text-red-400 mt-1"></div>
                </div>
            </div>
        `;
    }

    // ── Integrations sub-cards ──
    _renderIntegrations() {
        const integrations = this._data.integrations || [];
        if (!integrations.length) return '<div class="text-xs text-gray-600">No integrations configured</div>';
        return integrations.map((integ, i) => integ.type === 'email' ? this._renderEmailCard(integ, i) : this._renderCollabnookCard(integ, i)).join('');
    }

    _renderCollabnookCard(integ, idx) {
        return `
            <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3" data-integ-idx="${idx}">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs font-medium text-gray-400"><i class="fas fa-comments mr-1"></i>Collabnook</span>
                    <button class="remove-integration-btn text-xs text-gray-500 hover:text-red-400" data-integ-idx="${idx}"><i class="fas fa-trash"></i></button>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    ${this._field(`integrations.${idx}.url`, 'URL', integ.url)}
                    ${this._field(`integrations.${idx}.channel`, 'Channel', integ.channel)}
                    ${this._field(`integrations.${idx}.botName`, 'Bot Name', integ.botName)}
                    ${this._field(`integrations.${idx}.password`, 'Password', integ.password)}
                </div>
            </div>`;
    }

    _renderEmailCard(integ, idx) {
        const imap = integ.imap || {}, smtp = integ.smtp || {}, auth = integ.auth || {};
        return `
            <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3" data-integ-idx="${idx}">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs font-medium text-gray-400"><i class="fas fa-envelope mr-1"></i>Email</span>
                    <button class="remove-integration-btn text-xs text-gray-500 hover:text-red-400" data-integ-idx="${idx}"><i class="fas fa-trash"></i></button>
                </div>
                <div class="grid grid-cols-3 gap-2 mb-2">
                    ${this._field(`integrations.${idx}.imap.host`, 'IMAP Host', imap.host)}
                    ${this._fieldNum(`integrations.${idx}.imap.port`, 'Port', imap.port)}
                    ${this._fieldSelect(`integrations.${idx}.imap.secure`, 'Secure', imap.secure)}
                </div>
                <div class="grid grid-cols-3 gap-2 mb-2">
                    ${this._field(`integrations.${idx}.smtp.host`, 'SMTP Host', smtp.host)}
                    ${this._fieldNum(`integrations.${idx}.smtp.port`, 'Port', smtp.port)}
                    ${this._fieldSelect(`integrations.${idx}.smtp.secure`, 'Secure', smtp.secure)}
                </div>
                <div class="grid grid-cols-2 gap-2">
                    ${this._field(`integrations.${idx}.auth.user`, 'User', auth.user)}
                    ${this._field(`integrations.${idx}.auth.pass`, 'Password', auth.pass)}
                    ${this._field(`integrations.${idx}.fromName`, 'From Name', integ.fromName)}
                    ${this._field(`integrations.${idx}.fromAddress`, 'From Address', integ.fromAddress)}
                    ${this._fieldNum(`integrations.${idx}.pollInterval`, 'Poll Interval (s)', integ.pollInterval)}
                    ${this._field(`integrations.${idx}.folder`, 'Folder', integ.folder || 'INBOX')}
                </div>
            </div>`;
    }

    // ── Triggers sub-cards ──
    _renderTriggers() {
        const triggers = this._data.triggers || [];
        const inputVars = this._data.prompt?.inputVariables || [];
        const primaryVar = inputVars[0] || 'query';

        if (!triggers.length) return '<div class="text-xs text-gray-600">No triggers configured</div>';
        return triggers.map((trig, i) => {
            const isCron = trig.type === 'cron' || trig.schedule;
            const inputVal = (typeof trig.input === 'object' && trig.input) ? (trig.input[primaryVar] || '') : '';
            return `
                <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-3" data-trigger-idx="${i}">
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-xs font-medium text-gray-400"><i class="fas ${isCron ? 'fa-clock' : 'fa-link'} mr-1"></i>${isCron ? 'Cron' : 'Webhook'}</span>
                        <button class="remove-trigger-btn text-xs text-gray-500 hover:text-red-400" data-trigger-idx="${i}"><i class="fas fa-trash"></i></button>
                    </div>
                    <div class="grid grid-cols-2 gap-2">
                        ${isCron
                            ? `<div>
                                <label class="text-xs text-gray-500 block mb-0.5">Schedule</label>
                                <input type="text" data-field="triggers.${i}.schedule" value="${this._esc(trig.schedule || '')}" placeholder="*/5 * * * *"
                                       class="composer-input w-full bg-dark-bg border border-dark-border rounded px-2 py-1 text-xs text-gray-100 outline-none" />
                                <div class="flex flex-wrap gap-1 mt-1">
                                    <button class="cron-preset-btn px-1.5 py-0.5 text-[10px] text-gray-500 bg-dark-bg border border-dark-border rounded hover:text-gray-300 hover:border-gray-500 transition-colors" data-preset="* * * * *" data-trigger-idx="${i}">1min</button>
                                    <button class="cron-preset-btn px-1.5 py-0.5 text-[10px] text-gray-500 bg-dark-bg border border-dark-border rounded hover:text-gray-300 hover:border-gray-500 transition-colors" data-preset="*/5 * * * *" data-trigger-idx="${i}">5min</button>
                                    <button class="cron-preset-btn px-1.5 py-0.5 text-[10px] text-gray-500 bg-dark-bg border border-dark-border rounded hover:text-gray-300 hover:border-gray-500 transition-colors" data-preset="*/15 * * * *" data-trigger-idx="${i}">15min</button>
                                    <button class="cron-preset-btn px-1.5 py-0.5 text-[10px] text-gray-500 bg-dark-bg border border-dark-border rounded hover:text-gray-300 hover:border-gray-500 transition-colors" data-preset="0 * * * *" data-trigger-idx="${i}">hourly</button>
                                    <button class="cron-preset-btn px-1.5 py-0.5 text-[10px] text-gray-500 bg-dark-bg border border-dark-border rounded hover:text-gray-300 hover:border-gray-500 transition-colors" data-preset="0 */6 * * *" data-trigger-idx="${i}">6hr</button>
                                    <button class="cron-preset-btn px-1.5 py-0.5 text-[10px] text-gray-500 bg-dark-bg border border-dark-border rounded hover:text-gray-300 hover:border-gray-500 transition-colors" data-preset="0 0 * * *" data-trigger-idx="${i}">daily</button>
                                    <button class="cron-preset-btn px-1.5 py-0.5 text-[10px] text-gray-500 bg-dark-bg border border-dark-border rounded hover:text-gray-300 hover:border-gray-500 transition-colors" data-preset="0 0 * * 1" data-trigger-idx="${i}">weekly</button>
                                    <button class="cron-preset-btn px-1.5 py-0.5 text-[10px] text-gray-500 bg-dark-bg border border-dark-border rounded hover:text-gray-300 hover:border-gray-500 transition-colors" data-preset="0 0 1 * *" data-trigger-idx="${i}">monthly</button>
                                </div>
                              </div>`
                            : this._field(`triggers.${i}.path`, 'Path', trig.path, '/webhook/my-hook')
                        }
                        <div>
                            <label class="text-xs text-gray-500 block mb-0.5">Prompt <span class="text-gray-600 font-mono">(${this._esc(primaryVar)})</span></label>
                            <input type="text" data-field="triggers.${i}.inputVar" value="${this._esc(inputVal)}" placeholder="e.g. Generate the daily report"
                                   class="composer-input w-full bg-dark-bg border border-dark-border rounded px-2 py-1 text-xs text-gray-100 outline-none" />
                        </div>
                    </div>
                </div>`;
        }).join('');
    }

    // ── Shared field helpers ──
    _field(dataField, label, value, placeholder) {
        return `<div>
            <label class="text-xs text-gray-500 block mb-0.5">${label}</label>
            <input type="text" data-field="${dataField}" value="${this._esc(value || '')}" ${placeholder ? `placeholder="${placeholder}"` : ''}
                   class="composer-input w-full bg-dark-bg border border-dark-border rounded px-2 py-1 text-xs text-gray-100 outline-none" />
        </div>`;
    }
    _fieldNum(dataField, label, value) {
        return `<div>
            <label class="text-xs text-gray-500 block mb-0.5">${label}</label>
            <input type="number" data-field="${dataField}" value="${value || ''}"
                   class="composer-input w-full bg-dark-bg border border-dark-border rounded px-2 py-1 text-xs text-gray-100 outline-none" />
        </div>`;
    }
    _fieldSelect(dataField, label, value) {
        return `<div>
            <label class="text-xs text-gray-500 block mb-0.5">${label}</label>
            <select data-field="${dataField}"
                    class="composer-input w-full bg-dark-bg border border-dark-border rounded px-2 py-1 text-xs text-gray-100 outline-none">
                <option value="false" ${!value ? 'selected' : ''}>false</option>
                <option value="true" ${value ? 'selected' : ''}>true</option>
            </select>
        </div>`;
    }

    // ── Tool Picker ──
    _renderToolPicker() {
        const existing = new Set((this._data.tools || []).map(t => typeof t === 'string' ? t : t.name));
        const search = this._toolPickerSearch.toLowerCase();
        const tabs = [
            { id: 'mcp', label: 'MCP', items: this._mcpServers.map(s => `mcp:${s.name || s}`) },
            { id: 'knowledge', label: 'Knowledge', items: this._knowledgeStores.map(s => `knowledge:${s.name || s}`) },
            { id: 'function', label: 'Functions', items: this._functions.map(f => `function:${f.name || f}`) },
            { id: 'builtin', label: 'Builtin', items: ['builtin:ask_user'] },
            { id: 'sandbox', label: 'Sandbox', items: ['sandbox:shell','sandbox:exec','sandbox:web_fetch','sandbox:web_search','sandbox:browser_navigate','sandbox:browser_observe','sandbox:browser_click','sandbox:browser_type','sandbox:browser_screenshot','sandbox:browser_evaluate','sandbox:file_read','sandbox:file_write','sandbox:file_edit','sandbox:file_insert','sandbox:file_replace_lines'] },
        ];
        const active = tabs.find(t => t.id === this._toolPickerTab) || tabs[0];
        const filtered = active.items.filter(v => !search || v.toLowerCase().includes(search));

        return `
            <div class="bg-dark-bg border border-dark-border rounded-lg mt-2">
                <div class="flex border-b border-dark-border">
                    ${tabs.map(t => `<button class="tool-picker-tab flex-1 px-2 py-1.5 text-xs ${t.id === this._toolPickerTab ? 'text-gray-200 bg-dark-surface' : 'text-gray-600 hover:text-gray-400'}" data-tab="${t.id}">${t.label}</button>`).join('')}
                </div>
                <div class="p-2">
                    <input type="text" id="toolPickerSearch" placeholder="Filter..." value="${this._esc(this._toolPickerSearch)}"
                           class="w-full bg-dark-surface border border-dark-border rounded px-2 py-1 text-xs text-gray-100 outline-none mb-2" />
                    <div class="max-h-36 overflow-y-auto space-y-0.5">
                        ${filtered.length === 0 ? '<div class="text-xs text-gray-600 p-2 text-center">No items</div>' : ''}
                        ${filtered.map(item => {
                            const added = existing.has(item);
                            return `<div class="flex items-center justify-between px-2 py-1 rounded text-xs ${added ? 'text-gray-600' : 'text-gray-400 hover:bg-dark-surface cursor-pointer'}"
                                         ${!added ? `data-add-tool="${this._esc(item)}"` : ''}>
                                <span>${this._esc(item.split(':')[1] || item)}</span>
                                ${added ? '<i class="fas fa-check text-green-500 text-[10px]"></i>' : '<i class="fas fa-plus text-gray-600 text-[10px]"></i>'}
                            </div>`;
                        }).join('')}
                    </div>
                </div>
                <div class="border-t border-dark-border px-2 py-1 flex justify-end">
                    <button id="closeToolPicker" class="text-xs text-gray-600 hover:text-gray-400">Close</button>
                </div>
            </div>`;
    }

    // ── Listeners ──
    _attachListeners() {
        // Generic change tracking
        this.querySelectorAll('.composer-input').forEach(el => {
            const evt = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'range') ? 'change' : 'input';
            el.addEventListener(evt, () => this._emitChange());
        });

        // Temperature display
        const tempSlider = this.querySelector('[data-field="llm.temperature"]');
        const tempDisplay = this.querySelector('[data-temp-display]');
        if (tempSlider && tempDisplay) {
            tempSlider.addEventListener('input', () => { tempDisplay.textContent = tempSlider.value; });
        }

        // Memory toggle
        const memCheck = this.querySelector('[data-field="memory.enabled"]');
        const memFields = this.querySelector('#memoryFields');
        if (memCheck && memFields) memCheck.addEventListener('change', () => { memFields.classList.toggle('hidden', !memCheck.checked); this._emitChange(); });

        // Publish toggle
        const pubCheck = this.querySelector('[data-field="publish.enabled"]');
        const pubFields = this.querySelector('#publishFields');
        if (pubCheck && pubFields) pubCheck.addEventListener('change', () => { pubFields.classList.toggle('hidden', !pubCheck.checked); this._emitChange(); });

        // Output format toggle
        const outputFmt = this.querySelector('[data-field="output.format"]');
        const schemaField = this.querySelector('#outputSchemaField');
        if (outputFmt && schemaField) outputFmt.addEventListener('change', () => { schemaField.classList.toggle('hidden', outputFmt.value !== 'structured'); this._emitChange(); });

        // JSON validation
        this._attachJsonValidation('[data-field="metadata"]', '#metadataError');
        this._attachJsonValidation('[data-field="output.schema"]', '#outputSchemaError');

        // Input variables
        this._attachVarListeners();
        // Tools
        this._attachToolListeners();
        // Skills
        this._attachSkillListeners();
        // Sample questions
        this._attachQuestionListeners();
        // Integrations
        this._attachIntegrationListeners();
        // Triggers
        this._attachTriggerListeners();
    }

    _attachJsonValidation(fieldSel, errorSel) {
        const field = this.querySelector(fieldSel), error = this.querySelector(errorSel);
        if (!field || !error) return;
        field.addEventListener('blur', () => {
            const val = field.value.trim();
            if (!val) { error.classList.add('hidden'); field.classList.remove('border-red-500'); return; }
            try { JSON.parse(val); error.classList.add('hidden'); field.classList.remove('border-red-500'); }
            catch (e) { error.textContent = e.message; error.classList.remove('hidden'); field.classList.add('border-red-500'); }
        });
    }

    _attachVarListeners() {
        const addBtn = this.querySelector('#addVarBtn'), input = this.querySelector('#newVarInput');
        if (addBtn && input) {
            const add = () => {
                const val = input.value.trim();
                if (!val) return;
                if (!this._data.prompt) this._data.prompt = { system: '', inputVariables: [] };
                if (!this._data.prompt.inputVariables) this._data.prompt.inputVariables = [];
                if (!this._data.prompt.inputVariables.includes(val)) {
                    this._data.prompt.inputVariables.push(val);
                    this._emitChange();
                    this._renderComposer();
                }
            };
            addBtn.addEventListener('click', add);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
        }
        this.querySelectorAll('.remove-var-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this._data.prompt?.inputVariables) {
                    this._data.prompt.inputVariables = this._data.prompt.inputVariables.filter(x => x !== btn.dataset.var);
                    this._emitChange(); this._renderComposer();
                }
            });
        });
    }

    _attachToolListeners() {
        const addBtn = this.querySelector('#addToolBtn'), picker = this.querySelector('#toolPicker');
        if (addBtn && picker) {
            addBtn.addEventListener('click', () => {
                this._toolPickerOpen = !this._toolPickerOpen;
                if (this._toolPickerOpen) { picker.classList.remove('hidden'); picker.innerHTML = this._renderToolPicker(); this._attachToolPickerListeners(); }
                else { picker.classList.add('hidden'); picker.innerHTML = ''; }
            });
        }
        this.querySelectorAll('.remove-tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._data.tools = (this._data.tools || []).filter(t => (typeof t === 'string' ? t : t.name) !== btn.dataset.tool);
                this._emitChange(); this._readFormIntoData(); this._renderComposer();
            });
        });
    }

    _attachToolPickerListeners() {
        const picker = this.querySelector('#toolPicker');
        if (!picker) return;
        picker.querySelectorAll('.tool-picker-tab').forEach(tab => {
            tab.addEventListener('click', () => { this._toolPickerTab = tab.dataset.tab; this._readFormIntoData(); picker.innerHTML = this._renderToolPicker(); this._attachToolPickerListeners(); });
        });
        const searchInput = picker.querySelector('#toolPickerSearch');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                this._toolPickerSearch = searchInput.value; this._readFormIntoData();
                picker.innerHTML = this._renderToolPicker(); this._attachToolPickerListeners();
                const ni = picker.querySelector('#toolPickerSearch');
                if (ni) { ni.focus(); ni.selectionStart = ni.selectionEnd = ni.value.length; }
            });
        }
        picker.querySelectorAll('[data-add-tool]').forEach(el => {
            el.addEventListener('click', () => { if (!this._data.tools) this._data.tools = []; this._data.tools.push(el.dataset.addTool); this._emitChange(); this._readFormIntoData(); this._renderComposer(); });
        });
        picker.querySelector('#closeToolPicker')?.addEventListener('click', () => { this._toolPickerOpen = false; picker.classList.add('hidden'); picker.innerHTML = ''; });
    }

    _attachSkillListeners() {
        this.querySelectorAll('.skills-mode-radio').forEach(radio => {
            radio.addEventListener('change', () => {
                const mode = radio.value;
                this.querySelector('#skillsList')?.classList.toggle('hidden', mode !== 'specific');
                if (mode === 'none') this._data.skills = undefined;
                else if (mode === 'all') this._data.skills = ['*'];
                else this._data.skills = [];
                this._emitChange();
            });
        });
        this.querySelectorAll('.skill-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                if (!Array.isArray(this._data.skills)) this._data.skills = [];
                if (cb.checked) { if (!this._data.skills.includes(cb.value)) this._data.skills.push(cb.value); }
                else this._data.skills = this._data.skills.filter(s => s !== cb.value);
                this._emitChange();
            });
        });
    }

    _attachQuestionListeners() {
        this.querySelector('#addQuestionBtn')?.addEventListener('click', () => {
            this._readFormIntoData();
            if (!this._data.sampleQuestions) this._data.sampleQuestions = [];
            this._data.sampleQuestions.push('');
            this._emitChange(); this._renderComposer();
        });
        this.querySelectorAll('.remove-question-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.qIdx, 10);
                if (this._data.sampleQuestions) { this._readFormIntoData(); this._data.sampleQuestions.splice(idx, 1); this._emitChange(); this._renderComposer(); }
            });
        });
    }

    _attachIntegrationListeners() {
        this.querySelectorAll('.add-integration-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this._data.integrations) this._data.integrations = [];
                this._readFormIntoData();
                const type = btn.dataset.integType;
                if (type === 'collabnook') this._data.integrations.push({ type: 'collabnook', url: '', channel: '', botName: '' });
                else if (type === 'email') this._data.integrations.push({ type: 'email', imap: {}, smtp: {}, auth: {}, fromName: '', fromAddress: '', pollInterval: 30, folder: 'INBOX' });
                this._emitChange(); this._renderComposer();
            });
        });
        this.querySelectorAll('.remove-integration-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.integIdx, 10);
                if (this._data.integrations) { this._readFormIntoData(); this._data.integrations.splice(idx, 1); this._emitChange(); this._renderComposer(); }
            });
        });
    }

    _attachTriggerListeners() {
        this.querySelectorAll('.add-trigger-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this._data.triggers) this._data.triggers = [];
                this._readFormIntoData();
                if (btn.dataset.triggerType === 'cron') this._data.triggers.push({ type: 'cron', schedule: '' });
                else this._data.triggers.push({ type: 'webhook', path: '' });
                this._emitChange(); this._renderComposer();
            });
        });
        this.querySelectorAll('.remove-trigger-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.triggerIdx, 10);
                if (this._data.triggers) { this._readFormIntoData(); this._data.triggers.splice(idx, 1); this._emitChange(); this._renderComposer(); }
            });
        });
        this.querySelectorAll('.cron-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = btn.dataset.triggerIdx;
                const input = this.querySelector(`[data-field="triggers.${idx}.schedule"]`);
                if (input) { input.value = btn.dataset.preset; this._emitChange(); }
            });
        });
    }

    // ── Read form into data ──
    _readFormIntoData() {
        const read = sel => this.querySelector(`[data-field="${sel}"]`)?.value ?? undefined;
        const readChecked = sel => this.querySelector(`[data-field="${sel}"]`)?.checked ?? false;

        const name = read('name'); if (name !== undefined) this._data.name = name;
        const desc = read('description'); if (desc !== undefined) this._data.description = desc;
        const ver = read('version'); if (ver !== undefined) this._data.version = ver;
        const maxIter = read('maxIterations'); this._data.maxIterations = maxIter ? parseInt(maxIter, 10) : undefined;

        const llmName = read('llm.name'), llmTemp = read('llm.temperature');
        if (llmName !== undefined) {
            if (llmName === 'default' && llmTemp === undefined) this._data.llm = 'default';
            else { this._data.llm = { name: llmName || 'default' }; if (llmTemp !== undefined) this._data.llm.temperature = parseFloat(llmTemp); }
        }

        const sys = this.querySelector('[data-field="prompt.system"]')?.value;
        if (sys !== undefined) { if (!this._data.prompt) this._data.prompt = { system: '', inputVariables: [] }; this._data.prompt.system = sys; }

        const memEnabled = readChecked('memory.enabled'), memMaxLines = read('memory.maxLines');
        if (memEnabled) this._data.memory = memMaxLines ? { enabled: true, maxLines: parseInt(memMaxLines, 10) } : true;
        else this._data.memory = undefined;

        const outFmt = read('output.format');
        if (outFmt) {
            this._data.output = { format: outFmt };
            if (outFmt === 'structured') { const s = read('output.schema'); if (s) { try { this._data.output.schema = JSON.parse(s); } catch {} } }
        }

        const pubEnabled = readChecked('publish.enabled'), pubPassword = read('publish.password');
        if (pubEnabled) this._data.publish = pubPassword ? { enabled: true, password: pubPassword } : { enabled: true };
        else this._data.publish = undefined;

        const qInputs = this.querySelectorAll('[data-field^="sampleQuestions."]');
        if (qInputs.length > 0) this._data.sampleQuestions = Array.from(qInputs).map(el => el.value);

        const metaStr = this.querySelector('[data-field="metadata"]')?.value?.trim();
        if (metaStr !== undefined) { if (metaStr) { try { this._data.metadata = JSON.parse(metaStr); } catch {} } else this._data.metadata = undefined; }

        // Integrations
        (this._data.integrations || []).forEach((integ, i) => this._readNestedFields(integ, `integrations.${i}`));

        // Triggers
        const inputVars = this._data.prompt?.inputVariables || [];
        const primaryVar = inputVars[0] || 'query';
        (this._data.triggers || []).forEach((trig, i) => {
            const schedVal = read(`triggers.${i}.schedule`); if (schedVal !== undefined) trig.schedule = schedVal;
            const pathVal = read(`triggers.${i}.path`); if (pathVal !== undefined) trig.path = pathVal;
            const inputVarVal = this.querySelector(`[data-field="triggers.${i}.inputVar"]`)?.value;
            if (inputVarVal !== undefined) trig.input = inputVarVal.trim() ? { [primaryVar]: inputVarVal } : undefined;
        });
    }

    _readNestedFields(obj, prefix) {
        this.querySelectorAll(`[data-field^="${prefix}."]`).forEach(el => {
            const path = el.dataset.field.substring(prefix.length + 1);
            const parts = path.split('.');
            let target = obj;
            for (let i = 0; i < parts.length - 1; i++) { if (!target[parts[i]]) target[parts[i]] = {}; target = target[parts[i]]; }
            const key = parts[parts.length - 1];
            if (el.tagName === 'SELECT') { const val = el.value; target[key] = val === 'true' ? true : val === 'false' ? false : val; }
            else if (el.type === 'number') target[key] = el.value ? Number(el.value) : undefined;
            else target[key] = el.value;
        });
    }

    // ── Serialize clean output ──
    _serializeClean() {
        const d = this._data, out = {};
        if (d.name) out.name = d.name;
        if (d.description) out.description = d.description;
        if (d.version) out.version = d.version;

        if (d.llm && d.llm !== 'default') {
            if (typeof d.llm === 'object') {
                const llm = { name: d.llm.name || 'default' };
                if (d.llm.temperature !== undefined) llm.temperature = d.llm.temperature;
                out.llm = (llm.name === 'default' && llm.temperature === undefined) ? 'default' : llm;
            } else out.llm = d.llm;
        }

        if (d.prompt) { out.prompt = { system: d.prompt.system || '' }; if (d.prompt.inputVariables?.length) out.prompt.inputVariables = d.prompt.inputVariables; }
        if (d.tools?.length) out.tools = d.tools;
        if (d.skills) out.skills = d.skills;
        if (d.output?.format) { out.output = { format: d.output.format }; if (d.output.format === 'structured' && d.output.schema) out.output.schema = d.output.schema; }
        if (d.memory) out.memory = d.memory;

        if (d.integrations?.length) {
            out.integrations = d.integrations.map(integ => {
                const c = { type: integ.type };
                if (integ.type === 'collabnook') { ['url','channel','botName','password','replyDelay'].forEach(k => { if (integ[k]) c[k] = integ[k]; }); }
                else if (integ.type === 'email') { ['imap','smtp','auth','fromName','fromAddress','pollInterval','folder'].forEach(k => { if (integ[k]) c[k] = integ[k]; }); }
                return c;
            });
        }

        if (d.triggers?.length) {
            out.triggers = d.triggers.map(trig => {
                const c = {};
                if (trig.type) c.type = trig.type;
                if (trig.schedule) c.schedule = trig.schedule;
                if (trig.path) c.path = trig.path;
                if (trig.input) c.input = trig.input;
                return c;
            });
        }

        if (d.publish) out.publish = d.publish;
        if (d.maxIterations) out.maxIterations = d.maxIterations;
        if (d.sampleQuestions?.length) { const f = d.sampleQuestions.filter(q => q.trim()); if (f.length) out.sampleQuestions = f; }
        if (d.metadata && Object.keys(d.metadata).length) out.metadata = d.metadata;
        return out;
    }

    _esc(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    template() {
        return '<div id="composerRoot" class="overflow-y-auto h-full p-4 space-y-4"></div>';
    }
}

customElements.define('agent-composer', AgentComposer);
