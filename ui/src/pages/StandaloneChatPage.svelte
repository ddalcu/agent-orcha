<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { formatElapsedTime, estimateTokens } from '../lib/utils/format.js';
  import ChatInput from '../components/chat/ChatInput.svelte';
  import AttachmentPreview from '../components/chat/AttachmentPreview.svelte';
  import CanvasPane from '../components/chat/CanvasPane.svelte';
  import UserBubble from '../components/chat/UserBubble.svelte';
  import ResponseBubble from '../components/chat/ResponseBubble.svelte';
  import StreamStatusBar from '../components/chat/StreamStatusBar.svelte';
  import StreamStatsBar from '../components/chat/StreamStatsBar.svelte';

  interface AgentConfig {
    name: string;
    description?: string;
    requiresPassword?: boolean;
    inputVariables?: string[];
    sampleQuestions?: string[];
  }

  interface Attachment {
    data: string;
    mediaType: string;
    name: string;
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

  interface ModelOutputEntry {
    task: string;
    input?: string;
    image?: string;
    audio?: string;
    video?: string;
    error?: string;
  }

  interface ChatBubble {
    type: 'user' | 'response' | 'system';
    id: string;
    content: string;
    attachments?: Attachment[] | null;
    tools: ToolEntry[];
    thinkingSections: ThinkingEntry[];
    modelOutputs: ModelOutputEntry[];
    isLoading: boolean;
    error: string;
    stats: StatsData | null;
    showStatusBar: boolean;
    statusText: string;
    elapsedDisplay: string;
    resultContent?: string;
  }

  let agentName = $state('');
  let agentConfig = $state<AgentConfig | null>(null);
  let loadError = $state('');
  let showPasswordOverlay = $state(false);
  let passwordInput = $state('');
  let authError = $state('');
  let sessionId = $state('');
  let isLoading = $state(false);
  let currentAbortController: AbortController | null = null;
  let streamStartTime: number | null = null;
  let streamTimerInterval: ReturnType<typeof setInterval> | null = null;
  let streamUsageData: { input_tokens: number; output_tokens: number } | null = null;
  let pendingAttachments = $state<Attachment[]>([]);
  let chatInputRef = $state<ChatInput>(null!);
  let messagesEl = $state<HTMLElement>(null!);

  // Reactive chat state
  let bubbles = $state<ChatBubble[]>([]);
  let showSampleQuestions = $state(true);

  // Canvas state
  let canvasOpen = $state(false);
  let canvasContent = $state('');
  let canvasTitle = $state('Canvas');
  let canvasFormat = $state<'markdown' | 'html' | 'code'>('markdown');
  let canvasLanguage = $state<string | undefined>(undefined);

  // Loop state
  let loopInterval: ReturnType<typeof setInterval> | null = null;

  function getToken(): string | null {
    return sessionStorage.getItem(`chat-token-${agentName}`);
  }

  function setToken(token: string) {
    sessionStorage.setItem(`chat-token-${agentName}`, token);
  }

  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  onMount(() => {
    const parts = window.location.pathname.split('/');
    agentName = parts[parts.length - 1] || '';
    if (!agentName) { loadError = 'Invalid agent URL'; return; }
    sessionId = sessionStorage.getItem(`chat-session-${agentName}`) || ('chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    sessionStorage.setItem(`chat-session-${agentName}`, sessionId);
    const restored = restoreBubbles();
    if (restored.length > 0) {
      bubbles = restored;
      showSampleQuestions = false;
      requestAnimationFrame(scrollToBottom);
    }
    loadConfig();
  });

  onDestroy(() => {
    if (streamTimerInterval) clearInterval(streamTimerInterval);
    if (loopInterval) clearInterval(loopInterval);
    currentAbortController?.abort();
  });

  async function loadConfig() {
    try {
      const res = await fetch(`/api/chat/${agentName}/config`);
      if (!res.ok) { loadError = 'Agent not found or not published'; return; }
      agentConfig = await res.json();
      document.title = `${agentConfig!.name} — Agent Orcha`;
      if (agentConfig!.requiresPassword && !getToken()) showPasswordOverlay = true;
    } catch {
      loadError = 'Failed to load agent';
    }
  }

  async function authenticate() {
    if (!passwordInput) return;
    authError = '';
    try {
      const res = await fetch(`/api/chat/${agentName}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput }),
      });
      if (!res.ok) { authError = 'Invalid password'; passwordInput = ''; return; }
      const { token } = await res.json();
      setToken(token);
      showPasswordOverlay = false;
    } catch {
      authError = 'Authentication failed';
    }
  }

  function handleFileSelect(files: File[]) {
    const needsConversion = ['image/webp', 'image/bmp', 'image/tiff'];
    for (const file of files) {
      if (needsConversion.includes(file.type)) {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d')!.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          pendingAttachments = [...pendingAttachments, { data: c.toDataURL('image/jpeg', 0.92).split(',')[1]!, mediaType: 'image/jpeg', name: file.name }];
        };
        img.src = url;
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          pendingAttachments = [...pendingAttachments, { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: file.type || 'application/octet-stream', name: file.name }];
        };
        reader.readAsDataURL(file);
      }
    }
  }

  function removeAttachment(index: number) {
    pendingAttachments = pendingAttachments.filter((_, i) => i !== index);
  }

  // --- Loop ---
  function parseLoopCommand(msg: string) {
    const m = msg.match(/^\/loop\s+(\d+)(m|h)\s+(.+)$/is);
    if (!m) return null;
    const n = parseInt(m[1]!, 10), u = m[2]!.toLowerCase(), p = m[3]!.trim();
    if (!n || !p) return null;
    return { ms: u === 'h' ? n * 3600000 : n * 60000, prompt: p, label: `${n}${u}` };
  }

  function startLoop(ms: number, prompt: string, label: string) {
    stopLoop();
    loopInterval = setInterval(() => { if (!isLoading) sendLoopMessage(prompt); }, ms);
    addSystemBubble(`Loop started — every ${label}: "${prompt}". /stop to cancel.`);
    sendLoopMessage(prompt);
  }

  function stopLoop() {
    if (loopInterval) { clearInterval(loopInterval); loopInterval = null; addSystemBubble('Loop stopped.'); }
  }

  function addSystemBubble(text: string) {
    bubbles = [...bubbles, { type: 'system', id: 'sys-' + Date.now(), content: text, tools: [], thinkingSections: [], modelOutputs: [], isLoading: false, error: '', stats: null, showStatusBar: false, statusText: '', elapsedDisplay: '' }];
    requestAnimationFrame(scrollToBottom);
  }

  async function sendLoopMessage(prompt: string) {
    if (isLoading) return;
    showSampleQuestions = false;
    addUserBubble(`[loop] ${prompt}`, null);
    await doStream(prompt, null);
  }

  function handleSubmit(message: string) {
    const hasAtt = pendingAttachments.length > 0;
    if ((!message && !hasAtt) || isLoading) return;
    if (message.toLowerCase() === '/stop') { stopLoop(); return; }
    const loop = parseLoopCommand(message);
    if (loop) { startLoop(loop.ms, loop.prompt, loop.label); return; }
    const att = hasAtt ? [...pendingAttachments] : null;
    showSampleQuestions = false;
    addUserBubble(message || '(attached files)', att);
    pendingAttachments = [];
    saveBubblesState();
    doStream(message, att);
  }

  function addUserBubble(content: string, attachments: Attachment[] | null) {
    bubbles = [...bubbles, { type: 'user', id: 'user-' + Date.now(), content, attachments, tools: [], thinkingSections: [], modelOutputs: [], isLoading: false, error: '', stats: null, showStatusBar: false, statusText: '', elapsedDisplay: '' }];
    requestAnimationFrame(scrollToBottom);
  }

  function findBubble(id: string): ChatBubble | undefined {
    return bubbles.find(b => b.id === id);
  }

  async function doStream(message: string, attachments: Attachment[] | null) {
    isLoading = true;
    const responseId = 'response-' + Date.now();
    bubbles = [...bubbles, { type: 'response', id: responseId, content: '', tools: [], thinkingSections: [], modelOutputs: [], isLoading: true, error: '', stats: null, showStatusBar: true, statusText: 'Generating...', elapsedDisplay: '0.0s' }];
    currentAbortController = new AbortController();
    streamUsageData = null;

    streamStartTime = Date.now();
    streamTimerInterval = setInterval(() => {
      const b = findBubble(responseId);
      if (b) b.elapsedDisplay = formatElapsedTime(Date.now() - (streamStartTime || 0));
    }, 100);

    let finalContent = '', wasCancelled = false;
    try {
      finalContent = await streamAgent(message, responseId, attachments);
    } catch (e: unknown) {
      const err = e as Error;
      if (err.name === 'AbortError') wasCancelled = true;
      else {
        const b = findBubble(responseId);
        if (b) { b.error = err.message; b.isLoading = false; }
      }
    } finally {
      if (streamTimerInterval) { clearInterval(streamTimerInterval); streamTimerInterval = null; }
      const elapsed = streamStartTime ? Date.now() - streamStartTime : 0;
      streamStartTime = null;
      const b = findBubble(responseId);
      if (b) {
        b.isLoading = false;
        b.showStatusBar = false;
        const usage = streamUsageData as { input_tokens: number; output_tokens: number } | null;
        const hasReal = usage !== null && (usage.input_tokens > 0 || usage.output_tokens > 0);
        const it = hasReal ? usage!.input_tokens : estimateTokens(message);
        const ot = hasReal ? usage!.output_tokens : estimateTokens(finalContent);
        const px = hasReal ? '' : '~', tps = elapsed > 0 ? (ot / (elapsed / 1000)).toFixed(1) : '0';
        b.stats = { elapsed: formatElapsedTime(elapsed), inputTokens: `${px}${it} input`, outputTokens: `${px}${ot} output`, tps: `${px}${tps} tok/s`, cancelled: wasCancelled, visible: true };
      }
      streamUsageData = null;
      currentAbortController = null;
      isLoading = false;
      saveBubblesState();
      chatInputRef?.focus();
    }
  }

  async function streamAgent(message: string, responseId: string, attachments: Attachment[] | null): Promise<string> {
    const inputVars = agentConfig?.inputVariables || ['message'];
    const inputObj: Record<string, unknown> = { [inputVars[0] || 'message']: message };
    if (attachments) inputObj.attachments = attachments;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['X-Chat-Token'] = token;

    const res = await fetch(`/api/chat/${agentName}/stream`, {
      method: 'POST', headers,
      body: JSON.stringify({ input: inputObj, sessionId }),
      signal: currentAbortController?.signal,
    });
    if (!res.ok) { const err = await res.json().catch(() => ({ error: 'Request failed' })); throw new Error(err.error || `HTTP ${res.status}`); }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let currentContent = '', buffer = '';

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
          const event = JSON.parse(data);
          if (event.error) {
            const b = findBubble(responseId);
            if (b) { b.error = event.error; b.isLoading = false; }
            return currentContent;
          }
          if (event.type === 'content') currentContent += event.content;
          if (event.type === 'usage') streamUsageData = { input_tokens: event.input_tokens || 0, output_tokens: event.output_tokens || 0 };
          handleStreamEvent(event, responseId, currentContent);
        } catch { /* ignore */ }
      }
    }
    // Finalize last thinking section
    const b = findBubble(responseId);
    if (b) {
      const lastThinking = b.thinkingSections[b.thinkingSections.length - 1];
      if (lastThinking && !lastThinking.done) lastThinking.done = true;
    }
    return currentContent;
  }

  function handleStreamEvent(event: { type: string; content?: string; tool?: string; runId?: string; input?: unknown; output?: unknown; iteration?: number; contextChars?: number; error?: string }, responseId: string, currentContent: string) {
    const b = findBubble(responseId);
    if (!b) return;

    if (event.type === 'thinking') {
      const last = b.thinkingSections[b.thinkingSections.length - 1];
      if (last && !last.done) {
        last.content += event.content || '';
      } else {
        b.thinkingSections = [...b.thinkingSections, { content: event.content || '', done: false }];
      }
    } else if (event.type === 'content') {
      // Finalize any open thinking section
      const last = b.thinkingSections[b.thinkingSections.length - 1];
      if (last && !last.done) last.done = true;
      b.content = currentContent;
      b.isLoading = false;
    } else if (event.type === 'tool_start') {
      const last = b.thinkingSections[b.thinkingSections.length - 1];
      if (last && !last.done) last.done = true;
      const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2);
      b.tools = [...b.tools, { runId: event.runId!, tool: event.tool!, input, done: false }];
      b.isLoading = false;
    } else if (event.type === 'tool_end') {
      const tool = b.tools.find(t => t.runId === event.runId);
      if (tool) {
        tool.output = typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2);
        tool.done = true;
        // Handle canvas tools
        if (event.tool === 'canvas_write' && tool.input) {
          try { const p = JSON.parse(tool.input); openCanvas(p.content, p.title, p.format || 'markdown', p.language); } catch {}
        } else if (event.tool === 'canvas_append' && tool.input) {
          try { canvasContent += JSON.parse(tool.input).content; } catch {}
        }
      }
      // Intercept model tools
      if ((event.tool === 'generate_image' || event.tool === 'generate_tts' || event.tool === 'generate_video') && typeof event.output === 'string') {
        try {
          const parsed = JSON.parse(event.output);
          if (parsed.__modelTask) {
            b.modelOutputs = [...b.modelOutputs, {
              task: parsed.task,
              input: parsed.input,
              image: parsed.image,
              audio: parsed.audio,
              video: parsed.video,
              error: parsed.error,
            }];
          }
        } catch (err) { console.error('[StandaloneChatPage] Failed to parse model output:', err); }
      }
    } else if (event.type === 'react_iteration') {
      b.statusText = `Iteration ${event.iteration} · ${((event.contextChars || 0) / 1024).toFixed(1)} KB context`;
    } else if (event.type === 'result') {
      b.isLoading = false;
      b.resultContent = JSON.stringify(event.output, null, 2);
    } else if (event.type === 'error') {
      b.isLoading = false;
      b.error = event.error || 'Unknown error';
    }
    requestAnimationFrame(scrollToBottom);
  }

  function openCanvas(content: string, title: string, format: string, language?: string) {
    canvasContent = content; canvasTitle = title || 'Canvas';
    canvasFormat = format as 'markdown' | 'html' | 'code'; canvasLanguage = language; canvasOpen = true;
  }

  function saveBubblesState() {
    try {
      const stripped = bubbles.map(b => ({
        ...b,
        attachments: b.attachments?.map(a => ({ name: a.name, mediaType: a.mediaType, data: '' })) ?? null,
      }));
      sessionStorage.setItem(`chat-bubbles-${agentName}`, JSON.stringify(stripped));
    } catch { /* storage full or unavailable */ }
  }

  function restoreBubbles(): ChatBubble[] {
    try {
      const raw = sessionStorage.getItem(`chat-bubbles-${agentName}`);
      if (!raw) return [];
      return (JSON.parse(raw) as ChatBubble[]).map(b => ({ ...b, isLoading: false, showStatusBar: false }));
    } catch { return []; }
  }

  function clearChat() {
    if (isLoading) return;
    currentAbortController?.abort();
    if (loopInterval) { clearInterval(loopInterval); loopInterval = null; }
    sessionId = 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem(`chat-session-${agentName}`, sessionId);
    bubbles = [];
    sessionStorage.removeItem(`chat-bubbles-${agentName}`);
    showSampleQuestions = true;
    canvasOpen = false;
    canvasContent = '';
    chatInputRef?.focus();
  }

  function handleQuestionClick(q: string) { chatInputRef?.setValue(q); chatInputRef?.focus(); }
</script>

{#if loadError}
  <div class="auth-overlay"><span class="text-secondary">{loadError}</span></div>
{:else if showPasswordOverlay && agentConfig}
  <div class="auth-overlay">
    <div class="auth-card">
      <div class="text-center mb-6">
        <i class="fas fa-lock text-2xl text-muted mb-3"></i>
        <h2 class="text-lg font-semibold text-primary">{agentConfig.name}</h2>
        <p class="text-sm text-secondary mt-1">This agent requires a password</p>
      </div>
      {#if authError}<div class="text-sm text-red text-center mb-3">{authError}</div>{/if}
      <input type="password" class="input w-full" placeholder="Enter password" bind:value={passwordInput}
        onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && authenticate()} />
      <button class="btn btn-accent w-full mt-4" onclick={authenticate}>Continue</button>
    </div>
  </div>
{:else if agentConfig}
  <div class="standalone-container" class:canvas-open={canvasOpen}>
    <div class="standalone-shell">
      <div class="standalone-header">
        <i class="fas fa-robot text-accent"></i>
        <div class="min-w-0">
          <h1 class="text-sm font-semibold text-primary">{agentConfig.name}</h1>
          {#if agentConfig.description}<p class="text-xs text-muted truncate">{agentConfig.description}</p>{/if}
        </div>
        <button class="clear-chat-btn" title="New conversation" disabled={isLoading} onclick={clearChat}>
          <i class="fas fa-plus"></i> New session
        </button>
      </div>
      <div bind:this={messagesEl} class="standalone-messages custom-scrollbar">
        {#if showSampleQuestions && agentConfig.sampleQuestions?.length && bubbles.length === 0}
          <div class="welcome-container">
            <p class="text-muted text-sm">Try asking</p>
            <div class="sample-questions-wrap">
              {#each agentConfig.sampleQuestions as q}
                <button class="sample-question-chip" onclick={() => handleQuestionClick(q)}>{q}</button>
              {/each}
            </div>
          </div>
        {/if}
        {#each bubbles as bubble (bubble.id)}
          {#if bubble.type === 'user'}
            <UserBubble content={bubble.content} attachments={bubble.attachments} />
          {:else if bubble.type === 'system'}
            <div class="system-message">
              <i class="fas fa-rotate text-xs"></i>
              <span>{bubble.content}</span>
            </div>
          {:else if bubble.type === 'response'}
            <div class="response-wrapper">
              <ResponseBubble
                id={bubble.id}
                content={bubble.content}
                tools={bubble.tools}
                thinkingSections={bubble.thinkingSections}
                modelOutputs={bubble.modelOutputs}
                isLoading={bubble.isLoading}
                error={bubble.error}
              >
                {#if bubble.resultContent}
                  <div class="panel">
                    <pre class="text-sm text-primary font-mono whitespace-pre-wrap overflow-x-auto">{bubble.resultContent}</pre>
                  </div>
                {/if}
              </ResponseBubble>
              {#if bubble.showStatusBar}
                <StreamStatusBar
                  elapsed={bubble.elapsedDisplay}
                  statusText={bubble.statusText}
                  oncancel={() => currentAbortController?.abort()}
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
            </div>
          {/if}
        {/each}
      </div>
      <div class="chat-input-area">
        {#if pendingAttachments.length > 0}
          <AttachmentPreview attachments={pendingAttachments} onremove={removeAttachment} />
        {/if}
        <ChatInput bind:this={chatInputRef} disabled={isLoading} placeholder="Type a message..." onsubmit={handleSubmit} onfileselect={handleFileSelect} />
      </div>
    </div>
    {#if canvasOpen}
      <CanvasPane content={canvasContent} title={canvasTitle} format={canvasFormat} language={canvasLanguage} onclose={() => { canvasOpen = false; }} />
    {/if}
  </div>
{/if}
