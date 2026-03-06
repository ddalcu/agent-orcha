
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function timeAgo(dateStr) {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// Model family patterns for capability detection.
// HuggingFace tags are unreliable — most GGUF repos don't tag capabilities.
// We combine explicit tags, pipeline_tag, and model name heuristics.
const TOOL_TAGS = ['tool-calling', 'function-calling', 'tool_use', 'tool-use'];
const TOOL_NAME_PATTERNS = [
    /qwen[23]/i, /qwen3\.5/i, /llama.?3\.[1-9]/i, /mistral/i, /phi.?[4-9]/i,
    /functionary/i, /hermes/i, /command.?r/i, /glm/i, /gemma.?[2-9]/i,
    /nemotron/i, /granite/i,
];
const VISION_PIPELINE_TAGS = ['image-text-to-text', 'image-to-text'];
const VISION_NAME_PATTERNS = [
    /vision/i, /llava/i, /pixtral/i, /qwen3\.5/i,
];
const REASONING_NAME_PATTERNS = [
    /deepseek.?r1/i, /qwq/i, /o[134]-/i, /reasoning/i,
    /think/i, /r1.?distill/i, /qwen3/i,
];
// Qwen3+ has built-in thinking mode (enable_thinking), including Qwen3.5
const REASONING_TAG_PATTERNS = [/qwen3/i];

function detectCapabilities(result) {
    const { tags, pipelineTag, modelName, repoId } = result;
    const name = `${repoId} ${modelName}`;
    const lowerTags = (tags || []).map(t => t.toLowerCase());

    const vision = VISION_PIPELINE_TAGS.includes(pipelineTag)
        || lowerTags.some(t => VISION_PIPELINE_TAGS.includes(t))
        || VISION_NAME_PATTERNS.some(p => p.test(name));

    const tools = lowerTags.some(t => TOOL_TAGS.includes(t))
        || TOOL_NAME_PATTERNS.some(p => p.test(name));

    const reasoning = REASONING_NAME_PATTERNS.some(p => p.test(name))
        || REASONING_TAG_PATTERNS.some(p => lowerTags.some(t => p.test(t)));

    return { vision, tools, reasoning };
}

function detectCapabilitiesFromFile(model) {
    const name = `${model.repo || ''} ${model.fileName}`;
    return {
        tools: TOOL_NAME_PATTERNS.some(p => p.test(name)),
        vision: VISION_NAME_PATTERNS.some(p => p.test(name)),
        reasoning: REASONING_NAME_PATTERNS.some(p => p.test(name))
            || REASONING_TAG_PATTERNS.some(p => p.test(name)),
    };
}

function capabilityBadges(caps) {
    const badges = [];
    if (caps.tools) badges.push('<span class="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400" title="Tool calling"><i class="fas fa-wrench mr-0.5"></i>tools</span>');
    if (caps.vision) badges.push('<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400" title="Vision"><i class="fas fa-eye mr-0.5"></i>vision</span>');
    if (caps.reasoning) badges.push('<span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400" title="Reasoning"><i class="fas fa-brain mr-0.5"></i>think</span>');
    return badges.join(' ');
}

export class LocalLlmView extends Component {
    constructor() {
        super();
        this.status = null;
        this.models = [];
        this.searchResults = [];
        this.activeDownloads = new Map(); // EventSource connections (UI only)
        this.downloadPollTimer = null;
        this.systemRamBytes = 0;
    }

    async connectedCallback() {
        super.connectedCallback();
        await this.refresh();
        this.pollActiveDownloads();
        this.loadInterruptedDownloads();
    }

    disconnectedCallback() {
        // Only close SSE connections — server downloads continue
        for (const es of this.activeDownloads.values()) {
            es.close();
        }
        this.activeDownloads.clear();
        if (this.downloadPollTimer) {
            clearInterval(this.downloadPollTimer);
            this.downloadPollTimer = null;
        }
    }

    async refresh() {
        await Promise.all([this.loadStatus(), this.loadModels()]);
    }

    startDownloadPolling() {
        if (this.downloadPollTimer) return; // already polling
        this.downloadPollTimer = setInterval(async () => {
            try {
                const current = await api.getActiveDownloads();
                if (current.length === 0) {
                    clearInterval(this.downloadPollTimer);
                    this.downloadPollTimer = null;
                    this.renderActiveDownloads([]);
                    this.loadModels();
                } else {
                    this.renderActiveDownloads(current);
                }
            } catch { /* ignore */ }
        }, 1000);
    }

    async pollActiveDownloads() {
        try {
            const downloads = await api.getActiveDownloads();
            if (downloads.length > 0) {
                this.renderActiveDownloads(downloads);
                this.startDownloadPolling();
            }
        } catch { /* ignore */ }
    }

    async loadInterruptedDownloads() {
        const container = this.querySelector('#interruptedDownloads');
        if (!container) return;

        try {
            const interrupted = await api.getInterruptedDownloads();
            if (!interrupted.length) {
                container.innerHTML = '';
                return;
            }

            container.innerHTML = interrupted.map(d => `
                <div class="flex items-center gap-3 bg-dark-surface border border-yellow-500/30 rounded-lg px-4 py-3" data-interrupted="${escapeHtml(d.fileName)}">
                    <i class="fas fa-pause-circle text-yellow-400 text-sm"></i>
                    <div class="min-w-0 flex-1">
                        <div class="text-sm text-gray-200 truncate">${escapeHtml(d.fileName)}</div>
                        <div class="text-xs text-gray-500">${d.repo ? escapeHtml(d.repo) + ' · ' : ''}${formatBytes(d.downloadedBytes)} downloaded</div>
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0">
                        <button class="resume-btn px-3 py-1.5 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 rounded transition-colors" data-repo="${escapeHtml(d.repo || '')}" data-file="${escapeHtml(d.fileName)}">
                            <i class="fas fa-play mr-1"></i>Resume
                        </button>
                        <button class="discard-btn px-3 py-1.5 text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded transition-colors" data-file="${escapeHtml(d.fileName)}">
                            <i class="fas fa-trash-alt mr-1"></i>Discard
                        </button>
                    </div>
                </div>
            `).join('');

            container.querySelectorAll('.resume-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const repo = btn.dataset.repo;
                    const fileName = btn.dataset.file;
                    if (!repo) return;
                    const row = btn.closest('[data-interrupted]');
                    if (row) row.remove();
                    this.downloadModel(repo, fileName, null);
                    this.startDownloadPolling();
                });
            });

            container.querySelectorAll('.discard-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const fileName = btn.dataset.file;
                    try {
                        await api.deleteInterruptedDownload(fileName);
                        const row = btn.closest('[data-interrupted]');
                        if (row) row.remove();
                    } catch (e) {
                        console.error('Failed to discard download:', e);
                    }
                });
            });
        } catch {
            // ignore
        }
    }

    renderActiveDownloads(downloads) {
        const container = this.querySelector('#activeDownloads');
        if (!container) return;

        if (!downloads.length) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = downloads.map(d => `
            <div class="flex items-center gap-3 bg-dark-surface border border-amber-500/30 rounded-lg px-4 py-3">
                <i class="fas fa-spinner fa-spin text-amber-400 text-sm"></i>
                <div class="min-w-0 flex-1">
                    <div class="text-sm text-gray-200 truncate">${escapeHtml(d.fileName)}</div>
                    <div class="text-xs text-gray-500 truncate">${escapeHtml(d.repo)}</div>
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                    <div class="w-32 bg-dark-bg rounded-full h-1.5">
                        <div class="bg-amber-500 h-1.5 rounded-full transition-all duration-300" style="width: ${d.progress.percent}%"></div>
                    </div>
                    <span class="text-xs text-gray-500 font-mono w-12 text-right">${d.progress.percent}%</span>
                </div>
            </div>
        `).join('');
    }

    async loadStatus() {
        try {
            this.status = await api.getLocalLlmStatus();
            this.systemRamBytes = this.status.systemRamBytes || 0;
            this.renderStatus();
        } catch (e) {
            console.error('Failed to load local LLM status:', e);
        }
    }

    async loadModels() {
        try {
            this.models = await api.getLocalLlmModels();
            this.renderModels();
        } catch (e) {
            console.error('Failed to load local models:', e);
        }
    }

    renderStatus() {
        const container = this.querySelector('#statusBar');
        if (!container || !this.status) return;

        const { running, activeModel, embedding } = this.status;

        let html = '';

        // Chat model status
        if (running) {
            const modelName = activeModel ? activeModel.split('/').pop() : 'Unknown';
            html += `
                <div class="flex items-center justify-between bg-dark-surface border border-dark-border rounded-lg px-4 py-3">
                    <div class="flex items-center gap-3">
                        <span class="relative flex h-2.5 w-2.5">
                            <span class="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping"></span>
                            <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-400"></span>
                        </span>
                        <span class="text-sm text-gray-200">Chat Model</span>
                        <span class="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono">${escapeHtml(modelName)}</span>
                        ${this.status.port ? `<span class="text-xs text-gray-500">port ${this.status.port}</span>` : ''}
                    </div>
                    <button id="stopBtn" class="px-3 py-1.5 text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 rounded-lg transition-colors">
                        <i class="fas fa-stop mr-1"></i>Stop
                    </button>
                </div>`;
        } else {
            html += `
                <div class="flex items-center gap-3 bg-dark-surface border border-dark-border rounded-lg px-4 py-3">
                    <span class="inline-flex h-2.5 w-2.5 rounded-full bg-gray-500"></span>
                    <span class="text-sm text-gray-400">Chat Model</span>
                    <span class="text-xs text-gray-600">Activate a model to start</span>
                </div>`;
        }

        // Embedding model status
        if (embedding?.running) {
            const embName = embedding.activeModel ? embedding.activeModel.split('/').pop() : 'Unknown';
            html += `
                <div class="flex items-center justify-between bg-dark-surface border border-dark-border rounded-lg px-4 py-3 mt-2">
                    <div class="flex items-center gap-3">
                        <span class="relative flex h-2.5 w-2.5">
                            <span class="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping"></span>
                            <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-400"></span>
                        </span>
                        <span class="text-sm text-gray-200">Embedding Model</span>
                        <span class="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono">${escapeHtml(embName)}</span>
                    </div>
                    <button id="stopEmbBtn" class="px-3 py-1.5 text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 rounded-lg transition-colors">
                        <i class="fas fa-stop mr-1"></i>Stop
                    </button>
                </div>`;
        }

        container.innerHTML = html;
        this.querySelector('#stopBtn')?.addEventListener('click', () => this.stopServer());
        this.querySelector('#stopEmbBtn')?.addEventListener('click', () => this.stopEmbedding());
    }

    renderModels() {
        const container = this.querySelector('#modelsGrid');
        if (!container) return;

        if (!this.models.length) {
            container.innerHTML = `
                <div class="col-span-full space-y-6">
                    <div class="text-gray-500 text-center py-8">
                        <i class="fas fa-box-open text-4xl mb-4 block text-gray-600"></i>
                        <p class="text-lg mb-2">No models downloaded</p>
                        <p class="text-sm mb-6">Search HuggingFace below, or start with these recommended models:</p>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-3" id="recommendedModels">
                        <div class="bg-dark-surface border border-amber-500/30 rounded-lg p-4">
                            <div class="flex items-center gap-2 mb-2">
                                <i class="fas fa-comments text-amber-400 text-sm"></i>
                                <span class="font-medium text-gray-200 text-sm">Qwen3.5-9B-Q4_K_M</span>
                            </div>
                            <p class="text-xs text-gray-500 mb-3">Chat model with tool calling, vision, and reasoning. Great all-rounder for local use.</p>
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-gray-600">~5.3 GB</span>
                                <button class="rec-download-btn px-3 py-1.5 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 rounded transition-colors"
                                    data-repo="unsloth/Qwen3.5-9B-GGUF" data-file="Qwen3.5-9B-Q4_K_M.gguf">
                                    <i class="fas fa-download mr-1"></i>Download
                                </button>
                            </div>
                        </div>
                        <div class="bg-dark-surface border border-blue-500/30 rounded-lg p-4">
                            <div class="flex items-center gap-2 mb-2">
                                <i class="fas fa-vector-square text-blue-400 text-sm"></i>
                                <span class="font-medium text-gray-200 text-sm">nomic-embed-text-v1.5-Q4_K_M</span>
                            </div>
                            <p class="text-xs text-gray-500 mb-3">Embedding model for knowledge stores. Required for local RAG pipelines.</p>
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-gray-600">~80 MB</span>
                                <button class="rec-download-btn px-3 py-1.5 text-xs font-medium bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded transition-colors"
                                    data-repo="nomic-ai/nomic-embed-text-v1.5-GGUF" data-file="nomic-embed-text-v1.5.Q4_K_M.gguf">
                                    <i class="fas fa-download mr-1"></i>Download
                                </button>
                            </div>
                        </div>
                    </div>
                </div>`;
            container.querySelectorAll('.rec-download-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const repo = btn.dataset.repo;
                    const fileName = btn.dataset.file;
                    btn.disabled = true;
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Downloading...';
                    this.downloadModel(repo, fileName, null);
                    this.startDownloadPolling();
                });
            });
            return;
        }

        const activeModelPath = this.status?.activeModel;
        const activeEmbPath = this.status?.embedding?.activeModel;

        container.innerHTML = this.models.map(model => {
            const isChat = activeModelPath && activeModelPath === model.filePath;
            const isEmb = activeEmbPath && activeEmbPath === model.filePath;
            const looksLikeEmbedding = /embed/i.test(model.fileName);
            const borderClass = isChat ? 'border-amber-500 bg-amber-500/5'
                : isEmb ? 'border-blue-500 bg-blue-500/5'
                : 'border-dark-border hover:border-amber-500/50';
            const caps = looksLikeEmbedding ? null : detectCapabilitiesFromFile(model);
            const badges = caps ? capabilityBadges(caps) : '';

            return `
                <div class="bg-dark-surface border ${borderClass} rounded-lg p-4 transition-colors" data-model-id="${escapeHtml(model.id)}">
                    <div class="flex items-start justify-between mb-3">
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2 mb-1">
                                ${isChat ? '<i class="fas fa-circle text-amber-400 text-[6px]"></i>' : ''}
                                ${isEmb ? '<i class="fas fa-circle text-blue-400 text-[6px]"></i>' : ''}
                                <span class="font-medium text-gray-200 text-sm truncate">${escapeHtml(model.fileName)}</span>
                            </div>
                            ${model.repo ? `<div class="text-xs text-gray-500 truncate">${escapeHtml(model.repo)}</div>` : ''}
                            ${badges ? `<div class="flex items-center gap-1.5 mt-1.5">${badges}</div>` : ''}
                        </div>
                    </div>
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-3 text-xs text-gray-500">
                            <span><i class="fas fa-hard-drive mr-1"></i>${formatBytes(model.sizeBytes)}</span>
                            <span>${timeAgo(model.downloadedAt)}</span>
                        </div>
                        <div class="flex items-center gap-2">
                            ${looksLikeEmbedding
                                ? (isEmb
                                    ? '<span class="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-400">Embedding</span>'
                                    : `<button class="activate-emb-btn px-2.5 py-1 text-xs font-medium bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded transition-colors" data-id="${escapeHtml(model.id)}" title="Activate as embedding model">
                                            <i class="fas fa-vector-square mr-1"></i>Embed
                                        </button>`)
                                : (isChat
                                    ? '<span class="text-xs px-2 py-1 rounded bg-amber-500/20 text-amber-400">Active</span>'
                                    : `<button class="activate-btn px-2.5 py-1 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 rounded transition-colors" data-id="${escapeHtml(model.id)}" title="Activate as chat model">
                                            <i class="fas fa-play mr-1"></i>Activate
                                        </button>`)
                            }
                            ${!isChat && !isEmb
                                ? `<button class="delete-btn px-2 py-1 text-xs text-gray-500 hover:text-red-400 transition-colors" data-id="${escapeHtml(model.id)}" title="Delete model">
                                        <i class="fas fa-trash-alt"></i>
                                    </button>`
                                : ''
                            }
                        </div>
                    </div>
                </div>`;
        }).join('');

        container.querySelectorAll('.activate-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.activateModel(btn.dataset.id);
            });
        });

        container.querySelectorAll('.activate-emb-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.activateEmbedding(btn.dataset.id);
            });
        });

        container.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteModel(btn.dataset.id);
            });
        });
    }

    async activateModel(id) {
        const cloudProviders = ['openai', 'anthropic', 'gemini'];
        const isCloudDefault = cloudProviders.includes(this.status?.defaultProvider);
        // Non-cloud default (e.g. local) → silently replace. Cloud provider → ask first.
        const setAsDefault = !isCloudDefault
            ? true
            : confirm('Set this model as the default LLM?\n\nYes = replaces "default" in llm.json (existing default is preserved as "default_old")\nNo = saves as "local-llama" instead');

        const btn = this.querySelector(`.activate-btn[data-id="${id}"]`);
        const card = btn?.closest('[data-model-id]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="inline-block w-3 h-3 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin"></span> Loading...';
        }
        // Clear any previous error
        card?.querySelector('.activate-error')?.remove();

        try {
            const result = await api.activateLocalModel(id, { setAsDefault });
            if (result.error) {
                throw new Error(result.error);
            }
            await this.refresh();
        } catch (e) {
            console.error('Failed to activate model:', e);
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-play mr-1"></i>Activate';
            }
            if (card) {
                const errorEl = document.createElement('div');
                errorEl.className = 'activate-error mt-2 px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg';
                errorEl.innerHTML = `<i class="fas fa-exclamation-circle mr-1"></i>${escapeHtml(e.message)}`;
                card.appendChild(errorEl);
            }
        }
    }

    async deleteModel(id) {
        if (!confirm('Delete this model? This cannot be undone.')) return;

        try {
            await api.deleteLocalModel(id);
            await this.loadModels();
        } catch (e) {
            console.error('Failed to delete model:', e);
        }
    }

    async activateEmbedding(id) {
        const btn = this.querySelector(`.activate-emb-btn[data-id="${id}"]`);
        const card = btn?.closest('[data-model-id]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="inline-block w-3 h-3 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin"></span> Loading...';
        }
        card?.querySelector('.activate-error')?.remove();

        try {
            const result = await api.activateLocalEmbedding(id);
            if (result.error) {
                throw new Error(result.error);
            }
            await this.refresh();
        } catch (e) {
            console.error('Failed to activate embedding model:', e);
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-vector-square mr-1"></i>Embed';
            }
            if (card) {
                const errorEl = document.createElement('div');
                errorEl.className = 'activate-error mt-2 px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg';
                errorEl.innerHTML = `<i class="fas fa-exclamation-circle mr-1"></i>${escapeHtml(e.message)}`;
                card.appendChild(errorEl);
            }
        }
    }

    async stopServer() {
        const btn = this.querySelector('#stopBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Stopping...';
        }

        try {
            await api.stopLocalLlm();
            await this.loadStatus();
        } catch (e) {
            console.error('Failed to stop server:', e);
        }
    }

    async stopEmbedding() {
        const btn = this.querySelector('#stopEmbBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Stopping...';
        }

        try {
            await api.stopLocalEmbedding();
            await this.refresh();
        } catch (e) {
            console.error('Failed to stop embedding:', e);
        }
    }

    async searchHuggingFace() {
        const input = this.querySelector('#hfSearchInput');
        const query = input?.value?.trim();
        if (!query) return;

        const container = this.querySelector('#hfResults');
        const btn = this.querySelector('#hfSearchBtn');
        container.innerHTML = '<div class="text-gray-500 text-center py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Searching HuggingFace...</div>';
        btn.disabled = true;

        try {
            this.searchResults = await api.browseHuggingFace(query, 10);
            this.renderSearchResults();
        } catch (e) {
            container.innerHTML = `<div class="text-red-400 text-center py-4">Error: ${escapeHtml(e.message)}</div>`;
        } finally {
            btn.disabled = false;
        }
    }

    selectedFileForRow(idx) {
        const select = this.querySelector(`#gguf-select-${idx}`);
        if (!select) return null;
        const fileName = select.value;
        const result = this.searchResults[idx];
        return result?.ggufFiles.find(f => f.fileName === fileName) ?? null;
    }

    updateRowDownloadState(idx) {
        const btn = this.querySelector(`.download-btn[data-idx="${idx}"]`);
        if (!btn) return;
        const result = this.searchResults[idx];
        const file = this.selectedFileForRow(idx);
        if (!result || !file) return;

        const downloaded = this.isModelDownloaded(result.repoId, file.fileName);
        const downloadId = `${result.repoId}/${file.fileName}`;
        const isDownloading = this.activeDownloads.has(downloadId);

        // Always clear download-in-progress classes first
        btn.classList.remove('opacity-50', 'pointer-events-none');

        if (downloaded) {
            btn.disabled = true;
            btn.className = btn.className.replace(/bg-amber-500\/20 hover:bg-amber-500\/30 text-amber-400/, 'bg-green-500/20 text-green-400 cursor-default');
            btn.innerHTML = '<i class="fas fa-check mr-1"></i>Downloaded';
        } else if (isDownloading) {
            btn.classList.add('opacity-50', 'pointer-events-none');
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        } else {
            btn.disabled = false;
            btn.className = btn.className.replace(/bg-green-500\/20 text-green-400 cursor-default/, 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-400');
            btn.innerHTML = '<i class="fas fa-download mr-1"></i>Download';
        }
    }

    updateRowWarning(idx) {
        const warning = this.querySelector(`.ram-warning[data-idx="${idx}"]`);
        if (!warning) return;
        const file = this.selectedFileForRow(idx);
        if (file && this.systemRamBytes > 0 && file.sizeBytes > this.systemRamBytes) {
            warning.classList.remove('hidden');
        } else {
            warning.classList.add('hidden');
        }
    }

    isModelDownloaded(repoId, fileName) {
        return this.models.some(m => m.repo === repoId && m.fileName === fileName);
    }

    renderSearchResults() {
        const container = this.querySelector('#hfResults');
        if (!container) return;

        if (!this.searchResults.length) {
            container.innerHTML = '<div class="text-gray-500 text-center py-8">No GGUF models found for this query.</div>';
            return;
        }

        // Filter out results with no GGUF files
        const resultsWithFiles = this.searchResults.filter(r => r.ggufFiles.length > 0);
        if (!resultsWithFiles.length) {
            container.innerHTML = '<div class="text-gray-500 text-center py-8">No GGUF files found in the results.</div>';
            return;
        }

        const ram = this.systemRamBytes;

        const rows = this.searchResults.map((result, idx) => {
            if (result.ggufFiles.length === 0) return '';

            const caps = detectCapabilities(result);
            const capIcons = [
                caps.tools ? '<i class="fas fa-wrench text-green-400" title="Tool calling"></i>' : '<i class="fas fa-wrench text-gray-600" title="No tool calling"></i>',
                caps.vision ? '<i class="fas fa-eye text-blue-400" title="Vision"></i>' : '<i class="fas fa-eye text-gray-600" title="No vision"></i>',
                caps.reasoning ? '<i class="fas fa-brain text-purple-400" title="Reasoning / Thinking"></i>' : '<i class="fas fa-brain text-gray-600" title="No reasoning"></i>',
            ].join('');

            const options = result.ggufFiles.map(f =>
                `<option value="${escapeHtml(f.fileName)}" data-size="${f.sizeBytes}">${escapeHtml(f.fileName)} (${formatBytes(f.sizeBytes)})</option>`
            ).join('');

            const firstFile = result.ggufFiles[0];
            const firstTooLarge = ram > 0 && firstFile.sizeBytes > ram;
            const firstDownloaded = this.isModelDownloaded(result.repoId, firstFile.fileName);

            return `
                <div class="flex items-center gap-3 bg-dark-surface border border-dark-border rounded-lg px-4 py-3" data-idx="${idx}">
                    <div class="min-w-0 flex-shrink-0 w-44">
                        <div class="font-medium text-gray-200 text-sm truncate" title="${escapeHtml(result.repoId)}">${escapeHtml(result.modelName)}</div>
                        <div class="text-xs text-gray-500 truncate">${escapeHtml(result.author)}</div>
                    </div>
                    <div class="flex items-center gap-2 text-xs flex-shrink-0">
                        <span class="text-gray-500" title="Downloads"><i class="fas fa-download mr-1"></i>${result.downloads?.toLocaleString() ?? 0}</span>
                        <span class="flex items-center gap-1.5">${capIcons}</span>
                    </div>
                    <select class="gguf-select flex-1 min-w-0 bg-dark-bg border border-dark-border rounded px-2 py-1.5 text-xs text-gray-300 font-mono focus:outline-none focus:border-amber-500 truncate" id="gguf-select-${idx}">
                        ${options}
                    </select>
                    <span class="ram-warning text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 flex-shrink-0 ${firstTooLarge ? '' : 'hidden'}" data-idx="${idx}" title="File size exceeds system RAM (${formatBytes(ram)})"><i class="fas fa-memory mr-0.5"></i>won't fit</span>
                    <div class="flex items-center gap-2 flex-shrink-0">
                        <button class="download-btn px-3 py-1.5 text-xs font-medium rounded transition-colors ${firstDownloaded
                            ? 'bg-green-500/20 text-green-400 cursor-default'
                            : 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-400'}" data-idx="${idx}" ${firstDownloaded ? 'disabled' : ''}>
                            ${firstDownloaded
                                ? '<i class="fas fa-check mr-1"></i>Downloaded'
                                : '<i class="fas fa-download mr-1"></i>Download'}
                        </button>
                    </div>
                </div>`;
        }).join('');

        container.innerHTML = `<div class="space-y-2">${rows}</div>`;

        // Update RAM warning and download button when select changes
        container.querySelectorAll('.gguf-select').forEach(select => {
            select.addEventListener('change', () => {
                const idx = parseInt(select.id.replace('gguf-select-', ''));
                this.updateRowWarning(idx);
                this.updateRowDownloadState(idx);
            });
        });

        container.querySelectorAll('.download-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                const result = this.searchResults[idx];
                const select = container.querySelector(`#gguf-select-${idx}`);
                const fileName = select?.value;
                if (result && fileName) {
                    this.downloadModel(result.repoId, fileName, idx);
                    this.startDownloadPolling();
                }
            });
        });
    }

    downloadModel(repo, fileName, rowIdx) {
        const downloadId = `${repo}/${fileName}`;
        if (this.activeDownloads.has(downloadId)) return;

        const es = api.downloadLocalModel(repo, fileName);
        this.activeDownloads.set(downloadId, es);

        // Update button state for the search result row (if any)
        if (rowIdx != null) this.updateRowDownloadState(rowIdx);

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'complete') {
                    this.cleanupDownload(downloadId);
                    if (rowIdx != null) this.updateRowDownloadState(rowIdx);
                    this.loadModels();
                }

                if (data.type === 'error') {
                    console.error('Download error:', data.error);
                    this.cleanupDownload(downloadId);
                    if (rowIdx != null) this.updateRowDownloadState(rowIdx);
                }
            } catch {
                // ignore parse errors
            }
        };

        es.onerror = () => {
            this.cleanupDownload(downloadId);
            if (rowIdx != null) this.updateRowDownloadState(rowIdx);
        };
    }

    cleanupDownload(downloadId) {
        const es = this.activeDownloads.get(downloadId);
        if (es) {
            es.close();
            this.activeDownloads.delete(downloadId);
        }
    }

    postRender() {
        this.querySelector('#refreshBtn')?.addEventListener('click', () => this.refresh());

        this.querySelector('#hfSearchBtn')?.addEventListener('click', () => this.searchHuggingFace());
        this.querySelector('#hfSearchInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.searchHuggingFace();
        });
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-8 custom-scrollbar">
                <div class="flex items-center justify-between border-b border-dark-border pb-4">
                    <div>
                        <h2 class="text-lg font-semibold text-gray-200">Local LLM</h2>
                        <p class="text-xs text-gray-500 mt-1">Run AI models locally with llama-server</p>
                    </div>
                    <button id="refreshBtn" class="p-2 text-gray-400 hover:text-gray-200 transition-colors" title="Refresh">
                        <i class="fas fa-sync-alt text-sm"></i>
                    </button>
                </div>

                <!-- Status Bar -->
                <div id="statusBar">
                    <div class="flex items-center gap-3 bg-dark-surface border border-dark-border rounded-lg px-4 py-3">
                        <i class="fas fa-spinner fa-spin text-gray-500 text-sm"></i>
                        <span class="text-sm text-gray-400">Loading...</span>
                    </div>
                </div>

                <!-- Active / Interrupted Downloads -->
                <div id="activeDownloads"></div>
                <div id="interruptedDownloads"></div>

                <!-- Downloaded Models -->
                <div>
                    <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Downloaded Models</h3>
                    <div id="modelsGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        <div class="text-gray-500 text-center py-8 col-span-full">Loading...</div>
                    </div>
                </div>

                <!-- HuggingFace Browser -->
                <div class="border-t border-dark-border pt-6">
                    <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">HuggingFace Browser</h3>
                    <div class="flex gap-2 mb-2">
                        <input id="hfSearchInput" type="text" placeholder="Search GGUF models (e.g. Qwen3, Llama, Phi)..."
                            class="flex-1 bg-dark-surface border border-dark-border rounded-lg px-4 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-amber-500 placeholder-gray-600" />
                        <button id="hfSearchBtn" class="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors">
                            <i class="fas fa-search mr-1"></i>Search
                        </button>
                    </div>
                    <p class="text-xs text-gray-600 mb-4">
                        <i class="fas fa-wrench text-green-400 mr-0.5"></i>tool calling
                        <span class="mx-2">|</span>
                        <i class="fas fa-eye text-blue-400 mr-0.5"></i>vision
                        <span class="mx-2">|</span>
                        <i class="fas fa-brain text-purple-400 mr-0.5"></i>reasoning
                        <span class="mx-2">|</span>
                        <span class="text-gray-700">gray = not supported</span>
                    </p>
                    <div id="hfResults">
                        <div class="text-gray-600 text-center py-8 text-sm">
                            <i class="fas fa-cube text-3xl mb-3 block text-gray-700"></i>
                            Search HuggingFace to find and download GGUF models
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('local-llm-view', LocalLlmView);
