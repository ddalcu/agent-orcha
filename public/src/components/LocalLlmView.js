
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

const PROVIDERS = ['local', 'openai', 'anthropic', 'gemini'];

// Brand SVG icons (viewBox 0 0 24 24, uses currentColor)
const BRAND_SVGS = {
    openai: `<svg viewBox="0 0 24 24" fill="currentColor" class="llm-brand-icon"><path d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5zM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.08 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06l-4.84 2.79a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0L4.02 14.01A4.5 4.5 0 0 1 2.34 7.87zm16.6 3.86L13.1 8.36l2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1V12.42a.79.79 0 0 0-.41-.68zm2.01-3.02l-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.8.8 0 0 0-.39.68zm1.1-2.36l2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5z"/></svg>`,
    anthropic: `<svg viewBox="0 0 24 24" fill="currentColor" class="llm-brand-icon"><path d="M13.83 3.52h3.6L24 20.48h-3.6l-6.57-16.96zm-7.26 0h3.6l6.57 16.96h-3.6L6.57 3.52z"/></svg>`,
    gemini: `<svg viewBox="0 0 24 24" fill="currentColor" class="llm-brand-icon"><path d="M12 0C12 6.63 6.63 12 0 12c6.63 0 12 5.37 12 12 0-6.63 5.37-12 12-12C17.37 12 12 6.63 12 0z"/></svg>`,
};

function providerIcon(provider) {
    if (BRAND_SVGS[provider]) return BRAND_SVGS[provider];
    return `<i class="fas fa-server"></i>`;
}

const PROVIDER_META = {
    local:     { label: 'Local',     color: 'amber' },
    openai:    { label: 'OpenAI',    color: 'green' },
    anthropic: { label: 'Anthropic', color: 'purple' },
    gemini:    { label: 'Google',    color: 'blue' },
};
const POPULAR_MODELS = {
    openai:    ['gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'o4-mini', 'o3', 'o3-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
    anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-opus-4-5'],
    gemini:    ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
};
const POPULAR_EMBEDDINGS = {
    openai: ['text-embedding-3-small', 'text-embedding-3-large'],
    gemini: ['gemini-embedding-001', 'text-embedding-004'],
};
const PROVIDER_ENV_NAMES = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GOOGLE_API_KEY',
};

const RECOMMENDED_MODELS = [
    { repo: 'unsloth/Qwen3.5-9B-GGUF', file: 'Qwen3.5-9B-Q4_K_M.gguf', label: 'Qwen3.5-9B-Q4_K_M', desc: 'Chat model with tool calling, vision, and reasoning. Great all-rounder for local use.', size: '~5.3 GB', icon: 'fa-comments', color: 'amber' },
    { repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF', file: 'nomic-embed-text-v1.5.Q4_K_M.gguf', label: 'nomic-embed-text-v1.5-Q4_K_M', desc: 'Embedding model for knowledge stores. Required for local RAG pipelines.', size: '~80 MB', icon: 'fa-vector-square', color: 'blue' },
];

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
    if (caps.tools) badges.push('<span class="cap-badge cap-badge-tools" title="Tool calling"><i class="fas fa-wrench mr-1"></i>tools</span>');
    if (caps.vision) badges.push('<span class="cap-badge cap-badge-vision" title="Vision"><i class="fas fa-eye mr-1"></i>vision</span>');
    if (caps.reasoning) badges.push('<span class="cap-badge cap-badge-think" title="Reasoning"><i class="fas fa-brain mr-1"></i>think</span>');
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
        this.updateInfo = null;
        this.activeProvider = 'local';
        this.llmConfig = null;
    }

    async connectedCallback() {
        super.connectedCallback();
        await this.loadLlmConfig();
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
                <div class="llm-alert llm-alert-warning" data-interrupted="${escapeHtml(d.fileName)}">
                    <i class="fas fa-pause-circle text-amber text-sm"></i>
                    <div class="min-w-0 flex-1">
                        <div class="text-sm text-primary truncate">${escapeHtml(d.fileName)}</div>
                        <div class="text-xs text-muted">${d.repo ? escapeHtml(d.repo) + ' · ' : ''}${formatBytes(d.downloadedBytes)} downloaded</div>
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0">
                        <button class="resume-btn btn btn-amber btn-sm" data-repo="${escapeHtml(d.repo || '')}" data-file="${escapeHtml(d.fileName)}">
                            <i class="fas fa-play mr-1"></i>Resume
                        </button>
                        <button class="discard-btn btn btn-danger btn-sm" data-file="${escapeHtml(d.fileName)}">
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
            <div class="llm-alert llm-alert-amber">
                <i class="fas fa-spinner fa-spin text-amber text-sm"></i>
                <div class="min-w-0 flex-1">
                    <div class="text-sm text-primary truncate">${escapeHtml(d.fileName)}</div>
                    <div class="text-xs text-muted truncate">${escapeHtml(d.repo)}</div>
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                    <div class="llm-download-bar">
                        <div class="llm-download-fill llm-download-fill-amber" style="width: ${d.progress.percent}%"></div>
                    </div>
                    <span class="text-xs text-muted font-mono text-right">${d.progress.percent}%</span>
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
            this.renderRecommendations();
        } catch (e) {
            console.error('Failed to load local models:', e);
        }
    }

    renderStatus() {
        const container = this.querySelector('#statusBar');
        if (!container || !this.status) return;

        const { running, activeModel, embedding } = this.status;
        const version = this.status.llamaVersion;
        const gpuName = this.status.gpu?.name;
        const gpuAccel = this.status.gpu?.accel || 'none';
        const hasUpdate = this.updateInfo?.available === true;
        const daysLabel = hasUpdate && this.updateInfo.daysNewer != null
            ? (this.updateInfo.daysNewer === 0 ? 'today' : `${this.updateInfo.daysNewer}d ago`)
            : '';

        const accelLabels = { 'none': 'CPU', 'metal': 'Metal', 'vulkan': 'Vulkan', 'cuda-12.4': 'CUDA 12.4', 'cuda-13.1': 'CUDA 13.1' };
        const runtimeLabel = gpuName
            ? `${gpuName} (${accelLabels[gpuAccel] || gpuAccel})`
            : (accelLabels[gpuAccel] || gpuAccel);

        // --- Server header ---
        let html = `<div class="llm-server-panel">`;

        // Server info header
        html += `
            <div class="llm-server-header">
                <div class="flex items-center gap-2">
                    <i class="fas fa-server text-amber text-xs"></i>
                    <span class="text-sm font-semibold text-primary">llama-server</span>
                    ${version ? `<span class="text-xs text-muted font-mono">b${escapeHtml(version.match(/^(\d+)/)?.[1] || version)}</span>` : ''}
                </div>
                ${this.status.binarySource === 'managed' ? (
                    hasUpdate ? `
                    <button id="updateBinaryBtn" class="btn btn-indigo btn-sm flex-shrink-0" title="Latest: ${escapeHtml(this.updateInfo.latestTag || '')}">
                        <i class="fas fa-arrows-rotate mr-1"></i>Update${daysLabel ? ` <span class="text-muted">(${daysLabel})</span>` : ''}
                    </button>`
                    : !this.updateInfo ? `
                    <button id="checkUpdateBtn" class="btn-ghost text-xs flex-shrink-0">
                        <i class="fas fa-arrows-rotate mr-1"></i>Check for updates
                    </button>` : ''
                ) : ''}
            </div>`;

        // Server details row
        html += `
            <div class="llm-server-details">
                <span title="Runtime"><i class="fas fa-bolt mr-1 llm-icon-dim"></i>${escapeHtml(runtimeLabel)}</span>
                <span title="Server type"><i class="fas fa-comments mr-1 llm-icon-dim"></i>Chat Completions</span>
                ${running && this.status.port ? `
                    <span class="flex items-center gap-1" title="OpenAI-compatible API endpoint">
                        <i class="fas fa-link mr-1 llm-icon-dim"></i>
                        <code class="font-mono text-secondary">http://127.0.0.1:${this.status.port}/v1</code>
                        <button class="copy-url-btn text-muted transition-colors" data-url="http://127.0.0.1:${this.status.port}/v1" title="Copy URL">
                            <i class="fas fa-copy text-2xs"></i>
                        </button>
                    </span>` : `<span><i class="fas fa-link mr-1 llm-icon-dim"></i><span class="text-muted">Not running</span></span>`}
            </div>`;

        // --- Chat model (child) ---
        html += `<div class="llm-server-section">`;
        if (running) {
            const modelName = activeModel ? activeModel.split('/').pop() : 'Unknown';
            const mem = this.status.memoryEstimate;
            const totalRam = this.status.systemRamBytes;
            const ctxSize = this.status.contextSize;
            const memPct = mem && totalRam ? Math.round((mem.totalBytes / totalRam) * 100) : null;
            const memBarCls = memPct > 80 ? 'llm-mem-red' : memPct > 60 ? 'llm-mem-amber' : 'llm-mem-green';
            const kvPerToken = mem && ctxSize ? mem.kvCacheBytes / ctxSize : 0;
            const currentMaxTokens = this.llmConfig?.models?.default?.maxTokens || 4096;

            html += `
                <div class="llm-section-content space-y-2">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-3">
                            <span class="llm-pulse llm-pulse-green"></span>
                            <span class="text-sm text-primary">Chat Model</span>
                            <span class="badge badge-amber font-mono">${escapeHtml(modelName)}</span>
                            ${ctxSize ? `<span class="text-xs text-muted">${(ctxSize / 1024).toFixed(0)}K ctx</span>` : ''}
                        </div>
                        <button id="stopBtn" class="btn btn-danger btn-sm">
                            <i class="fas fa-stop mr-1"></i>Stop
                        </button>
                    </div>
                    ${mem ? `
                    <div class="flex items-center gap-3">
                        <div class="llm-mem-bar">
                            <div class="llm-mem-fill ${memBarCls}" style="width: ${memPct}%"></div>
                        </div>
                        <div class="flex items-center gap-3 text-xs text-muted flex-shrink-0">
                            <span title="Model weights"><i class="fas fa-cube mr-1"></i>${formatBytes(mem.modelBytes)}</span>
                            <span title="KV cache"><i class="fas fa-memory mr-1"></i>${formatBytes(mem.kvCacheBytes)}</span>
                            <span title="Total estimated / System RAM">${formatBytes(mem.totalBytes)} / ${formatBytes(totalRam)}</span>
                        </div>
                    </div>` : ''}
                    <div class="llm-sliders-section">
                        <div class="llm-slider-row">
                            <label class="llm-slider-label">
                                <span>Context Size</span>
                                <span id="ctxValue" class="font-mono">${ctxSize >= 1024 ? `${(ctxSize / 1024).toFixed(0)}K` : ctxSize}</span>
                            </label>
                            <input type="range" id="ctxSlider" class="llm-range"
                                data-kv-per-token="${kvPerToken}" data-model-bytes="${mem?.modelBytes || 0}" data-total-ram="${totalRam || 0}"
                                data-orig="${ctxSize || 8192}"
                                min="2048" max="131072" step="1024" value="${ctxSize || 8192}" />
                            <div class="llm-slider-meta">
                                <span>2K</span>
                                <span id="ctxMemEstimate" class="font-mono">${formatBytes(mem?.kvCacheBytes || 0)} KV + ${formatBytes(mem?.modelBytes || 0)} model = ${formatBytes(mem?.totalBytes || 0)} / ${formatBytes(totalRam)}</span>
                                <span>128K</span>
                            </div>
                        </div>
                        <div class="llm-slider-row">
                            <label class="llm-slider-label">
                                <span>Max Tokens</span>
                                <span id="maxTokValue" class="font-mono">${currentMaxTokens.toLocaleString()}</span>
                            </label>
                            <input type="range" id="maxTokSlider" class="llm-range"
                                data-orig="${currentMaxTokens}"
                                min="256" max="16384" step="256" value="${currentMaxTokens}" />
                            <div class="llm-slider-meta">
                                <span>256</span>
                                <span>16K</span>
                            </div>
                        </div>
                        <div id="sliderWarning" class="llm-slider-warning hidden"></div>
                        <button id="applySettingsBtn" class="btn btn-accent btn-sm hidden">
                            <i class="fas fa-save mr-1"></i>Apply
                        </button>
                    </div>
                </div>`;
        } else {
            const lastModel = this.status.lastActiveModel;
            const lastModelName = lastModel ? this.models.find(m => m.id === lastModel) : null;
            html += `
                <div class="llm-section-content flex items-center justify-between">
                    <div class="flex items-center gap-3">
                        <span class="llm-pulse-off"></span>
                        <span class="text-sm text-secondary">Chat Model</span>
                        ${lastModelName
                            ? `<span class="text-xs text-muted">${escapeHtml(lastModelName.fileName)}</span>`
                            : '<span class="text-xs text-muted">Activate a model to start</span>'}
                    </div>
                    ${lastModelName
                        ? `<button id="startLastBtn" class="btn btn-amber btn-sm" data-id="${escapeHtml(lastModel)}">
                                <i class="fas fa-play mr-1"></i>Start
                            </button>`
                        : ''}
                </div>`;
        }
        html += `</div>`;

        // --- Embedding model (child) ---
        if (embedding?.running) {
            const embName = embedding.activeModel ? embedding.activeModel.split('/').pop() : 'Unknown';
            html += `
                <div class="llm-server-section">
                    <div class="llm-section-content flex items-center justify-between">
                        <div class="flex items-center gap-3">
                            <span class="llm-pulse llm-pulse-blue"></span>
                            <span class="text-sm text-primary">Embedding Model</span>
                            <span class="badge badge-blue font-mono">${escapeHtml(embName)}</span>
                        </div>
                        <button id="stopEmbBtn" class="btn btn-danger btn-sm">
                            <i class="fas fa-stop mr-1"></i>Stop
                        </button>
                    </div>
                </div>`;
        }

        html += `</div>`; // close outer container

        container.innerHTML = html;
        this.querySelector('#stopBtn')?.addEventListener('click', () => this.stopServer());
        this.querySelector('#stopEmbBtn')?.addEventListener('click', () => this.stopEmbedding());
        this.querySelector('#startLastBtn')?.addEventListener('click', (e) => this.activateModel(e.currentTarget.dataset.id));
        this.querySelector('.copy-url-btn')?.addEventListener('click', (e) => {
            navigator.clipboard.writeText(e.currentTarget.dataset.url);
            const icon = e.currentTarget.querySelector('i');
            icon.className = 'fas fa-check text-2xs text-green';
            setTimeout(() => { icon.className = 'fas fa-copy text-2xs'; }, 1500);
        });
        this.querySelector('#updateBinaryBtn')?.addEventListener('click', () => this.updateBinary());
        this.querySelector('#checkUpdateBtn')?.addEventListener('click', () => this.checkForUpdate());

        const ctxSlider = this.querySelector('#ctxSlider');
        const maxTokSlider = this.querySelector('#maxTokSlider');
        const applyBtn = this.querySelector('#applySettingsBtn');
        const warningEl = this.querySelector('#sliderWarning');

        const updateSliderTrack = (slider, pct) => {
            const color = pct > 80 ? 'var(--red-400)' : pct > 60 ? 'var(--amber-400)' : 'var(--green)';
            const pos = ((parseInt(slider.value) - slider.min) / (slider.max - slider.min)) * 100;
            slider.style.setProperty('--range-color', color);
            slider.style.setProperty('--range-fill', `${pos}%`);
        };

        const updateApplyVisibility = () => {
            const ctxChanged = ctxSlider && ctxSlider.value !== ctxSlider.dataset.orig;
            const tokChanged = maxTokSlider && maxTokSlider.value !== maxTokSlider.dataset.orig;
            const changed = ctxChanged || tokChanged;
            applyBtn?.classList.toggle('hidden', !changed);
            if (!changed && warningEl) { warningEl.classList.add('hidden'); warningEl.textContent = ''; }
        };

        const computeRamPct = () => {
            if (!ctxSlider) return 0;
            const kvPT = parseFloat(ctxSlider.dataset.kvPerToken);
            const modelB = parseInt(ctxSlider.dataset.modelBytes);
            const ram = parseInt(ctxSlider.dataset.totalRam);
            const newKv = parseInt(ctxSlider.value) * kvPT;
            return ram ? Math.round((modelB + newKv) / ram * 100) : 0;
        };

        const updateWarning = (pct) => {
            if (!warningEl) return;
            if (pct > 90) {
                warningEl.textContent = 'Exceeds available RAM — will cause heavy swapping and very slow performance';
                warningEl.className = 'llm-slider-warning llm-slider-warning-red';
            } else if (pct > 75) {
                warningEl.textContent = 'High memory usage — may cause swapping and reduced performance';
                warningEl.className = 'llm-slider-warning llm-slider-warning-amber';
            } else {
                warningEl.classList.add('hidden');
                warningEl.textContent = '';
            }
        };

        // Set initial track fill
        if (ctxSlider) { updateSliderTrack(ctxSlider, computeRamPct()); }
        if (maxTokSlider) {
            const orig = parseInt(maxTokSlider.dataset.orig);
            const pos = ((orig - 256) / (16384 - 256)) * 100;
            maxTokSlider.style.setProperty('--range-color', 'var(--green)');
            maxTokSlider.style.setProperty('--range-fill', `${pos}%`);
        }

        ctxSlider?.addEventListener('input', () => {
            const val = parseInt(ctxSlider.value);
            const kvPT = parseFloat(ctxSlider.dataset.kvPerToken);
            const modelB = parseInt(ctxSlider.dataset.modelBytes);
            const ram = parseInt(ctxSlider.dataset.totalRam);
            const newKv = val * kvPT;
            const newTotal = modelB + newKv;
            this.querySelector('#ctxValue').textContent = val >= 1024 ? `${(val / 1024).toFixed(0)}K` : val;
            this.querySelector('#ctxMemEstimate').textContent = `${formatBytes(newKv)} KV + ${formatBytes(modelB)} model = ${formatBytes(newTotal)} / ${formatBytes(ram)}`;
            const pct = computeRamPct();
            updateSliderTrack(ctxSlider, pct);
            updateWarning(pct);
            updateApplyVisibility();
        });
        maxTokSlider?.addEventListener('input', () => {
            this.querySelector('#maxTokValue').textContent = parseInt(maxTokSlider.value).toLocaleString();
            const pos = ((parseInt(maxTokSlider.value) - 256) / (16384 - 256)) * 100;
            maxTokSlider.style.setProperty('--range-fill', `${pos}%`);
            updateApplyVisibility();
        });
        applyBtn?.addEventListener('click', () => this.applyModelSettings());
    }

    async checkForUpdate() {
        const btn = this.querySelector('#checkUpdateBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Checking...';
        }
        try {
            this.updateInfo = await api.checkLlamaUpdate();
            this.renderStatus();
        } catch (e) {
            console.error('Failed to check for updates:', e);
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-exclamation-circle mr-1 text-red"></i>Failed';
                setTimeout(() => { btn.innerHTML = '<i class="fas fa-arrows-rotate mr-1"></i>Check for updates'; }, 3000);
            }
        }
    }

    async applyModelSettings() {
        const ctxSlider = this.querySelector('#ctxSlider');
        const maxTokSlider = this.querySelector('#maxTokSlider');
        const btn = this.querySelector('#applySettingsBtn');
        if (!ctxSlider || !maxTokSlider) return;

        const newCtx = parseInt(ctxSlider.value);
        const newMaxTokens = parseInt(maxTokSlider.value);
        const currentCtx = this.status?.contextSize;
        const ctxChanged = newCtx !== currentCtx;

        if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i>${ctxChanged ? 'Restarting...' : 'Saving...'}`; }

        try {
            const existing = this.llmConfig?.models?.default || {};
            await api.saveLlmModel('default', {
                provider: existing.provider || existing._provider || 'local',
                model: existing.model,
                contextSize: newCtx,
                maxTokens: newMaxTokens,
                ...(existing.reasoningBudget != null ? { reasoningBudget: existing.reasoningBudget } : {}),
                ...(existing.temperature != null ? { temperature: existing.temperature } : {}),
            });

            if (ctxChanged) {
                await api.stopLocalLlm();
                const model = this.models.find(m => this.status?.activeModel === m.filePath);
                if (model) {
                    await api.activateLocalModel(model.id, { setAsDefault: false });
                }
            }

            await this.loadLlmConfig();
            await this.refresh();
        } catch (e) {
            console.error('Failed to apply settings:', e);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save mr-1"></i>Apply'; }
        }
    }

    async updateBinary() {
        const btn = this.querySelector('#updateBinaryBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Updating...';
        }
        try {
            await api.updateLlamaBinary();
            this.updateInfo = null;
            await this.refresh();
        } catch (e) {
            console.error('Failed to update llama-server:', e);
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-exclamation-circle mr-1 text-red"></i>Failed';
                setTimeout(() => { btn.innerHTML = '<i class="fas fa-arrows-rotate mr-1"></i>Update'; }, 3000);
            }
        }
    }

    async loadLlmConfig() {
        try {
            this.llmConfig = await api.getLlmConfig();
            const defaultModel = this.llmConfig?.models?.default;
            if (defaultModel?._provider) {
                this.activeProvider = defaultModel._provider;
            }
            this.renderProviderTabs();
            this.switchProviderView(this.activeProvider);
        } catch (e) {
            console.error('Failed to load LLM config:', e);
        }
    }

    renderProviderTabs() {
        const container = this.querySelector('#providerTabs');
        if (!container) return;

        const defaultProvider = this.llmConfig?.models?.default?._provider || 'local';

        container.innerHTML = PROVIDERS.map(p => {
            const meta = PROVIDER_META[p];
            const isActive = this.activeProvider === p;
            const isDefault = defaultProvider === p;
            return `
                <button class="llm-provider-tab ${isActive ? 'active' : ''}" data-provider="${p}">
                    <span class="text-${meta.color}">${providerIcon(p)}</span>
                    <span>${meta.label}</span>
                    ${isDefault ? '<span class="default-dot" title="Default provider"></span>' : ''}
                </button>`;
        }).join('');

        container.querySelectorAll('.llm-provider-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this.activeProvider = btn.dataset.provider;
                this.renderProviderTabs();
                this.switchProviderView(this.activeProvider);
            });
        });
    }

    switchProviderView(provider) {
        const localEl = this.querySelector('#localContent');
        const cloudEl = this.querySelector('#cloudContent');
        if (!localEl || !cloudEl) return;

        if (provider === 'local') {
            localEl.classList.remove('hidden');
            cloudEl.classList.add('hidden');
        } else {
            localEl.classList.add('hidden');
            cloudEl.classList.remove('hidden');
            this.renderCloudConfig(provider);
        }
    }

    renderCloudConfig(provider) {
        const container = this.querySelector('#cloudContent');
        if (!container) return;

        const meta = PROVIDER_META[provider];
        const models = POPULAR_MODELS[provider] || [];
        const embeddings = POPULAR_EMBEDDINGS[provider] || [];
        const config = this.llmConfig;
        const defaultModel = config?.models?.default;
        const isDefault = defaultModel?._provider === provider;
        const defaultEmbedding = config?.embeddings?.default;

        // Find the config entry for this provider (check default first, then named entries)
        let modelEntry = null;
        let modelEntryName = null;
        if (isDefault) {
            modelEntry = defaultModel;
            modelEntryName = 'default';
        } else {
            // Check named entries
            for (const [name, m] of Object.entries(config?.models || {})) {
                if (m._provider === provider && name !== 'default') {
                    modelEntry = m;
                    modelEntryName = name;
                    break;
                }
            }
        }

        const currentModel = modelEntry?.model || models[0] || '';
        const hasEnvKey = modelEntry?._hasEnvKey || false;
        const hasConfigKey = modelEntry?.apiKey && !modelEntry.apiKey.startsWith('••••') ? false : !!modelEntry?.apiKey;
        const envVarName = PROVIDER_ENV_NAMES[provider] || '';

        // Key status
        let keyStatusHtml = '';
        if (hasConfigKey) {
            keyStatusHtml = `<span class="llm-key-status llm-key-status-set"><i class="fas fa-check"></i>Set in config</span>`;
        } else if (hasEnvKey) {
            keyStatusHtml = `<span class="llm-key-status llm-key-status-env"><i class="fas fa-leaf"></i>Using ${envVarName}</span>`;
        } else {
            keyStatusHtml = `<span class="llm-key-status llm-key-status-missing"><i class="fas fa-exclamation-triangle"></i>Not configured</span>`;
        }

        // Model select options
        const isCustomModel = currentModel && !models.includes(currentModel);
        const modelOptions = models.map(m =>
            `<option value="${escapeHtml(m)}" ${m === currentModel ? 'selected' : ''}>${escapeHtml(m)}</option>`
        ).join('');

        // Embedding select options (for providers that have them)
        const embSection = embeddings.length > 0 ? (() => {
            const isEmbDefault = defaultEmbedding?.provider === provider;
            const currentEmb = isEmbDefault ? defaultEmbedding?.model : embeddings[0];
            const isCustomEmb = currentEmb && !embeddings.includes(currentEmb);
            const embOptions = embeddings.map(m =>
                `<option value="${escapeHtml(m)}" ${m === currentEmb ? 'selected' : ''}>${escapeHtml(m)}</option>`
            ).join('');
            return `
                <div class="llm-form-group">
                    <label class="llm-form-label">Embedding Model</label>
                    <div class="llm-form-row">
                        <select id="cloudEmbModel" class="select">${embOptions}<option value="" ${isCustomEmb ? 'selected' : ''}>Custom...</option></select>
                        <input id="cloudEmbModelCustom" type="text" class="input ${isCustomEmb ? '' : 'hidden'}"
                            placeholder="Custom embedding model name" value="${isCustomEmb ? escapeHtml(currentEmb) : ''}" />
                    </div>
                </div>`;
        })() : '';

        container.innerHTML = `
            <div class="llm-config-card">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center gap-2">
                        <span class="text-${meta.color}">${providerIcon(provider)}</span>
                        <span class="font-semibold text-primary">${meta.label} Configuration</span>
                    </div>
                    ${isDefault
                        ? `<span class="badge badge-green"><i class="fas fa-check mr-1"></i>Default</span>`
                        : `<button id="setDefaultBtn" class="btn btn-accent btn-sm"><i class="fas fa-star mr-1"></i>Set as Default</button>`}
                </div>

                <div class="llm-cloud-form">
                    <div class="llm-form-group">
                        <div class="flex items-center justify-between">
                            <label class="llm-form-label">API Key</label>
                            ${keyStatusHtml}
                        </div>
                        <input id="cloudApiKey" type="password" class="input" placeholder="${envVarName ? `Or set ${envVarName} env var` : 'Enter API key'}"
                            value="${hasConfigKey ? (modelEntry?.apiKey || '') : ''}" />
                        ${envVarName ? `<span class="llm-form-hint">Environment variable: ${envVarName}</span>` : ''}
                    </div>

                    <div class="llm-form-group">
                        <label class="llm-form-label">Chat Model</label>
                        <div class="llm-form-row">
                            <select id="cloudModel" class="select">${modelOptions}<option value="" ${isCustomModel ? 'selected' : ''}>Custom...</option></select>
                            <input id="cloudModelCustom" type="text" class="input ${isCustomModel ? '' : 'hidden'}"
                                placeholder="Custom model name" value="${isCustomModel ? escapeHtml(currentModel) : ''}" />
                        </div>
                    </div>

                    ${embSection}

                    <div class="llm-form-group">
                        <label class="llm-form-label">Advanced</label>
                        <div class="llm-form-row">
                            <div class="llm-form-group">
                                <label class="llm-form-label">Temperature</label>
                                <input id="cloudTemp" type="number" class="input" min="0" max="2" step="0.1"
                                    placeholder="Default" value="${modelEntry?.temperature ?? ''}" />
                            </div>
                            <div class="llm-form-group">
                                <label class="llm-form-label">Max Tokens</label>
                                <input id="cloudMaxTokens" type="number" class="input" min="1"
                                    placeholder="Default" value="${modelEntry?.maxTokens ?? ''}" />
                            </div>
                        </div>
                        ${provider === 'anthropic' ? `
                        <div class="llm-form-group">
                            <label class="llm-form-label">Thinking Budget</label>
                            <input id="cloudThinkingBudget" type="number" class="input" min="0"
                                placeholder="0 = disabled" value="${modelEntry?.thinkingBudget ?? ''}" />
                        </div>` : ''}
                        <div class="llm-form-group">
                            <label class="llm-form-label">Base URL</label>
                            <input id="cloudBaseUrl" type="text" class="input"
                                placeholder="Default (leave empty for standard API)" value="${modelEntry?.baseUrl ? escapeHtml(modelEntry.baseUrl) : ''}" />
                        </div>
                    </div>

                    <div id="cloudSaveStatus" class="text-xs text-muted"></div>

                    <div class="flex items-center gap-2">
                        <button id="cloudSaveBtn" class="btn btn-accent">
                            <i class="fas fa-save mr-1"></i>Save Configuration
                        </button>
                    </div>
                </div>
            </div>

            ${this.renderNamedConfigs(provider)}
        `;

        // Wire up events
        const modelSelect = container.querySelector('#cloudModel');
        const modelCustom = container.querySelector('#cloudModelCustom');
        modelSelect?.addEventListener('change', () => {
            modelCustom.classList.toggle('hidden', modelSelect.value !== '');
            if (modelSelect.value === '') modelCustom.focus();
        });

        const embSelect = container.querySelector('#cloudEmbModel');
        const embCustom = container.querySelector('#cloudEmbModelCustom');
        embSelect?.addEventListener('change', () => {
            embCustom?.classList.toggle('hidden', embSelect.value !== '');
            if (embSelect.value === '') embCustom?.focus();
        });

        container.querySelector('#cloudSaveBtn')?.addEventListener('click', () => this.saveCloudConfig(provider));
        container.querySelector('#setDefaultBtn')?.addEventListener('click', () => this.setProviderAsDefault(provider));
    }

    renderNamedConfigs(excludeProvider) {
        if (!this.llmConfig?.models) return '';
        const entries = Object.entries(this.llmConfig.models)
            .filter(([name, m]) => name !== 'default' && m._provider !== excludeProvider);
        if (!entries.length) return '';

        const rows = entries.map(([name, m]) => `
            <div class="llm-named-row">
                <span class="name">${escapeHtml(name)}</span>
                <span class="badge badge-${PROVIDER_META[m._provider]?.color || 'gray'}">${PROVIDER_META[m._provider]?.label || m._provider}</span>
                <span class="model">${escapeHtml(m.model)}</span>
            </div>`).join('');

        return `
            <div class="mt-4">
                <h4 class="text-xs font-medium text-muted mb-2">Other Named Configs</h4>
                <div class="llm-named-configs">${rows}</div>
            </div>`;
    }

    async saveCloudConfig(provider) {
        const btn = this.querySelector('#cloudSaveBtn');
        const statusEl = this.querySelector('#cloudSaveStatus');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Saving...'; }

        try {
            const modelSelect = this.querySelector('#cloudModel');
            const modelCustom = this.querySelector('#cloudModelCustom');
            const model = modelSelect?.value || modelCustom?.value?.trim();
            if (!model) throw new Error('Please select or enter a model name');

            const apiKey = this.querySelector('#cloudApiKey')?.value?.trim() || undefined;
            const temp = this.querySelector('#cloudTemp')?.value;
            const maxTokens = this.querySelector('#cloudMaxTokens')?.value;
            const baseUrl = this.querySelector('#cloudBaseUrl')?.value?.trim() || undefined;
            const thinkingBudget = this.querySelector('#cloudThinkingBudget')?.value;

            const config = {
                provider,
                model,
                ...(apiKey ? { apiKey } : {}),
                ...(baseUrl ? { baseUrl } : {}),
                ...(temp !== '' && temp != null ? { temperature: parseFloat(temp) } : {}),
                ...(maxTokens !== '' && maxTokens != null ? { maxTokens: parseInt(maxTokens) } : {}),
                ...(thinkingBudget !== '' && thinkingBudget != null ? { thinkingBudget: parseInt(thinkingBudget) } : {}),
            };

            // Determine entry name: if this provider is already default, update default; otherwise create a named entry
            const defaultModel = this.llmConfig?.models?.default;
            const isDefault = defaultModel?._provider === provider;
            const entryName = isDefault ? 'default' : provider;

            await api.saveLlmModel(entryName, config);

            // Save embedding config if applicable
            const embSelect = this.querySelector('#cloudEmbModel');
            const embCustom = this.querySelector('#cloudEmbModelCustom');
            const embModel = embSelect?.value || embCustom?.value?.trim();
            if (embModel) {
                await api.saveLlmEmbedding('default', {
                    provider,
                    model: embModel,
                    ...(apiKey ? { apiKey } : {}),
                });
            }

            await this.loadLlmConfig();
            if (statusEl) { statusEl.innerHTML = '<i class="fas fa-check text-green mr-1"></i>Saved'; }
            setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 3000);
        } catch (e) {
            console.error('Failed to save config:', e);
            if (statusEl) { statusEl.innerHTML = `<i class="fas fa-exclamation-circle text-red mr-1"></i>${escapeHtml(e.message)}`; }
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save mr-1"></i>Save Configuration'; }
        }
    }

    async setProviderAsDefault(provider) {
        const btn = this.querySelector('#setDefaultBtn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Switching...'; }

        try {
            // Find the config for this provider
            const modelSelect = this.querySelector('#cloudModel');
            const modelCustom = this.querySelector('#cloudModelCustom');
            const model = modelSelect?.value || modelCustom?.value?.trim();
            if (!model) throw new Error('Please select or enter a model name first');

            const apiKey = this.querySelector('#cloudApiKey')?.value?.trim() || undefined;
            const temp = this.querySelector('#cloudTemp')?.value;
            const maxTokens = this.querySelector('#cloudMaxTokens')?.value;
            const baseUrl = this.querySelector('#cloudBaseUrl')?.value?.trim() || undefined;
            const thinkingBudget = this.querySelector('#cloudThinkingBudget')?.value;

            // Save old default as backup if it's a different provider
            const oldDefault = this.llmConfig?.models?.default;
            if (oldDefault && oldDefault._provider !== provider) {
                await api.saveLlmModel('default_old', {
                    provider: oldDefault.provider || oldDefault._provider,
                    model: oldDefault.model,
                    ...(oldDefault.apiKey ? { apiKey: oldDefault.apiKey } : {}),
                    ...(oldDefault.baseUrl ? { baseUrl: oldDefault.baseUrl } : {}),
                    ...(oldDefault.temperature != null ? { temperature: oldDefault.temperature } : {}),
                    ...(oldDefault.maxTokens != null ? { maxTokens: oldDefault.maxTokens } : {}),
                    ...(oldDefault.contextSize != null ? { contextSize: oldDefault.contextSize } : {}),
                    ...(oldDefault.reasoningBudget != null ? { reasoningBudget: oldDefault.reasoningBudget } : {}),
                });
            }

            // Set new default
            await api.saveLlmModel('default', {
                provider,
                model,
                ...(apiKey ? { apiKey } : {}),
                ...(baseUrl ? { baseUrl } : {}),
                ...(temp !== '' && temp != null ? { temperature: parseFloat(temp) } : {}),
                ...(maxTokens !== '' && maxTokens != null ? { maxTokens: parseInt(maxTokens) } : {}),
                ...(thinkingBudget !== '' && thinkingBudget != null ? { thinkingBudget: parseInt(thinkingBudget) } : {}),
            });

            await this.loadLlmConfig();
        } catch (e) {
            console.error('Failed to set default:', e);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-star mr-1"></i>Set as Default'; }
        }
    }

    renderModels() {
        const container = this.querySelector('#modelsGrid');
        if (!container) return;

        if (!this.models.length) {
            container.innerHTML = `
                <div class="col-span-full text-muted text-center py-8">
                    <i class="fas fa-box-open text-4xl mb-4 block text-muted"></i>
                    <p class="text-lg mb-2">No models downloaded</p>
                    <p class="text-sm">Search HuggingFace below, or download a recommended model</p>
                </div>`;
            return;
        }

        const activeModelPath = this.status?.activeModel;
        const activeEmbPath = this.status?.embedding?.activeModel;

        container.innerHTML = this.models.map(model => {
            const isChat = activeModelPath && activeModelPath === model.filePath;
            const isEmb = activeEmbPath && activeEmbPath === model.filePath;
            const looksLikeEmbedding = /embed/i.test(model.fileName);
            const cardCls = isChat ? 'llm-model-card active-chat' : isEmb ? 'llm-model-card active-emb' : 'llm-model-card';
            const caps = looksLikeEmbedding ? null : detectCapabilitiesFromFile(model);
            const badges = caps ? capabilityBadges(caps) : '';

            return `
                <div class="${cardCls}" data-model-id="${escapeHtml(model.id)}">
                    <div class="flex items-start justify-between mb-3">
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2 mb-1">
                                ${isChat ? '<i class="fas fa-circle text-amber text-2xs"></i>' : ''}
                                ${isEmb ? '<i class="fas fa-circle text-blue text-2xs"></i>' : ''}
                                <span class="font-medium text-primary text-sm truncate">${escapeHtml(model.fileName)}</span>
                            </div>
                            ${model.repo ? `<div class="text-xs text-muted truncate">${escapeHtml(model.repo)}</div>` : ''}
                            ${badges ? `<div class="flex items-center gap-1 mt-1">${badges}</div>` : ''}
                        </div>
                    </div>
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-3 text-xs text-muted">
                            <span><i class="fas fa-hard-drive mr-1"></i>${formatBytes(model.sizeBytes)}</span>
                            <span>${timeAgo(model.downloadedAt)}</span>
                        </div>
                        <div class="flex items-center gap-2">
                            ${looksLikeEmbedding
                                ? (isEmb
                                    ? '<span class="badge badge-blue">Embedding</span>'
                                    : `<button class="activate-emb-btn btn btn-blue btn-sm" data-id="${escapeHtml(model.id)}" title="Activate as embedding model">
                                            <i class="fas fa-vector-square mr-1"></i>Embed
                                        </button>`)
                                : (isChat
                                    ? '<span class="badge badge-amber">Active</span>'
                                    : `<button class="activate-btn btn btn-amber btn-sm" data-id="${escapeHtml(model.id)}" title="Activate as chat model">
                                            <i class="fas fa-play mr-1"></i>Activate
                                        </button>`)
                            }
                            ${!isChat && !isEmb
                                ? `<button class="delete-btn text-xs text-muted transition-colors" data-id="${escapeHtml(model.id)}" title="Delete model">
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

    renderRecommendations() {
        const container = this.querySelector('#recommendedSection');
        if (!container) return;

        const pending = RECOMMENDED_MODELS.filter(r => !this.isModelDownloaded(r.repo, r.file));
        if (!pending.length) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = `
            <h3 class="section-title mb-3">Recommended Models</h3>
            <div class="llm-rec-grid">
                ${pending.map(r => {
                    const downloadId = `${r.repo}/${r.file}`;
                    const isDownloading = this.activeDownloads.has(downloadId);
                    return `
                    <div class="llm-rec-card llm-rec-card-${r.color}">
                        <div class="flex items-center gap-2 mb-2">
                            <i class="fas ${r.icon} text-${r.color} text-sm"></i>
                            <span class="font-medium text-primary text-sm">${escapeHtml(r.label)}</span>
                        </div>
                        <p class="text-xs text-muted mb-3">${escapeHtml(r.desc)}</p>
                        <div class="flex items-center justify-between">
                            <span class="text-xs text-muted">${r.size}</span>
                            <button class="rec-download-btn btn btn-${r.color} btn-sm"
                                data-repo="${escapeHtml(r.repo)}" data-file="${escapeHtml(r.file)}" ${isDownloading ? 'disabled' : ''}>
                                ${isDownloading
                                    ? '<i class="fas fa-spinner fa-spin mr-1"></i>Downloading...'
                                    : '<i class="fas fa-download mr-1"></i>Download'}
                            </button>
                        </div>
                    </div>`;
                }).join('')}
            </div>`;

        container.querySelectorAll('.rec-download-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Downloading...';
                this.downloadModel(btn.dataset.repo, btn.dataset.file, null);
                this.startDownloadPolling();
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

        const gridBtn = this.querySelector(`.activate-btn[data-id="${id}"]`);
        const startBtn = this.querySelector('#startLastBtn');
        const card = gridBtn?.closest('[data-model-id]');
        const spinnerHtml = '<span class="spinner-sm"></span>';
        if (gridBtn) {
            gridBtn.disabled = true;
            gridBtn.innerHTML = `${spinnerHtml} Starting...`;
        }
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.innerHTML = `${spinnerHtml} Starting...`;
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
            if (gridBtn) {
                gridBtn.disabled = false;
                gridBtn.innerHTML = '<i class="fas fa-play mr-1"></i>Activate';
            }
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.innerHTML = '<i class="fas fa-play mr-1"></i>Start';
            }
            if (card) {
                const errorEl = document.createElement('div');
                errorEl.className = 'activate-error';
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
            btn.innerHTML = '<span class="spinner-sm"></span> Loading...';
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
                errorEl.className = 'activate-error';
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
            await this.refresh();
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
        container.innerHTML = '<div class="text-muted text-center py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Searching HuggingFace...</div>';
        btn.disabled = true;

        try {
            this.searchResults = await api.browseHuggingFace(query, 10);
            this.renderSearchResults();
        } catch (e) {
            container.innerHTML = `<div class="text-red text-center py-4">Error: ${escapeHtml(e.message)}</div>`;
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
            btn.classList.remove('btn-amber');
            btn.classList.add('btn-green', 'cursor-not-allowed');
            btn.innerHTML = '<i class="fas fa-check mr-1"></i>Downloaded';
        } else if (isDownloading) {
            btn.classList.add('opacity-50', 'pointer-events-none');
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        } else {
            btn.disabled = false;
            btn.classList.remove('btn-green', 'cursor-not-allowed');
            btn.classList.add('btn-amber');
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
            container.innerHTML = '<div class="text-muted text-center py-8">No GGUF models found for this query.</div>';
            return;
        }

        // Filter out results with no GGUF files
        const resultsWithFiles = this.searchResults.filter(r => r.ggufFiles.length > 0);
        if (!resultsWithFiles.length) {
            container.innerHTML = '<div class="text-muted text-center py-8">No GGUF files found in the results.</div>';
            return;
        }

        const ram = this.systemRamBytes;

        const rows = this.searchResults.map((result, idx) => {
            if (result.ggufFiles.length === 0) return '';

            const caps = detectCapabilities(result);
            const capIcons = [
                caps.tools ? '<i class="fas fa-wrench text-green" title="Tool calling"></i>' : '<i class="fas fa-wrench text-muted" title="No tool calling"></i>',
                caps.vision ? '<i class="fas fa-eye text-blue" title="Vision"></i>' : '<i class="fas fa-eye text-muted" title="No vision"></i>',
                caps.reasoning ? '<i class="fas fa-brain text-purple" title="Reasoning / Thinking"></i>' : '<i class="fas fa-brain text-muted" title="No reasoning"></i>',
            ].join('');

            const options = result.ggufFiles.map(f =>
                `<option value="${escapeHtml(f.fileName)}" data-size="${f.sizeBytes}">${escapeHtml(f.fileName)} (${formatBytes(f.sizeBytes)})</option>`
            ).join('');

            const firstFile = result.ggufFiles[0];
            const firstTooLarge = ram > 0 && firstFile.sizeBytes > ram;
            const firstDownloaded = this.isModelDownloaded(result.repoId, firstFile.fileName);

            return `
                <div class="hf-result-row" data-idx="${idx}">
                    <div class="min-w-0 flex-shrink-0">
                        <div class="font-medium text-primary text-sm truncate" title="${escapeHtml(result.repoId)}">${escapeHtml(result.modelName)}</div>
                        <div class="text-xs text-muted truncate">${escapeHtml(result.author)}</div>
                    </div>
                    <div class="flex items-center gap-2 text-xs flex-shrink-0">
                        <span class="text-muted" title="Downloads"><i class="fas fa-download mr-1"></i>${result.downloads?.toLocaleString() ?? 0}</span>
                        <span class="flex items-center gap-1">${capIcons}</span>
                    </div>
                    <select class="gguf-select hf-select" id="gguf-select-${idx}">
                        ${options}
                    </select>
                    <span class="ram-warning ram-warning-badge ${firstTooLarge ? '' : 'hidden'}" data-idx="${idx}" title="File size exceeds system RAM (${formatBytes(ram)})"><i class="fas fa-memory mr-1"></i>won't fit</span>
                    <div class="flex items-center gap-2 flex-shrink-0">
                        <button class="download-btn btn btn-sm ${firstDownloaded
                            ? 'btn-green cursor-not-allowed'
                            : 'btn-amber'}" data-idx="${idx}" ${firstDownloaded ? 'disabled' : ''}>
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
        this.querySelector('#refreshBtn')?.addEventListener('click', async () => {
            await this.loadLlmConfig();
            await this.refresh();
        });

        this.querySelector('#hfSearchBtn')?.addEventListener('click', () => this.searchHuggingFace());
        this.querySelector('#hfSearchInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.searchHuggingFace();
        });
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-6 custom-scrollbar view-panel">
                <div class="flex items-center justify-between border-b pb-4">
                    <div>
                        <h2 class="text-lg font-semibold text-primary">LLM Configuration</h2>
                        <p class="text-xs text-muted mt-1">Configure your AI model provider</p>
                    </div>
                    <button id="refreshBtn" class="btn-ghost" title="Refresh">
                        <i class="fas fa-sync-alt text-sm"></i>
                    </button>
                </div>

                <!-- Provider Tabs -->
                <div id="providerTabs" class="llm-provider-tabs"></div>

                <!-- Cloud Provider Config (hidden by default) -->
                <div id="cloudContent" class="hidden"></div>

                <!-- Local LLM Content -->
                <div id="localContent">
                    <!-- Status Bar -->
                    <div id="statusBar" class="mb-6">
                        <div class="llm-alert">
                            <i class="fas fa-spinner fa-spin text-muted text-sm"></i>
                            <span class="text-sm text-secondary">Loading...</span>
                        </div>
                    </div>

                    <!-- Active / Interrupted Downloads -->
                    <div id="activeDownloads" class="mb-4"></div>
                    <div id="interruptedDownloads" class="mb-4"></div>

                    <!-- Downloaded Models -->
                    <div class="mb-6">
                        <h3 class="section-title mb-3">Downloaded Models</h3>
                        <div id="modelsGrid" class="llm-model-grid">
                            <div class="text-muted text-center py-8 col-span-full">Loading...</div>
                        </div>
                    </div>

                    <!-- Recommended Models (shown when not all are downloaded) -->
                    <div id="recommendedSection" class="mb-6"></div>

                    <!-- HuggingFace Browser -->
                    <div class="border-t pt-4">
                        <h3 class="section-title mb-3">HuggingFace Browser</h3>
                        <div class="flex gap-2 mb-2">
                            <input id="hfSearchInput" type="text" placeholder="Search GGUF models (e.g. Qwen3, Llama, Phi)..."
                                class="input flex-1" />
                            <button id="hfSearchBtn" class="btn btn-accent flex-shrink-0">
                                <i class="fas fa-search mr-1"></i>Search
                            </button>
                        </div>
                        <p class="text-xs text-muted mb-4">
                            <i class="fas fa-wrench text-green mr-1"></i>tool calling
                            <span class="mx-2">|</span>
                            <i class="fas fa-eye text-blue mr-1"></i>vision
                            <span class="mx-2">|</span>
                            <i class="fas fa-brain text-purple mr-1"></i>reasoning
                            <span class="mx-2">|</span>
                            <span class="text-muted">gray = not supported</span>
                        </p>
                        <div id="hfResults">
                            <div class="text-muted text-center py-8 text-sm">
                                <i class="fas fa-cube text-2xl mb-3 block text-muted"></i>
                                Search HuggingFace to find and download GGUF models
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('local-llm-view', LocalLlmView);
