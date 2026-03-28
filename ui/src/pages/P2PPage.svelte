<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { api } from '../lib/services/api.js';
  import { formatElapsedTime, estimateTokens, formatTokenCount } from '../lib/utils/format.js';
  import type { P2PStatus, P2PPeer, P2PRemoteAgent, P2PRemoteModel, P2PLeaderboardEntry, P2PNetworkStats, StreamEvent } from '../lib/types/index.js';

  import Toggle from '../components/Toggle.svelte';
  import ChatInput from '../components/chat/ChatInput.svelte';
  import ChatMessages from '../components/chat/ChatMessages.svelte';
  import UserBubble from '../components/chat/UserBubble.svelte';
  import ResponseBubble from '../components/chat/ResponseBubble.svelte';
  import StreamStatusBar from '../components/chat/StreamStatusBar.svelte';
  import StreamStatsBar from '../components/chat/StreamStatsBar.svelte';
  import ModelOutput from '../components/chat/ModelOutput.svelte';

  // --- Types ---

  interface ModelOutputEntry {
    task: string;
    input?: string;
    image?: string;
    audio?: string;
    video?: string;
    error?: string;
  }

  interface ChatBubble {
    type: 'user' | 'response';
    id: string;
    content: string;
    tools: ToolEntry[];
    thinkingSections: ThinkingEntry[];
    modelOutputs: ModelOutputEntry[];
    isLoading: boolean;
    error: string;
    stats: StatsData | null;
    cancelled: boolean;
    showStatusBar: boolean;
    statusText: string;
    elapsedDisplay: string;
  }

  interface ToolEntry {
    runId: string;
    tool: string;
    input: string;
    output?: string;
    done: boolean;
  }

  interface ThinkingEntry {
    content: string;
    done: boolean;
  }

  interface StatsData {
    elapsed: string;
    inputTokens: string;
    outputTokens: string;
    tps: string;
    cancelled: boolean;
    visible: boolean;
  }

  interface ChatSession {
    bubbles: ChatBubble[];
    sessionId: string;
  }

  // --- Persistent chat store (survives tab switches) ---

  const chatSessions = new Map<string, ChatSession>();
  let lastSelectionKey: string | null = null;

  function selectionKey(agent: P2PRemoteAgent | null, llm: P2PRemoteModel | null): string | null {
    if (agent) return `agent:${agent.peerId}:${agent.name}`;
    if (llm) return `llm:${llm.peerId}:${llm.name}`;
    return null;
  }

  function saveCurrentSession() {
    const key = selectionKey(selectedAgent, selectedModel);
    if (key && bubbles.length > 0) {
      chatSessions.set(key, { bubbles: [...bubbles], sessionId });
    }
  }

  function restoreSession(key: string): boolean {
    const session = chatSessions.get(key);
    if (session && session.bubbles.length > 0) {
      bubbles = [...session.bubbles];
      sessionId = session.sessionId;
      return true;
    }
    return false;
  }

  // --- State ---

  let status = $state<P2PStatus>({ enabled: false, connected: false, peerCount: 0, peerName: '', networkKey: '', rateLimit: 0, disabledByEnv: false });
  let peers = $state<P2PPeer[]>([]);
  let remoteAgents = $state<P2PRemoteAgent[]>([]);
  let remoteModels = $state<P2PRemoteModel[]>([]);
  let selectedAgent = $state<P2PRemoteAgent | null>(null);
  let selectedModel = $state<P2PRemoteModel | null>(null);
  let bubbles = $state<ChatBubble[]>([]);
  let isStreaming = $state(false);
  let currentAbortController = $state<AbortController | null>(null);
  let streamStartTime = $state<number | null>(null);
  let streamTimerInterval = $state<ReturnType<typeof setInterval> | null>(null);
  let streamUsageData = $state<{ input_tokens: number; output_tokens: number; total_tokens: number } | null>(null);
  let sessionId = $state(`p2p-${Date.now()}`);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let chatInputRef = $state<ChatInput | null>(null);
  let chatMessagesRef = $state<ChatMessages | null>(null);
  let sidebarFilter = $state('');

  let filteredPeers = $derived(sidebarFilter
    ? peers.filter(p => p.peerName.toLowerCase().includes(sidebarFilter.toLowerCase()))
    : peers);
  let filteredAgents = $derived(sidebarFilter
    ? remoteAgents.filter(a => a.name.toLowerCase().includes(sidebarFilter.toLowerCase()) || a.peerName.toLowerCase().includes(sidebarFilter.toLowerCase()))
    : remoteAgents);
  let filteredModels = $derived(sidebarFilter
    ? remoteModels.filter(l => l.name.toLowerCase().includes(sidebarFilter.toLowerCase()) || l.model.toLowerCase().includes(sidebarFilter.toLowerCase()) || l.peerName.toLowerCase().includes(sidebarFilter.toLowerCase()))
    : remoteModels);
  let filteredChatModels = $derived(filteredModels.filter(m => !m.type || m.type === 'chat'));
  let filteredMediaModels = $derived(filteredModels.filter(m => m.type === 'image' || m.type === 'tts'));
  let p2pConfig = $state<{ sharedAgents: any[]; sharedModels: any[] }>({ sharedAgents: [], sharedModels: [] });
  let togglingP2P = $state(false);
  let peerNameInput = $state('');
  let peerNameSaving = $state(false);
  let peerNameSaved = $state(false);
  let networkKeyInput = $state('');
  let networkKeySaving = $state(false);
  let networkKeySaved = $state(false);
  let useCustomKey = $state(false);
  let rateLimitInput = $state(0);
  let rateLimitSaving = $state(false);
  let rateLimitSaved = $state(false);

  // --- Tabs & Leaderboard ---
  type P2PTab = 'settings' | 'leaderboard';
  let activeMainTab = $state<P2PTab>('settings');
  let leaderboard = $state<P2PLeaderboardEntry[]>([]);
  let ownStats = $state<P2PNetworkStats | null>(null);
  let leaderboardLoading = $state(false);
  let showOwnDetails = $state(false);
  let leaderboardPollTimer: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    await loadStatus();
    peerNameInput = status.peerName;
    networkKeyInput = status.networkKey;
    useCustomKey = status.networkKey !== 'agent-orcha-default';
    rateLimitInput = status.rateLimit;
    loadP2PConfig();
    pollTimer = setInterval(loadStatus, 5000);

    // Restore last selection if we had one
    if (lastSelectionKey) {
      const session = chatSessions.get(lastSelectionKey);
      if (session) {
        // Find the matching agent or LLM once status loads
        const restore = () => {
          const [type, peerId, ...nameParts] = lastSelectionKey!.split(':');
          const name = nameParts.join(':');
          if (type === 'agent') {
            const agent = remoteAgents.find(a => a.peerId === peerId && a.name === name);
            if (agent) {
              selectedAgent = agent;
              selectedModel = null;
              restoreSession(lastSelectionKey!);
            }
          } else if (type === 'llm') {
            const llm = remoteModels.find(l => l.peerId === peerId && l.name === name);
            if (llm) {
              selectedModel = llm;
              selectedAgent = null;
              restoreSession(lastSelectionKey!);
            }
          }
        };
        // Try immediately and also after first poll
        restore();
        const unsubTimer = setInterval(() => {
          if (remoteAgents.length > 0 || remoteModels.length > 0) {
            restore();
            clearInterval(unsubTimer);
          }
        }, 500);
        setTimeout(() => clearInterval(unsubTimer), 10000);
      }
    }
  });

  onDestroy(() => {
    saveCurrentSession();
    if (pollTimer) clearInterval(pollTimer);
    if (leaderboardPollTimer) clearInterval(leaderboardPollTimer);
    if (streamTimerInterval) clearInterval(streamTimerInterval);
    currentAbortController?.abort();
  });

  async function loadStatus() {
    try {
      const [s, p, a, l] = await Promise.all([
        api.getP2PStatus(),
        api.getP2PPeers(),
        api.getP2PAgents(),
        api.getP2PLLMs(),
      ]);
      status = s;
      peers = p;
      remoteAgents = a;
      remoteModels = l;
    } catch { /* ignore */ }
  }

  async function loadP2PConfig() {
    try { p2pConfig = await api.getP2PConfig(); } catch { /* ignore */ }
  }

  async function toggleP2PEnabled() {
    togglingP2P = true;
    try {
      status = await api.toggleP2P(!status.enabled);
      if (status.enabled) {
        peerNameInput = status.peerName;
        await loadP2PConfig();
        await loadStatus();
      } else {
        peers = [];
        remoteAgents = [];
        remoteModels = [];
        p2pConfig = { sharedAgents: [], sharedModels: [] };
      }
    } catch { /* ignore */ }
    finally { togglingP2P = false; }
  }

  async function savePeerName() {
    if (!peerNameInput.trim() || peerNameInput.trim() === status.peerName) return;
    peerNameSaving = true;
    try {
      status = await api.updateP2PSettings({ peerName: peerNameInput.trim() });
      peerNameSaved = true;
      setTimeout(() => { peerNameSaved = false; }, 2000);
    } catch { /* ignore */ }
    finally { peerNameSaving = false; }
  }

  async function saveNetworkKey() {
    const key = useCustomKey ? networkKeyInput.trim() : 'agent-orcha-default';
    if (!key || key === status.networkKey) return;
    networkKeySaving = true;
    try {
      status = await api.updateP2PSettings({ networkKey: key });
      networkKeyInput = status.networkKey;
      networkKeySaved = true;
      setTimeout(() => { networkKeySaved = false; }, 2000);
      // Reload peers since we joined a new network
      await loadStatus();
      await loadP2PConfig();
    } catch { /* ignore */ }
    finally { networkKeySaving = false; }
  }

  async function saveRateLimit() {
    if (rateLimitInput === status.rateLimit) return;
    rateLimitSaving = true;
    try {
      status = await api.updateP2PSettings({ rateLimit: Math.max(0, rateLimitInput) });
      rateLimitInput = status.rateLimit;
      rateLimitSaved = true;
      setTimeout(() => { rateLimitSaved = false; }, 2000);
    } catch { /* ignore */ }
    finally { rateLimitSaving = false; }
  }

  function toggleCustomKey() {
    useCustomKey = !useCustomKey;
    if (!useCustomKey) {
      networkKeyInput = 'agent-orcha-default';
      saveNetworkKey();
    }
  }

  async function loadLeaderboard() {
    leaderboardLoading = true;
    try {
      const [lb, stats] = await Promise.all([
        api.getP2PLeaderboard(),
        api.getP2PStats(),
      ]);
      leaderboard = lb ?? [];
      ownStats = stats;
    } catch {
      // Leaderboard may not be available if P2P is off
    } finally {
      leaderboardLoading = false;
    }
  }

  $effect(() => {
    if (activeMainTab === 'leaderboard' && status.enabled && !selectedAgent && !selectedModel) {
      loadLeaderboard();
      leaderboardPollTimer = setInterval(loadLeaderboard, 10_000);
      return () => {
        if (leaderboardPollTimer) { clearInterval(leaderboardPollTimer); leaderboardPollTimer = null; }
      };
    } else {
      if (leaderboardPollTimer) { clearInterval(leaderboardPollTimer); leaderboardPollTimer = null; }
    }
  });

  function selectAgent(agent: P2PRemoteAgent) {
    saveCurrentSession();
    selectedModel = null;
    selectedAgent = agent;
    const key = selectionKey(agent, null)!;
    lastSelectionKey = key;
    if (!restoreSession(key)) {
      bubbles = [];
      sessionId = `p2p-${agent.peerId.slice(0, 8)}-${Date.now()}`;
    }
  }

  function selectModel(llm: P2PRemoteModel) {
    saveCurrentSession();
    selectedAgent = null;
    selectedModel = llm;
    const key = selectionKey(null, llm)!;
    lastSelectionKey = key;
    if (!restoreSession(key)) {
      bubbles = [];
      sessionId = `p2p-llm-${llm.peerId.slice(0, 8)}-${Date.now()}`;
    }
  }

  function deselectSelection() {
    saveCurrentSession();
    currentAbortController?.abort();
    selectedAgent = null;
    selectedModel = null;
    bubbles = [];
  }

  function resetChat() {
    currentAbortController?.abort();
    const key = selectionKey(selectedAgent, selectedModel);
    if (key) chatSessions.delete(key);
    bubbles = [];
    if (selectedAgent) {
      sessionId = `p2p-${selectedAgent.peerId.slice(0, 8)}-${Date.now()}`;
    } else if (selectedModel) {
      sessionId = `p2p-llm-${selectedModel.peerId.slice(0, 8)}-${Date.now()}`;
    }
  }

  // --- Chat ---

  function handleSubmit(message: string) {
    if (!message.trim() || (!selectedAgent && !selectedModel) || isStreaming) return;
    sendMessage(message.trim());
  }

  function handleSampleClick(question: string) {
    if (isStreaming) return;
    sendMessage(question);
  }

  async function sendMessage(message: string) {
    if (!selectedAgent && !selectedModel) return;

    const userBubble: ChatBubble = {
      type: 'user',
      id: `user-${Date.now()}`,
      content: message,
      tools: [],
      thinkingSections: [],
      modelOutputs: [],
      isLoading: false,
      error: '',
      stats: null,
      cancelled: false,
      showStatusBar: false,
      statusText: '',
      elapsedDisplay: '',
    };

    const responseId = `response-${Date.now()}`;
    const responseBubble: ChatBubble = {
      type: 'response',
      id: responseId,
      content: '',
      tools: [],
      thinkingSections: [],
      modelOutputs: [],
      isLoading: true,
      error: '',
      stats: null,
      cancelled: false,
      showStatusBar: true,
      statusText: 'Connecting to peer...',
      elapsedDisplay: '0s',
    };

    bubbles = [...bubbles, userBubble, responseBubble];
    await tick();
    chatMessagesRef?.scrollToBottom();

    isStreaming = true;
    streamUsageData = null;
    streamStartTime = Date.now();

    streamTimerInterval = setInterval(() => {
      if (streamStartTime) {
        const elapsed = Date.now() - streamStartTime;
        updateBubble(responseId, b => { b.elapsedDisplay = formatElapsedTime(elapsed); });
      }
    }, 100);

    const abortController = new AbortController();
    currentAbortController = abortController;

    let thinkingBuffer = '';
    let lastThinkingContent = '';

    try {
      let response: Response;
      if (selectedAgent) {
        const inputVar = selectedAgent.inputVariables[0] || 'input';
        const input = { [inputVar]: message };
        response = await api.streamP2PAgent(
          selectedAgent.peerId,
          selectedAgent.name,
          input,
          sessionId,
          { signal: abortController.signal },
        );
      } else {
        response = await api.streamP2PLLM(
          selectedModel!.peerId,
          selectedModel!.name,
          message,
          sessionId,
          { signal: abortController.signal },
        );
      }

      if (!response.ok) {
        const errorText = await response.text();
        updateBubble(responseId, b => {
          b.isLoading = false;
          b.showStatusBar = false;
          b.error = errorText || 'Failed to connect to peer';
        });
        finishStream(responseId, message);
        return;
      }

      updateBubble(responseId, b => { b.statusText = 'Streaming...'; });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as StreamEvent;
            handleStreamEvent(event, responseId, thinkingBuffer, lastThinkingContent);

            if (event.type === 'thinking') {
              thinkingBuffer += event.content || '';
            } else if (thinkingBuffer) {
              if (thinkingBuffer !== lastThinkingContent) {
                updateBubble(responseId, b => {
                  b.thinkingSections.push({ content: thinkingBuffer, done: true });
                });
              }
              lastThinkingContent = thinkingBuffer;
              thinkingBuffer = '';
            }
          } catch { /* ignore */ }
        }
      }

      // Flush remaining thinking
      if (thinkingBuffer && thinkingBuffer !== lastThinkingContent) {
        updateBubble(responseId, b => {
          b.thinkingSections.push({ content: thinkingBuffer, done: true });
        });
      }

      updateBubble(responseId, b => {
        b.isLoading = false;
        b.showStatusBar = false;
      });
    } catch (err: unknown) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        updateBubble(responseId, b => {
          b.isLoading = false;
          b.showStatusBar = false;
          b.cancelled = true;
        });
      } else {
        updateBubble(responseId, b => {
          b.isLoading = false;
          b.showStatusBar = false;
          b.error = error.message || 'Stream error';
        });
      }
    }

    finishStream(responseId, message);
  }

  function handleStreamEvent(event: StreamEvent, responseId: string, _thinkingBuffer: string, _lastThinkingContent: string) {
    if (event.type === 'content' && event.content) {
      updateBubble(responseId, b => { b.content += event.content!; });
      tick().then(() => chatMessagesRef?.scrollToBottom());
    }

    if (event.type === 'tool_start') {
      updateBubble(responseId, b => {
        b.tools.push({
          runId: event.runId || crypto.randomUUID(),
          tool: event.tool || 'unknown',
          input: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
          done: false,
        });
        b.statusText = `Using ${event.tool}...`;
      });
    }

    if (event.type === 'tool_end') {
      const toolOutput = typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? '');

      // Intercept model tools (image, TTS, video generation) — parse and display media
      if ((event.tool === 'generate_image' || event.tool === 'generate_tts' || event.tool === 'generate_video') && typeof event.output === 'string') {
        try {
          const parsed = JSON.parse(event.output);
          if (parsed.__modelTask) {
            updateBubble(responseId, b => {
              b.modelOutputs = [...b.modelOutputs, {
                task: parsed.task,
                input: parsed.input,
                image: parsed.image,
                audio: parsed.audio,
                video: parsed.video,
                error: parsed.error,
              }];
            });
          }
        } catch (err) { console.error('[P2PPage] Failed to parse model output:', err); }
      }

      updateBubble(responseId, b => {
        const tool = b.tools.find(t => t.runId === event.runId);
        if (tool) {
          tool.output = toolOutput;
          tool.done = true;
        }
        b.statusText = 'Streaming...';
      });
    }

    if (event.type === 'usage') {
      streamUsageData = {
        input_tokens: event.input_tokens || 0,
        output_tokens: event.output_tokens || 0,
        total_tokens: event.total_tokens || 0,
      };
    }

    if (event.type === 'react_iteration') {
      updateBubble(responseId, b => {
        b.statusText = `Iteration ${event.iteration || '?'}`;
        if (event.contextChars) b.statusText += ` · ${(event.contextChars / 1024).toFixed(1)} KB context`;
      });
    }

    if (event.error) {
      updateBubble(responseId, b => { b.error = event.error!; });
    }
  }

  function finishStream(responseId: string, inputMessage: string) {
    if (streamTimerInterval) { clearInterval(streamTimerInterval); streamTimerInterval = null; }

    const elapsed = streamStartTime ? Date.now() - streamStartTime : 0;
    const elapsedStr = formatElapsedTime(elapsed);
    const bubble = bubbles.find(b => b.id === responseId);
    const content = bubble?.content || '';

    const hasRealUsage = streamUsageData && (streamUsageData.input_tokens > 0 || streamUsageData.output_tokens > 0);
    const inTok = hasRealUsage ? streamUsageData!.input_tokens : estimateTokens(inputMessage);
    const outTok = hasRealUsage ? streamUsageData!.output_tokens : estimateTokens(content);
    const tps = elapsed > 0 ? (outTok / (elapsed / 1000)).toFixed(1) : '0';
    const prefix = hasRealUsage ? '' : '~';

    updateBubble(responseId, b => {
      b.stats = {
        elapsed: elapsedStr,
        inputTokens: `${prefix}${inTok} input`,
        outputTokens: `${prefix}${outTok} output`,
        tps: `${prefix}${tps} tok/s`,
        cancelled: b.cancelled,
        visible: true,
      };
    });

    isStreaming = false;
    currentAbortController = null;
    streamStartTime = null;
    streamUsageData = null;
  }

  function cancelStream() {
    currentAbortController?.abort();
  }

  function updateBubble(id: string, fn: (b: ChatBubble) => void) {
    const idx = bubbles.findIndex(b => b.id === id);
    if (idx >= 0) {
      fn(bubbles[idx]);
      bubbles = [...bubbles];
    }
  }
</script>

<div class="p2p-layout">
  <!-- Left sidebar: status + peers + agents -->
  <div class="p2p-sidebar">
    <div class="p2p-status-bar">
      <div class="flex items-center gap-2">
        <span class="status-dot" class:status-dot-active={status.connected} class:status-dot-error={!status.connected}></span>
        <span class="text-sm font-semibold text-primary">P2P Network</span>
      </div>
      <span class="text-xs text-muted">{status.peerName}</span>
    </div>

    {#if !status.connected}
      <div class="p2p-offline-notice">
        <i class="fas fa-link-slash text-muted"></i>
        <span class="text-sm text-muted">Not connected</span>
        <span class="text-xs text-muted">Waiting to join swarm...</span>
      </div>
    {:else}
      <!-- Search filter -->
      <div class="p2p-filter">
        <i class="fas fa-search text-2xs text-muted"></i>
        <input
          type="text"
          class="p2p-filter-input"
          placeholder="Filter..."
          bind:value={sidebarFilter}
        />
        {#if sidebarFilter}
          <button class="p2p-filter-clear" title="Clear filter" onclick={() => { sidebarFilter = ''; }}>
            <i class="fas fa-xmark text-2xs"></i>
          </button>
        {/if}
      </div>

      <!-- Peers section -->
      <div class="p2p-section">
        <div class="section-title">Peers ({filteredPeers.length})</div>
        {#if filteredPeers.length === 0}
          <div class="text-xs text-muted p-3">No peers discovered yet</div>
        {:else}
          {#each filteredPeers as peer}
            <div class="p2p-peer-card">
              <div class="flex items-center gap-2">
                <span class="status-dot status-dot-active"></span>
                <span class="text-sm font-medium text-primary">{peer.peerName}</span>
              </div>
              <span class="badge badge-gray text-2xs">{peer.agents.length} agent{peer.agents.length !== 1 ? 's' : ''}</span>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Remote agents section -->
      <div class="p2p-section">
        <div class="section-title">Remote Agents ({filteredAgents.length})</div>
        {#if filteredAgents.length === 0}
          <div class="text-xs text-muted p-3">{sidebarFilter ? 'No matches' : 'No shared agents available'}</div>
        {:else}
          {#each filteredAgents as agent}
            <button
              class="p2p-agent-card"
              class:active={selectedAgent?.name === agent.name && selectedAgent?.peerId === agent.peerId}
              onclick={() => selectAgent(agent)}
            >
              <div class="flex items-center gap-2">
                <i class="fas fa-robot text-xs text-accent"></i>
                <span class="text-sm font-medium text-primary">{agent.name}</span>
              </div>
              <span class="text-2xs text-muted p2p-desc">{agent.description}</span>
              <span class="text-2xs text-muted"><i class="fas fa-server text-2xs"></i> {agent.peerName}</span>
            </button>
          {/each}
        {/if}
      </div>

      <!-- Remote Chat LLMs section -->
      <div class="p2p-section">
        <div class="section-title">Remote LLMs ({filteredChatModels.length})</div>
        {#if filteredChatModels.length === 0}
          <div class="text-xs text-muted p-3">{sidebarFilter ? 'No matches' : 'No shared LLMs available'}</div>
        {:else}
          {#each filteredChatModels as llm}
            <button
              class="p2p-agent-card"
              class:active={selectedModel?.name === llm.name && selectedModel?.peerId === llm.peerId}
              onclick={() => selectModel(llm)}
            >
              <div class="flex items-center gap-2">
                <i class="fas fa-microchip text-xs text-accent"></i>
                <span class="text-sm font-medium text-primary">{llm.model}</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-2xs text-muted"><i class="fas fa-server text-2xs"></i> {llm.peerName}</span>
              </div>
            </button>
          {/each}
        {/if}
      </div>

      <!-- Remote Image/TTS models (non-chat, leverage only) -->
      {#if filteredMediaModels.length > 0}
        <div class="p2p-section">
          <div class="section-title">Remote Media Models ({filteredMediaModels.length})</div>
          {#each filteredMediaModels as m}
            <div class="p2p-agent-card" style="cursor: default;">
              <div class="flex items-center gap-2">
                <i class="fas {m.type === 'image' ? 'fa-image text-purple' : 'fa-microphone text-green'} text-xs"></i>
                <span class="text-sm font-medium text-primary">{m.model}</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-2xs text-muted"><i class="fas fa-server text-2xs"></i> {m.peerName}</span>
                <span class="badge badge-pill {m.type === 'image' ? 'badge-purple' : 'badge-green'} text-2xs">{m.type}</span>
                <span class="text-2xs text-muted">leverage only</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  <!-- Main chat area -->
  <div class="p2p-main">
    {#if !selectedAgent && !selectedModel}
      <!-- Tab bar -->
      <div class="p2p-tab-bar">
        <button class="p2p-tab" class:active={activeMainTab === 'settings'} onclick={() => { activeMainTab = 'settings'; }}>
          <i class="fas fa-gear"></i> Settings
        </button>
        <button class="p2p-tab" class:active={activeMainTab === 'leaderboard'} onclick={() => { activeMainTab = 'leaderboard'; }}>
          <i class="fas fa-trophy"></i> Leaderboard
        </button>
      </div>

      {#if activeMainTab === 'settings'}
      <div class="p2p-config-panel">
        <!-- P2P Settings -->
        <div class="p2p-config-section">
          <h3 class="text-sm font-semibold text-primary mb-3"><i class="fas fa-gear text-accent mr-2"></i>P2P Settings</h3>

          <div class="p2p-setting-row">
            <div class="flex-1">
              <div class="text-sm text-primary">Enable P2P</div>
              {#if status.disabledByEnv}
                <div class="text-xs text-amber">P2P was disabled at startup via <code>P2P_ENABLED=false</code>. Remove or change the environment variable and restart to enable.</div>
              {:else}
                <div class="text-xs text-muted">Connect to the Hyperswarm DHT to discover and share with peers</div>
              {/if}
            </div>
            <Toggle active={status.enabled} disabled={togglingP2P || !!status.disabledByEnv} onchange={toggleP2PEnabled} />
          </div>

          {#if status.enabled}
            <div class="p2p-setting-row">
              <div class="flex-1">
                <div class="text-sm text-primary">Machine Name</div>
                <div class="text-xs text-muted">How this instance appears to other peers</div>
              </div>
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  class="input p2p-name-input"
                  bind:value={peerNameInput}
                  placeholder="Peer name"
                  onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') savePeerName(); }}
                />
                <button
                  class="btn btn-sm btn-accent"
                  disabled={peerNameSaving || !peerNameInput.trim() || peerNameInput.trim() === status.peerName}
                  onclick={savePeerName}
                >
                  {#if peerNameSaved}
                    <i class="fas fa-check"></i>
                  {:else if peerNameSaving}
                    <i class="fas fa-spinner fa-spin"></i>
                  {:else}
                    Save
                  {/if}
                </button>
              </div>
            </div>

            <div class="p2p-setting-row">
              <div class="flex-1">
                <div class="text-sm text-primary">Network Key</div>
                <div class="text-xs text-muted">
                  {#if useCustomKey}
                    Private network — only peers with the same key can discover each other
                  {:else}
                    Default public network — all ORCHA instances can discover each other
                  {/if}
                </div>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-xs {useCustomKey ? 'text-amber' : 'text-muted'}">{useCustomKey ? 'Private' : 'Default'}</span>
                <Toggle active={useCustomKey} disabled={networkKeySaving} onchange={toggleCustomKey} />
              </div>
            </div>

            {#if useCustomKey}
              <div class="p2p-setting-row">
                <div class="flex-1">
                  <div class="text-xs text-muted">Key is SHA-256 hashed before joining the swarm</div>
                </div>
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    class="input p2p-name-input"
                    bind:value={networkKeyInput}
                    placeholder="my-private-network"
                    onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') saveNetworkKey(); }}
                  />
                  <button
                    class="btn btn-sm btn-accent"
                    disabled={networkKeySaving || !networkKeyInput.trim() || networkKeyInput.trim() === status.networkKey}
                    onclick={saveNetworkKey}
                  >
                    {#if networkKeySaved}
                      <i class="fas fa-check"></i>
                    {:else if networkKeySaving}
                      <i class="fas fa-spinner fa-spin"></i>
                    {:else}
                      Save
                    {/if}
                  </button>
                </div>
              </div>
            {/if}

            <div class="p2p-setting-row">
              <div class="flex-1">
                <div class="text-sm text-primary">Rate Limit</div>
                <div class="text-xs text-muted">Max incoming requests per minute across all shared resources. 0 = unlimited.</div>
              </div>
              <div class="flex items-center gap-2">
                <input
                  type="number"
                  class="input p2p-rate-input"
                  min="0"
                  bind:value={rateLimitInput}
                  placeholder="0"
                  onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') saveRateLimit(); }}
                />
                <button
                  class="btn btn-sm btn-accent"
                  disabled={rateLimitSaving || rateLimitInput === status.rateLimit}
                  onclick={saveRateLimit}
                >
                  {#if rateLimitSaved}
                    <i class="fas fa-check"></i>
                  {:else if rateLimitSaving}
                    <i class="fas fa-spinner fa-spin"></i>
                  {:else}
                    Save
                  {/if}
                </button>
              </div>
            </div>
          {/if}
        </div>

        <!-- Sharing Status -->
        {#if status.enabled}
        <div class="p2p-config-section">
          <h3 class="text-sm font-semibold text-primary mb-3"><i class="fas fa-share-nodes text-accent mr-2"></i>What You're Sharing</h3>

          <div class="p2p-sharing-group">
            <div class="text-xs font-medium text-muted mb-1">Shared Agents ({p2pConfig.sharedAgents.length})</div>
            {#if p2pConfig.sharedAgents.length === 0}
              <div class="text-xs text-muted p2p-hint">No agents shared. Add <code>p2p: true</code> to an agent YAML to share it.</div>
            {:else}
              {#each p2pConfig.sharedAgents as agent}
                <div class="p2p-shared-item">
                  <i class="fas fa-robot text-xs text-accent"></i>
                  <span class="text-sm text-primary">{agent.name}</span>
                  {#if agent.description}<span class="text-xs text-muted">— {agent.description}</span>{/if}
                </div>
              {/each}
            {/if}
          </div>

          <div class="p2p-sharing-group mt-3">
            <div class="text-xs font-medium text-muted mb-1">Shared Models ({p2pConfig.sharedModels.length})</div>
            {#if p2pConfig.sharedModels.length === 0}
              <div class="text-xs text-muted p2p-hint">No models shared. Toggle sharing on a provider in the Models tab, or add <code>share: true</code> in models.yaml.</div>
            {:else}
              {#each p2pConfig.sharedModels as m}
                <div class="p2p-shared-item">
                  <i class="fas {m.type === 'image' ? 'fa-image text-purple' : m.type === 'tts' ? 'fa-microphone text-green' : 'fa-microchip text-accent'} text-xs"></i>
                  <span class="text-sm text-primary">{m.model}</span>
                  <span class="text-2xs text-muted">({m.name})</span>
                  {#if m.type && m.type !== 'chat'}
                    <span class="badge badge-pill {m.type === 'image' ? 'badge-purple' : 'badge-green'} text-2xs">{m.type}</span>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        </div>

        <!-- Help / How It Works -->
        <div class="p2p-config-section">
          <h3 class="text-sm font-semibold text-primary mb-3"><i class="fas fa-circle-question text-accent mr-2"></i>How P2P Works</h3>
          <div class="p2p-help-grid">
            <div class="p2p-help-item">
              <div class="text-xs font-medium text-primary">Auto-Discovery</div>
              <div class="text-xs text-muted">Peers find each other via Hyperswarm DHT. Your network key is SHA-256 hashed before joining — safe for private networks.</div>
            </div>
            <div class="p2p-help-item">
              <div class="text-xs font-medium text-primary">Share an Agent</div>
              <div class="text-xs text-muted">Add <code>p2p: true</code> to any agent YAML file, or toggle it in the IDE visual editor.</div>
            </div>
            <div class="p2p-help-item">
              <div class="text-xs font-medium text-primary">Share a Model</div>
              <div class="text-xs text-muted">Click the <i class="fas fa-share-nodes"></i> icon on a provider in the Models tab, or set <code>share: true</code> in models.yaml.</div>
            </div>
            <div class="p2p-help-item">
              <div class="text-xs font-medium text-primary">Use Remote LLMs</div>
              <div class="text-xs text-muted">Set <code>llm: "p2p"</code> or <code>llm: "p2p:model-name"</code> in an agent config to use a peer's LLM.</div>
            </div>
            <div class="p2p-help-item">
              <div class="text-xs font-medium text-primary">Disable P2P</div>
              <div class="text-xs text-muted">Set <code>P2P_ENABLED=false</code> as an environment variable to opt out entirely.</div>
            </div>
          </div>
        </div>
        {/if}
      </div>
      {:else if activeMainTab === 'leaderboard'}
      <div class="p2p-config-panel">
        {#if !status.enabled}
          <div class="p2p-config-section">
            <div class="text-sm text-muted">Enable P2P to see the leaderboard.</div>
          </div>
        {:else}
          <!-- Network label -->
          <div class="p2p-leaderboard-header">
            <div class="flex items-center gap-2">
              <i class="fas fa-trophy text-accent"></i>
              <span class="text-sm font-semibold text-primary">Network: "{status.networkKey}"</span>
            </div>
            <button class="btn btn-sm btn-ghost text-muted" disabled={leaderboardLoading} onclick={loadLeaderboard} title="Refresh">
              <i class="fas fa-sync-alt" class:fa-spin={leaderboardLoading}></i>
            </button>
          </div>

          <!-- Leaderboard table -->
          <div class="p2p-config-section p2p-leaderboard-section">
            {#if leaderboard.length === 0}
              <div class="text-sm text-muted p-3">
                {leaderboardLoading ? 'Loading...' : 'No token data yet. Share agents or models and serve requests to populate the leaderboard.'}
              </div>
            {:else}
              <div class="p2p-lb-table">
                <div class="p2p-lb-row p2p-lb-header">
                  <span class="p2p-lb-rank">#</span>
                  <span class="p2p-lb-name">Peer</span>
                  <span class="p2p-lb-tokens">Served</span>
                  <span class="p2p-lb-tokens">Consumed</span>
                  <span class="p2p-lb-status-col">Status</span>
                </div>
                {#each leaderboard as entry, i}
                  <div class="p2p-lb-row" class:p2p-lb-self={entry.isSelf}>
                    <span class="p2p-lb-rank">
                      {#if i === 0}
                        <i class="fas fa-crown text-amber"></i>
                      {:else}
                        {i + 1}
                      {/if}
                    </span>
                    <span class="p2p-lb-name">
                      <span class="text-sm font-medium text-primary">{entry.peerName}</span>
                      {#if entry.isSelf}<span class="badge badge-pill badge-accent text-2xs">you</span>{/if}
                    </span>
                    <span class="p2p-lb-tokens">
                      <span class="text-sm font-medium text-primary">{formatTokenCount(entry.servedTotalTokens)}</span>
                      <span class="text-2xs text-muted">{entry.servedRequests} req</span>
                    </span>
                    <span class="p2p-lb-tokens">
                      <span class="text-sm font-medium text-primary">{formatTokenCount(entry.consumedTotalTokens)}</span>
                      <span class="text-2xs text-muted">{entry.consumedRequests} req</span>
                    </span>
                    <span class="p2p-lb-status-col">
                      <span class="status-dot" class:status-dot-active={entry.online} class:status-dot-error={!entry.online}></span>
                      <span class="text-2xs text-muted">{entry.online ? 'Online' : 'Offline'}</span>
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Own detailed stats -->
          <div class="p2p-config-section">
            <button class="p2p-details-toggle" onclick={() => { showOwnDetails = !showOwnDetails; }}>
              <i class="fas {showOwnDetails ? 'fa-chevron-down' : 'fa-chevron-right'} text-2xs text-muted"></i>
              <span class="text-sm font-semibold text-primary">Your Detailed Stats</span>
            </button>

            {#if showOwnDetails && ownStats}
              <div class="p2p-stats-details">
                <!-- Served breakdown -->
                <div class="p2p-stats-group">
                  <div class="text-xs font-medium text-accent mb-1">
                    <i class="fas fa-arrow-up"></i> Served — {formatTokenCount(ownStats.served.totalInputTokens + ownStats.served.totalOutputTokens)} tokens ({ownStats.served.totalRequests} requests)
                  </div>
                  {#if ownStats.served.byModel.length > 0}
                    <div class="text-2xs text-muted mb-1 mt-2">By Model</div>
                    {#each ownStats.served.byModel as m}
                      <div class="p2p-stats-row">
                        <span class="text-xs text-primary">{m.name}</span>
                        <span class="text-xs text-muted">{formatTokenCount(m.inputTokens + m.outputTokens)} tokens · {m.requestCount} req</span>
                      </div>
                    {/each}
                  {/if}
                  {#if ownStats.served.byAgent.length > 0}
                    <div class="text-2xs text-muted mb-1 mt-2">By Agent</div>
                    {#each ownStats.served.byAgent as a}
                      <div class="p2p-stats-row">
                        <span class="text-xs text-primary">{a.name}</span>
                        <span class="text-xs text-muted">{formatTokenCount(a.inputTokens + a.outputTokens)} tokens · {a.requestCount} req</span>
                      </div>
                    {/each}
                  {/if}
                  {#if ownStats.served.byModel.length === 0 && ownStats.served.byAgent.length === 0}
                    <div class="text-xs text-muted p2p-hint">No served data yet</div>
                  {/if}
                </div>

                <!-- Consumed breakdown -->
                <div class="p2p-stats-group">
                  <div class="text-xs font-medium text-accent mb-1">
                    <i class="fas fa-arrow-down"></i> Consumed — {formatTokenCount(ownStats.consumed.totalInputTokens + ownStats.consumed.totalOutputTokens)} tokens ({ownStats.consumed.totalRequests} requests)
                  </div>
                  {#if ownStats.consumed.byModel.length > 0}
                    <div class="text-2xs text-muted mb-1 mt-2">By Model</div>
                    {#each ownStats.consumed.byModel as m}
                      <div class="p2p-stats-row">
                        <span class="text-xs text-primary">{m.name}</span>
                        <span class="text-xs text-muted">{formatTokenCount(m.inputTokens + m.outputTokens)} tokens · {m.requestCount} req</span>
                      </div>
                    {/each}
                  {/if}
                  {#if ownStats.consumed.byAgent.length > 0}
                    <div class="text-2xs text-muted mb-1 mt-2">By Agent</div>
                    {#each ownStats.consumed.byAgent as a}
                      <div class="p2p-stats-row">
                        <span class="text-xs text-primary">{a.name}</span>
                        <span class="text-xs text-muted">{formatTokenCount(a.inputTokens + a.outputTokens)} tokens · {a.requestCount} req</span>
                      </div>
                    {/each}
                  {/if}
                  {#if ownStats.consumed.byModel.length === 0 && ownStats.consumed.byAgent.length === 0}
                    <div class="text-xs text-muted p2p-hint">No consumed data yet</div>
                  {/if}
                </div>
              </div>
            {:else if showOwnDetails && !ownStats}
              <div class="text-xs text-muted p-3">No stats yet. Start sharing and serving requests.</div>
            {/if}
          </div>
        {/if}
      </div>
      {/if}
    {:else}
      <!-- Chat header -->
      <div class="p2p-chat-header">
        <button class="btn-ghost text-sm" onclick={deselectSelection} aria-label="Back to list">
          <i class="fas fa-arrow-left"></i>
        </button>
        <div class="flex-1 min-w-0">
          {#if selectedAgent}
            <div class="text-sm font-semibold text-primary truncate">{selectedAgent.name}</div>
            <div class="text-2xs text-muted truncate">{selectedAgent.description} · <i class="fas fa-server text-2xs"></i> {selectedAgent.peerName}</div>
          {:else if selectedModel}
            <div class="text-sm font-semibold text-primary truncate">{selectedModel.model}</div>
            <div class="text-2xs text-muted truncate"><i class="fas fa-server text-2xs"></i> {selectedModel.peerName}</div>
          {/if}
        </div>
        {#if bubbles.length > 0 && !isStreaming}
          <button class="btn-ghost text-sm text-muted" onclick={resetChat} title="New conversation">
            <i class="fas fa-rotate-right"></i>
          </button>
        {/if}
      </div>

      <!-- Chat messages -->
      <ChatMessages bind:this={chatMessagesRef}>
        {#if bubbles.length === 0}
          <div class="p2p-welcome">
            {#if selectedAgent}
              <i class="fas fa-comments text-2xl text-accent opacity-50"></i>
              <div class="text-sm text-muted mt-2">Start chatting with {selectedAgent.name}</div>
              {#if selectedAgent.sampleQuestions?.length}
                <div class="p2p-sample-questions">
                  {#each selectedAgent.sampleQuestions as q}
                    <button class="p2p-sample-btn" onclick={() => handleSampleClick(q)}>{q}</button>
                  {/each}
                </div>
              {/if}
            {:else if selectedModel}
              <i class="fas fa-microchip text-2xl text-accent opacity-50"></i>
              <div class="text-sm text-muted mt-2">Start chatting with {selectedModel.name}</div>
            {/if}
          </div>
        {:else}
          {#each bubbles as bubble (bubble.id)}
            {#if bubble.type === 'user'}
              <UserBubble content={bubble.content} />
            {:else}
              <ResponseBubble
                id={bubble.id}
                content={bubble.content}
                tools={bubble.tools}
                thinkingSections={bubble.thinkingSections}
                modelOutputs={bubble.modelOutputs}
                isLoading={bubble.isLoading}
                error={bubble.error}
              >
                {#if bubble.showStatusBar}
                  <StreamStatusBar
                    elapsed={bubble.elapsedDisplay}
                    statusText={bubble.statusText}
                    oncancel={cancelStream}
                  />
                {/if}
                {#if bubble.stats}
                  <StreamStatsBar
                    elapsed={bubble.stats.elapsed}
                    inputTokens={bubble.stats.inputTokens}
                    outputTokens={bubble.stats.outputTokens}
                    tps={bubble.stats.tps}
                    cancelled={bubble.stats.cancelled}
                    visible={bubble.stats.visible}
                  />
                {/if}
              </ResponseBubble>
            {/if}
          {/each}
        {/if}
      </ChatMessages>

      <!-- Chat input -->
      <div class="p2p-input-area">
        <ChatInput
          bind:this={chatInputRef}
          disabled={isStreaming}
          placeholder="Message {selectedAgent?.name ?? selectedModel?.name ?? ''}..."
          onsubmit={handleSubmit}
        />
      </div>
    {/if}
  </div>
</div>

<style>
  .p2p-layout {
    display: flex;
    height: 100%;
    overflow: hidden;
    border: 1px solid var(--border-60);
    border-radius: var(--radius-lg);
    background: var(--bg);
  }

  .p2p-sidebar {
    width: 280px;
    min-width: 280px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    background: var(--sidebar);
  }

  .p2p-filter {
    display: flex;
    align-items: center;
    gap: var(--sp-1h);
    padding: var(--sp-1h) var(--sp-3);
    border-bottom: 1px solid var(--border-subtle);
  }

  .p2p-filter-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-1);
    font-size: 0.75rem;
    padding: var(--sp-0h) 0;
  }

  .p2p-filter-input::placeholder {
    color: var(--text-3);
  }

  .p2p-filter-clear {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-3);
    padding: 2px;
    line-height: 1;
  }

  .p2p-filter-clear:hover {
    color: var(--text-1);
  }

  .p2p-desc {
    overflow-wrap: anywhere;
    word-break: break-word;
    line-height: 1.3;
  }

  .p2p-status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--border);
  }

  .p2p-offline-notice {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-8) var(--sp-4);
  }

  .p2p-section {
    padding: var(--sp-2) 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .p2p-section .section-title {
    padding: var(--sp-1) var(--sp-4);
  }

  .p2p-peer-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--sp-2) var(--sp-4);
  }

  .p2p-agent-card {
    display: flex;
    flex-direction: column;
    gap: var(--sp-0h);
    padding: var(--sp-2) var(--sp-4);
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    transition: background var(--fast);
  }

  .p2p-agent-card:hover {
    background: var(--hover);
  }

  .p2p-agent-card.active {
    background: var(--accent-dim);
    border-left: 2px solid var(--accent);
  }

  .p2p-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .p2p-config-panel {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-4) var(--sp-5);
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .p2p-config-section {
    padding: var(--sp-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }

  .p2p-setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    padding: var(--sp-2h) 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .p2p-setting-row:last-child {
    border-bottom: none;
  }

  .p2p-name-input {
    width: 180px;
    font-size: 0.8rem;
    padding: var(--sp-1) var(--sp-2);
  }

  .p2p-rate-input {
    width: 80px;
    font-size: 0.8rem;
    padding: var(--sp-1) var(--sp-2);
    text-align: center;
  }

  .p2p-sharing-group {
    padding: var(--sp-2) 0;
  }

  .p2p-shared-item {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    padding: var(--sp-1h) var(--sp-2);
    border-radius: var(--radius);
    flex-wrap: wrap;
  }

  .p2p-shared-item:hover {
    background: var(--hover);
  }

  .p2p-hint {
    padding: var(--sp-1) var(--sp-2);
    font-style: italic;
  }

  .p2p-hint code {
    font-size: 0.65rem;
    background: var(--hover);
    padding: 1px 4px;
    border-radius: var(--radius-sm);
  }

  .p2p-help-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-3);
  }

  .p2p-help-item {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    padding: var(--sp-2);
    border-radius: var(--radius);
    background: var(--bg);
  }

  .p2p-help-item code {
    font-size: 0.65rem;
    background: var(--hover);
    padding: 1px 4px;
    border-radius: var(--radius-sm);
  }

  @media (max-width: 640px) {
    .p2p-help-grid {
      grid-template-columns: 1fr;
    }
  }

  .p2p-chat-header {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }

  .p2p-input-area {
    padding: var(--sp-3) var(--sp-4);
    border-top: 1px solid var(--border);
  }

  .p2p-welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: var(--sp-8);
  }

  .p2p-sample-questions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin-top: var(--sp-4);
    justify-content: center;
    max-width: 600px;
  }

  .p2p-sample-btn {
    padding: var(--sp-1h) var(--sp-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface);
    color: var(--text-2);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: all var(--fast);
  }

  .p2p-sample-btn:hover {
    background: var(--hover);
    color: var(--text-1);
    border-color: var(--accent);
  }

  /* --- Tab bar --- */

  .p2p-tab-bar {
    display: flex;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
  }

  .p2p-tab {
    flex: 1;
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--text-xs);
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-3);
    transition: color var(--fast), background var(--fast);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-1h);
  }

  .p2p-tab.active {
    color: var(--text-1);
    background: var(--surface);
    border-bottom: 2px solid var(--accent);
  }

  .p2p-tab:not(.active):hover {
    color: var(--text-2);
    background: var(--hover);
  }

  /* --- Leaderboard --- */

  .p2p-leaderboard-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-1);
  }

  .p2p-leaderboard-section {
    padding: 0;
    overflow: hidden;
  }

  .p2p-lb-table {
    display: flex;
    flex-direction: column;
  }

  .p2p-lb-row {
    display: grid;
    grid-template-columns: 40px 1fr 100px 100px 80px;
    align-items: center;
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--border-subtle);
    gap: var(--sp-2);
  }

  .p2p-lb-row:last-child {
    border-bottom: none;
  }

  .p2p-lb-header {
    background: var(--bg);
    font-size: var(--text-2xs);
    color: var(--text-3);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .p2p-lb-self {
    background: var(--accent-dim);
  }

  .p2p-lb-rank {
    text-align: center;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  .p2p-lb-name {
    display: flex;
    align-items: center;
    gap: var(--sp-1h);
    min-width: 0;
  }

  .p2p-lb-name .text-sm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .p2p-lb-tokens {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
  }

  .p2p-lb-status-col {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }

  /* --- Details toggle --- */

  .p2p-details-toggle {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    background: none;
    border: none;
    cursor: pointer;
    padding: var(--sp-1) 0;
    width: 100%;
    text-align: left;
  }

  .p2p-details-toggle:hover {
    opacity: 0.8;
  }

  .p2p-stats-details {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--border-subtle);
    margin-top: var(--sp-2);
  }

  .p2p-stats-group {
    padding: var(--sp-2);
    border-radius: var(--radius);
    background: var(--bg);
  }

  .p2p-stats-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--radius-sm);
  }

  .p2p-stats-row:hover {
    background: var(--hover);
  }

  @media (max-width: 768px) {
    .p2p-sidebar {
      display: none;
    }

    .p2p-lb-row {
      grid-template-columns: 30px 1fr 80px 80px 60px;
      padding: var(--sp-1h) var(--sp-2);
    }
  }
</style>
