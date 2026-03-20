<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/services/api.ts';
  import { timeAgo } from '../lib/utils/format.ts';
  import Toggle from '../components/Toggle.svelte';

  // ─── Helpers ───
  function formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  // ─── Constants ───
  const TOOL_TAGS = ['tool-calling', 'function-calling', 'tool_use', 'tool-use'];
  const TOOL_NAME_PATTERNS = [
    /qwen[23]/i, /qwen3\.5/i, /llama.?3\.[1-9]/i, /mistral/i, /phi.?[4-9]/i,
    /functionary/i, /hermes/i, /command.?r/i, /glm/i, /gemma.?[2-9]/i,
    /nemotron/i, /granite/i,
  ];
  const VISION_PIPELINE_TAGS = ['image-text-to-text', 'image-to-text'];
  const VISION_NAME_PATTERNS = [/vision/i, /llava/i, /pixtral/i, /qwen3\.5/i];
  const REASONING_NAME_PATTERNS = [
    /deepseek.?r1/i, /qwq/i, /o[134]-/i, /reasoning/i,
    /think/i, /r1.?distill/i, /qwen3/i,
  ];
  const REASONING_TAG_PATTERNS = [/qwen3/i];

  const PROVIDERS = ['local', 'openai', 'anthropic', 'gemini'] as const;

  const BRAND_SVGS: Record<string, string> = {
    openai: `<svg viewBox="0 0 24 24" fill="currentColor" class="llm-brand-icon"><path d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5zM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.08 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06l-4.84 2.79a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0L4.02 14.01A4.5 4.5 0 0 1 2.34 7.87zm16.6 3.86L13.1 8.36l2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1V12.42a.79.79 0 0 0-.41-.68zm2.01-3.02l-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.8.8 0 0 0-.39.68zm1.1-2.36l2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5z"/></svg>`,
    anthropic: `<svg viewBox="0 0 24 24" fill="currentColor" class="llm-brand-icon"><path d="M13.83 3.52h3.6L24 20.48h-3.6l-6.57-16.96zm-7.26 0h3.6l6.57 16.96h-3.6L6.57 3.52z"/></svg>`,
    gemini: `<svg viewBox="0 0 24 24" fill="currentColor" class="llm-brand-icon"><path d="M12 0C12 6.63 6.63 12 0 12c6.63 0 12 5.37 12 12 0-6.63 5.37-12 12-12C17.37 12 12 6.63 12 0z"/></svg>`,
  };

  const PROVIDER_META: Record<string, { label: string; color: string }> = {
    local:     { label: 'Local',     color: 'amber' },
    openai:    { label: 'OpenAI',    color: 'green' },
    anthropic: { label: 'Anthropic', color: 'purple' },
    gemini:    { label: 'Google',    color: 'blue' },
  };
  const POPULAR_MODELS: Record<string, string[]> = {
    openai:    ['gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'o4-mini', 'o3', 'o3-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
    anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-opus-4-5'],
    gemini:    ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  };
  const POPULAR_EMBEDDINGS: Record<string, string[]> = {
    openai: ['text-embedding-3-small', 'text-embedding-3-large'],
    gemini: ['gemini-embedding-001', 'text-embedding-004'],
  };
  const PROVIDER_ENV_NAMES: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GOOGLE_API_KEY',
  };

  const RECOMMENDED_MODELS_GGUF = [
    { repo: 'unsloth/Qwen3.5-9B-GGUF', file: 'Qwen3.5-9B-Q4_K_M.gguf', label: 'Qwen3.5-9B-Q4_K_M', desc: 'Chat model with tool calling, vision, and reasoning. Great all-rounder for local use.', size: '~5.3 GB', icon: 'fa-comments', color: 'amber', type: 'gguf' },
    { repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF', file: 'nomic-embed-text-v1.5.Q4_K_M.gguf', label: 'nomic-embed-text-v1.5-Q4_K_M', desc: 'Embedding model for knowledge stores. Required for local RAG pipelines.', size: '~80 MB', icon: 'fa-vector-square', color: 'blue', type: 'gguf' },
  ];
  const RECOMMENDED_MODELS_MLX = [
    { repo: 'mlx-community/Qwen3.5-9B-4bit', file: '__mlx_repo__', label: 'Qwen3.5-9B-4bit (MLX)', desc: 'MLX-optimized for Apple Silicon. Recommended for Mac.', size: '~5 GB', icon: 'fa-apple', color: 'amber', type: 'mlx' },
    { repo: 'mlx-community/all-MiniLM-L6-v2-4bit', file: '__mlx_repo__', label: 'all-MiniLM-L6-v2-4bit (MLX)', desc: 'Fast, lightweight embedding model (22M params, 384 dims). Recommended for local RAG.', size: '~15 MB', icon: 'fa-vector-square', color: 'blue', type: 'mlx' },
  ];

  const ENGINE_LABELS: Record<string, string> = {
    'llama-cpp': 'llama-cpp',
    'mlx-serve': 'mlx-serve',
    'ollama': 'Ollama',
    'lmstudio': 'LM Studio',
  };
  const ENGINE_ICONS: Record<string, string> = {
    'llama-cpp': 'fa-server',
    'mlx-serve': 'fa-apple',
    'ollama': 'fa-cube',
    'lmstudio': 'fa-flask',
  };
  const MANAGED_ENGINES = ['llama-cpp', 'mlx-serve'];
  const EXTERNAL_ENGINES = ['ollama', 'lmstudio'];
  const ACCEL_LABELS: Record<string, string> = { 'none': 'CPU', 'metal': 'Metal', 'vulkan': 'Vulkan', 'cuda-12.4': 'CUDA 12.4', 'cuda-13.1': 'CUDA 13.1' };

  // ─── Capability detection ───
  function detectCapabilities(result: any) {
    const { tags, pipelineTag, modelName, repoId } = result;
    const name = `${repoId} ${modelName}`;
    const lowerTags = (tags || []).map((t: string) => t.toLowerCase());
    const vision = VISION_PIPELINE_TAGS.includes(pipelineTag)
      || lowerTags.some((t: string) => VISION_PIPELINE_TAGS.includes(t))
      || VISION_NAME_PATTERNS.some(p => p.test(name));
    const tools = lowerTags.some((t: string) => TOOL_TAGS.includes(t))
      || TOOL_NAME_PATTERNS.some(p => p.test(name));
    const reasoning = REASONING_NAME_PATTERNS.some(p => p.test(name))
      || REASONING_TAG_PATTERNS.some(p => lowerTags.some((t: string) => p.test(t)));
    return { vision, tools, reasoning };
  }

  function detectCapabilitiesFromFile(model: any) {
    const name = `${model.repo || ''} ${model.fileName}`;
    return {
      tools: TOOL_NAME_PATTERNS.some(p => p.test(name)),
      vision: VISION_NAME_PATTERNS.some(p => p.test(name)),
      reasoning: REASONING_NAME_PATTERNS.some(p => p.test(name))
        || REASONING_TAG_PATTERNS.some(p => p.test(name)),
    };
  }

  function detectExternalCaps(model: any) {
    const name = model.name || '';
    const caps = model.capabilities || [];
    const type = model.type || '';
    const hasApiCaps = caps.length > 0 || !!type;
    const embedding = caps.includes('embedding') || caps.includes('embeddings')
      || type === 'embedding' || type === 'embeddings'
      || /embed|MiniLM|bge-|e5-|gte-|nomic/i.test(name);
    const tools = caps.includes('tools') || caps.includes('tool_use')
      || (!hasApiCaps && TOOL_NAME_PATTERNS.some(p => p.test(name)));
    const vision = caps.includes('vision') || type === 'vlm'
      || (!hasApiCaps && VISION_NAME_PATTERNS.some(p => p.test(name)));
    const reasoning = caps.includes('thinking') || caps.includes('reasoning')
      || (!hasApiCaps && REASONING_NAME_PATTERNS.some(p => p.test(name)));
    return { tools, vision, reasoning, embedding };
  }

  function isEngineRemote(eng: string, engineUrls: Record<string, string>) {
    const defaultUrls: Record<string, string> = { ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234' };
    const url = engineUrls?.[eng] || defaultUrls[eng] || '';
    try {
      const host = new URL(url).hostname;
      return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
    } catch { return false; }
  }

  function getRecommendedModels(engine: string) {
    return engine === 'mlx-serve' ? RECOMMENDED_MODELS_MLX : RECOMMENDED_MODELS_GGUF;
  }

  function isModelDownloaded(models: any[], repoId: string, fileName: string) {
    if (fileName === '__mlx_repo__') {
      return models.some((m: any) => m.repo === repoId && m.type === 'mlx');
    }
    return models.some((m: any) => m.repo === repoId && m.fileName === fileName);
  }

  // ─── State ───
  let status = $state<any>(null);
  let models = $state<any[]>([]);
  let searchResults = $state<any[]>([]);
  let activeDownloads = $state(new Map<string, EventSource>());
  let downloadPollTimer = $state<ReturnType<typeof setInterval> | null>(null);
  let systemRamBytes = $state(0);
  let activeProvider = $state<string>('local');
  let llmConfig = $state<any>(null);
  let browseFormat = $state<string>('gguf');
  let selectedEngine = $state<string | null>(null);
  let engines = $state<any>(null);
  let engineUrls = $state<Record<string, string>>({});
  let activeDownloadsList = $state<any[]>([]);
  let interruptedDownloads = $state<any[]>([]);

  // Cloud config form state
  let cloudApiKey = $state('');
  let cloudModel = $state('');
  let cloudModelCustom = $state('');
  let cloudEmbModel = $state('');
  let cloudEmbModelCustom = $state('');
  let cloudTemp = $state('');
  let cloudMaxTokens = $state('');
  let cloudThinkingBudget = $state('');
  let cloudBaseUrl = $state('');
  let cloudSaveStatus = $state('');
  let cloudSaving = $state(false);

  // Managed engine slider state
  let ctxSliderValue = $state(8192);
  let ctxSliderOrig = $state(8192);
  let maxTokSliderValue = $state(4096);
  let maxTokSliderOrig = $state(4096);
  let thinkingEnabled = $state(false);
  let thinkingBudgetValue = $state(128);
  let thinkingBudgetOrig = $state(0);
  let applyingSettings = $state(false);

  // External engine slider state
  let extCtxSliderValue = $state(8192);
  let extCtxSliderOrig = $state(8192);
  let extMaxTokSliderValue = $state(4096);
  let extMaxTokSliderOrig = $state(4096);
  let extApplying = $state(false);

  // Engine URL form
  let engineUrlInput = $state('');
  let engineUrlOrig = $state('');
  let engineUrlSaving = $state(false);

  // Search form
  let hfSearchQuery = $state('');
  let hfSearching = $state(false);

  // Button loading states
  let stoppingChat = $state(false);
  let stoppingEmb = $state(false);
  let togglingActive = $state<string | null>(null);
  let togglingP2P = $state<string | null>(null);
  let p2pEnabled = $state(false);
  let activatingModelId = $state<string | null>(null);
  let activateErrors = $state<Record<string, string>>({});
  let activatingEmbId = $state<string | null>(null);
  // External engine activation
  let activatingExtChat = $state<string | null>(null);
  let activatingExtEmb = $state<string | null>(null);
  // Unloading
  let unloadingModel = $state<string | null>(null);

  // ─── Config Resolvers ───
  function resolveDefault(section: 'models' | 'embeddings'): any {
    const sectionData = llmConfig?.[section];
    if (!sectionData) return null;
    let val = sectionData['default'];
    if (typeof val === 'string') val = sectionData[val];
    return (val && typeof val === 'object') ? val : null;
  }

  function resolveDefaultKey(section: 'models' | 'embeddings'): string | null {
    const sectionData = llmConfig?.[section];
    if (!sectionData) return null;
    const val = sectionData['default'];
    if (typeof val === 'string') return val;
    return 'default';
  }

  // ─── Derived state ───
  let isExternalEngine = $derived(EXTERNAL_ENGINES.includes(selectedEngine || ''));
  let isManagedEngine = $derived(MANAGED_ENGINES.includes(selectedEngine || ''));
  let isMlx = $derived(selectedEngine === 'mlx-serve');
  let isMacHost = $derived(status?.platform === 'darwin');

  let configDefaultEngine = $derived(resolveDefault('models')?.engine || status?.defaultEngine || null);
  let selectedEngineActive = $derived.by(() => {
    const entry = llmConfig?.models?.[selectedEngine || ''];
    return entry?.active !== false;
  });

  // Engine list to show
  let engineList = $derived(
    (['llama-cpp', 'mlx-serve', 'ollama', 'lmstudio'] as string[])
      .filter(eng => eng !== 'mlx-serve' || isMacHost)
  );

  // Current engine status for managed engines
  let engineStatus = $derived(status?.engines?.[selectedEngine || '']);
  let chatStatus = $derived(engineStatus?.chat || {});
  let embeddingStatus = $derived(engineStatus?.embedding || {});
  let chatRunning = $derived(chatStatus?.running || false);
  let activeModelPath = $derived(chatRunning ? chatStatus?.activeModel : null);
  let embRunning = $derived(embeddingStatus?.running || false);
  let activeEmbModelPath = $derived(embRunning ? embeddingStatus?.activeModel : null);

  // Version info for managed engines
  let version = $derived(isMlx ? status?.mlxVersion : status?.llamaVersion);
  let versionLabel = $derived(
    isMlx
      ? (version ? `v${version}` : '')
      : (version ? `b${version?.match?.(/^(\d+)/)?.[1] || version}` : '')
  );
  // GPU & runtime
  let gpuName = $derived(status?.gpu?.name);
  let gpuAccel = $derived(status?.gpu?.accel || 'none');
  let runtimeLabel = $derived(
    gpuName
      ? `${gpuName} (${ACCEL_LABELS[gpuAccel] || gpuAccel})`
      : (ACCEL_LABELS[gpuAccel] || gpuAccel)
  );

  // RAM
  let totalRam = $derived(systemRamBytes);

  // Chat model details for managed engine
  let activeModelName = $derived(activeModelPath ? activeModelPath.split('/').pop() : null);
  let mem = $derived(chatStatus?.memoryEstimate);
  let procMem = $derived(chatStatus?.processMemory);
  let actualBytes = $derived(procMem ? (procMem.rssBytes + (procMem.gpuBytes ?? 0)) : 0);
  let ctxSize = $derived(chatStatus?.contextSize);
  let memPct = $derived(actualBytes && totalRam ? Math.round((actualBytes / totalRam) * 100) : null);
  let memBarCls = $derived((memPct ?? 0) > 80 ? 'llm-mem-red' : (memPct ?? 0) > 60 ? 'llm-mem-amber' : 'llm-mem-green');
  let kvPerToken = $derived(mem && ctxSize ? mem.kvCacheBytes / ctxSize : 0);
  let resolvedDefaultModel = $derived(resolveDefault('models'));
  let currentMaxTokensConfig = $derived(resolvedDefaultModel?.maxTokens || 4096);
  let currentReasoningBudget = $derived(resolvedDefaultModel?.reasoningBudget || 0);
  let activeModelObj = $derived(models.find((m: any) => m.filePath === activeModelPath));
  let modelCaps = $derived(activeModelObj ? detectCapabilitiesFromFile(activeModelObj) : { reasoning: false, tools: false, vision: false });
  let lastActiveModel = $derived(status?.lastActiveModel);
  let lastActiveModelObj = $derived(lastActiveModel ? models.find((m: any) => m.id === lastActiveModel) : null);

  // Embedding model for managed engine
  let embModelName = $derived(activeEmbModelPath ? activeEmbModelPath.split('/').pop() : null);

  // Slider state derived
  let sliderCtxChanged = $derived(ctxSliderValue !== ctxSliderOrig);
  let sliderMaxTokChanged = $derived(maxTokSliderValue !== maxTokSliderOrig);
  let sliderThinkingChanged = $derived(
    (thinkingEnabled ? thinkingBudgetValue : 0) !== thinkingBudgetOrig
  );
  let anySliderChanged = $derived(sliderCtxChanged || sliderMaxTokChanged || sliderThinkingChanged);

  // Computed RAM estimate for context slider
  let estimatedKvCache = $derived(ctxSliderValue * kvPerToken);
  let estimatedTotal = $derived((mem?.modelBytes || 0) + estimatedKvCache);
  let estimatedPct = $derived(totalRam ? Math.round(estimatedTotal / totalRam * 100) : 0);

  // Slider fill color based on RAM usage
  let ctxRangeColor = $derived(
    estimatedPct > 90 ? 'var(--red)' : estimatedPct > 75 ? 'var(--amber-400)' : 'var(--green)'
  );
  let ctxRangeFill = $derived(
    `${((ctxSliderValue - 2048) / (131072 - 2048)) * 100}%`
  );

  // Slider warning
  let sliderWarning = $derived(
    estimatedPct > 90
      ? { text: 'Exceeds available RAM \u2014 will cause heavy swapping and very slow performance', cls: 'llm-slider-warning-red' }
      : estimatedPct > 75
        ? { text: 'High memory usage \u2014 may cause swapping and reduced performance', cls: 'llm-slider-warning-amber' }
        : null
  );

  // External engine state
  let extEngineData = $derived(engines?.[selectedEngine || '']);
  let extAvailable = $derived(extEngineData?.available);
  let extModels = $derived(extEngineData?.models || []);
  let extRunning = $derived(extEngineData?.running || []);
  let extLabel = $derived(ENGINE_LABELS[selectedEngine || ''] || '');
  let extDefaultUrls: Record<string, string> = { ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234' };
  let extEffectiveUrl = $derived(engineUrls?.[selectedEngine || ''] || extDefaultUrls[selectedEngine || ''] || '');
  let extIsRemote = $derived(isExternalEngine ? isEngineRemote(selectedEngine || '', engineUrls) : false);

  // External engine config
  let extCurrentDefault = $derived(resolveDefault('models'));
  let extCurrentEmbDefault = $derived(resolveDefault('embeddings'));
  let extIsActiveChat = $derived(extCurrentDefault?.engine === selectedEngine);
  let extIsActiveEmb = $derived(extCurrentEmbDefault?.engine === selectedEngine);
  let extActiveChatModel = $derived(extIsActiveChat ? extCurrentDefault?.model : null);
  let extActiveEmbModel = $derived(extIsActiveEmb ? extCurrentEmbDefault?.model : null);
  let extCurrentCtx = $derived(extCurrentDefault?.contextSize || 8192);
  let extCurrentMaxTokens = $derived(extCurrentDefault?.maxTokens || 4096);

  // External slider changes
  let extCtxChanged = $derived(extCtxSliderValue !== extCtxSliderOrig);
  let extMaxTokChanged = $derived(extMaxTokSliderValue !== extMaxTokSliderOrig);
  let extAnyChanged = $derived(extCtxChanged || extMaxTokChanged);

  // Models filtered by current engine
  let filteredModels = $derived(
    models.filter((model: any) => {
      if (!selectedEngine || !MANAGED_ENGINES.includes(selectedEngine)) return true;
      const modelEngine = model.type === 'mlx' ? 'mlx-serve' : 'llama-cpp';
      return modelEngine === selectedEngine;
    })
  );

  // Active models across all engines for managed model cards
  let globalActiveModelPath = $derived(() => {
    if (!status?.engines) return null;
    for (const eng of Object.values(status.engines) as any[]) {
      if (eng.chat?.running && eng.chat.activeModel) return eng.chat.activeModel;
    }
    return null;
  });
  let globalActiveEmbPath = $derived(() => {
    if (!status?.engines) return null;
    for (const eng of Object.values(status.engines) as any[]) {
      if (eng.embedding?.running && eng.embedding.activeModel) return eng.embedding.activeModel;
    }
    return null;
  });

  // Recommended models not yet downloaded
  let pendingRecommended = $derived(
    getRecommendedModels(selectedEngine || 'llama-cpp')
      .filter(r => !isModelDownloaded(models, r.repo, r.file))
  );

  // Cloud config
  let defaultProvider = $derived(resolveDefault('models')?._provider || 'local');

  let settingDefault = $state<string | null>(null);

  async function setDefaultProvider(configName: string) {
    settingDefault = configName;
    try {
      const entry = llmConfig?.models?.[configName];
      if (entry?.active === false) await api.toggleLlmActive(configName, true);
      await api.saveLlmModel('default', { _pointer: configName });
      await loadLlmConfig();
    } catch (e: any) {
      console.error('Failed to set default:', e);
    } finally {
      settingDefault = null;
    }
  }

  // Cloud config - model entry for current provider
  let cloudModelEntry = $derived(() => {
    const isDefault = resolveDefault('models')?._provider === activeProvider;
    if (isDefault) return { entry: resolveDefault('models'), name: resolveDefaultKey('models') };
    for (const [name, m] of Object.entries(llmConfig?.models || {})) {
      if (typeof m === 'string') continue;
      if ((m as any)._provider === activeProvider && name !== 'default') {
        return { entry: m, name };
      }
    }
    return { entry: null, name: null };
  });

  // ─── Data Loading ───
  async function loadStatus() {
    try {
      status = await api.getLocalLlmStatus();
      systemRamBytes = status.systemRamBytes || 0;
    } catch (e) {
      console.error('Failed to load local LLM status:', e);
    }
  }

  async function loadModels() {
    try {
      models = await api.getLocalLlmModels();
    } catch (e) {
      console.error('Failed to load local models:', e);
    }
  }

  async function loadLlmConfig() {
    try {
      llmConfig = await api.getLlmConfig();
      const defaultModel = resolveDefault('models');
      if (defaultModel?._provider) {
        activeProvider = defaultModel._provider;
      }
    } catch (e) {
      console.error('Failed to load LLM config:', e);
    }
  }

  async function loadEngines() {
    try {
      const [engs, urls] = await Promise.all([api.getEngines(), api.getEngineUrls()]);
      engines = engs;
      engineUrls = urls || {};
      if (!selectedEngine) {
        const configEngine = status?.defaultEngine || resolveDefault('models')?.engine;
        selectedEngine = configEngine || 'llama-cpp';
      }
      syncEngineUrlInput();
    } catch (e) {
      console.error('Failed to load engines:', e);
    }
  }

  async function refresh() {
    await Promise.all([loadStatus(), loadModels()]);
  }

  async function pollActiveDownloads() {
    try {
      const downloads = await api.getActiveDownloads();
      if (downloads.length > 0) {
        activeDownloadsList = downloads;
        startDownloadPolling();
      }
    } catch { /* ignore */ }
  }

  function startDownloadPolling() {
    if (downloadPollTimer) return;
    downloadPollTimer = setInterval(async () => {
      try {
        const current = await api.getActiveDownloads();
        if (current.length === 0) {
          if (downloadPollTimer) clearInterval(downloadPollTimer);
          downloadPollTimer = null;
          activeDownloadsList = [];
          loadModels();
        } else {
          activeDownloadsList = current;
        }
      } catch { /* ignore */ }
    }, 1000);
  }

  async function loadInterruptedDownloads() {
    try {
      const interrupted = await api.getInterruptedDownloads();
      interruptedDownloads = interrupted || [];
    } catch { /* ignore */ }
  }

  // Sync engine URL input when engine changes
  function syncEngineUrlInput() {
    if (!selectedEngine) return;
    const currentUrl = engineUrls?.[selectedEngine] || '';
    engineUrlInput = currentUrl;
    engineUrlOrig = currentUrl;
  }

  // Sync external sliders when engine or config changes
  $effect(() => {
    if (isExternalEngine && extCurrentDefault) {
      extCtxSliderValue = extCurrentCtx;
      extCtxSliderOrig = extCurrentCtx;
      extMaxTokSliderValue = extCurrentMaxTokens;
      extMaxTokSliderOrig = extCurrentMaxTokens;
    }
  });

  // Sync managed sliders when status changes
  $effect(() => {
    if (isManagedEngine && chatRunning) {
      ctxSliderValue = ctxSize || 8192;
      ctxSliderOrig = ctxSize || 8192;
      maxTokSliderValue = currentMaxTokensConfig;
      maxTokSliderOrig = currentMaxTokensConfig;
      thinkingBudgetOrig = currentReasoningBudget;
      thinkingEnabled = currentReasoningBudget > 0;
      thinkingBudgetValue = currentReasoningBudget || 128;
    }
  });

  // Browse format auto-matches engine
  $effect(() => {
    if (isManagedEngine) {
      const newFormat = selectedEngine === 'mlx-serve' ? 'mlx' : 'gguf';
      if (browseFormat !== newFormat) {
        browseFormat = newFormat;
        searchResults = [];
      }
    }
  });

  // Cloud form sync when provider or config changes
  function syncCloudForm() {
    const { entry, name } = cloudModelEntry();
    const provider = activeProvider;
    const popularModels = POPULAR_MODELS[provider] || [];
    const popularEmbs = POPULAR_EMBEDDINGS[provider] || [];

    if (entry) {
      const currentModel = entry.model || popularModels[0] || '';
      const isCustom = currentModel && !popularModels.includes(currentModel);
      cloudModel = isCustom ? '' : currentModel;
      cloudModelCustom = isCustom ? currentModel : '';
      cloudApiKey = entry.apiKey && !entry.apiKey.startsWith('••••') ? '' : (entry.apiKey || '');
      cloudTemp = entry.temperature != null ? String(entry.temperature) : '';
      cloudMaxTokens = entry.maxTokens != null ? String(entry.maxTokens) : '';
      cloudThinkingBudget = entry.thinkingBudget != null ? String(entry.thinkingBudget) : '';
      cloudBaseUrl = entry.baseUrl || '';

      // Embedding
      const embDefault = resolveDefault('embeddings');
      const isEmbDefault = embDefault?.provider === provider;
      const currentEmb = isEmbDefault ? embDefault?.model : popularEmbs[0] || '';
      const isCustomEmb = currentEmb && !popularEmbs.includes(currentEmb);
      cloudEmbModel = isCustomEmb ? '' : (currentEmb || '');
      cloudEmbModelCustom = isCustomEmb ? currentEmb : '';
    } else {
      cloudModel = popularModels[0] || '';
      cloudModelCustom = '';
      cloudApiKey = '';
      cloudTemp = '';
      cloudMaxTokens = '';
      cloudThinkingBudget = '';
      cloudBaseUrl = '';
      cloudEmbModel = popularEmbs[0] || '';
      cloudEmbModelCustom = '';
    }
    cloudSaveStatus = '';
  }

  // ─── Actions ───
  async function activateModel(id: string) {
    activatingModelId = id;
    activateErrors = { ...activateErrors };
    delete activateErrors[id];
    try {
      const result = await api.activateLocalModel(id);
      if (result.error) throw new Error(result.error);
      await loadLlmConfig();
      await refresh();
    } catch (e: any) {
      console.error('Failed to activate model:', e);
      activateErrors = { ...activateErrors, [id]: e.message };
    } finally {
      activatingModelId = null;
    }
  }

  async function deleteModel(id: string) {
    if (!confirm('Delete this model? This cannot be undone.')) return;
    try {
      await api.deleteLocalModel(id);
      await loadModels();
    } catch (e) {
      console.error('Failed to delete model:', e);
    }
  }

  async function activateEmbedding(id: string) {
    activatingEmbId = id;
    activateErrors = { ...activateErrors };
    delete activateErrors[id];
    try {
      const result = await api.activateLocalEmbedding(id);
      if (result.error) throw new Error(result.error);
      await refresh();
    } catch (e: any) {
      console.error('Failed to activate embedding model:', e);
      activateErrors = { ...activateErrors, [id]: e.message };
    } finally {
      activatingEmbId = null;
    }
  }

  async function stopServer() {
    stoppingChat = true;
    try {
      await api.stopLocalLlm(selectedEngine || undefined);
      await refresh();
    } catch (e) {
      console.error('Failed to stop server:', e);
    } finally {
      stoppingChat = false;
    }
  }

  async function stopEmbedding() {
    stoppingEmb = true;
    try {
      await api.stopLocalEmbedding(selectedEngine || undefined);
      await refresh();
    } catch (e) {
      console.error('Failed to stop embedding:', e);
    } finally {
      stoppingEmb = false;
    }
  }

  async function applyModelSettings() {
    const engineSt = status?.engines?.[selectedEngine || ''];
    const currentCtx = engineSt?.chat?.contextSize;
    const ctxChanged = ctxSliderValue !== currentCtx;
    const newReasoningBudget = thinkingEnabled ? thinkingBudgetValue : 0;
    const existingBudget = resolveDefault('models')?.reasoningBudget || 0;
    const reasoningChanged = newReasoningBudget !== existingBudget;
    const needsRestart = ctxChanged || reasoningChanged;

    applyingSettings = true;
    try {
      const resolvedKey = resolveDefaultKey('models');
      const existing = resolveDefault('models') || {};
      await api.saveLlmModel(resolvedKey!, {
        provider: existing.provider || existing._provider || 'local',
        model: existing.model,
        contextSize: ctxSliderValue,
        maxTokens: maxTokSliderValue,
        ...(newReasoningBudget !== undefined ? { reasoningBudget: newReasoningBudget } : existing.reasoningBudget != null ? { reasoningBudget: existing.reasoningBudget } : {}),
        ...(existing.temperature != null ? { temperature: existing.temperature } : {}),
      });
      if (needsRestart) {
        await api.stopLocalLlm(selectedEngine || undefined);
        const activeMP = status?.engines?.[selectedEngine || '']?.chat?.activeModel;
        const model = models.find((m: any) => activeMP === m.filePath);
        if (model) await api.activateLocalModel(model.id);
      }
      await loadLlmConfig();
      await refresh();
    } catch (e) {
      console.error('Failed to apply settings:', e);
    } finally {
      applyingSettings = false;
    }
  }

  // HuggingFace search
  async function searchHuggingFace() {
    if (!hfSearchQuery.trim()) return;
    hfSearching = true;
    try {
      searchResults = await api.browseHuggingFace(hfSearchQuery.trim(), 10, browseFormat);
    } catch (e: any) {
      searchResults = [];
      console.error('Search failed:', e);
    } finally {
      hfSearching = false;
    }
  }

  function downloadModel(repo: string, fileName: string, type = 'gguf') {
    const downloadId = type === 'mlx' ? `mlx:${repo}` : `${repo}/${fileName}`;
    if (activeDownloads.has(downloadId)) return;

    const es = api.downloadLocalModel(repo, fileName, type);
    activeDownloads.set(downloadId, es);
    activeDownloads = new Map(activeDownloads);

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'complete') {
          cleanupDownload(downloadId);
          loadModels();
        }
        if (data.type === 'error') {
          console.error('Download error:', data.error);
          cleanupDownload(downloadId);
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => { cleanupDownload(downloadId); };
    startDownloadPolling();
  }

  function cleanupDownload(downloadId: string) {
    const es = activeDownloads.get(downloadId);
    if (es) {
      es.close();
      activeDownloads.delete(downloadId);
      activeDownloads = new Map(activeDownloads);
    }
  }

  // Cloud config actions
  async function saveCloudConfig() {
    cloudSaving = true;
    cloudSaveStatus = '';
    try {
      const provider = activeProvider;
      const model = cloudModel || cloudModelCustom.trim();
      if (!model) throw new Error('Please select or enter a model name');

      const apiKey = cloudApiKey.trim() || (PROVIDER_ENV_NAMES[provider] ? `\${${PROVIDER_ENV_NAMES[provider]}}` : undefined);
      const config: any = {
        provider,
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(cloudBaseUrl.trim() ? { baseUrl: cloudBaseUrl.trim() } : {}),
        ...(cloudTemp !== '' ? { temperature: parseFloat(cloudTemp) } : {}),
        ...(cloudMaxTokens !== '' ? { maxTokens: parseInt(cloudMaxTokens) } : {}),
        ...(cloudThinkingBudget !== '' ? { thinkingBudget: parseInt(cloudThinkingBudget) } : {}),
      };

      await api.saveLlmModel(provider, config);

      const embModel = cloudEmbModel || cloudEmbModelCustom.trim();
      if (embModel) {
        await api.saveLlmEmbedding(provider, {
          provider,
          model: embModel,
          ...(apiKey ? { apiKey } : {}),
          ...(cloudBaseUrl.trim() ? { baseUrl: cloudBaseUrl.trim() } : {}),
        });
      }

      await loadLlmConfig();
      cloudSaveStatus = 'saved';
      setTimeout(() => { cloudSaveStatus = ''; }, 3000);
    } catch (e: any) {
      console.error('Failed to save config:', e);
      cloudSaveStatus = `error:${e.message}`;
    } finally {
      cloudSaving = false;
    }
  }

  async function toggleModelActive(configName: string) {
    togglingActive = configName;
    try {
      const entry = llmConfig?.models?.[configName];
      const currentActive = entry?.active !== false;
      await api.toggleLlmActive(configName, !currentActive);
      // Refresh config without resetting activeProvider
      llmConfig = await api.getLlmConfig();
    } catch (e: any) {
      console.error('Failed to toggle active:', e);
    } finally {
      togglingActive = null;
    }
  }

  async function toggleModelP2P(configName: string) {
    togglingP2P = configName;
    try {
      const entry = llmConfig?.models?.[configName];
      const currentP2P = entry?.p2p === true;
      await api.toggleLlmP2P(configName, !currentP2P);
      llmConfig = await api.getLlmConfig();
    } catch (e: any) {
      console.error('Failed to toggle P2P:', e);
    } finally {
      togglingP2P = null;
    }
  }

  // External engine actions
  async function activateExtChat(model: string) {
    activatingExtChat = model;
    try {
      await api.activateEngine(selectedEngine!, model, 'chat');
      await loadLlmConfig();
      await loadEngines();
    } catch (e) {
      console.error('Failed to activate external model:', e);
    } finally {
      activatingExtChat = null;
    }
  }

  async function activateExtEmb(model: string) {
    activatingExtEmb = model;
    try {
      await api.activateEngine(selectedEngine!, model, 'embedding');
      await loadLlmConfig();
      await loadEngines();
    } catch (e) {
      console.error('Failed to activate external embedding:', e);
    } finally {
      activatingExtEmb = null;
    }
  }

  async function unloadEngineModel(modelName: string, instanceId?: string) {
    unloadingModel = modelName;
    try {
      await api.unloadEngineModel(selectedEngine!, modelName, instanceId);
      await loadEngines();
    } catch (e) {
      console.error('Failed to unload model:', e);
    } finally {
      unloadingModel = null;
    }
  }

  async function saveEngineUrl() {
    const newUrl = engineUrlInput.trim();
    if (!newUrl) return;
    engineUrlSaving = true;
    try {
      await api.setEngineUrl(selectedEngine!, newUrl);
      await loadEngines();
    } catch (e) {
      console.error('Failed to set engine URL:', e);
    } finally {
      engineUrlSaving = false;
    }
  }

  async function resetEngineUrl() {
    const defaults: Record<string, string> = { ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234' };
    try {
      await api.setEngineUrl(selectedEngine!, defaults[selectedEngine!]);
      await loadEngines();
    } catch (e) {
      console.error('Failed to reset engine URL:', e);
    }
  }

  async function applyExtSettings() {
    extApplying = true;
    try {
      await api.setEngineContext(extCtxSliderValue);
      const resolvedKey = resolveDefaultKey('models');
      const existing = resolveDefault('models') || {};
      await api.saveLlmModel(resolvedKey!, {
        ...existing,
        provider: existing.provider || 'local',
        maxTokens: extMaxTokSliderValue,
      });
      await loadLlmConfig();
      extCtxSliderOrig = extCtxSliderValue;
      extMaxTokSliderOrig = extMaxTokSliderValue;
    } catch (e) {
      console.error('Failed to apply settings:', e);
    } finally {
      extApplying = false;
    }
  }

  async function resumeInterruptedDownload(d: any) {
    if (!d.repo) return;
    interruptedDownloads = interruptedDownloads.filter((x: any) => x.fileName !== d.fileName);
    downloadModel(d.repo, d.fileName);
    startDownloadPolling();
  }

  async function discardInterruptedDownload(d: any) {
    try {
      await api.deleteInterruptedDownload(d.fileName);
      interruptedDownloads = interruptedDownloads.filter((x: any) => x.fileName !== d.fileName);
    } catch (e) {
      console.error('Failed to discard download:', e);
    }
  }

  function selectEngine(eng: string) {
    selectedEngine = eng;
    syncEngineUrlInput();
  }

  function copyUrl(url: string, event: MouseEvent) {
    navigator.clipboard.writeText(url);
    const target = event.currentTarget as HTMLElement;
    const icon = target.querySelector('i');
    if (icon) {
      icon.className = 'fas fa-check text-2xs text-green';
      setTimeout(() => { icon!.className = 'fas fa-copy text-2xs'; }, 1500);
    }
  }

  function selectProvider(p: string) {
    activeProvider = p;
    syncCloudForm();
  }

  // Format ctx display
  function fmtCtx(val: number): string {
    return val >= 1024 ? `${(val / 1024).toFixed(0)}K` : String(val);
  }

  // ─── Lifecycle ───
  onMount(async () => {
    await loadLlmConfig();
    await refresh();
    pollActiveDownloads();
    loadInterruptedDownloads();
    await loadEngines();
    try { p2pEnabled = (await api.getP2PStatus()).enabled; } catch {}
    // Default format for Apple Silicon
    if (status?.platform === 'darwin' && status?.arch === 'arm64') {
      browseFormat = 'mlx';
    }
    syncCloudForm();
  });

  onDestroy(() => {
    for (const es of activeDownloads.values()) {
      es.close();
    }
    activeDownloads.clear();
    if (downloadPollTimer) {
      clearInterval(downloadPollTimer);
      downloadPollTimer = null;
    }
  });

  // Helper: get max context from external engine API
  function getExtMaxCtx(modelName: string | null): number {
    if (!modelName) return 131072;
    const m = extModels.find((x: any) => x.name === modelName);
    return m?.maxContextLength || 131072;
  }
</script>

<div class="space-y-6 h-full overflow-y-auto pb-6 custom-scrollbar view-panel">
  <!-- Header -->
  <div class="flex items-center justify-between border-b pb-4">
    <div>
      <h2 class="text-lg font-semibold text-primary">LLM Configuration</h2>
      <p class="text-xs text-muted mt-1">Manage providers, set your default model</p>
    </div>
  </div>

  <!-- Provider Management Strip -->
  <div class="llm-provider-mgmt">
    {#each engineList as eng}
      {@const entry = llmConfig?.models?.[eng]}
      {@const isEngActive = entry?.active !== false}
      {@const isEngDefault = resolveDefault('models')?.engine === eng && !['openai', 'anthropic', 'gemini'].includes(defaultProvider)}
      <div class="llm-provider-chip {isEngActive ? '' : 'disabled'}">
        <span class="llm-chip-label">{ENGINE_LABELS[eng]}</span>
        <Toggle active={isEngActive} disabled={togglingActive === eng} onchange={() => toggleModelActive(eng)} />
        {#if isEngDefault}
          <span class="badge badge-green text-2xs">default</span>
        {:else}
          <button class="llm-chip-default-btn" title="Set as default" disabled={settingDefault === eng} onclick={() => setDefaultProvider(eng)}>
            default
          </button>
        {/if}
      </div>
    {/each}
    {#each ['openai', 'anthropic', 'gemini'] as p}
      {@const meta = PROVIDER_META[p]}
      {@const entry = llmConfig?.models?.[p]}
      {@const isCloudActive = entry?.active !== false}
      {@const isCloudDefault = defaultProvider === p}
      <div class="llm-provider-chip {isCloudActive ? '' : 'disabled'}">
        <span class="llm-chip-label">{meta.label}</span>
        <Toggle active={isCloudActive} disabled={togglingActive === p} onchange={() => toggleModelActive(p)} />
        {#if isCloudDefault}
          <span class="badge badge-green text-2xs">default</span>
        {:else}
          <button class="llm-chip-default-btn" title="Set as default" disabled={settingDefault === p} onclick={() => setDefaultProvider(p)}>
            default
          </button>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Provider Tabs -->
  <div class="llm-provider-tabs">
    {#each PROVIDERS as p}
      {@const meta = PROVIDER_META[p]}
      {@const isActive = activeProvider === p}
      {@const isEnabled = p === 'local'
        ? engineList.some(eng => llmConfig?.models?.[eng]?.active !== false)
        : llmConfig?.models?.[p]?.active !== false}
      {#if isEnabled}
        <button class="llm-provider-tab {isActive ? 'active' : ''}" onclick={() => selectProvider(p)}>
          <span class="text-{meta.color}">
            {#if BRAND_SVGS[p]}
              {@html BRAND_SVGS[p]}
            {:else}
              <i class="fas fa-server"></i>
            {/if}
          </span>
          <span>{meta.label}</span>
        </button>
      {/if}
    {/each}
  </div>

  <!-- Cloud Provider Config -->
  {#if activeProvider !== 'local'}
    {@const provider = activeProvider}
    {@const meta = PROVIDER_META[provider]}
    {@const popularModels = POPULAR_MODELS[provider] || []}
    {@const popularEmbs = POPULAR_EMBEDDINGS[provider] || []}
    {@const { entry: modelEntry } = cloudModelEntry()}
    {@const hasEnvKey = modelEntry?._hasEnvKey || false}
    {@const isEnvRef = modelEntry?.apiKey && /^\$\{.+\}$/.test(modelEntry.apiKey)}
    {@const hasConfigKey = isEnvRef ? false : (modelEntry?.apiKey && !modelEntry.apiKey.startsWith('••••') ? false : !!modelEntry?.apiKey)}
    {@const envVarName = PROVIDER_ENV_NAMES[provider] || ''}

    <div class="llm-config-card">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <span class="text-{meta.color}">
            {#if BRAND_SVGS[provider]}
              {@html BRAND_SVGS[provider]}
            {:else}
              <i class="fas fa-server"></i>
            {/if}
          </span>
          <span class="font-semibold text-primary">{meta.label} Configuration</span>
        </div>
      </div>

      <div class="llm-cloud-form">
        <!-- API Key -->
        <div class="llm-form-group">
          <div class="flex items-center justify-between">
            <label class="llm-form-label" for="cloudApiKey">API Key</label>
            {#if hasConfigKey}
              <span class="llm-key-status llm-key-status-set"><i class="fas fa-check"></i>Set in config</span>
            {:else if isEnvRef || hasEnvKey}
              <span class="llm-key-status llm-key-status-env"><i class="fas fa-leaf"></i>Using {envVarName}</span>
            {:else}
              <span class="llm-key-status llm-key-status-missing"><i class="fas fa-exclamation-triangle"></i>Not configured</span>
            {/if}
          </div>
          <input id="cloudApiKey" type="password" class="input"
            placeholder={envVarName ? `Or set ${envVarName} env var` : 'Enter API key'}
            bind:value={cloudApiKey} />
          {#if envVarName}
            <span class="llm-form-hint">Environment variable: {envVarName}</span>
          {/if}
        </div>

        <!-- Chat Model -->
        <div class="llm-form-group">
          <label class="llm-form-label" for="cloudModel">Chat Model</label>
          <div class="llm-form-row">
            <select id="cloudModel" class="select" bind:value={cloudModel} onchange={() => { if (cloudModel === '') { /* custom */ } }}>
              {#each popularModels as m}
                <option value={m}>{m}</option>
              {/each}
              <option value="">Custom...</option>
            </select>
            {#if cloudModel === ''}
              <input type="text" class="input" placeholder="Custom model name" bind:value={cloudModelCustom} />
            {/if}
          </div>
        </div>

        <!-- Embedding Model -->
        {#if popularEmbs.length > 0}
          <div class="llm-form-group">
            <label class="llm-form-label" for="cloudEmbModel">Embedding Model</label>
            <div class="llm-form-row">
              <select id="cloudEmbModel" class="select" bind:value={cloudEmbModel}>
                {#each popularEmbs as m}
                  <option value={m}>{m}</option>
                {/each}
                <option value="">Custom...</option>
              </select>
              {#if cloudEmbModel === ''}
                <input type="text" class="input" placeholder="Custom embedding model name" bind:value={cloudEmbModelCustom} />
              {/if}
            </div>
          </div>
        {/if}

        <!-- Advanced -->
        <div class="llm-form-group">
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="llm-form-label">Advanced</label>
          <div class="llm-form-row">
            <div class="llm-form-group">
              <label class="llm-form-label" for="cloudTemp">Temperature</label>
              <input id="cloudTemp" type="number" class="input" min="0" max="2" step="0.1"
                placeholder="Default" bind:value={cloudTemp} />
            </div>
            <div class="llm-form-group">
              <label class="llm-form-label" for="cloudMaxTokens">Max Tokens</label>
              <input id="cloudMaxTokens" type="number" class="input" min="1"
                placeholder="Default" bind:value={cloudMaxTokens} />
            </div>
          </div>
          {#if provider === 'anthropic'}
            <div class="llm-form-group">
              <label class="llm-form-label" for="cloudThinkingBudget">Thinking Budget</label>
              <input id="cloudThinkingBudget" type="number" class="input" min="0"
                placeholder="0 = disabled" bind:value={cloudThinkingBudget} />
            </div>
          {/if}
          <div class="llm-form-group">
            <label class="llm-form-label" for="cloudBaseUrl">Base URL</label>
            <input id="cloudBaseUrl" type="text" class="input"
              placeholder="Default (leave empty for standard API)" bind:value={cloudBaseUrl} />
          </div>
        </div>

        <!-- Save status -->
        <div class="text-xs text-muted">
          {#if cloudSaveStatus === 'saved'}
            <i class="fas fa-check text-green mr-1"></i>Saved
          {:else if cloudSaveStatus.startsWith('error:')}
            <i class="fas fa-exclamation-circle text-red mr-1"></i>{cloudSaveStatus.slice(6)}
          {/if}
        </div>

        <div class="flex items-center gap-3">
          <button class="btn btn-accent" disabled={cloudSaving} onclick={saveCloudConfig}>
            {#if cloudSaving}
              <i class="fas fa-spinner fa-spin mr-1"></i>Saving...
            {:else}
              <i class="fas fa-save mr-1"></i>Save Configuration
            {/if}
          </button>
          {#if p2pEnabled}
            {@const pEntry = llmConfig?.models?.[provider]}
            <div class="flex items-center gap-2">
              <i class="fas fa-share-nodes text-xs {pEntry?.p2p ? 'text-accent' : 'text-muted'}"></i>
              <span class="text-xs {pEntry?.p2p ? 'text-accent' : 'text-muted'}">P2P</span>
              <Toggle active={pEntry?.p2p === true} disabled={togglingP2P === provider} onchange={() => toggleModelP2P(provider)} />
            </div>
          {/if}
        </div>
      </div>
    </div>

  {/if}

  <!-- Local LLM Content -->
  {#if activeProvider === 'local'}
    <!-- Engine Tabs -->
    {#if engines}
      <div class="llm-engine-tabs">
        {#each engineList as eng}
          {@const available = engines[eng]?.available}
          {@const isActive = selectedEngine === eng}
          {@const isExternal = EXTERNAL_ENGINES.includes(eng)}
          {@const isEngEnabled = llmConfig?.models?.[eng]?.active !== false}
          {#if isEngEnabled}
            <button class="llm-engine-tab {isActive ? 'active' : ''}" onclick={() => selectEngine(eng)}>
              <i class="{eng === 'mlx-serve' ? 'fab' : 'fas'} {ENGINE_ICONS[eng]}"></i>
              <span>{ENGINE_LABELS[eng]}</span>
              {#if eng === 'mlx-serve'}
                <span class="badge badge-amber text-2xs">experimental</span>
              {/if}
              {#if isExternal}
                <span class="engine-status {available ? 'connected' : 'disconnected'}"></span>
              {/if}
            </button>
          {/if}
        {/each}
      </div>
    {/if}

    <!-- Status Bar -->
    <div class="mb-6">
      {#if isExternalEngine}
        <!-- External Engine Status Panel -->
        <div class="llm-server-panel">
          <!-- Header -->
          <div class="llm-server-header">
            <div class="flex items-center gap-2">
              <i class="{selectedEngine === 'mlx-serve' ? 'fab' : 'fas'} {ENGINE_ICONS[selectedEngine || '']}"></i>
              <span class="text-sm font-semibold text-primary">{extLabel}</span>
              <span class="{extAvailable ? 'llm-pulse llm-pulse-green' : 'llm-pulse-off'}"></span>
              <span class="text-xs {extAvailable ? 'text-green' : 'text-red'}">{extAvailable ? 'Connected' : 'Not detected / Not running'}</span>
            </div>
            <div class="flex items-center gap-2">
              <button class="btn-ghost text-xs flex-shrink-0" onclick={loadEngines}>
                <i class="fas fa-sync-alt mr-1"></i>Refresh
              </button>
            </div>
          </div>

          <!-- Base URL -->
          <div class="llm-server-section">
            <div class="llm-section-content flex items-center gap-2">
              <label class="text-xs text-muted flex-shrink-0" for="engineUrl">Base URL</label>
              <input id="engineUrl" type="text" class="input input-sm flex-1 font-mono text-xs"
                bind:value={engineUrlInput}
                placeholder={extDefaultUrls[selectedEngine || ''] || ''}
                onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') saveEngineUrl(); }} />
              {#if engineUrlInput.replace(/\/+$/, '') !== engineUrlOrig}
                <button class="btn btn-accent btn-sm" disabled={engineUrlSaving} onclick={saveEngineUrl}>
                  {#if engineUrlSaving}
                    <i class="fas fa-spinner fa-spin mr-1"></i>Saving...
                  {:else}
                    <i class="fas fa-save mr-1"></i>Save
                  {/if}
                </button>
              {/if}
              {#if engineUrlOrig && engineUrlOrig !== extDefaultUrls[selectedEngine || '']}
                <button class="btn-ghost text-xs" title="Reset to default" onclick={resetEngineUrl}>
                  <i class="fas fa-undo"></i>
                </button>
              {/if}
            </div>
          </div>

          {#if !extAvailable}
            <div class="llm-section-content flex items-center gap-3 py-2">
              <span class="text-sm text-muted">Make sure {extLabel} is running{extIsRemote ? ` at ${extEffectiveUrl}` : ' on your machine'}</span>
            </div>
          {:else}
            <!-- Running models with unload -->
            {#each extRunning as r}
              {@const vramStr = r.sizeVram ? formatBytes(r.sizeVram) : ''}
              {@const ctxStr = r.contextLength ? `${(r.contextLength / 1024).toFixed(0)}K ctx` : ''}
              {@const sizeStr = r.size ? formatBytes(r.size) : ''}
              {@const rmeta = [sizeStr, vramStr, ctxStr].filter(Boolean).join(' \u00B7 ')}
              <div class="llm-server-section">
                <div class="llm-section-content flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <span class="llm-pulse llm-pulse-green"></span>
                    <span class="badge badge-amber font-mono">{r.name}</span>
                    {#if rmeta}<span class="text-xs text-muted">{rmeta}</span>{/if}
                  </div>
                  <button class="btn btn-danger btn-sm" disabled={unloadingModel === r.name}
                    onclick={() => unloadEngineModel(r.name, r.instanceId)}>
                    {#if unloadingModel === r.name}
                      <i class="fas fa-spinner fa-spin mr-1"></i>Unloading...
                    {:else}
                      <i class="fas fa-eject mr-1"></i>Unload
                    {/if}
                  </button>
                </div>
              </div>
            {/each}

            <!-- Chat model config sliders -->
            <div class="llm-server-section">
              {#if extActiveChatModel}
                {@const activeExtModelData = extModels.find((m: any) => m.name === extActiveChatModel)}
                {@const isChatLoaded = !!activeExtModelData?.loaded}
                {@const maxCtxFromApi = activeExtModelData?.maxContextLength || null}
                <div class="llm-section-content space-y-2">
                  <div class="flex items-center gap-3">
                    <i class="fas fa-comments text-amber text-xs"></i>
                    <span class="text-sm text-primary">Chat Config</span>
                    <span class="text-xs text-muted font-mono">{extActiveChatModel}</span>
                    {#if !isChatLoaded}<span class="text-2xs text-red">not loaded</span>{/if}
                  </div>
                  <div class="llm-sliders-section">
                    <div class="llm-slider-row">
                      <!-- svelte-ignore a11y_label_has_associated_control -->
                      <label class="llm-slider-label flex items-center gap-2" style:justify-content="flex-start">
                        <span>Context Size</span>
                        <span class="font-mono text-xs text-green">{fmtCtx(extCtxSliderValue)}</span>
                      </label>
                      <input type="range" class="llm-range"
                        min="2048" max={maxCtxFromApi || 131072} step="1024"
                        bind:value={extCtxSliderValue}
                        style:--range-fill={`${((extCtxSliderValue - 2048) / ((maxCtxFromApi || 131072) - 2048)) * 100}%`} />
                      <div class="llm-slider-meta">
                        <span>2K</span>
                        <span class="text-2xs text-muted">{selectedEngine === 'ollama' ? 'Sent as num_ctx per request' : 'Reloads model in LM Studio'}</span>
                        <span>{maxCtxFromApi ? `${(maxCtxFromApi / 1024).toFixed(0)}K` : '128K'}</span>
                      </div>
                    </div>
                    <div class="llm-slider-row">
                      <!-- svelte-ignore a11y_label_has_associated_control -->
                      <label class="llm-slider-label flex items-center gap-2" style:justify-content="flex-start">
                        <span>Max Tokens</span>
                        <span class="font-mono text-xs text-green">{extMaxTokSliderValue.toLocaleString()}</span>
                      </label>
                      <input type="range" class="llm-range"
                        min="256" max="16384" step="256"
                        bind:value={extMaxTokSliderValue}
                        style:--range-fill={`${((extMaxTokSliderValue - 256) / (16384 - 256)) * 100}%`} />
                      <div class="llm-slider-meta">
                        <span>256</span>
                        <span>16K</span>
                      </div>
                    </div>
                    {#if extAnyChanged}
                      <button class="btn btn-accent btn-sm" disabled={extApplying} onclick={applyExtSettings}>
                        {#if extApplying}
                          <i class="fas fa-spinner fa-spin mr-1"></i>Applying...
                        {:else}
                          <i class="fas fa-save mr-1"></i>Apply
                        {/if}
                      </button>
                    {/if}
                  </div>
                </div>
              {:else}
                <div class="llm-section-content flex items-center gap-3">
                  <span class="llm-pulse-off"></span>
                  <span class="text-sm text-secondary">Chat Model</span>
                  <span class="text-xs text-muted">Activate a model below</span>
                </div>
              {/if}
            </div>

            <!-- Embedding model -->
            {#if extActiveEmbModel}
              <div class="llm-server-section">
                <div class="llm-section-content flex items-center gap-3">
                  <span class="llm-pulse llm-pulse-blue"></span>
                  <span class="text-sm text-primary">Embedding Model</span>
                  <span class="badge badge-blue font-mono">{extActiveEmbModel}</span>
                </div>
              </div>
            {/if}
          {/if}

          {#if p2pEnabled && selectedEngine}
            {@const engEntry = llmConfig?.models?.[selectedEngine]}
            <div class="llm-server-section">
              <div class="llm-section-content flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <i class="fas fa-share-nodes text-xs {engEntry?.p2p ? 'text-accent' : 'text-muted'}"></i>
                  <span class="text-sm {engEntry?.p2p ? 'text-primary' : 'text-secondary'}">P2P Sharing</span>
                  {#if engEntry?.p2p}
                    <span class="badge badge-accent text-2xs">Shared</span>
                  {/if}
                </div>
                <Toggle active={engEntry?.p2p === true} disabled={togglingP2P === selectedEngine} onchange={() => toggleModelP2P(selectedEngine!)} />
              </div>
            </div>
          {/if}
        </div>
      {:else if isManagedEngine && status}
        <!-- Managed Engine Status Panel -->
        {@const isDefaultEngine = selectedEngine === configDefaultEngine}
        <div class="llm-server-panel">
          <!-- Header -->
          <div class="llm-server-header">
            <div class="flex items-center gap-2">
              <i class="fas fa-server text-amber text-xs"></i>
              <span class="text-sm font-semibold text-primary">{isMlx ? 'mlx-serve' : 'llama-server'}</span>
              {#if versionLabel}<span class="text-xs text-muted font-mono">{versionLabel}</span>{/if}
              <span class="{chatRunning ? 'llm-pulse llm-pulse-green' : 'llm-pulse-off'}"></span>
              <span class="text-xs {chatRunning ? 'text-green' : 'text-muted'}">{chatRunning ? 'Running' : 'Stopped'}</span>
            </div>
          </div>

          <!-- Server details -->
          <div class="llm-server-details">
            <span title="Runtime"><i class="fas fa-bolt mr-1 llm-icon-dim"></i>{runtimeLabel}</span>
            <span title="Server type"><i class="fas fa-comments mr-1 llm-icon-dim"></i>Chat Completions</span>
            {#if chatRunning && chatStatus.port}
              <span class="flex items-center gap-1" title="OpenAI-compatible API endpoint">
                <i class="fas fa-link mr-1 llm-icon-dim"></i>
                <code class="font-mono text-secondary">http://127.0.0.1:{chatStatus.port}/v1</code>
                <button class="copy-url-btn text-muted transition-colors" title="Copy URL"
                  onclick={(e: MouseEvent) => copyUrl(`http://127.0.0.1:${chatStatus.port}/v1`, e)}>
                  <i class="fas fa-copy text-2xs"></i>
                </button>
              </span>
            {:else}
              <span><i class="fas fa-link mr-1 llm-icon-dim"></i><span class="text-muted">Not running</span></span>
            {/if}
          </div>

          <!-- Chat model section -->
          <div class="llm-server-section">
            {#if chatRunning}
              <div class="llm-section-content space-y-2">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <span class="llm-pulse llm-pulse-green"></span>
                    <span class="text-sm text-primary">Chat Model</span>
                    <span class="badge badge-amber font-mono">{activeModelName}</span>
                    {#if ctxSize}<span class="text-xs text-muted">{(ctxSize / 1024).toFixed(0)}K ctx</span>{/if}
                  </div>
                  <button class="btn btn-danger btn-sm" disabled={stoppingChat} onclick={stopServer}>
                    {#if stoppingChat}
                      Stopping...
                    {:else}
                      <i class="fas fa-stop mr-1"></i>Stop
                    {/if}
                  </button>
                </div>

                <!-- Memory bar -->
                {#if procMem}
                  <div class="flex items-center gap-3"
                    title={mem ? `Estimate: ${formatBytes(mem.modelBytes)} model + ${formatBytes(mem.kvCacheBytes)} KV cache = ${formatBytes(mem.totalBytes)}` : ''}>
                    <div class="llm-mem-bar">
                      <div class="llm-mem-fill {memBarCls}" style:width="{memPct}%"></div>
                    </div>
                    <div class="flex items-center gap-3 text-xs text-muted flex-shrink-0">
                      <span><i class="fas fa-memory mr-1"></i>{formatBytes(actualBytes)}</span>
                      {#if procMem.gpuBytes != null}
                        <span class="text-2xs">({formatBytes(procMem.rssBytes)} RAM + {formatBytes(procMem.gpuBytes)} VRAM)</span>
                      {/if}
                      <span>/ {formatBytes(totalRam)}</span>
                    </div>
                  </div>
                {/if}

                <!-- Sliders -->
                <div class="llm-sliders-section">
                  <div class="llm-slider-row">
                    <!-- svelte-ignore a11y_label_has_associated_control -->
                    <label class="llm-slider-label flex items-center gap-2" style:justify-content="flex-start">
                      <span>Context Size</span>
                      <span class="font-mono text-xs" style:color={ctxRangeColor}>{fmtCtx(ctxSliderValue)}</span>
                    </label>
                    <input type="range" class="llm-range"
                      min="2048" max="131072" step="1024"
                      bind:value={ctxSliderValue}
                      style:--range-color={ctxRangeColor}
                      style:--range-fill={ctxRangeFill} />
                    <div class="llm-slider-meta">
                      <span>2K</span>
                      <span class="font-mono">{formatBytes(estimatedKvCache)} KV + {formatBytes(mem?.modelBytes || 0)} model = {formatBytes(estimatedTotal)} / {formatBytes(totalRam)}</span>
                      <span>128K</span>
                    </div>
                  </div>

                  <div class="llm-slider-row">
                    <!-- svelte-ignore a11y_label_has_associated_control -->
                    <label class="llm-slider-label flex items-center gap-2" style:justify-content="flex-start">
                      <span>Max Tokens</span>
                      <span class="font-mono text-xs text-green">{maxTokSliderValue.toLocaleString()}</span>
                    </label>
                    <input type="range" class="llm-range"
                      min="256" max="16384" step="256"
                      bind:value={maxTokSliderValue}
                      style:--range-fill={`${((maxTokSliderValue - 256) / (16384 - 256)) * 100}%`} />
                    <div class="llm-slider-meta">
                      <span>256</span>
                      <span>16K</span>
                    </div>
                  </div>

                  <!-- Thinking toggle -->
                  {#if modelCaps.reasoning}
                    <div class="llm-thinking-row">
                      <div class="flex items-center justify-between">
                        <!-- svelte-ignore a11y_label_has_associated_control -->
                        <label class="llm-slider-label flex items-center gap-2">
                          <span><i class="fas fa-brain text-purple mr-1"></i>Thinking</span>
                          <span class="font-mono text-xs {thinkingEnabled ? (thinkingBudgetValue > 256 ? 'text-red' : 'text-purple') : 'text-muted'}">
                            {thinkingEnabled ? `${thinkingBudgetValue.toLocaleString()} tokens` : 'Off'}
                          </span>
                        </label>
                        <label class="llm-toggle">
                          <input type="checkbox" bind:checked={thinkingEnabled} />
                          <span class="llm-toggle-slider"></span>
                        </label>
                      </div>
                      {#if thinkingEnabled}
                        <div>
                          <input type="range" class="llm-range"
                            min="128" max="1024" step="128"
                            bind:value={thinkingBudgetValue}
                            style:--range-fill={`${((thinkingBudgetValue - 128) / (1024 - 128)) * 100}%`} />
                          <div class="llm-slider-meta">
                            <span>128</span>
                            <span class="text-2xs text-muted">Requires server restart</span>
                            <span>1K</span>
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/if}

                  <!-- Warning -->
                  {#if sliderWarning && anySliderChanged}
                    <div class="llm-slider-warning {sliderWarning.cls}">{sliderWarning.text}</div>
                  {/if}

                  <!-- Apply button -->
                  {#if anySliderChanged}
                    <button class="btn btn-accent btn-sm" disabled={applyingSettings} onclick={applyModelSettings}>
                      {#if applyingSettings}
                        <i class="fas fa-spinner fa-spin mr-1"></i>{sliderCtxChanged || sliderThinkingChanged ? 'Restarting...' : 'Saving...'}
                      {:else}
                        <i class="fas fa-save mr-1"></i>Apply
                      {/if}
                    </button>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="llm-section-content flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <span class="llm-pulse-off"></span>
                  <span class="text-sm text-secondary">Chat Model</span>
                  {#if lastActiveModelObj}
                    <span class="text-xs text-muted">{lastActiveModelObj.fileName}</span>
                  {:else}
                    <span class="text-xs text-muted">Activate a model to start</span>
                  {/if}
                </div>
                {#if lastActiveModelObj}
                  <button class="btn btn-amber btn-sm"
                    disabled={activatingModelId === lastActiveModel}
                    onclick={() => activateModel(lastActiveModel!)}>
                    {#if activatingModelId === lastActiveModel}
                      <span class="spinner-sm"></span> Starting...
                    {:else}
                      <i class="fas fa-play mr-1"></i>Start
                    {/if}
                  </button>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Embedding model -->
          {#if embRunning}
            <div class="llm-server-section">
              <div class="llm-section-content flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <span class="llm-pulse llm-pulse-blue"></span>
                  <span class="text-sm text-primary">Embedding Model</span>
                  <span class="badge badge-blue font-mono">{embModelName}</span>
                </div>
                <button class="btn btn-danger btn-sm" disabled={stoppingEmb} onclick={stopEmbedding}>
                  {#if stoppingEmb}
                    Stopping...
                  {:else}
                    <i class="fas fa-stop mr-1"></i>Stop
                  {/if}
                </button>
              </div>
            </div>
          {/if}

          {#if p2pEnabled && selectedEngine}
            {@const engEntry = llmConfig?.models?.[selectedEngine]}
            <div class="llm-server-section">
              <div class="llm-section-content flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <i class="fas fa-share-nodes text-xs {engEntry?.p2p ? 'text-accent' : 'text-muted'}"></i>
                  <span class="text-sm {engEntry?.p2p ? 'text-primary' : 'text-secondary'}">P2P Sharing</span>
                  {#if engEntry?.p2p}
                    <span class="badge badge-accent text-2xs">Shared</span>
                  {/if}
                </div>
                <Toggle active={engEntry?.p2p === true} disabled={togglingP2P === selectedEngine} onchange={() => toggleModelP2P(selectedEngine!)} />
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="llm-alert">
          <i class="fas fa-spinner fa-spin text-muted text-sm"></i>
          <span class="text-sm text-secondary">Loading...</span>
        </div>
      {/if}
    </div>

    <!-- External Models Section -->
    {#if isExternalEngine && extAvailable && engines}
      <div class="mb-6">
        {#if extModels.length === 0}
          <div class="text-muted text-center py-8 text-sm">No models loaded in {extLabel}.</div>
        {:else}
          <h3 class="section-title mb-3">Available Models</h3>
          <div class="llm-model-grid">
            {#each extModels as m}
              {@const name = m.name}
              {@const isChatActive = extActiveChatModel === name}
              {@const isEmbActive = extActiveEmbModel === name}
              {@const isLoaded = !!m.loaded}
              {@const caps = detectExternalCaps(m)}
              {@const looksLikeEmbed = caps.embedding}
              {@const sizeStr = m.size ? formatBytes(m.size) : ''}
              {@const tooLarge = !extIsRemote && totalRam && m.size && m.size > totalRam}
              {@const metaParts = [m.parameterSize, m.quantization, m.family, m.arch, m.maxContextLength ? `${(m.maxContextLength / 1024).toFixed(0)}K ctx` : ''].filter(Boolean)}
              {@const metaStr = metaParts.join(' \u00B7 ')}
              {@const cardCls = isChatActive ? 'llm-model-card active-chat' : isEmbActive ? 'llm-model-card active-emb' : 'llm-model-card'}

              <div class={cardCls}>
                <div class="flex items-start justify-between mb-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 mb-1">
                      {#if isChatActive}
                        <i class="fas fa-circle {isLoaded ? 'text-amber' : 'text-muted'} text-2xs" title={!isLoaded ? 'Not loaded on server' : ''}></i>
                      {/if}
                      {#if isEmbActive}
                        <i class="fas fa-circle {isLoaded ? 'text-blue' : 'text-muted'} text-2xs" title={!isLoaded ? 'Not loaded on server' : ''}></i>
                      {/if}
                      <span class="font-medium text-primary text-sm truncate">{name}</span>
                      {#if m.format}
                        <span class="badge badge-{m.format === 'mlx' ? 'green' : 'amber'} text-2xs">{m.format.toUpperCase()}</span>
                      {/if}
                    </div>
                    {#if metaStr}<div class="text-xs text-muted">{metaStr}</div>{/if}
                    {#if caps.tools || caps.vision || caps.reasoning}
                      <div class="flex items-center gap-1 mt-1">
                        {#if caps.tools}<span class="cap-badge cap-badge-tools" title="Tool calling"><i class="fas fa-wrench mr-1"></i>tools</span>{/if}
                        {#if caps.vision}<span class="cap-badge cap-badge-vision" title="Vision"><i class="fas fa-eye mr-1"></i>vision</span>{/if}
                        {#if caps.reasoning}<span class="cap-badge cap-badge-think" title="Reasoning"><i class="fas fa-brain mr-1"></i>think</span>{/if}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3 text-xs text-muted">
                    {#if sizeStr}<span><i class="fas fa-hard-drive mr-1"></i>{sizeStr}</span>{/if}
                    {#if tooLarge}<span class="text-red"><i class="fas fa-memory mr-1"></i>won't fit</span>{/if}
                  </div>
                  <div class="flex items-center gap-2">
                    {#if looksLikeEmbed}
                      {#if isEmbActive && isLoaded}
                        <span class="badge badge-blue">Embedding</span>
                      {:else}
                        <button class="btn btn-blue btn-sm" disabled={activatingExtEmb === name}
                          onclick={() => activateExtEmb(name)}>
                          {#if activatingExtEmb === name}
                            <span class="spinner-sm"></span> Activating...
                          {:else if isEmbActive && !isLoaded}
                            <i class="fas fa-redo mr-1"></i>Reload
                          {:else}
                            <i class="fas fa-vector-square mr-1"></i>Embed
                          {/if}
                        </button>
                      {/if}
                    {:else}
                      {#if isChatActive && isLoaded}
                        <span class="badge badge-amber">Active</span>
                      {:else}
                        <button class="btn btn-amber btn-sm" disabled={activatingExtChat === name}
                          onclick={() => activateExtChat(name)}>
                          {#if activatingExtChat === name}
                            <span class="spinner-sm"></span> Activating...
                          {:else if isChatActive && !isLoaded}
                            <i class="fas fa-redo mr-1"></i>Reload
                          {:else}
                            <i class="fas fa-play mr-1"></i>Activate
                          {/if}
                        </button>
                      {/if}
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Active Downloads -->
    {#if activeDownloadsList.length > 0}
      <div class="mb-4">
        {#each activeDownloadsList as d}
          <div class="llm-alert llm-alert-amber">
            <i class="fas fa-spinner fa-spin text-amber text-sm"></i>
            <div class="min-w-0 flex-1">
              <div class="text-sm text-primary truncate">{d.fileName}</div>
              <div class="text-xs text-muted truncate">{d.repo}</div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <div class="llm-download-bar">
                <div class="llm-download-fill llm-download-fill-amber" style:width="{d.progress.percent}%"></div>
              </div>
              <span class="text-xs text-muted font-mono text-right">{d.progress.percent}%</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Interrupted Downloads -->
    {#if interruptedDownloads.length > 0}
      <div class="mb-4">
        {#each interruptedDownloads as d}
          <div class="llm-alert llm-alert-warning">
            <i class="fas fa-pause-circle text-amber text-sm"></i>
            <div class="min-w-0 flex-1">
              <div class="text-sm text-primary truncate">{d.fileName}</div>
              <div class="text-xs text-muted">{d.repo ? `${d.repo} \u00B7 ` : ''}{formatBytes(d.downloadedBytes)} downloaded</div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <button class="btn btn-amber btn-sm" onclick={() => resumeInterruptedDownload(d)}>
                <i class="fas fa-play mr-1"></i>Resume
              </button>
              <button class="btn btn-danger btn-sm" onclick={() => discardInterruptedDownload(d)}>
                <i class="fas fa-trash-alt mr-1"></i>Discard
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Downloaded Models (managed engines) -->
    {#if isManagedEngine}
      <div class="mb-6">
        <h3 class="section-title mb-3">Downloaded Models</h3>
        <div class="llm-model-grid">
          {#if filteredModels.length === 0}
            <div class="col-span-full text-muted text-center py-8">
              <i class="fas fa-box-open text-4xl mb-4 block text-muted"></i>
              <p class="text-lg mb-2">No {selectedEngine === 'mlx-serve' ? 'MLX' : 'GGUF'} models downloaded</p>
              <p class="text-sm">Search HuggingFace below, or download a recommended model</p>
            </div>
          {:else}
            {#each filteredModels as model}
              {@const gActiveChat = globalActiveModelPath()}
              {@const gActiveEmb = globalActiveEmbPath()}
              {@const isChat = gActiveChat && gActiveChat === model.filePath}
              {@const isEmb = gActiveEmb && gActiveEmb === model.filePath}
              {@const looksLikeEmbedding = /embed|MiniLM/i.test(model.fileName)}
              {@const cardCls = isChat ? 'llm-model-card active-chat' : isEmb ? 'llm-model-card active-emb' : 'llm-model-card'}
              {@const caps = looksLikeEmbedding ? null : detectCapabilitiesFromFile(model)}

              <div class={cardCls} data-model-id={model.id}>
                <div class="flex items-start justify-between mb-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 mb-1">
                      {#if isChat}<i class="fas fa-circle text-amber text-2xs"></i>{/if}
                      {#if isEmb}<i class="fas fa-circle text-blue text-2xs"></i>{/if}
                      <span class="font-medium text-primary text-sm truncate">{model.fileName}</span>
                      <span class="badge badge-{model.type === 'mlx' ? 'green' : 'amber'} text-2xs">{(model.type || 'gguf').toUpperCase()}</span>
                    </div>
                    {#if model.repo}<div class="text-xs text-muted truncate">{model.repo}</div>{/if}
                    {#if caps && (caps.tools || caps.vision || caps.reasoning)}
                      <div class="flex items-center gap-1 mt-1">
                        {#if caps.tools}<span class="cap-badge cap-badge-tools" title="Tool calling"><i class="fas fa-wrench mr-1"></i>tools</span>{/if}
                        {#if caps.vision}<span class="cap-badge cap-badge-vision" title="Vision"><i class="fas fa-eye mr-1"></i>vision</span>{/if}
                        {#if caps.reasoning}<span class="cap-badge cap-badge-think" title="Reasoning"><i class="fas fa-brain mr-1"></i>think</span>{/if}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3 text-xs text-muted">
                    <span><i class="fas fa-hard-drive mr-1"></i>{formatBytes(model.sizeBytes)}</span>
                    <span>{timeAgo(model.downloadedAt)}</span>
                  </div>
                  <div class="flex items-center gap-2">
                    {#if looksLikeEmbedding}
                      {#if isEmb}
                        <span class="badge badge-blue">Embedding</span>
                      {:else}
                        <button class="btn btn-blue btn-sm"
                          disabled={activatingEmbId === model.id}
                          onclick={() => activateEmbedding(model.id)}>
                          {#if activatingEmbId === model.id}
                            <span class="spinner-sm"></span> Loading...
                          {:else}
                            <i class="fas fa-vector-square mr-1"></i>Embed
                          {/if}
                        </button>
                      {/if}
                    {:else}
                      {#if isChat}
                        <span class="badge badge-amber">Active</span>
                      {:else}
                        <button class="btn btn-amber btn-sm"
                          disabled={activatingModelId === model.id}
                          onclick={() => activateModel(model.id)}>
                          {#if activatingModelId === model.id}
                            <span class="spinner-sm"></span> Starting...
                          {:else}
                            <i class="fas fa-play mr-1"></i>Activate
                          {/if}
                        </button>
                      {/if}
                    {/if}
                    {#if !isChat && !isEmb}
                      <button class="text-xs text-muted transition-colors" title="Delete model"
                        onclick={() => deleteModel(model.id)}>
                        <i class="fas fa-trash-alt"></i>
                      </button>
                    {/if}
                  </div>
                </div>
                {#if activateErrors[model.id]}
                  <div class="activate-error">
                    <i class="fas fa-exclamation-circle mr-1"></i>{activateErrors[model.id]}
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {/if}

    <!-- Recommended Models -->
    {#if isManagedEngine && pendingRecommended.length > 0 && models.length === 0}
      <div class="mb-6">
        <h3 class="section-title mb-3">Recommended Models</h3>
        <div class="llm-rec-grid">
          {#each pendingRecommended as r}
            {@const downloadId = r.type === 'mlx' ? `mlx:${r.repo}` : `${r.repo}/${r.file}`}
            {@const isDownloading = activeDownloads.has(downloadId)}
            <div class="llm-rec-card llm-rec-card-{r.color}">
              <div class="flex items-center gap-2 mb-2">
                <i class="{r.icon === 'fa-apple' ? 'fab' : 'fas'} {r.icon} text-{r.color} text-sm"></i>
                <span class="font-medium text-primary text-sm">{r.label}</span>
                <span class="badge badge-{r.type === 'mlx' ? 'green' : 'amber'} text-2xs">{r.type.toUpperCase()}</span>
              </div>
              <p class="text-xs text-muted mb-3">{r.desc}</p>
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted">{r.size}</span>
                <button class="btn btn-{r.color} btn-sm" disabled={isDownloading}
                  onclick={() => downloadModel(r.repo, r.file, r.type)}>
                  {#if isDownloading}
                    <i class="fas fa-spinner fa-spin mr-1"></i>Downloading...
                  {:else}
                    <i class="fas fa-download mr-1"></i>Download
                  {/if}
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- HuggingFace Browser (managed engines only) -->
    {#if isManagedEngine}
      <div class="border-t pt-4">
        <h3 class="section-title mb-3">HuggingFace Browser</h3>
        <div class="flex gap-2 mb-2">
          <input type="text" placeholder="Search models (e.g. Qwen3, Llama, Phi)..."
            class="input flex-1"
            bind:value={hfSearchQuery}
            onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') searchHuggingFace(); }} />
          <span class="badge badge-gray flex-shrink-0">{browseFormat.toUpperCase()}</span>
          <button class="btn btn-accent flex-shrink-0" disabled={hfSearching} onclick={searchHuggingFace}>
            {#if hfSearching}
              <i class="fas fa-spinner fa-spin mr-1"></i>Searching...
            {:else}
              <i class="fas fa-search mr-1"></i>Search
            {/if}
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
        <div>
          {#if hfSearching}
            <div class="text-muted text-center py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Searching HuggingFace...</div>
          {:else if searchResults.length === 0}
            <div class="text-muted text-center py-8 text-sm">
              <i class="fas fa-cube text-2xl mb-3 block text-muted"></i>
              Search HuggingFace to find and download {browseFormat.toUpperCase()} models
            </div>
          {:else}
            {@const filterGguf = (files: any[]) => selectedEngine === 'llama-cpp'
              ? files.filter((f: any) => !/mmproj|bf16/i.test(f.fileName))
              : files}
            {@const resultsWithFiles = searchResults.filter((r: any) => filterGguf(r.ggufFiles).length > 0)}
            {#if resultsWithFiles.length === 0}
              <div class="text-muted text-center py-8">No {browseFormat.toUpperCase()} files found in the results.</div>
            {:else}
              <div class="space-y-2">
                {#each searchResults as result, idx}
                  {#if filterGguf(result.ggufFiles).length > 0}
                    {@const caps = detectCapabilities(result)}
                    {@const isMlxFormat = browseFormat === 'mlx'}
                    {#if isMlxFormat}
                      <!-- MLX result row -->
                      {@const totalSize = result.ggufFiles[0]?.sizeBytes || 0}
                      {@const downloaded = isModelDownloaded(models, result.repoId, '__mlx_repo__')}
                      {@const tooLarge = systemRamBytes > 0 && totalSize > systemRamBytes}
                      {@const dlId = `mlx:${result.repoId}`}
                      {@const isDownloading = activeDownloads.has(dlId)}
                      <div class="hf-result-row">
                        <div class="min-w-0 flex-shrink-0">
                          <div class="font-medium text-primary text-sm truncate" title={result.repoId}>{result.modelName}</div>
                          <div class="text-xs text-muted truncate">{result.author}</div>
                        </div>
                        <div class="flex items-center gap-2 text-xs flex-shrink-0">
                          <span class="text-muted" title="Downloads"><i class="fas fa-download mr-1"></i>{result.downloads?.toLocaleString() ?? 0}</span>
                          <span class="flex items-center gap-1">
                            <i class="fas fa-wrench {caps.tools ? 'text-green' : 'text-muted'}" title={caps.tools ? 'Tool calling' : 'No tool calling'}></i>
                            <i class="fas fa-eye {caps.vision ? 'text-blue' : 'text-muted'}" title={caps.vision ? 'Vision' : 'No vision'}></i>
                            <i class="fas fa-brain {caps.reasoning ? 'text-purple' : 'text-muted'}" title={caps.reasoning ? 'Reasoning / Thinking' : 'No reasoning'}></i>
                          </span>
                        </div>
                        <span class="text-xs text-muted">{formatBytes(totalSize)}</span>
                        {#if tooLarge}
                          <span class="ram-warning-badge" title="Exceeds system RAM"><i class="fas fa-memory mr-1"></i>won't fit</span>
                        {/if}
                        <div class="flex items-center gap-2 flex-shrink-0">
                          <button class="btn btn-sm {downloaded ? 'btn-green cursor-not-allowed' : 'btn-amber'}"
                            disabled={downloaded || isDownloading}
                            onclick={() => downloadModel(result.repoId, '__mlx_repo__', 'mlx')}>
                            {#if downloaded}
                              <i class="fas fa-check mr-1"></i>Downloaded
                            {:else if isDownloading}
                              <i class="fas fa-spinner fa-spin"></i>
                            {:else}
                              <i class="fas fa-download mr-1"></i>Download
                            {/if}
                          </button>
                        </div>
                      </div>
                    {:else}
                      <!-- GGUF result row -->
                      {@const filteredFiles = selectedEngine === 'llama-cpp'
                        ? result.ggufFiles.filter((f: any) => !/mmproj|bf16/i.test(f.fileName))
                        : result.ggufFiles}
                      {@const firstFile = filteredFiles[0]}
                      {@const selectedFileName = result._selectedFile || firstFile?.fileName}
                      {@const selectedFile = filteredFiles.find((f: any) => f.fileName === selectedFileName) || firstFile}
                      {@const tooLarge = systemRamBytes > 0 && selectedFile.sizeBytes > systemRamBytes}
                      {@const downloaded = isModelDownloaded(models, result.repoId, selectedFileName)}
                      {@const dlId = `${result.repoId}/${selectedFileName}`}
                      {@const isDownloading = activeDownloads.has(dlId)}
                      <div class="hf-result-row">
                        <div class="min-w-0 flex-shrink-0">
                          <div class="font-medium text-primary text-sm truncate" title={result.repoId}>{result.modelName}</div>
                          <div class="text-xs text-muted truncate">{result.author}</div>
                        </div>
                        <div class="flex items-center gap-2 text-xs flex-shrink-0">
                          <span class="text-muted" title="Downloads"><i class="fas fa-download mr-1"></i>{result.downloads?.toLocaleString() ?? 0}</span>
                          <span class="flex items-center gap-1">
                            <i class="fas fa-wrench {caps.tools ? 'text-green' : 'text-muted'}" title={caps.tools ? 'Tool calling' : 'No tool calling'}></i>
                            <i class="fas fa-eye {caps.vision ? 'text-blue' : 'text-muted'}" title={caps.vision ? 'Vision' : 'No vision'}></i>
                            <i class="fas fa-brain {caps.reasoning ? 'text-purple' : 'text-muted'}" title={caps.reasoning ? 'Reasoning / Thinking' : 'No reasoning'}></i>
                          </span>
                        </div>
                        <select class="hf-select"
                          onchange={(e: Event) => {
                            const target = e.target as HTMLSelectElement;
                            result._selectedFile = target.value;
                          }}>
                          {#each filteredFiles as f}
                            <option value={f.fileName}>{f.fileName} ({formatBytes(f.sizeBytes)})</option>
                          {/each}
                        </select>
                        {#if tooLarge}
                          <span class="ram-warning-badge" title="File size exceeds system RAM ({formatBytes(systemRamBytes)})"><i class="fas fa-memory mr-1"></i>won't fit</span>
                        {/if}
                        <div class="flex items-center gap-2 flex-shrink-0">
                          <button class="btn btn-sm {downloaded ? 'btn-green cursor-not-allowed' : 'btn-amber'}"
                            disabled={downloaded || isDownloading}
                            onclick={() => downloadModel(result.repoId, selectedFileName)}>
                            {#if downloaded}
                              <i class="fas fa-check mr-1"></i>Downloaded
                            {:else if isDownloading}
                              <i class="fas fa-spinner fa-spin"></i>
                            {:else}
                              <i class="fas fa-download mr-1"></i>Download
                            {/if}
                          </button>
                        </div>
                      </div>
                    {/if}
                  {/if}
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>
