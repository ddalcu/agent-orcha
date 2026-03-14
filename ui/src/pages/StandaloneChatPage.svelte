<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { renderMarkdown, highlightCode } from '../lib/services/markdown.js';
  import { formatElapsedTime, estimateTokens, escapeHtml } from '../lib/utils/format.js';
  import ChatInput from '../components/chat/ChatInput.svelte';
  import AttachmentPreview from '../components/chat/AttachmentPreview.svelte';
  import CanvasPane from '../components/chat/CanvasPane.svelte';

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
  let chatMessagesEl: HTMLElement;
  let chatInputRef: ChatInput;

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

  onMount(() => {
    const parts = window.location.pathname.split('/');
    agentName = parts[parts.length - 1] || '';
    if (!agentName) { loadError = 'Invalid agent URL'; return; }
    sessionId = sessionStorage.getItem(`chat-session-${agentName}`) || ('chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    sessionStorage.setItem(`chat-session-${agentName}`, sessionId);
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
    appendSystemMessage(`Loop started — every ${label}: "${prompt}". /stop to cancel.`);
    sendLoopMessage(prompt);
  }

  function stopLoop() {
    if (loopInterval) { clearInterval(loopInterval); loopInterval = null; appendSystemMessage('Loop stopped.'); }
  }

  function appendSystemMessage(text: string) {
    if (!chatMessagesEl) return;
    const d = document.createElement('div');
    d.className = 'system-message';
    d.innerHTML = `<i class="fas fa-rotate text-xs"></i> <span>${escapeHtml(text)}</span>`;
    chatMessagesEl.appendChild(d);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  async function sendLoopMessage(prompt: string) {
    if (isLoading) return;
    chatMessagesEl?.querySelector('#sampleQuestions')?.remove();
    appendUserMessage(`[loop] ${prompt}`);
    await doStream(prompt, null);
  }

  function handleSubmit(message: string) {
    const hasAtt = pendingAttachments.length > 0;
    if ((!message && !hasAtt) || isLoading) return;
    if (message.toLowerCase() === '/stop') { stopLoop(); return; }
    const loop = parseLoopCommand(message);
    if (loop) { startLoop(loop.ms, loop.prompt, loop.label); return; }
    const att = hasAtt ? [...pendingAttachments] : null;
    chatMessagesEl?.querySelector('#sampleQuestions')?.remove();
    appendUserMessage(message || '(attached files)', att);
    pendingAttachments = [];
    doStream(message, att);
  }

  async function doStream(message: string, attachments: Attachment[] | null) {
    isLoading = true;
    const responseId = 'response-' + Date.now();
    createResponseBubble(responseId);
    currentAbortController = new AbortController();
    streamUsageData = null;
    startStreamTimer(responseId);
    let finalContent = '', wasCancelled = false;
    try {
      finalContent = await streamAgent(message, responseId, attachments);
    } catch (e: unknown) {
      const err = e as Error;
      if (err.name === 'AbortError') wasCancelled = true;
      else updateResponseError(responseId, `Error: ${err.message}`);
    } finally {
      stopStreamTimer(responseId, message, finalContent, wasCancelled);
      currentAbortController = null;
      isLoading = false;
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
    const bubble = chatMessagesEl.querySelector(`#${responseId}`) as HTMLElement;
    const contentDiv = bubble.querySelector('.response-content') as HTMLElement;
    const toolsDiv = bubble.querySelector('.tool-invocations') as HTMLElement;
    const thinkingState = { thinkingContent: '', thinkingPill: null as HTMLElement | null };
    let currentContent = '', buffer = '', hasToolCalls = false;

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
          if (event.error) { updateResponseError(responseId, `Error: ${event.error}`); return currentContent; }
          if (event.type === 'content') currentContent += event.content;
          if (event.type === 'tool_start' || event.type === 'tool_end') hasToolCalls = true;
          if (event.type === 'usage') streamUsageData = { input_tokens: event.input_tokens || 0, output_tokens: event.output_tokens || 0 };
          handleStreamEvent(event, bubble, contentDiv, toolsDiv, currentContent, thinkingState);
        } catch { /* ignore */ }
      }
    }
    finalizeThinkingPill(toolsDiv, thinkingState);
    if (hasToolCalls && !currentContent.trim()) {
      const dots = contentDiv.querySelector('.loading-dots');
      if (dots) { dots.remove(); clearLoading(bubble, contentDiv); }
    }
    return currentContent;
  }

  function clearLoading(bubble: HTMLElement, contentDiv: HTMLElement) {
    bubble.querySelector('.response-bubble-inner')?.classList.remove('loading');
    contentDiv.classList.remove('flex', 'items-center', 'whitespace-pre-wrap');
    contentDiv.innerHTML = '';
  }

  function handleStreamEvent(event: any, bubble: HTMLElement, contentDiv: HTMLElement, toolsDiv: HTMLElement, currentContent: string, ts: any) {
    const loadingDots = contentDiv.querySelector('.loading-dots');
    if (event.type === 'thinking') {
      ts.thinkingContent = (ts.thinkingContent || '') + (event.content || '');
      if (!ts.thinkingPill) {
        const p = document.createElement('div'); p.className = 'tool-pill thinking';
        p.innerHTML = '<i class="fas fa-brain animate-pulse text-2xs"></i><span>Thinking...</span>';
        toolsDiv.appendChild(p); ts.thinkingPill = p;
      }
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    } else if (event.type === 'content') {
      finalizeThinkingPill(toolsDiv, ts);
      if (loadingDots) { loadingDots.remove(); clearLoading(bubble, contentDiv); }
      renderStreaming(contentDiv, currentContent);
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    } else if (event.type === 'tool_start') {
      finalizeThinkingPill(toolsDiv, ts);
      if (loadingDots) { loadingDots.remove(); clearLoading(bubble, contentDiv); }
      const el = document.createElement('div'); el.id = `tool-${event.runId}`; el.className = 'tool-pill';
      el.dataset.toolInput = typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2);
      el.innerHTML = `<i class="fas fa-circle-notch animate-spin text-blue text-2xs"></i><span>${escapeHtml(event.tool)}</span>`;
      toolsDiv.appendChild(el);
    } else if (event.type === 'tool_end') {
      const el = toolsDiv.querySelector(`#tool-${event.runId}`) as HTMLElement | null;
      if (el) {
        const ti = el.dataset.toolInput || '';
        const to = typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2);
        if (event.tool === 'canvas_write' && ti) { try { const p = JSON.parse(ti); openCanvas(p.content, p.title, p.format || 'markdown', p.language); } catch {} }
        else if (event.tool === 'canvas_append' && ti) { try { canvasContent += JSON.parse(ti).content; } catch {} }
        el.className = 'tool-pill done'; el.innerHTML = '';
        const sp = document.createElement('span'); sp.className = 'inline-flex items-center gap-1';
        sp.innerHTML = `<i class="fas fa-check text-green text-2xs"></i><span>${escapeHtml(event.tool)}</span>`;
        el.appendChild(sp);
        const det = document.createElement('div'); det.className = 'tool-invocation-details';
        if (ti) { const s = document.createElement('div'); s.className = 'tool-detail-section'; s.innerHTML = '<h4>Input</h4>'; const pr = document.createElement('pre'); pr.className = 'tool-detail-pre custom-scrollbar'; pr.textContent = ti; s.appendChild(pr); det.appendChild(s); }
        const os = document.createElement('div'); os.className = 'tool-detail-section'; os.innerHTML = '<h4>Output</h4>'; const op = document.createElement('pre'); op.className = 'tool-detail-pre custom-scrollbar'; op.textContent = to; os.appendChild(op); det.appendChild(os);
        el.appendChild(det);
        el.addEventListener('click', (e) => { if (det.contains(e.target as Node)) return; e.stopPropagation(); toolsDiv.querySelectorAll('.tool-invocation-details.visible').forEach(d => { if (d !== det) d.classList.remove('visible'); }); det.classList.toggle('visible'); });
        document.addEventListener('click', (e) => { if (!el.contains(e.target as Node)) det.classList.remove('visible'); }, { capture: true });
      }
    } else if (event.type === 'react_iteration') {
      const st = bubble.closest('.response-wrapper')?.querySelector('.stream-status-text');
      if (st) st.textContent = `Iteration ${event.iteration} · ${(event.contextChars / 1024).toFixed(1)} KB context`;
    } else if (event.type === 'result') {
      if (loadingDots) { loadingDots.remove(); clearLoading(bubble, contentDiv); }
      const pr = document.createElement('pre'); pr.className = 'text-sm text-primary font-mono whitespace-pre-wrap overflow-x-auto panel';
      pr.textContent = JSON.stringify(event.output, null, 2); contentDiv.appendChild(pr);
    } else if (event.type === 'error') {
      if (loadingDots) { loadingDots.remove(); clearLoading(bubble, contentDiv); }
      const d = document.createElement('div'); d.className = 'text-red text-sm'; d.textContent = `Error: ${event.error}`; contentDiv.appendChild(d);
    }
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function renderStreaming(contentDiv: HTMLElement, fullContent: string) {
    const existing = contentDiv.querySelector('.content-text');
    if (existing) { existing.innerHTML = renderMarkdown(fullContent); highlightCode(existing as HTMLElement); }
    else { const d = document.createElement('div'); d.className = 'content-text markdown-content'; d.innerHTML = renderMarkdown(fullContent); highlightCode(d); contentDiv.appendChild(d); }
  }

  function finalizeThinkingPill(toolsDiv: HTMLElement, ts: any) {
    if (!ts.thinkingPill) return;
    const content = ts.thinkingContent || '';
    ts.thinkingPill.className = 'tool-pill done thinking';
    ts.thinkingPill.innerHTML = '';
    const sp = document.createElement('span'); sp.className = 'inline-flex items-center gap-1';
    sp.innerHTML = '<i class="fas fa-brain text-purple text-2xs"></i><span>Thinking</span>';
    ts.thinkingPill.appendChild(sp);
    const det = document.createElement('div'); det.className = 'tool-invocation-details';
    const sec = document.createElement('div'); sec.className = 'tool-detail-section';
    const pre = document.createElement('div'); pre.className = 'tool-detail-pre markdown-content custom-scrollbar';
    pre.innerHTML = renderMarkdown(content); highlightCode(pre);
    sec.appendChild(pre); det.appendChild(sec); ts.thinkingPill.appendChild(det);
    const pill = ts.thinkingPill;
    pill.addEventListener('click', (e: MouseEvent) => { if (det.contains(e.target as Node)) return; e.stopPropagation(); toolsDiv.querySelectorAll('.tool-invocation-details.visible').forEach((d: Element) => { if (d !== det) d.classList.remove('visible'); }); det.classList.toggle('visible'); });
    document.addEventListener('click', (e) => { if (!pill.contains(e.target as Node)) det.classList.remove('visible'); }, { capture: true });
    ts.thinkingPill = null; ts.thinkingContent = '';
  }

  function appendUserMessage(content: string, attachments?: Attachment[] | null) {
    if (!chatMessagesEl) return;
    const d = document.createElement('div'); d.className = 'flex justify-end';
    let ah = '';
    if (attachments?.length) {
      ah = '<div class="flex flex-wrap gap-2 mb-2">' + attachments.map(a =>
        a.mediaType.startsWith('image/') ? `<img src="data:${a.mediaType};base64,${a.data}" class="attachment-thumb">` :
        `<div class="attachment-pill"><i class="fas fa-file"></i><span class="truncate attachment-name">${escapeHtml(a.name)}</span></div>`
      ).join('') + '</div>';
    }
    d.innerHTML = `<div class="user-bubble">${ah}<div class="whitespace-pre-wrap">${escapeHtml(content)}</div></div>`;
    chatMessagesEl.appendChild(d);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function createResponseBubble(id: string) {
    if (!chatMessagesEl) return;
    const w = document.createElement('div'); w.className = 'response-wrapper';
    w.innerHTML = `<div id="${id}" class="flex justify-start"><div class="response-bubble-inner loading group"><div class="response-content whitespace-pre-wrap flex items-center"><div class="loading-dots"><div></div><div></div><div></div></div></div><div class="tool-invocations"></div></div></div>
      <div class="stream-status-bar"><div class="status-dot-pulse"></div><span class="stream-status-text">Generating...</span><span class="stream-elapsed text-muted">0.0s</span><button class="stream-cancel-btn">Stop</button></div>
      <div class="stream-stats-bar"><span class="flex items-center gap-1"><i class="far fa-clock"></i><span class="stats-elapsed"></span></span><span class="divider">|</span><span class="flex items-center gap-1"><i class="fas fa-arrow-up text-2xs"></i><span class="stats-input-tokens"></span></span><span class="divider">|</span><span class="flex items-center gap-1"><i class="fas fa-arrow-down text-2xs"></i><span class="stats-output-tokens"></span></span><span class="divider">|</span><span class="flex items-center gap-1"><i class="fas fa-bolt text-2xs"></i><span class="stats-tps"></span></span></div>`;
    w.querySelector('.stream-cancel-btn')!.addEventListener('click', () => currentAbortController?.abort());
    chatMessagesEl.appendChild(w);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function updateResponseError(id: string, msg: string) {
    const b = chatMessagesEl?.querySelector(`#${id}`);
    if (b) { const c = b.querySelector('.response-content'); if (c) c.innerHTML = `<span class="text-red">${msg}</span>`; }
  }

  function startStreamTimer(responseId: string) {
    streamStartTime = Date.now();
    streamTimerInterval = setInterval(() => {
      const el = chatMessagesEl?.querySelector(`#${responseId}`)?.closest('.response-wrapper')?.querySelector('.stream-elapsed');
      if (el) el.textContent = formatElapsedTime(Date.now() - (streamStartTime || 0));
    }, 100);
  }

  function stopStreamTimer(responseId: string, inputMsg: string, finalContent: string, wasCancelled: boolean) {
    if (streamTimerInterval) { clearInterval(streamTimerInterval); streamTimerInterval = null; }
    const elapsed = streamStartTime ? Date.now() - streamStartTime : 0;
    streamStartTime = null;
    const wrapper = chatMessagesEl?.querySelector(`#${responseId}`)?.closest('.response-wrapper');
    if (!wrapper) return;
    wrapper.querySelector('.stream-status-bar')?.remove();
    const stats = wrapper.querySelector('.stream-stats-bar') as HTMLElement | null;
    if (stats) {
      const u = streamUsageData, hr = u && (u.input_tokens > 0 || u.output_tokens > 0);
      const it = hr ? u!.input_tokens : estimateTokens(inputMsg), ot = hr ? u!.output_tokens : estimateTokens(finalContent);
      const px = hr ? '' : '~', tps = elapsed > 0 ? (ot / (elapsed / 1000)).toFixed(1) : '0';
      stats.querySelector('.stats-elapsed')!.textContent = formatElapsedTime(elapsed);
      stats.querySelector('.stats-input-tokens')!.textContent = `${px}${it} input`;
      stats.querySelector('.stats-output-tokens')!.textContent = `${px}${ot} output`;
      stats.querySelector('.stats-tps')!.textContent = `${px}${tps} tok/s`;
      if (wasCancelled) { const b = document.createElement('span'); b.className = 'badge badge-amber'; b.textContent = 'Cancelled'; stats.appendChild(b); }
      stats.classList.add('visible');
      streamUsageData = null;
    }
  }

  function openCanvas(content: string, title: string, format: string, language?: string) {
    canvasContent = content; canvasTitle = title || 'Canvas';
    canvasFormat = format as 'markdown' | 'html' | 'code'; canvasLanguage = language; canvasOpen = true;
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
      </div>
      <div bind:this={chatMessagesEl} class="standalone-messages custom-scrollbar">
        {#if agentConfig.sampleQuestions?.length}
          <div id="sampleQuestions" class="welcome-container">
            <p class="text-muted text-sm">Try asking</p>
            <div class="sample-questions-wrap">
              {#each agentConfig.sampleQuestions as q}
                <button class="sample-question-chip" onclick={() => handleQuestionClick(q)}>{q}</button>
              {/each}
            </div>
          </div>
        {/if}
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
