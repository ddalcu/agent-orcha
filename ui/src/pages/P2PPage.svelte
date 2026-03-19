<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { api } from '../lib/services/api.js';
  import { formatElapsedTime, estimateTokens } from '../lib/utils/format.js';
  import type { P2PStatus, P2PPeer, P2PRemoteAgent, P2PRemoteLLM, StreamEvent } from '../lib/types/index.js';

  import ChatInput from '../components/chat/ChatInput.svelte';
  import ChatMessages from '../components/chat/ChatMessages.svelte';
  import UserBubble from '../components/chat/UserBubble.svelte';
  import ResponseBubble from '../components/chat/ResponseBubble.svelte';
  import StreamStatusBar from '../components/chat/StreamStatusBar.svelte';
  import StreamStatsBar from '../components/chat/StreamStatsBar.svelte';

  // --- Types ---

  interface ChatBubble {
    type: 'user' | 'response';
    id: string;
    content: string;
    tools: ToolEntry[];
    thinkingSections: ThinkingEntry[];
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

  function selectionKey(agent: P2PRemoteAgent | null, llm: P2PRemoteLLM | null): string | null {
    if (agent) return `agent:${agent.peerId}:${agent.name}`;
    if (llm) return `llm:${llm.peerId}:${llm.name}`;
    return null;
  }

  function saveCurrentSession() {
    const key = selectionKey(selectedAgent, selectedLLM);
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

  let status = $state<P2PStatus>({ enabled: false, connected: false, peerCount: 0, peerName: '' });
  let peers = $state<P2PPeer[]>([]);
  let remoteAgents = $state<P2PRemoteAgent[]>([]);
  let remoteLLMs = $state<P2PRemoteLLM[]>([]);
  let selectedAgent = $state<P2PRemoteAgent | null>(null);
  let selectedLLM = $state<P2PRemoteLLM | null>(null);
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

  onMount(() => {
    loadStatus();
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
              selectedLLM = null;
              restoreSession(lastSelectionKey!);
            }
          } else if (type === 'llm') {
            const llm = remoteLLMs.find(l => l.peerId === peerId && l.name === name);
            if (llm) {
              selectedLLM = llm;
              selectedAgent = null;
              restoreSession(lastSelectionKey!);
            }
          }
        };
        // Try immediately and also after first poll
        restore();
        const unsubTimer = setInterval(() => {
          if (remoteAgents.length > 0 || remoteLLMs.length > 0) {
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
      remoteLLMs = l;
    } catch { /* ignore */ }
  }

  function selectAgent(agent: P2PRemoteAgent) {
    saveCurrentSession();
    selectedLLM = null;
    selectedAgent = agent;
    const key = selectionKey(agent, null)!;
    lastSelectionKey = key;
    if (!restoreSession(key)) {
      bubbles = [];
      sessionId = `p2p-${agent.peerId.slice(0, 8)}-${Date.now()}`;
    }
  }

  function selectLLM(llm: P2PRemoteLLM) {
    saveCurrentSession();
    selectedAgent = null;
    selectedLLM = llm;
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
    selectedLLM = null;
    bubbles = [];
  }

  function resetChat() {
    currentAbortController?.abort();
    const key = selectionKey(selectedAgent, selectedLLM);
    if (key) chatSessions.delete(key);
    bubbles = [];
    if (selectedAgent) {
      sessionId = `p2p-${selectedAgent.peerId.slice(0, 8)}-${Date.now()}`;
    } else if (selectedLLM) {
      sessionId = `p2p-llm-${selectedLLM.peerId.slice(0, 8)}-${Date.now()}`;
    }
  }

  // --- Chat ---

  function handleSubmit(message: string) {
    if (!message.trim() || (!selectedAgent && !selectedLLM) || isStreaming) return;
    sendMessage(message.trim());
  }

  function handleSampleClick(question: string) {
    if (isStreaming) return;
    sendMessage(question);
  }

  async function sendMessage(message: string) {
    if (!selectedAgent && !selectedLLM) return;

    const userBubble: ChatBubble = {
      type: 'user',
      id: `user-${Date.now()}`,
      content: message,
      tools: [],
      thinkingSections: [],
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
          selectedLLM!.peerId,
          selectedLLM!.name,
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
      updateBubble(responseId, b => {
        const tool = b.tools.find(t => t.runId === event.runId);
        if (tool) {
          tool.output = typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? '');
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
      <!-- Peers section -->
      <div class="p2p-section">
        <div class="section-title">Peers ({peers.length})</div>
        {#if peers.length === 0}
          <div class="text-xs text-muted p-3">No peers discovered yet</div>
        {:else}
          {#each peers as peer}
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
        <div class="section-title">Remote Agents ({remoteAgents.length})</div>
        {#if remoteAgents.length === 0}
          <div class="text-xs text-muted p-3">No shared agents available</div>
        {:else}
          {#each remoteAgents as agent}
            <button
              class="p2p-agent-card"
              class:active={selectedAgent?.name === agent.name && selectedAgent?.peerId === agent.peerId}
              onclick={() => selectAgent(agent)}
            >
              <div class="flex items-center gap-2">
                <i class="fas fa-robot text-xs text-accent"></i>
                <span class="text-sm font-medium text-primary">{agent.name}</span>
              </div>
              <span class="text-2xs text-muted truncate">{agent.description}</span>
              <span class="text-2xs text-muted"><i class="fas fa-server text-2xs"></i> {agent.peerName}</span>
            </button>
          {/each}
        {/if}
      </div>

      <!-- Remote LLMs section -->
      <div class="p2p-section">
        <div class="section-title">Remote LLMs ({remoteLLMs.length})</div>
        {#if remoteLLMs.length === 0}
          <div class="text-xs text-muted p-3">No shared LLMs available</div>
        {:else}
          {#each remoteLLMs as llm}
            <button
              class="p2p-agent-card"
              class:active={selectedLLM?.name === llm.name && selectedLLM?.peerId === llm.peerId}
              onclick={() => selectLLM(llm)}
            >
              <div class="flex items-center gap-2">
                <i class="fas fa-microchip text-xs text-accent"></i>
                <span class="text-sm font-medium text-primary">{llm.name}</span>
              </div>
              <span class="text-2xs text-muted truncate">{llm.model}</span>
              <div class="flex items-center gap-2">
                <span class="badge badge-gray text-2xs">{llm.provider}</span>
                <span class="text-2xs text-muted"><i class="fas fa-server text-2xs"></i> {llm.peerName}</span>
              </div>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  <!-- Main chat area -->
  <div class="p2p-main">
    {#if !selectedAgent && !selectedLLM}
      <div class="p2p-empty-state">
        <i class="fas fa-share-nodes text-4xl text-accent opacity-50"></i>
        <div class="text-lg font-semibold text-primary mt-4">P2P Agent Network</div>
        <div class="text-sm text-muted mt-2">
          {#if !status.connected}
            Connecting to the P2P swarm...
          {:else if remoteAgents.length === 0 && remoteLLMs.length === 0}
            No remote agents or LLMs discovered yet. Other peers will appear when they share resources with <code class="text-xs bg-surface px-1 rounded">p2p: true</code>.
          {:else}
            Select a remote agent or LLM from the sidebar to start chatting.
          {/if}
        </div>
      </div>
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
          {:else if selectedLLM}
            <div class="text-sm font-semibold text-primary truncate">{selectedLLM.name}</div>
            <div class="text-2xs text-muted truncate">{selectedLLM.model} · <span class="badge badge-gray text-2xs">{selectedLLM.provider}</span> · <i class="fas fa-server text-2xs"></i> {selectedLLM.peerName}</div>
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
            {:else if selectedLLM}
              <i class="fas fa-microchip text-2xl text-accent opacity-50"></i>
              <div class="text-sm text-muted mt-2">Start chatting with {selectedLLM.name}</div>
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
          placeholder="Message {selectedAgent?.name ?? selectedLLM?.name ?? ''}..."
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

  .p2p-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: var(--sp-8);
    text-align: center;
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

  @media (max-width: 768px) {
    .p2p-sidebar {
      display: none;
    }
  }
</style>
