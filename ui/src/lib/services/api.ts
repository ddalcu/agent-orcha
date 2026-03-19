async function _fetch(url: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:required'));
    throw new Error('Unauthorized');
  }
  return res;
}

export const api = {
  // Agents
  async getAgents() { return (await _fetch('/api/agents')).json(); },
  async invokeAgent(name: string, input: unknown, sessionId: string) {
    return (await _fetch(`/api/agents/${name}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, sessionId }) })).json();
  },
  async checkSession(sessionId: string) { return (await _fetch(`/api/agents/sessions/${sessionId}`)).ok; },
  async streamAgent(name: string, input: unknown, sessionId: string, opts: { signal?: AbortSignal } = {}) {
    return _fetch(`/api/agents/${name}/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, sessionId }), signal: opts.signal });
  },

  // Workflows
  async getWorkflows() { return (await _fetch('/api/workflows')).json(); },
  async getWorkflow(name: string) { return (await _fetch(`/api/workflows/${name}`)).json(); },
  async startWorkflowStream(name: string, input: unknown, signal?: AbortSignal) {
    return _fetch(`/api/workflows/${name}/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }), signal });
  },
  async resumeWorkflowStream(name: string, threadId: string, answer: string, signal?: AbortSignal) {
    return _fetch(`/api/workflows/${name}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, answer }), signal });
  },

  // Knowledge
  async getKnowledgeStores() { return (await _fetch('/api/knowledge')).json(); },
  async getKnowledgeStore(name: string) { return (await _fetch(`/api/knowledge/${name}`)).json(); },
  async searchKnowledgeStore(name: string, query: string, k: number) {
    return (await _fetch(`/api/knowledge/${name}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, k }) })).json();
  },
  async getKnowledgeStatus(name: string) { return (await _fetch(`/api/knowledge/${name}/status`)).json(); },
  async indexKnowledgeStore(name: string) {
    return (await _fetch(`/api/knowledge/${name}/index`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).json();
  },
  indexKnowledgeStoreStream(name: string) { return new EventSource(`/api/knowledge/${name}/index/stream`); },

  // LLMs
  async getLLMs() { return (await _fetch('/api/llm')).json(); },
  async getLlmConfig() { return (await _fetch('/api/llm/config')).json(); },
  async saveLlmModel(name: string, config: unknown) {
    return (await _fetch(`/api/llm/config/models/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) })).json();
  },
  async deleteLlmModel(name: string) {
    return (await _fetch(`/api/llm/config/models/${encodeURIComponent(name)}`, { method: 'DELETE' })).json();
  },
  async toggleLlmActive(name: string, active: boolean) {
    return (await _fetch(`/api/llm/config/models/${encodeURIComponent(name)}/active`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) })).json();
  },
  async saveLlmEmbedding(name: string, config: unknown) {
    return (await _fetch(`/api/llm/config/embeddings/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) })).json();
  },
  async streamLLM(name: string, message: string, sessionId: string, attachments?: unknown[], opts: { signal?: AbortSignal } = {}) {
    return _fetch(`/api/llm/${name}/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sessionId, ...(attachments ? { attachments } : {}) }), signal: opts.signal });
  },

  // MCP
  async getMCPServers() { return (await _fetch('/api/mcp')).json(); },
  async getMCPTools(serverName: string) { return (await _fetch(`/api/mcp/${serverName}/tools`)).json(); },
  async executeMcpTool(serverName: string, toolName: string, args: unknown) {
    return (await _fetch(`/api/mcp/${serverName}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: toolName, arguments: args }) })).json();
  },

  // Tools (unified)
  async getTools() { return (await _fetch('/api/tools')).json(); },

  // Functions
  async getFunctions() { return (await _fetch('/api/functions')).json(); },
  async getFunction(name: string) { return (await _fetch(`/api/functions/${name}`)).json(); },
  async executeFunction(name: string, args: unknown) {
    return (await _fetch(`/api/functions/${name}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arguments: args }) })).json();
  },

  // Skills
  async getSkills() { return (await _fetch('/api/skills')).json(); },
  async getSkill(name: string) { return (await _fetch(`/api/skills/${encodeURIComponent(name)}`)).json(); },

  // Files (IDE)
  async getFileTree() { return (await _fetch('/api/files/tree')).json(); },
  async readFile(filePath: string) { return (await _fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`)).json(); },
  async writeFile(filePath: string, content: string) {
    return (await _fetch('/api/files/write', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath, content }) })).json();
  },
  async getResourceTemplate(type: string, name: string) {
    return (await _fetch(`/api/files/template?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`)).json();
  },
  async createFile(filePath: string, content = '') {
    return (await _fetch('/api/files/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath, content }) })).json();
  },
  async renameFile(oldPath: string, newPath: string) {
    return (await _fetch('/api/files/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPath, newPath }) })).json();
  },
  async deleteFile(filePath: string) {
    return (await _fetch('/api/files/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }) })).json();
  },

  // Tasks
  async getTasks(queryString = '') {
    const url = queryString ? `/api/tasks?${queryString}` : '/api/tasks';
    return (await _fetch(url)).json();
  },
  async getTask(id: string) { return (await _fetch(`/api/tasks/${id}`)).json(); },
  async submitAgentTask(agent: string, input: string, sessionId: string) {
    return (await _fetch('/api/tasks/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, input, sessionId }) })).json();
  },
  async submitWorkflowTask(workflow: string, input: string) {
    return (await _fetch('/api/tasks/workflow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow, input }) })).json();
  },
  async cancelTask(id: string) { return (await _fetch(`/api/tasks/${id}/cancel`, { method: 'POST' })).json(); },
  async respondToTask(id: string, response: string) {
    return (await _fetch(`/api/tasks/${id}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response }) })).json();
  },
  streamTask(id: string) { return new EventSource(`/api/tasks/${id}/stream`); },

  // Local LLM
  async getLocalLlmStatus() { return (await _fetch('/api/local-llm/status')).json(); },
  async getLocalLlmModels() { return (await _fetch('/api/local-llm/models')).json(); },
  async activateLocalModel(id: string) {
    return (await _fetch(`/api/local-llm/models/${encodeURIComponent(id)}/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).json();
  },
  async deleteLocalModel(id: string) {
    return (await _fetch(`/api/local-llm/models/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
  },
  browseHuggingFace(query: string, limit = 10, format = 'gguf') {
    return _fetch(`/api/local-llm/browse?q=${encodeURIComponent(query)}&limit=${limit}&format=${format}`).then(r => r.json());
  },
  downloadLocalModel(repo: string, fileName: string, type = 'gguf') {
    const params = new URLSearchParams({ repo });
    if (type === 'mlx') params.set('type', 'mlx');
    else params.set('fileName', fileName);
    return new EventSource(`/api/local-llm/models/download?${params.toString()}`);
  },
  async getActiveDownloads() { return (await _fetch('/api/local-llm/models/downloads')).json(); },
  async getInterruptedDownloads() { return (await _fetch('/api/local-llm/models/interrupted')).json(); },
  async deleteInterruptedDownload(fileName: string) {
    return (await _fetch(`/api/local-llm/models/interrupted/${encodeURIComponent(fileName)}`, { method: 'DELETE' })).json();
  },
  async activateLocalEmbedding(id: string) {
    return (await _fetch(`/api/local-llm/models/${encodeURIComponent(id)}/activate-embedding`, { method: 'POST' })).json();
  },
  async stopLocalLlm(engine?: string) {
    return (await _fetch('/api/local-llm/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(engine ? { engine } : {}) })).json();
  },
  async stopLocalEmbedding(engine?: string) {
    return (await _fetch('/api/local-llm/stop-embedding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(engine ? { engine } : {}) })).json();
  },
  async getEngines() { return (await _fetch('/api/local-llm/engines')).json(); },
  async activateEngine(engine: string, model: string, role = 'chat') {
    return (await _fetch('/api/local-llm/engines/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine, model, role }) })).json();
  },
  async unloadEngineModel(engine: string, model: string, instanceId?: string) {
    return (await _fetch('/api/local-llm/engines/unload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine, model, ...(instanceId ? { instanceId } : {}) }) })).json();
  },
  async getEngineUrls() { return (await _fetch('/api/local-llm/engines/urls')).json(); },
  async setEngineUrl(engine: string, url: string) {
    return (await _fetch('/api/local-llm/engines/urls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine, url }) })).json();
  },
  async setEngineContext(contextSize: number) {
    return (await _fetch('/api/local-llm/engines/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextSize }) })).json();
  },

  // Logs
  streamLogs() { return new EventSource('/api/logs/stream'); },

  // Graph
  async getGraphConfig() { return (await _fetch('/api/graph/config')).json(); },
  async getGraphKnowledgeBases() { return (await _fetch('/api/graph/knowledge-bases')).json(); },
  async getGraphFull(limit = 300) { return (await _fetch(`/api/graph/full?limit=${limit}`)).json(); },
  async getGraphNeighbors(nodeId: string, depth = 1) {
    return (await _fetch(`/api/graph/neighbors/${encodeURIComponent(nodeId)}?depth=${depth}`)).json();
  },
};
