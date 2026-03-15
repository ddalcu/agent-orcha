<script lang="ts">
  import yaml from 'js-yaml';
  import { api } from '../lib/services/api.js';

  const TOOL_PREFIXES: Record<string, string> = {
    mcp: 'tool-chip-mcp',
    knowledge: 'tool-chip-knowledge',
    function: 'tool-chip-function',
    builtin: 'tool-chip-builtin',
    sandbox: 'tool-chip-sandbox',
    workspace: 'tool-chip-workspace',
  };

  interface ToolPickerTab {
    id: string;
    label: string;
    items: string[];
  }

  // Props
  let {
    data = $bindable<Record<string, any>>({}),
    onchange,
  }: {
    data?: Record<string, any>;
    onchange?: () => void;
  } = $props();

  // Internal deep copy of data
  let d = $state<Record<string, any>>({});

  // External data
  let llmOptions = $state<any[]>([]);
  let mcpServers = $state<any[]>([]);
  let knowledgeStores = $state<any[]>([]);
  let functions = $state<any[]>([]);
  let availableSkills = $state<any[]>([]);

  // Tool picker
  let toolPickerOpen = $state(false);
  let toolPickerTab = $state('mcp');
  let toolPickerSearch = $state('');

  // New variable input
  let newVarValue = $state('');

  // Temperature display
  let tempDisplay = $derived(d.llm?.temperature !== undefined ? d.llm.temperature : (typeof d.llm === 'object' ? d.llm?.temperature : undefined));

  // Skills derived
  let skillsMode = $derived<'none' | 'all' | 'specific'>(
    !d.skills ? 'none' :
    (Array.isArray(d.skills) && d.skills.length === 1 && d.skills[0] === '*') ? 'all' :
    'specific'
  );
  let selectedSkills = $derived<string[]>(
    Array.isArray(d.skills) && !(d.skills.length === 1 && d.skills[0] === '*') ? d.skills : []
  );

  // Tools as strings
  let tools = $derived<string[]>(
    (d.tools || []).map((t: any) => typeof t === 'string' ? t : t.name)
  );

  // Prompt
  let promptSystem = $derived(d.prompt?.system || '');
  let inputVariables = $derived<string[]>(d.prompt?.inputVariables || []);

  // LLM
  let llmName = $derived(typeof d.llm === 'string' ? d.llm : (d.llm?.name || 'default'));
  let llmTemp = $derived(typeof d.llm === 'object' ? d.llm?.temperature : undefined);

  // Memory
  let memEnabled = $derived(d.memory === true || (typeof d.memory === 'object' && d.memory?.enabled !== false));
  let memMaxLines = $derived((typeof d.memory === 'object' && d.memory?.maxLines) || '');

  // Output
  let outFmt = $derived(d.output?.format || 'text');
  let outSchema = $derived(d.output?.schema ? JSON.stringify(d.output.schema, null, 2) : '');

  // Publish
  let pubEnabled = $derived(d.publish === true || (typeof d.publish === 'object' && d.publish?.enabled));
  let pubPassword = $derived((typeof d.publish === 'object' && d.publish?.password) || '');

  // Questions
  let questions = $derived<string[]>(d.sampleQuestions || []);

  // Metadata
  let metadataStr = $derived(d.metadata ? JSON.stringify(d.metadata, null, 2) : '');

  // Integrations
  let integrations = $derived<any[]>(d.integrations || []);

  // Triggers
  let triggers = $derived<any[]>(d.triggers || []);

  // JSON validation errors
  let metadataError = $state('');
  let outputSchemaError = $state('');

  // Tool picker tabs
  let toolPickerTabs = $derived<ToolPickerTab[]>([
    { id: 'mcp', label: 'MCP', items: mcpServers.map((s: any) => `mcp:${s.name || s}`) },
    { id: 'knowledge', label: 'Knowledge', items: knowledgeStores.map((s: any) => `knowledge:${s.name || s}`) },
    { id: 'function', label: 'Functions', items: functions.map((f: any) => `function:${f.name || f}`) },
    { id: 'builtin', label: 'Builtin', items: ['builtin:ask_user'] },
    { id: 'sandbox', label: 'Sandbox', items: ['sandbox:shell','sandbox:exec','sandbox:web_fetch','sandbox:web_search','sandbox:browser_navigate','sandbox:browser_observe','sandbox:browser_click','sandbox:browser_type','sandbox:browser_screenshot','sandbox:browser_evaluate','sandbox:file_read','sandbox:file_write','sandbox:file_edit','sandbox:file_insert','sandbox:file_replace_lines'] },
  ]);

  let activePickerTab = $derived(toolPickerTabs.find(t => t.id === toolPickerTab) || toolPickerTabs[0]);
  let existingTools = $derived(new Set(tools));
  let filteredPickerItems = $derived(
    activePickerTab.items.filter(v => !toolPickerSearch || v.toLowerCase().includes(toolPickerSearch.toLowerCase()))
  );

  // Primary input var for triggers
  let primaryVar = $derived((d.prompt?.inputVariables || [])[0] || 'query');

  // Load external data
  async function loadExternalData() {
    try {
      const [llms, mcpRes, knowledgeRes, functionsRes, skillsRes] = await Promise.all([
        api.getLLMs().catch(() => []),
        api.getMCPServers().catch(() => []),
        api.getKnowledgeStores().catch(() => []),
        api.getFunctions().catch(() => []),
        api.getSkills().catch(() => []),
      ]);
      llmOptions = Array.isArray(llms) ? llms : (llms.models || []);
      mcpServers = Array.isArray(mcpRes) ? mcpRes : (mcpRes.servers || []);
      knowledgeStores = Array.isArray(knowledgeRes) ? knowledgeRes : (knowledgeRes.stores || []);
      functions = Array.isArray(functionsRes) ? functionsRes : (functionsRes.functions || []);
      availableSkills = Array.isArray(skillsRes) ? skillsRes : (skillsRes.skills || []);
    } catch { /* silent */ }
  }

  // Emit change
  function emitChange() {
    onchange?.();
  }

  // Sync data in when prop changes
  $effect(() => {
    d = JSON.parse(JSON.stringify(data || {}));
    loadExternalData();
  });

  // --- getData: exported for parent to call ---
  export function getData(): Record<string, any> {
    return serializeClean();
  }

  // --- Serialize clean output ---
  function serializeClean(): Record<string, any> {
    const out: Record<string, any> = {};
    if (d.name) out.name = d.name;
    if (d.description) out.description = d.description;
    if (d.version) out.version = d.version;

    if (d.llm && d.llm !== 'default') {
      if (typeof d.llm === 'object') {
        const llm: any = { name: d.llm.name || 'default' };
        if (d.llm.temperature !== undefined) llm.temperature = d.llm.temperature;
        out.llm = (llm.name === 'default' && llm.temperature === undefined) ? 'default' : llm;
      } else out.llm = d.llm;
    }

    if (d.prompt) {
      out.prompt = { system: d.prompt.system || '' };
      if (d.prompt.inputVariables?.length) out.prompt.inputVariables = d.prompt.inputVariables;
    }
    if (d.tools?.length) out.tools = d.tools;
    if (d.skills) out.skills = d.skills;
    if (d.output?.format) {
      out.output = { format: d.output.format };
      if (d.output.format === 'structured' && d.output.schema) out.output.schema = d.output.schema;
    }
    if (d.memory) out.memory = d.memory;

    if (d.integrations?.length) {
      out.integrations = d.integrations.map((integ: any) => {
        const c: any = { type: integ.type };
        if (integ.type === 'collabnook') {
          ['url','channel','botName','password','replyDelay'].forEach(k => { if (integ[k]) c[k] = integ[k]; });
        } else if (integ.type === 'email') {
          ['imap','smtp','auth','fromName','fromAddress','pollInterval','folder'].forEach(k => { if (integ[k]) c[k] = integ[k]; });
        }
        return c;
      });
    }

    if (d.triggers?.length) {
      out.triggers = d.triggers.map((trig: any) => {
        const c: any = {};
        if (trig.type) c.type = trig.type;
        if (trig.schedule) c.schedule = trig.schedule;
        if (trig.path) c.path = trig.path;
        if (trig.input) c.input = trig.input;
        return c;
      });
    }

    if (d.publish) out.publish = d.publish;
    if (d.maxIterations) out.maxIterations = d.maxIterations;
    if (d.sampleQuestions?.length) {
      const f = d.sampleQuestions.filter((q: string) => q.trim());
      if (f.length) out.sampleQuestions = f;
    }
    if (d.metadata && Object.keys(d.metadata).length) out.metadata = d.metadata;
    return out;
  }

  // --- Field handlers ---
  function handleFieldInput(field: string, value: any) {
    setNestedValue(d, field, value);
    emitChange();
  }

  function setNestedValue(obj: any, path: string, value: any) {
    const parts = path.split('.');
    let target = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]]) target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = value;
  }

  function getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    let target = obj;
    for (const part of parts) {
      if (target == null) return undefined;
      target = target[part];
    }
    return target;
  }

  // --- LLM handlers ---
  function handleLlmNameChange(value: string) {
    if (value === 'default') {
      if (typeof d.llm === 'object' && d.llm?.temperature !== undefined) {
        d.llm = { name: 'default', temperature: d.llm.temperature };
      } else {
        d.llm = 'default';
      }
    } else {
      if (typeof d.llm === 'object') {
        d.llm = { ...d.llm, name: value };
      } else {
        d.llm = { name: value };
      }
    }
    emitChange();
  }

  function handleLlmTempChange(value: string) {
    const temp = parseFloat(value);
    if (typeof d.llm === 'object') {
      d.llm = { ...d.llm, temperature: temp };
    } else {
      d.llm = { name: d.llm || 'default', temperature: temp };
    }
    emitChange();
  }

  // --- Prompt handlers ---
  function handlePromptChange(value: string) {
    if (!d.prompt) d.prompt = { system: '', inputVariables: [] };
    d.prompt = { ...d.prompt, system: value };
    emitChange();
  }

  // --- Variable handlers ---
  function addVariable() {
    const val = newVarValue.trim();
    if (!val) return;
    if (!d.prompt) d.prompt = { system: '', inputVariables: [] };
    if (!d.prompt.inputVariables) d.prompt.inputVariables = [];
    if (!d.prompt.inputVariables.includes(val)) {
      d.prompt = { ...d.prompt, inputVariables: [...d.prompt.inputVariables, val] };
      emitChange();
    }
    newVarValue = '';
  }

  function removeVariable(v: string) {
    if (d.prompt?.inputVariables) {
      d.prompt = { ...d.prompt, inputVariables: d.prompt.inputVariables.filter((x: string) => x !== v) };
      emitChange();
    }
  }

  function handleVarKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addVariable();
    }
  }

  // --- Tool handlers ---
  function removeTool(t: string) {
    d.tools = (d.tools || []).filter((x: any) => (typeof x === 'string' ? x : x.name) !== t);
    emitChange();
  }

  function addTool(item: string) {
    if (!d.tools) d.tools = [];
    d.tools = [...d.tools, item];
    emitChange();
  }

  function getToolChipClass(tool: string): string {
    const prefix = tool.split(':')[0];
    return TOOL_PREFIXES[prefix] || TOOL_PREFIXES['workspace'];
  }

  // --- Skills handlers ---
  function handleSkillsModeChange(mode: string) {
    if (mode === 'none') d.skills = undefined;
    else if (mode === 'all') d.skills = ['*'];
    else d.skills = [];
    emitChange();
  }

  function handleSkillCheckbox(name: string, checked: boolean) {
    if (!Array.isArray(d.skills)) d.skills = [];
    if (checked) {
      if (!d.skills.includes(name)) d.skills = [...d.skills, name];
    } else {
      d.skills = d.skills.filter((s: string) => s !== name);
    }
    emitChange();
  }

  // --- Memory handlers ---
  function handleMemoryToggle(checked: boolean) {
    if (checked) {
      d.memory = true;
    } else {
      d.memory = undefined;
    }
    emitChange();
  }

  function handleMemMaxLines(value: string) {
    if (value) {
      d.memory = { enabled: true, maxLines: parseInt(value, 10) };
    } else {
      d.memory = true;
    }
    emitChange();
  }

  // --- Output handlers ---
  function handleOutputFormat(value: string) {
    d.output = { format: value };
    emitChange();
  }

  function handleOutputSchema(value: string) {
    if (!d.output) d.output = { format: 'structured' };
    if (value.trim()) {
      try {
        d.output = { ...d.output, schema: JSON.parse(value) };
        outputSchemaError = '';
      } catch (e: any) {
        outputSchemaError = e.message;
      }
    } else {
      const { schema, ...rest } = d.output;
      d.output = rest;
      outputSchemaError = '';
    }
    emitChange();
  }

  // --- Publish handlers ---
  function handlePublishToggle(checked: boolean) {
    if (checked) {
      d.publish = { enabled: true };
    } else {
      d.publish = undefined;
    }
    emitChange();
  }

  function handlePublishPassword(value: string) {
    d.publish = value ? { enabled: true, password: value } : { enabled: true };
    emitChange();
  }

  // --- Question handlers ---
  function addQuestion() {
    if (!d.sampleQuestions) d.sampleQuestions = [];
    d.sampleQuestions = [...d.sampleQuestions, ''];
    emitChange();
  }

  function removeQuestion(idx: number) {
    if (d.sampleQuestions) {
      d.sampleQuestions = d.sampleQuestions.filter((_: string, i: number) => i !== idx);
      emitChange();
    }
  }

  function handleQuestionChange(idx: number, value: string) {
    if (d.sampleQuestions) {
      d.sampleQuestions = d.sampleQuestions.map((q: string, i: number) => i === idx ? value : q);
      emitChange();
    }
  }

  // --- Metadata ---
  function handleMetadataBlur(value: string) {
    const val = value.trim();
    if (!val) {
      d.metadata = undefined;
      metadataError = '';
      return;
    }
    try {
      d.metadata = JSON.parse(val);
      metadataError = '';
    } catch (e: any) {
      metadataError = e.message;
    }
    emitChange();
  }

  // --- Integration handlers ---
  function addIntegration(type: string) {
    if (!d.integrations) d.integrations = [];
    if (type === 'collabnook') {
      d.integrations = [...d.integrations, { type: 'collabnook', url: '', channel: '', botName: '' }];
    } else if (type === 'email') {
      d.integrations = [...d.integrations, { type: 'email', imap: {}, smtp: {}, auth: {}, fromName: '', fromAddress: '', pollInterval: 30, folder: 'INBOX' }];
    }
    emitChange();
  }

  function removeIntegration(idx: number) {
    if (d.integrations) {
      d.integrations = d.integrations.filter((_: any, i: number) => i !== idx);
      emitChange();
    }
  }

  function handleIntegrationField(idx: number, path: string, value: any) {
    if (d.integrations && d.integrations[idx]) {
      setNestedValue(d.integrations[idx], path, value);
      d.integrations = [...d.integrations]; // trigger reactivity
      emitChange();
    }
  }

  // --- Trigger handlers ---
  function addTrigger(type: string) {
    if (!d.triggers) d.triggers = [];
    if (type === 'cron') {
      d.triggers = [...d.triggers, { type: 'cron', schedule: '' }];
    } else {
      d.triggers = [...d.triggers, { type: 'webhook', path: '' }];
    }
    emitChange();
  }

  function removeTrigger(idx: number) {
    if (d.triggers) {
      d.triggers = d.triggers.filter((_: any, i: number) => i !== idx);
      emitChange();
    }
  }

  function handleTriggerField(idx: number, field: string, value: string) {
    if (d.triggers && d.triggers[idx]) {
      if (field === 'schedule') d.triggers[idx].schedule = value;
      else if (field === 'path') d.triggers[idx].path = value;
      else if (field === 'inputVar') {
        d.triggers[idx].input = value.trim() ? { [primaryVar]: value } : undefined;
      }
      d.triggers = [...d.triggers];
      emitChange();
    }
  }

  function applyCronPreset(idx: number, preset: string) {
    if (d.triggers && d.triggers[idx]) {
      d.triggers[idx].schedule = preset;
      d.triggers = [...d.triggers];
      emitChange();
    }
  }

  function getTriggerInputValue(trig: any): string {
    return (typeof trig.input === 'object' && trig.input) ? (trig.input[primaryVar] || '') : '';
  }

  // --- Output schema blur ---
  function handleOutputSchemaBlur(value: string) {
    const val = value.trim();
    if (!val) { outputSchemaError = ''; return; }
    try { JSON.parse(val); outputSchemaError = ''; }
    catch (e: any) { outputSchemaError = e.message; }
  }
</script>

<div class="composer-root overflow-y-auto h-full p-4">
  <!-- Identity & LLM -->
  <div class="grid grid-cols-2 gap-4">
    <div class="composer-section space-y-3">
      <h3 class="section-title">Identity</h3>
      <div>
        <label class="composer-label" for="agent-name">Name</label>
        <input id="agent-name" type="text" value={d.name || ''}
               oninput={(e: Event) => { d.name = (e.target as HTMLInputElement).value; emitChange(); }}
               class="composer-input-field" />
      </div>
      <div>
        <label class="composer-label" for="agent-description">Description</label>
        <input id="agent-description" type="text" value={d.description || ''}
               oninput={(e: Event) => { d.description = (e.target as HTMLInputElement).value; emitChange(); }}
               class="composer-input-field" />
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="composer-label" for="agent-version">Version</label>
          <input id="agent-version" type="text" value={d.version || '1.0.0'}
                 oninput={(e: Event) => { d.version = (e.target as HTMLInputElement).value; emitChange(); }}
                 class="composer-input-field" />
        </div>
        <div>
          <label class="composer-label" for="agent-max-iterations">Max Iterations</label>
          <input id="agent-max-iterations" type="number" value={d.maxIterations || ''} min="1" placeholder="Default"
                 oninput={(e: Event) => { const v = (e.target as HTMLInputElement).value; d.maxIterations = v ? parseInt(v, 10) : undefined; emitChange(); }}
                 class="composer-input-field" />
        </div>
      </div>
    </div>

    <div class="composer-section space-y-3">
      <h3 class="section-title">LLM</h3>
      <div>
        <label class="composer-label" for="agent-llm-model">Model</label>
        <select id="agent-llm-model" value={llmName}
                onchange={(e: Event) => handleLlmNameChange((e.target as HTMLSelectElement).value)}
                class="composer-input-field">
          <option value="default" selected={llmName === 'default'}>default</option>
          {#each llmOptions as m}
            {@const name = typeof m === 'string' ? m : m.name}
            <option value={name} selected={name === llmName}>{name}</option>
          {/each}
        </select>
      </div>
      <div>
        <label class="composer-label" for="agent-llm-temp">Temperature <span class="text-muted font-mono">{llmTemp !== undefined ? llmTemp : '\u2014'}</span></label>
        <input id="agent-llm-temp" type="range" min="0" max="2" step="0.1" value={llmTemp !== undefined ? llmTemp : 0.7}
               oninput={(e: Event) => handleLlmTempChange((e.target as HTMLInputElement).value)}
               class="w-full" />
        <div class="flex justify-between text-xs text-muted mt-1">
          <span>0 Precise</span>
          <span>2 Creative</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Prompt -->
  <div class="composer-section space-y-3">
    <h3 class="section-title">System Prompt</h3>
    <textarea rows="10"
              value={promptSystem}
              oninput={(e: Event) => handlePromptChange((e.target as HTMLTextAreaElement).value)}
              class="composer-input-field font-mono composer-textarea"></textarea>
    <div>
      <!-- svelte-ignore a11y_label_has_associated_control -->
      <label class="composer-label">Input Variables</label>
      <div class="flex flex-wrap gap-1 mb-2">
        {#each inputVariables as v}
          <span class="var-chip">
            {v}<button class="composer-remove-btn ml-1" onclick={() => removeVariable(v)}>&times;</button>
          </span>
        {/each}
      </div>
      <div class="flex gap-2">
        <input type="text" placeholder="Add variable..."
               bind:value={newVarValue}
               onkeydown={handleVarKeydown}
               class="composer-input-field flex-1" />
        <button class="btn btn-sm bg-surface" onclick={addVariable}>Add</button>
      </div>
    </div>
  </div>

  <!-- Tools & Skills -->
  <div class="grid grid-cols-2 gap-4">
    <div class="composer-section space-y-3">
      <h3 class="section-title">Tools</h3>
      <div class="flex flex-wrap gap-1">
        {#if tools.length === 0}
          <span class="text-xs text-muted">No tools added</span>
        {:else}
          {#each tools as t}
            <span class="tool-chip {getToolChipClass(t)}">
              {t}<button class="composer-remove-btn ml-1" onclick={() => removeTool(t)}>&times;</button>
            </span>
          {/each}
        {/if}
      </div>
      <button class="composer-add-btn" onclick={() => { toolPickerOpen = !toolPickerOpen; }}>
        <i class="fas fa-plus mr-1"></i> Add tool
      </button>

      {#if toolPickerOpen}
        <div class="tool-picker-inline">
          <div class="tool-picker-inline-tabs">
            {#each toolPickerTabs as tab}
              <button class="tool-picker-inline-tab tool-picker-tab {tab.id === toolPickerTab ? 'active' : ''}"
                      onclick={() => { toolPickerTab = tab.id; }}>{tab.label}</button>
            {/each}
          </div>
          <div class="p-2">
            <input type="text" placeholder="Filter..."
                   bind:value={toolPickerSearch}
                   class="composer-input-sm mb-2" />
            <div class="tool-picker-list">
              {#if filteredPickerItems.length === 0}
                <div class="text-xs text-muted p-2 text-center">No items</div>
              {:else}
                {#each filteredPickerItems as item}
                  {@const added = existingTools.has(item)}
                  <div class="tool-picker-item {added ? 'added' : 'available'}"
                       role="button"
                       tabindex="0"
                       onclick={() => { if (!added) addTool(item); }}
                       onkeydown={(e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && !added) addTool(item); }}>
                    <span>{item.split(':')[1] || item}</span>
                    {#if added}
                      <i class="fas fa-check text-green text-2xs"></i>
                    {:else}
                      <i class="fas fa-plus text-muted text-2xs"></i>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          </div>
          <div class="border-t px-2 py-1 flex justify-end">
            <button class="composer-add-btn" onclick={() => { toolPickerOpen = false; toolPickerSearch = ''; }}>Close</button>
          </div>
        </div>
      {/if}
    </div>

    <div class="composer-section space-y-3">
      <h3 class="section-title">Skills</h3>
      <div class="flex gap-3">
        <label class="inline-flex items-center gap-1 text-xs text-secondary cursor-pointer">
          <input type="radio" name="skillsMode" value="none" checked={skillsMode === 'none'}
                 onchange={() => handleSkillsModeChange('none')} /> None
        </label>
        <label class="inline-flex items-center gap-1 text-xs text-secondary cursor-pointer">
          <input type="radio" name="skillsMode" value="all" checked={skillsMode === 'all'}
                 onchange={() => handleSkillsModeChange('all')} /> All
        </label>
        <label class="inline-flex items-center gap-1 text-xs text-secondary cursor-pointer">
          <input type="radio" name="skillsMode" value="specific" checked={skillsMode === 'specific'}
                 onchange={() => handleSkillsModeChange('specific')} /> Specific
        </label>
      </div>
      {#if skillsMode === 'specific'}
        <div class="space-y-1">
          {#if availableSkills.length === 0}
            <span class="text-xs text-muted">No skills loaded</span>
          {:else}
            {#each availableSkills as s}
              {@const name = typeof s === 'string' ? s : s.name}
              <label class="flex items-center gap-2 text-xs text-secondary cursor-pointer">
                <input type="checkbox" value={name} checked={selectedSkills.includes(name)}
                       onchange={(e: Event) => handleSkillCheckbox(name, (e.target as HTMLInputElement).checked)} /> {name}
              </label>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <!-- Memory, Output, Publish -->
  <div class="grid grid-cols-3 gap-4">
    <div class="composer-section space-y-3">
      <h3 class="section-title">Memory</h3>
      <label class="flex items-center gap-2 text-xs text-secondary cursor-pointer">
        <input type="checkbox" checked={memEnabled}
               onchange={(e: Event) => handleMemoryToggle((e.target as HTMLInputElement).checked)} />
        Enable persistent memory
      </label>
      {#if memEnabled}
        <div>
          <label class="composer-label" for="agent-mem-max-lines">Max Lines</label>
          <input id="agent-mem-max-lines" type="number" value={memMaxLines} min="1" placeholder="100"
                 oninput={(e: Event) => handleMemMaxLines((e.target as HTMLInputElement).value)}
                 class="composer-input-field" />
        </div>
      {/if}
    </div>

    <div class="composer-section space-y-3">
      <h3 class="section-title">Output</h3>
      <div>
        <label class="composer-label" for="agent-output-format">Format</label>
        <select id="agent-output-format" value={outFmt}
                onchange={(e: Event) => handleOutputFormat((e.target as HTMLSelectElement).value)}
                class="composer-input-field">
          <option value="text" selected={outFmt === 'text'}>text</option>
          <option value="structured" selected={outFmt === 'structured'}>structured</option>
        </select>
      </div>
      {#if outFmt === 'structured'}
        <div>
          <label class="composer-label" for="agent-output-schema">Schema (JSON)</label>
          <textarea id="agent-output-schema" rows="4"
                    value={outSchema}
                    oninput={(e: Event) => handleOutputSchema((e.target as HTMLTextAreaElement).value)}
                    onblur={(e: Event) => handleOutputSchemaBlur((e.target as HTMLTextAreaElement).value)}
                    class="composer-input-field text-xs font-mono composer-textarea"></textarea>
          {#if outputSchemaError}
            <div class="text-xs text-red mt-1">{outputSchemaError}</div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="composer-section space-y-3">
      <h3 class="section-title">Publish</h3>
      <label class="flex items-center gap-2 text-xs text-secondary cursor-pointer">
        <input type="checkbox" checked={pubEnabled}
               onchange={(e: Event) => handlePublishToggle((e.target as HTMLInputElement).checked)} />
        Standalone chat page
      </label>
      {#if pubEnabled}
        <div>
          <label class="composer-label" for="agent-pub-password">Password</label>
          <input id="agent-pub-password" type="text" value={pubPassword} placeholder="Optional"
                 oninput={(e: Event) => handlePublishPassword((e.target as HTMLInputElement).value)}
                 class="composer-input-field" />
        </div>
      {/if}
    </div>
  </div>

  <!-- Integrations -->
  <div class="composer-section space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="section-title">Integrations</h3>
      <div class="flex gap-1">
        <button class="composer-add-btn" onclick={() => addIntegration('collabnook')}><i class="fas fa-plus mr-1"></i>Collabnook</button>
        <button class="composer-add-btn ml-3" onclick={() => addIntegration('email')}><i class="fas fa-plus mr-1"></i>Email</button>
      </div>
    </div>
    {#if integrations.length === 0}
      <div class="text-xs text-muted">No integrations</div>
    {:else}
      {#each integrations as integ, i}
        {#if integ.type === 'collabnook'}
          <div class="composer-sub-card">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-secondary"><i class="fas fa-comments mr-1"></i>Collabnook</span>
              <button class="composer-remove-btn" aria-label="Remove Collabnook integration" onclick={() => removeIntegration(i)}><i class="fas fa-trash"></i></button>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="composer-label" for="integ-{i}-url">URL</label>
                <input id="integ-{i}-url" type="text" value={integ.url || ''} oninput={(e: Event) => handleIntegrationField(i, 'url', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-channel">Channel</label>
                <input id="integ-{i}-channel" type="text" value={integ.channel || ''} oninput={(e: Event) => handleIntegrationField(i, 'channel', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-botname">Bot Name</label>
                <input id="integ-{i}-botname" type="text" value={integ.botName || ''} oninput={(e: Event) => handleIntegrationField(i, 'botName', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-password">Password</label>
                <input id="integ-{i}-password" type="text" value={integ.password || ''} oninput={(e: Event) => handleIntegrationField(i, 'password', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
            </div>
          </div>
        {:else if integ.type === 'email'}
          <div class="composer-sub-card">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-secondary"><i class="fas fa-envelope mr-1"></i>Email</span>
              <button class="composer-remove-btn" aria-label="Remove Email integration" onclick={() => removeIntegration(i)}><i class="fas fa-trash"></i></button>
            </div>
            <div class="grid grid-cols-3 gap-2 mb-2">
              <div>
                <label class="composer-label" for="integ-{i}-imap-host">IMAP Host</label>
                <input id="integ-{i}-imap-host" type="text" value={integ.imap?.host || ''} oninput={(e: Event) => handleIntegrationField(i, 'imap.host', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-imap-port">Port</label>
                <input id="integ-{i}-imap-port" type="number" value={integ.imap?.port || ''} oninput={(e: Event) => handleIntegrationField(i, 'imap.port', Number((e.target as HTMLInputElement).value) || undefined)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-imap-secure">Secure</label>
                <select id="integ-{i}-imap-secure" value={integ.imap?.secure ? 'true' : 'false'} onchange={(e: Event) => handleIntegrationField(i, 'imap.secure', (e.target as HTMLSelectElement).value === 'true')} class="composer-input-sm">
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-2 mb-2">
              <div>
                <label class="composer-label" for="integ-{i}-smtp-host">SMTP Host</label>
                <input id="integ-{i}-smtp-host" type="text" value={integ.smtp?.host || ''} oninput={(e: Event) => handleIntegrationField(i, 'smtp.host', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-smtp-port">Port</label>
                <input id="integ-{i}-smtp-port" type="number" value={integ.smtp?.port || ''} oninput={(e: Event) => handleIntegrationField(i, 'smtp.port', Number((e.target as HTMLInputElement).value) || undefined)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-smtp-secure">Secure</label>
                <select id="integ-{i}-smtp-secure" value={integ.smtp?.secure ? 'true' : 'false'} onchange={(e: Event) => handleIntegrationField(i, 'smtp.secure', (e.target as HTMLSelectElement).value === 'true')} class="composer-input-sm">
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="composer-label" for="integ-{i}-auth-user">User</label>
                <input id="integ-{i}-auth-user" type="text" value={integ.auth?.user || ''} oninput={(e: Event) => handleIntegrationField(i, 'auth.user', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-auth-pass">Password</label>
                <input id="integ-{i}-auth-pass" type="text" value={integ.auth?.pass || ''} oninput={(e: Event) => handleIntegrationField(i, 'auth.pass', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-from-name">From Name</label>
                <input id="integ-{i}-from-name" type="text" value={integ.fromName || ''} oninput={(e: Event) => handleIntegrationField(i, 'fromName', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-from-address">From Address</label>
                <input id="integ-{i}-from-address" type="text" value={integ.fromAddress || ''} oninput={(e: Event) => handleIntegrationField(i, 'fromAddress', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-poll-interval">Poll Interval (s)</label>
                <input id="integ-{i}-poll-interval" type="number" value={integ.pollInterval || ''} oninput={(e: Event) => handleIntegrationField(i, 'pollInterval', Number((e.target as HTMLInputElement).value) || undefined)} class="composer-input-sm" />
              </div>
              <div>
                <label class="composer-label" for="integ-{i}-folder">Folder</label>
                <input id="integ-{i}-folder" type="text" value={integ.folder || 'INBOX'} oninput={(e: Event) => handleIntegrationField(i, 'folder', (e.target as HTMLInputElement).value)} class="composer-input-sm" />
              </div>
            </div>
          </div>
        {/if}
      {/each}
    {/if}
  </div>

  <!-- Triggers -->
  <div class="composer-section space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="section-title">Triggers</h3>
      <div class="flex gap-1">
        <button class="composer-add-btn" onclick={() => addTrigger('cron')}><i class="fas fa-plus mr-1"></i>Cron</button>
        <button class="composer-add-btn ml-3" onclick={() => addTrigger('webhook')}><i class="fas fa-plus mr-1"></i>Webhook</button>
      </div>
    </div>
    {#if triggers.length === 0}
      <div class="text-xs text-muted">No triggers</div>
    {:else}
      {#each triggers as trig, i}
        {@const isCron = trig.type === 'cron' || trig.schedule}
        <div class="composer-sub-card">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-medium text-secondary"><i class="fas {isCron ? 'fa-clock' : 'fa-link'} mr-1"></i>{isCron ? 'Cron' : 'Webhook'}</span>
            <button class="composer-remove-btn" aria-label="Remove trigger" onclick={() => removeTrigger(i)}><i class="fas fa-trash"></i></button>
          </div>
          <div class="grid grid-cols-2 gap-2">
            {#if isCron}
              <div>
                <label class="composer-label" for="trig-{i}-schedule">Schedule</label>
                <input id="trig-{i}-schedule" type="text" value={trig.schedule || ''} placeholder="*/5 * * * *"
                       oninput={(e: Event) => handleTriggerField(i, 'schedule', (e.target as HTMLInputElement).value)}
                       class="composer-input-sm" />
                <div class="flex flex-wrap gap-1 mt-1">
                  {#each [{ label: '1min', val: '* * * * *' }, { label: '5min', val: '*/5 * * * *' }, { label: '15min', val: '*/15 * * * *' }, { label: 'hourly', val: '0 * * * *' }, { label: '6hr', val: '0 */6 * * *' }, { label: 'daily', val: '0 0 * * *' }, { label: 'weekly', val: '0 0 * * 1' }, { label: 'monthly', val: '0 0 1 * *' }] as preset}
                    <button class="cron-preset-btn" onclick={() => applyCronPreset(i, preset.val)}>{preset.label}</button>
                  {/each}
                </div>
              </div>
            {:else}
              <div>
                <label class="composer-label" for="trig-{i}-path">Path</label>
                <input id="trig-{i}-path" type="text" value={trig.path || ''} placeholder="/webhook/my-hook"
                       oninput={(e: Event) => handleTriggerField(i, 'path', (e.target as HTMLInputElement).value)}
                       class="composer-input-sm" />
              </div>
            {/if}
            <div>
              <label class="composer-label" for="trig-{i}-prompt">Prompt <span class="text-muted font-mono">({primaryVar})</span></label>
              <input id="trig-{i}-prompt" type="text" value={getTriggerInputValue(trig)} placeholder="e.g. Generate the daily report"
                     oninput={(e: Event) => handleTriggerField(i, 'inputVar', (e.target as HTMLInputElement).value)}
                     class="composer-input-sm" />
            </div>
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <!-- Sample Questions & Metadata -->
  <div class="grid grid-cols-2 gap-4">
    <div class="composer-section space-y-3">
      <h3 class="section-title">Sample Questions</h3>
      <div class="space-y-2">
        {#if questions.length === 0}
          <span class="text-xs text-muted">No sample questions</span>
        {:else}
          {#each questions as q, i}
            <div class="flex gap-2">
              <input type="text" value={q}
                     oninput={(e: Event) => handleQuestionChange(i, (e.target as HTMLInputElement).value)}
                     class="composer-input-field flex-1" />
              <button class="composer-remove-btn px-1" aria-label="Remove question" onclick={() => removeQuestion(i)}><i class="fas fa-trash"></i></button>
            </div>
          {/each}
        {/if}
      </div>
      <button class="composer-add-btn" onclick={addQuestion}>
        <i class="fas fa-plus mr-1"></i> Add question
      </button>
    </div>

    <div class="composer-section space-y-3">
      <h3 class="section-title">Metadata</h3>
      <textarea rows="6"
                value={metadataStr}
                onblur={(e: Event) => handleMetadataBlur((e.target as HTMLTextAreaElement).value)}
                class="composer-input-field text-xs font-mono composer-textarea"></textarea>
      {#if metadataError}
        <div class="text-xs text-red mt-1">{metadataError}</div>
      {/if}
    </div>
  </div>
</div>
