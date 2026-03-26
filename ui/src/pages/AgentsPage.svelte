<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { api } from '../lib/services/api.js';
  import { sessionStore } from '../lib/stores/session.svelte.js';
  import { streamManager, type StreamState } from '../lib/stores/stream.svelte.js';
  import { appStore } from '../lib/stores/app.svelte.js';

  import { formatElapsedTime, estimateTokens, escapeHtml } from '../lib/utils/format.js';
  import type { Agent, Workflow, LLM, Session, StreamEvent, MessageMeta } from '../lib/types/index.js';

  import ChatInput from '../components/chat/ChatInput.svelte';
  import ChatMessages from '../components/chat/ChatMessages.svelte';
  import UserBubble from '../components/chat/UserBubble.svelte';
  import ResponseBubble from '../components/chat/ResponseBubble.svelte';
  import StreamStatusBar from '../components/chat/StreamStatusBar.svelte';
  import StreamStatsBar from '../components/chat/StreamStatsBar.svelte';
  import AttachmentPreview from '../components/chat/AttachmentPreview.svelte';
  import WelcomeState from '../components/chat/WelcomeState.svelte';
  import CanvasPane from '../components/chat/CanvasPane.svelte';

  // --- Types ---

  interface Attachment {
    data: string;
    mediaType: string;
    name: string;
  }

  interface ModelOutputEntry {
    task: string;
    input?: string;
    image?: string;
    audio?: string;
    error?: string;
  }

  interface ChatBubble {
    type: 'user' | 'response' | 'system' | 'session-reset';
    id: string;
    content: string;
    attachments?: Attachment[] | null;
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
    resultContent?: string;
    warningContent?: string;
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

  interface WorkflowState {
    responseId: string;
    startTime: number;
    chatOutputFormat: string;
    workflowName: string;
    abortController: AbortController | null;
    interruptState: { question: string; threadId: string; workflowName: string } | null;
    status: 'streaming' | 'interrupted' | 'done';
    events: StreamEvent[];
    inputMessage: string;
    taskId: string | null;
    threadId: string | null;
  }

  interface CanvasState {
    content: string;
    title: string;
    format: 'markdown' | 'html' | 'code';
    language: string;
    mode?: string;
  }

  // --- State ---

  let isLoading = $state(false);
  let currentAbortController = $state<AbortController | null>(null);
  let streamStartTime = $state<number | null>(null);
  let streamTimerInterval = $state<ReturnType<typeof setInterval> | null>(null);
  let streamUsageData = $state<{ input_tokens: number; output_tokens: number; total_tokens: number } | null>(null);
  let pendingAttachments = $state<Attachment[]>([]);
  let streamUnsubscribe: (() => void) | null = null;
  let sidebarOpen = $state(false);
  let chatInputRef = $state<ChatInput | null>(null);
  let chatMessagesRef = $state<ChatMessages | null>(null);

  // Chat bubbles — reactive array for rendering
  let bubbles = $state<ChatBubble[]>([]);

  // Canvas state
  let canvasOpen = $state(false);
  let canvasState = $state<CanvasState | null>(null);

  // Workflow tasks — survives component remount
  const workflowTasks = new Map<string, WorkflowState>();

  // Loop state
  let loopInterval: ReturnType<typeof setInterval> | null = null;
  let loopPrompt: string | null = null;
  let loopLabel: string | null = null;

  // Sessions for sidebar
  let sessions = $state<Session[]>([]);
  let activeSessionId = $state<string | null>(null);

  // Current session header info
  let headerSession = $state<Session | null>(null);

  function refreshSessionList() {
    sessions = sessionStore.getAll();
    activeSessionId = sessionStore.getActiveId();
  }

  // --- Init ---

  onMount(async () => {
    await Promise.all([loadAgents(), loadLLMs(), loadWorkflows()]);
    restoreActiveSession();
  });

  onDestroy(() => {
    if (streamUnsubscribe) {
      streamUnsubscribe();
      streamUnsubscribe = null;
    }
    if (streamTimerInterval) {
      clearInterval(streamTimerInterval);
      streamTimerInterval = null;
    }
    if (loopInterval) {
      clearInterval(loopInterval);
      loopInterval = null;
    }
    currentAbortController = null;
  });

  // --- Data loading ---

  async function loadAgents() {
    try {
      const agents: Agent[] = await api.getAgents();
      agents.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      appStore.agents = agents;
    } catch (e) {
      console.error('Failed to load agents', e);
    }
  }

  async function loadLLMs() {
    try {
      const [llms, llmConfig] = await Promise.all([api.getLLMs(), api.getLlmConfig()]);
      const defaultPointer = llmConfig?.models?.default;
      appStore.defaultLlmName = typeof defaultPointer === 'string' ? defaultPointer : null;
      appStore.llms = llms;
    } catch (e) {
      console.error('Failed to load LLMs', e);
    }
  }

  async function loadWorkflows() {
    try {
      const workflows: Workflow[] = await api.getWorkflows();
      workflows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      appStore.workflows = workflows;
    } catch (e) {
      console.error('Failed to load workflows', e);
    }
  }

  // --- Sidebar ---

  function isMobile(): boolean {
    return !window.matchMedia('(min-width: 768px)').matches;
  }

  function toggleSidebar(show?: boolean) {
    sidebarOpen = show ?? !sidebarOpen;
  }

  // --- Session management ---

  function restoreActiveSession() {
    const id = sessionStore.getActiveId();
    if (id && sessionStore.get(id)) {
      switchToSession(id);
    } else {
      showEmptyState();
    }
    refreshSessionList();
  }

  function switchToSession(sessionId: string) {
    // Stop any active loop
    if (loopInterval) {
      clearInterval(loopInterval);
      loopInterval = null;
      loopPrompt = null;
      loopLabel = null;
    }

    if (streamUnsubscribe) {
      streamUnsubscribe();
      streamUnsubscribe = null;
    }
    if (streamTimerInterval) {
      clearInterval(streamTimerInterval);
      streamTimerInterval = null;
    }
    streamStartTime = null;
    currentAbortController = null;
    isLoading = false;

    const session = sessionStore.get(sessionId);
    if (!session) return;

    sessionStore.setActiveId(sessionId);

    // Update appStore selections
    if (session.agentType === 'workflow') {
      const wf = appStore.workflows.find(w => w.name === session.workflowName);
      appStore.selectedWorkflow = wf || null;
      appStore.selectedAgent = null;
      appStore.selectedLlm = null;
      appStore.selectionType = 'workflow';
    } else if (session.agentType === 'agent') {
      const agent = appStore.agents.find(a => a.name === session.agentName);
      appStore.selectedAgent = agent || null;
      appStore.selectedLlm = null;
      appStore.selectedWorkflow = null;
      appStore.selectionType = 'agent';
    } else {
      const llm = appStore.llms.find(l => l.name === session.llmName);
      appStore.selectedLlm = llm || null;
      appStore.selectedAgent = null;
      appStore.selectedWorkflow = null;
      appStore.selectionType = 'llm';
    }

    restoreMessages(session);
    headerSession = session;
    refreshSessionList();

    // Reconnect to active stream if exists
    const wfState = workflowTasks.get(sessionId);
    if (wfState && wfState.status !== 'done') {
      reconnectWorkflowStream(sessionId);
    } else if (streamManager.isActive(sessionId)) {
      reconnectToStream(sessionId);
    }

    if (isMobile()) toggleSidebar(false);

    tick().then(() => {
      chatInputRef?.focus();
    });
  }

  async function restoreMessages(session: Session) {
    closeCanvas();
    bubbles = [];

    if (session.messages.length === 0) {
      // Welcome state is handled in the template via derived state
      await tick();
      scrollToBottom();
      return;
    }

    const restored: ChatBubble[] = [];
    for (const msg of session.messages) {
      if (msg.role === 'user') {
        restored.push(createUserBubble(msg.content));
      } else if (msg.role === 'system') {
        restored.push(createSystemBubble(msg.content));
      } else {
        restored.push(createRestoredResponseBubble(msg.content, msg.meta));
      }
    }
    bubbles = restored;

    // Restore canvas state from tool call history
    restoreCanvasFromHistory(session.messages);

    await tick();
    scrollToBottom();

    // Check if server still has session
    try {
      const exists = await api.checkSession(session.id);
      if (!exists) {
        bubbles = [...bubbles, createSessionResetBubble()];
        await tick();
        scrollToBottom();
      }
    } catch {
      // Server unreachable — skip banner
    }
  }

  function showEmptyState() {
    bubbles = [];
    headerSession = null;
  }

  function showNewSessionModal() {
    newSessionModalOpen = true;
  }

  function showNewAgentModal() {
    newAgentModalOpen = true;
  }

  function deleteSession(sessionId: string) {
    sessionStore.delete(sessionId);
    const id = sessionStore.getActiveId();
    if (!id || id === sessionId) {
      const all = sessionStore.getAll();
      if (all.length > 0) {
        switchToSession(all[0].id);
      } else {
        showEmptyState();
        refreshSessionList();
      }
    } else {
      refreshSessionList();
    }
  }

  // --- Modals ---

  let newSessionModalOpen = $state(false);
  let newAgentModalOpen = $state(false);

  // Input context menu
  let inputMenuOpen = $state(false);

  // Prebuilt voices
  interface VoiceEntry { filename: string; name: string; size: number }
  let availableVoices = $state<VoiceEntry[]>([]);
  let voiceLoading = $state<string | null>(null);

  // Loop dialog
  let loopDialogOpen = $state(false);
  let loopDialogAmount = $state(5);
  let loopDialogUnit = $state<'m' | 'h'>('m');
  let loopDialogPrompt = $state('');

  function createSession(type: string, name: string) {
    const session = sessionStore.create({
      agentName: type === 'agent' ? name : null,
      agentType: type,
      llmName: type === 'llm' ? name : null,
      workflowName: type === 'workflow' ? name : null,
    });
    newSessionModalOpen = false;
    switchToSession(session.id);
  }

  function createAgentViaArchitect() {
    newAgentModalOpen = false;
    const session = sessionStore.create({
      agentName: 'architect',
      agentType: 'agent',
    });
    switchToSession(session.id);
  }

  function createAgentViaIde() {
    newAgentModalOpen = false;
    appStore.setTab('ide');
  }

  // --- Bubble helpers ---

  let bubbleIdCounter = 0;
  function nextBubbleId(prefix: string): string {
    return `${prefix}-${Date.now()}-${++bubbleIdCounter}`;
  }

  function createUserBubble(content: string, attachments?: Attachment[] | null): ChatBubble {
    return {
      type: 'user',
      id: nextBubbleId('user'),
      content,
      attachments,
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
  }

  function createResponseBubble(responseId?: string): ChatBubble {
    return {
      type: 'response',
      id: responseId || nextBubbleId('response'),
      content: '',
      tools: [],
      thinkingSections: [],
      modelOutputs: [],
      isLoading: true,
      error: '',
      stats: null,
      cancelled: false,
      showStatusBar: true,
      statusText: 'Generating...',
      elapsedDisplay: '0.0s',
    };
  }

  function createRestoredResponseBubble(content: string, meta?: MessageMeta): ChatBubble {
    const bubble: ChatBubble = {
      type: 'response',
      id: nextBubbleId('restored'),
      content,
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

    if (meta) {
      if (meta.thinking) {
        bubble.thinkingSections = meta.thinking.map(t => ({ content: t, done: true }));
      }
      if (meta.tools) {
        bubble.tools = meta.tools
          .filter(t => t.output !== undefined)
          .map(t => ({
            runId: t.runId,
            tool: t.tool,
            input: typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2),
            output: typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2),
            done: true,
          }));
      }
      if (meta.stats) {
        const s = meta.stats;
        const prefix = s.estimated ? '~' : '';
        const tps = s.elapsed > 0 ? (s.outputTokens / (s.elapsed / 1000)).toFixed(1) : '0';
        bubble.stats = {
          elapsed: formatElapsedTime(s.elapsed),
          inputTokens: `${prefix}${s.inputTokens} input`,
          outputTokens: `${prefix}${s.outputTokens} output`,
          tps: `${prefix}${tps} tok/s`,
          cancelled: s.cancelled,
          visible: true,
        };
      }
    }

    return bubble;
  }

  function createSystemBubble(text: string): ChatBubble {
    return {
      type: 'system',
      id: nextBubbleId('system'),
      content: text,
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
  }

  function createSessionResetBubble(): ChatBubble {
    return {
      type: 'session-reset',
      id: nextBubbleId('reset'),
      content: '',
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
  }

  // Find and update a bubble by id
  function updateBubble(id: string, updater: (b: ChatBubble) => void) {
    const idx = bubbles.findIndex(b => b.id === id);
    if (idx === -1) return;
    updater(bubbles[idx]);
    bubbles = [...bubbles]; // trigger reactivity
  }

  function scrollToBottom() {
    chatMessagesRef?.scrollToBottom();
  }

  // --- File attachments ---

  function handleFileAttach(files: File[]) {
    const fileArr = files;
    const needsConversion = ['image/webp', 'image/bmp', 'image/tiff'];

    for (const file of fileArr) {
      if (needsConversion.includes(file.type)) {
        convertImageToJpeg(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          pendingAttachments = [...pendingAttachments, { data: base64, mediaType: file.type || 'application/octet-stream', name: file.name }];
        };
        reader.readAsDataURL(file);
      }
    }
  }

  function convertImageToJpeg(file: File) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      pendingAttachments = [...pendingAttachments, { data: dataUrl.split(',')[1], mediaType: 'image/jpeg', name: file.name }];
    };
    img.src = url;
  }

  function removeAttachment(index: number) {
    pendingAttachments = pendingAttachments.filter((_, i) => i !== index);
  }

  function clearAttachments() {
    pendingAttachments = [];
  }

  // --- Loop commands ---

  function parseLoopCommand(message: string): { ms: number; prompt: string; label: string } | null {
    const match = message.match(/^\/loop\s+(\d+)(m|h)\s+(.+)$/is);
    if (!match) return null;
    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const prompt = match[3].trim();
    if (!amount || !prompt) return null;
    const ms = unit === 'h' ? amount * 3600000 : amount * 60000;
    return { ms, prompt, label: `${amount}${unit}` };
  }

  function startLoop(ms: number, prompt: string, label: string) {
    stopLoop();
    loopPrompt = prompt;
    loopLabel = label;
    loopInterval = setInterval(() => {
      if (!isLoading) {
        chatInputRef?.setValue(prompt);
        sendMessage(prompt);
      }
    }, ms);
    appendSystemMessage(`Loop started — will run every ${label}: "${prompt}". Type /stop to cancel.`);
    // Run immediately
    sendMessage(prompt);
  }

  function stopLoop() {
    if (loopInterval) {
      clearInterval(loopInterval);
      loopInterval = null;
      appendSystemMessage('Loop stopped.');
    }
    loopPrompt = null;
    loopLabel = null;
  }

  function appendSystemMessage(text: string) {
    bubbles = [...bubbles, createSystemBubble(text)];
    tick().then(scrollToBottom);
  }

  // --- Cancel ---

  function cancelCurrentStream() {
    const activeId = sessionStore.getActiveId();

    if (activeId) {
      const streamState = streamManager.getState(activeId);
      const wfState = workflowTasks.get(activeId);
      const taskId = streamState?.taskId || wfState?.taskId;
      if (taskId) {
        api.cancelTask(taskId).catch(() => {});
      }
    }

    if (currentAbortController) {
      currentAbortController.abort();
      return;
    }
    if (!activeId) return;
    const wfState = workflowTasks.get(activeId);
    if (wfState?.abortController) {
      wfState.abortController.abort();
      return;
    }
    streamManager.cancel(activeId);
  }

  // --- Stream timer ---

  function startStreamTimer(responseId: string, startTime?: number) {
    streamStartTime = startTime || Date.now();
    streamTimerInterval = setInterval(() => {
      if (!streamStartTime) return;
      const elapsed = Date.now() - streamStartTime;
      updateBubble(responseId, b => {
        b.elapsedDisplay = formatElapsedTime(elapsed);
      });
    }, 100);
  }

  function stopStreamTimer(responseId: string, inputMessage: string, finalContent: string, wasCancelled: boolean) {
    if (streamTimerInterval) {
      clearInterval(streamTimerInterval);
      streamTimerInterval = null;
    }

    const elapsed = streamStartTime ? Date.now() - streamStartTime : 0;
    streamStartTime = null;

    const usage = streamUsageData;
    const hasRealUsage = usage && (usage.input_tokens > 0 || usage.output_tokens > 0);
    const inputTokens = hasRealUsage ? usage.input_tokens : estimateTokens(inputMessage);
    const outputTokens = hasRealUsage ? usage.output_tokens : estimateTokens(finalContent);
    const prefix = hasRealUsage ? '' : '~';
    const seconds = elapsed / 1000;
    const tps = seconds > 0 ? (outputTokens / seconds).toFixed(1) : '0';

    streamUsageData = null;

    updateBubble(responseId, b => {
      b.showStatusBar = false;
      b.stats = {
        elapsed: formatElapsedTime(elapsed),
        inputTokens: `${prefix}${inputTokens} input`,
        outputTokens: `${prefix}${outputTokens} output`,
        tps: `${prefix}${tps} tok/s`,
        cancelled: wasCancelled,
        visible: true,
      };
      b.cancelled = wasCancelled;
    });
  }

  // --- Messaging ---

  async function handleSubmit(message: string) {
    sendMessage(message);
  }

  async function sendMessage(messageOverride?: string) {
    const message = messageOverride ?? chatInputRef?.getValue() ?? '';
    const activeId = sessionStore.getActiveId();
    const hasAttachments = pendingAttachments.length > 0;

    if ((!message && !hasAttachments) || isLoading || !activeId) return;

    // Handle /loop and /stop commands
    if (message.toLowerCase() === '/stop') {
      chatInputRef?.clear();
      stopLoop();
      return;
    }
    const loop = parseLoopCommand(message);
    if (loop) {
      chatInputRef?.clear();
      startLoop(loop.ms, loop.prompt, loop.label);
      return;
    }

    // Handle workflow messages
    if (appStore.selectionType === 'workflow') {
      return sendWorkflowMessage(message);
    }

    const selected = appStore.selectionType === 'agent' ? appStore.selectedAgent : appStore.selectedLlm;
    if (!selected) return;

    const attachments = hasAttachments ? [...pendingAttachments] : null;

    // Add user bubble
    bubbles = [...bubbles, createUserBubble(message || '(attached files)', attachments)];
    sessionStore.addMessage(activeId, 'user', message || '(attached files)');
    chatInputRef?.clear();
    clearAttachments();

    isLoading = true;

    const responseId = nextBubbleId('response');
    bubbles = [...bubbles, createResponseBubble(responseId)];
    await tick();
    scrollToBottom();

    const abortController = new AbortController();
    currentAbortController = abortController;
    streamUsageData = null;
    startStreamTimer(responseId);

    try {
      let response: Response;
      if (appStore.selectionType === 'agent') {
        const agent = appStore.selectedAgent!;
        const inputVars = agent.inputVariables || ['message'];
        const inputObj: Record<string, unknown> = {};
        inputObj[inputVars[0] || 'message'] = message;
        if (attachments) inputObj.attachments = attachments;
        response = await api.streamAgent(agent.name, inputObj, activeId, { signal: abortController.signal });
      } else {
        response = await api.streamLLM(appStore.selectedLlm!.name, message, activeId, attachments ?? undefined, { signal: abortController.signal });
      }

      streamManager.start(activeId, {
        response,
        abortController,
        streamType: appStore.selectionType === 'agent' ? 'agent' : 'llm',
        inputMessage: message,
        responseId,
      });

      attachToStream(activeId, responseId);
    } catch (e: unknown) {
      const err = e as Error;
      const wasCancelled = err.name === 'AbortError';
      if (!wasCancelled) {
        updateBubble(responseId, b => {
          b.error = `Error: ${err.message}`;
          b.isLoading = false;
        });
      }
      stopStreamTimer(responseId, message, '', wasCancelled);
      currentAbortController = null;
      isLoading = false;
    }

    refreshSessionList();
  }

  // --- Stream handling ---

  function attachToStream(sessionId: string, responseId: string, initialThinkingContent?: string) {
    const state = streamManager.getState(sessionId);
    if (!state) return;

    let thinkingContent = initialThinkingContent || '';
    let hasToolCalls = false;

    // For LLM streams, remove loading immediately if content exists
    if (state.streamType === 'llm') {
      const hasContent = state.content || state.events.length > 0;
      if (hasContent) {
        updateBubble(responseId, b => { b.isLoading = false; });
      }
    }

    streamUnsubscribe = streamManager.subscribe(sessionId, (event: StreamEvent) => {
      if (event.type === '_stream_end') {
        streamUsageData = state.usageData;
        const wasCancelled = event.status === 'cancelled';

        // Finalize any in-progress thinking
        if (thinkingContent) {
          updateBubble(responseId, b => {
            const activeIdx = b.thinkingSections.findIndex(t => !t.done);
            if (activeIdx >= 0) {
              b.thinkingSections[activeIdx].done = true;
              b.thinkingSections[activeIdx].content = thinkingContent;
            }
          });
          thinkingContent = '';
        }

        if (state.streamType === 'agent' && hasToolCalls && !state.content.trim()) {
          updateBubble(responseId, b => { b.isLoading = false; });
        }

        stopStreamTimer(responseId, state.inputMessage, state.content, wasCancelled);
        currentAbortController = null;
        isLoading = false;
        refreshSessionList();
        streamUnsubscribe = null;

        tick().then(() => chatInputRef?.focus());
        return;
      }

      if (state.streamType === 'agent') {
        if (event.type === 'tool_start' || event.type === 'tool_end') hasToolCalls = true;
        handleAgentStreamEvent(event, responseId, state.content, thinkingContent, (tc) => { thinkingContent = tc; });
      } else {
        handleLlmStreamEvent(event, responseId, state, thinkingContent, (tc) => { thinkingContent = tc; });
      }
    });
  }

  function handleAgentStreamEvent(
    event: StreamEvent,
    responseId: string,
    currentContent: string,
    thinkingContent: string,
    setThinking: (tc: string) => void,
  ) {
    if (event.type === 'thinking') {
      const newContent = thinkingContent + (event.content || '');
      setThinking(newContent);
      updateBubble(responseId, b => {
        const activeIdx = b.thinkingSections.findIndex(t => !t.done);
        if (activeIdx >= 0) {
          b.thinkingSections[activeIdx].content = newContent;
        } else {
          b.thinkingSections = [...b.thinkingSections, { content: newContent, done: false }];
        }
      });
      tick().then(scrollToBottom);
    } else if (event.type === 'content') {
      // Finalize thinking
      if (thinkingContent) {
        updateBubble(responseId, b => {
          const activeIdx = b.thinkingSections.findIndex(t => !t.done);
          if (activeIdx >= 0) {
            b.thinkingSections[activeIdx].done = true;
          }
        });
        setThinking('');
      }
      updateBubble(responseId, b => {
        b.content = currentContent;
        b.isLoading = false;
      });
      tick().then(scrollToBottom);
    } else if (event.type === 'tool_start') {
      // Finalize thinking
      if (thinkingContent) {
        updateBubble(responseId, b => {
          const activeIdx = b.thinkingSections.findIndex(t => !t.done);
          if (activeIdx >= 0) {
            b.thinkingSections[activeIdx].done = true;
          }
        });
        setThinking('');
      }
      const toolInput = typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2);
      updateBubble(responseId, b => {
        b.tools = [...b.tools, {
          runId: event.runId!,
          tool: event.tool!,
          input: toolInput,
          done: false,
        }];
      });
      tick().then(scrollToBottom);
    } else if (event.type === 'tool_end') {
      const toolOutput = typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2);

      // Intercept canvas tools
      if (event.tool === 'canvas_write') {
        const toolEntry = bubbles.find(b => b.id === responseId)?.tools.find(t => t.runId === event.runId);
        if (toolEntry) {
          try {
            const parsed = JSON.parse(toolEntry.input);
            openCanvas(parsed.content, parsed.title, parsed.format || 'markdown', parsed.language, parsed.mode);
          } catch { /* ignore */ }
        }
      } else if (event.tool === 'canvas_append') {
        const toolEntry = bubbles.find(b => b.id === responseId)?.tools.find(t => t.runId === event.runId);
        if (toolEntry) {
          try {
            const parsed = JSON.parse(toolEntry.input);
            appendCanvas(parsed.content);
          } catch { /* ignore */ }
        }
      }

      // Intercept model tools
      if (event.tool?.startsWith('model_') && typeof event.output === 'string') {
        try {
          const parsed = JSON.parse(event.output);
          if (parsed.__modelTask) {
            updateBubble(responseId, b => {
              b.modelOutputs = [...b.modelOutputs, {
                task: parsed.task,
                input: parsed.input,
                image: parsed.image,
                audio: parsed.audio,
                error: parsed.error,
              }];
            });
          }
        } catch (err) { console.error('[AgentsPage] Failed to parse model output:', err); }
      }

      updateBubble(responseId, b => {
        const idx = b.tools.findIndex(t => t.runId === event.runId);
        if (idx >= 0) {
          b.tools[idx].output = toolOutput;
          b.tools[idx].done = true;
        }
      });

      // Reload agents if workspace write/delete affects agents
      if (event.tool === 'workspace_write' || event.tool === 'workspace_delete') {
        try {
          const result = JSON.parse(typeof event.output === 'string' ? event.output : JSON.stringify(event.output));
          if (result.success && (result.reloaded === 'agent' || result.unloaded === 'agent')) loadAgents();
        } catch { /* ignore */ }
      }

      tick().then(scrollToBottom);
    } else if (event.type === 'result') {
      updateBubble(responseId, b => {
        b.isLoading = false;
        b.resultContent = JSON.stringify(event.output, null, 2);
      });
      tick().then(scrollToBottom);
    } else if (event.type === 'error') {
      updateBubble(responseId, b => {
        b.isLoading = false;
        b.error = `Error: ${event.error}`;
      });
      tick().then(scrollToBottom);
    } else if (event.type === 'warning') {
      updateBubble(responseId, b => {
        b.warningContent = event.message;
      });
      tick().then(scrollToBottom);
    } else if (event.type === 'usage') {
      streamUsageData = {
        input_tokens: event.input_tokens || 0,
        output_tokens: event.output_tokens || 0,
        total_tokens: event.total_tokens || 0,
      };
    } else if (event.type === 'react_iteration') {
      const contextKB = ((event.contextChars || 0) / 1024).toFixed(1);
      updateBubble(responseId, b => {
        b.statusText = `Iteration ${event.iteration} · ${contextKB} KB context`;
      });
    }
  }

  function handleLlmStreamEvent(
    event: StreamEvent,
    responseId: string,
    state: StreamState,
    thinkingContent: string,
    setThinking: (tc: string) => void,
  ) {
    if (event.type === 'usage') {
      streamUsageData = state.usageData;
      return;
    }
    if (event.error) {
      updateBubble(responseId, b => {
        b.error = `Error: ${event.error}`;
        b.isLoading = false;
      });
      return;
    }
    if (event.type === 'thinking') {
      const newContent = thinkingContent + (event.content || '');
      setThinking(newContent);
      updateBubble(responseId, b => {
        b.isLoading = false;
        const activeIdx = b.thinkingSections.findIndex(t => !t.done);
        if (activeIdx >= 0) {
          b.thinkingSections[activeIdx].content = newContent;
        } else {
          b.thinkingSections = [...b.thinkingSections, { content: newContent, done: false }];
        }
      });
      tick().then(scrollToBottom);
      return;
    }
    if (event.content) {
      // Finalize thinking
      if (thinkingContent) {
        updateBubble(responseId, b => {
          const activeIdx = b.thinkingSections.findIndex(t => !t.done);
          if (activeIdx >= 0) {
            b.thinkingSections[activeIdx].done = true;
          }
        });
        setThinking('');
      }
      updateBubble(responseId, b => {
        b.content = state.content;
        b.isLoading = false;
      });
      tick().then(scrollToBottom);
    }
  }

  // --- Stream reconnection ---

  function reconnectToStream(sessionId: string) {
    const state = streamManager.getState(sessionId);
    if (!state || state.status !== 'streaming') return;

    // Build bubble from snapshot
    const responseBubble = createResponseBubble(state.responseId);
    let activeThinkingContent = '';

    if (state.streamType === 'agent') {
      const tools = new Map<string, ToolEntry>();
      const completedThinking: string[] = [];
      let currentThinking = '';
      let lastWasThinking = false;

      for (const event of state.events) {
        if (event.type === 'thinking') {
          currentThinking += event.content || '';
          lastWasThinking = true;
        } else {
          if (lastWasThinking && currentThinking) {
            completedThinking.push(currentThinking);
            currentThinking = '';
          }
          lastWasThinking = false;
        }
        if (event.type === 'tool_start') {
          tools.set(event.runId!, {
            runId: event.runId!,
            tool: event.tool!,
            input: typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2),
            done: false,
          });
        }
        if (event.type === 'tool_end') {
          const t = tools.get(event.runId!);
          if (t) {
            t.output = typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2);
            t.done = true;
          }
        }
        if (event.type === 'react_iteration') {
          const contextKB = ((event.contextChars || 0) / 1024).toFixed(1);
          responseBubble.statusText = `Iteration ${event.iteration} · ${contextKB} KB context`;
        }
      }

      responseBubble.thinkingSections = completedThinking.map(c => ({ content: c, done: true }));
      if (lastWasThinking && currentThinking) {
        responseBubble.thinkingSections.push({ content: currentThinking, done: false });
        activeThinkingContent = currentThinking;
      }
      responseBubble.tools = Array.from(tools.values());
    }

    if (state.content) {
      responseBubble.content = state.content;
      responseBubble.isLoading = false;
    }

    bubbles = [...bubbles, responseBubble];

    streamUsageData = state.usageData;
    startStreamTimer(state.responseId, state.startTime);
    isLoading = true;
    currentAbortController = state.abortController;

    attachToStream(sessionId, state.responseId, activeThinkingContent);

    tick().then(scrollToBottom);
  }

  // --- Workflow ---

  async function sendWorkflowMessage(message: string) {
    const activeId = sessionStore.getActiveId();
    if (!activeId) return;

    const wfState = workflowTasks.get(activeId);
    if (wfState?.interruptState) {
      return respondToWorkflowInterrupt(activeId, message);
    }

    const workflow = appStore.selectedWorkflow;
    if (!workflow) return;

    const schema = workflow.inputSchema || {};
    const firstField = Object.keys(schema)[0] || 'input';
    const inputObj = { [firstField]: message };

    bubbles = [...bubbles, createUserBubble(message)];
    sessionStore.addMessage(activeId, 'user', message);
    chatInputRef?.clear();
    clearAttachments();

    const responseId = nextBubbleId('response');
    bubbles = [...bubbles, createResponseBubble(responseId)];
    isLoading = true;
    await tick();
    scrollToBottom();

    startStreamTimer(responseId);

    const abortController = new AbortController();
    const existingWfState = workflowTasks.get(activeId);
    const existingThreadId = existingWfState?.threadId || null;
    workflowTasks.set(activeId, {
      responseId,
      startTime: Date.now(),
      chatOutputFormat: workflow.chatOutputFormat || 'json',
      workflowName: workflow.name,
      abortController,
      interruptState: null,
      status: 'streaming',
      events: [],
      inputMessage: message,
      taskId: null,
      threadId: existingThreadId,
    });

    try {
      const response = await api.startWorkflowStream(workflow.name, inputObj, abortController.signal, existingThreadId || undefined);
      await processWorkflowStream(response, activeId, responseId);
    } catch (e: unknown) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        finishWorkflowStream(activeId, responseId, null, null, true);
      } else {
        updateBubble(responseId, b => {
          b.error = `Error: ${err.message}`;
          b.isLoading = false;
        });
        stopStreamTimer(responseId, message, '', false);
        isLoading = false;
      }
    }

    refreshSessionList();
  }

  async function respondToWorkflowInterrupt(sessionId: string, message: string) {
    const wfState = workflowTasks.get(sessionId);
    if (!wfState?.interruptState) return;

    const { threadId, workflowName } = wfState.interruptState;

    bubbles = [...bubbles, createUserBubble(message)];
    sessionStore.addMessage(sessionId, 'user', message);
    chatInputRef?.clear();

    const responseId = nextBubbleId('response');
    bubbles = [...bubbles, createResponseBubble(responseId)];

    const abortController = new AbortController();
    wfState.responseId = responseId;
    wfState.interruptState = null;
    wfState.status = 'streaming';
    wfState.abortController = abortController;

    isLoading = true;
    await tick();
    scrollToBottom();
    startStreamTimer(responseId);

    try {
      const response = await api.resumeWorkflowStream(workflowName, threadId, message, abortController.signal);
      await processWorkflowStream(response, sessionId, responseId);
    } catch (e: unknown) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        finishWorkflowStream(sessionId, responseId, null, null, true);
      } else {
        updateBubble(responseId, b => {
          b.error = `Error: ${err.message}`;
          b.isLoading = false;
        });
        stopStreamTimer(responseId, message, '', false);
        isLoading = false;
      }
    }

    refreshSessionList();
  }

  async function processWorkflowStream(response: Response, sessionId: string, responseId: string) {
    if (!response.ok) {
      const text = await response.text();
      let msg = `HTTP ${response.status}`;
      try { msg = JSON.parse(text).error || msg; } catch { /* use status */ }
      throw new Error(msg);
    }

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
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const update = JSON.parse(payload);
          handleWorkflowStreamEvent(update, sessionId, responseId);
        } catch (e) {
          console.error('Workflow stream parse error:', e);
        }
      }
    }

    if (buffer.startsWith('data: ')) {
      const payload = buffer.slice(6).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const update = JSON.parse(payload);
          handleWorkflowStreamEvent(update, sessionId, responseId);
        } catch { /* ignore */ }
      }
    }

    const wfState = workflowTasks.get(sessionId);
    if (wfState && wfState.status === 'streaming') {
      finishWorkflowStream(sessionId, responseId, null, 'Stream ended unexpectedly', false);
    }
  }

  function handleWorkflowStreamEvent(update: { type: string; data?: unknown; error?: string; taskId?: string }, sessionId: string, responseId: string) {
    const wfState = workflowTasks.get(sessionId);
    if (!wfState) return;

    if (update.type === 'task_id') {
      wfState.taskId = update.taskId || null;
      return;
    }

    if (update.type === 'status') {
      const event = update.data as StreamEvent;
      wfState.events.push(event);
      handleWorkflowEventRendering(event, responseId);
    }

    if (update.type === 'result') {
      const result = update.data as { output?: Record<string, unknown> & { interrupted?: boolean; threadId?: string; question?: string }; metadata?: { threadId?: string }; error?: string };
      if (result?.output?.interrupted && result?.output?.threadId) {
        handleWorkflowInterrupt(sessionId, responseId, result.output);
      } else if (result?.error) {
        finishWorkflowStream(sessionId, responseId, null, result.error, false);
      } else {
        // Capture threadId for multi-turn continuations
        const threadId = result?.metadata?.threadId;
        if (threadId && wfState) {
          wfState.threadId = threadId;
        }
        finishWorkflowStream(sessionId, responseId, result, null, false);
      }
    }

    if (update.type === 'error') {
      finishWorkflowStream(sessionId, responseId, null, update.error || 'Unknown error', false);
    }
  }

  function handleWorkflowEventRendering(event: StreamEvent, responseId: string) {
    if (event.type === 'step_start') {
      updateBubble(responseId, b => {
        b.isLoading = false;
        b.tools = [...b.tools, {
          runId: event.stepId || event.runId || '',
          tool: event.stepId || '',
          input: '',
          done: false,
        }];
      });
    }

    if (event.type === 'step_complete') {
      updateBubble(responseId, b => {
        const idx = b.tools.findIndex(t => t.runId === event.stepId);
        if (idx >= 0) {
          b.tools[idx].done = true;
        }
      });
    }

    if (event.type === 'step_error') {
      updateBubble(responseId, b => {
        const idx = b.tools.findIndex(t => t.runId === event.stepId);
        if (idx >= 0) {
          b.tools[idx].done = true;
          b.tools[idx].output = event.error || 'Error';
        }
      });
    }

    if (event.type === 'tool_call') {
      const toolName = event.message?.replace(/^Calling:?\s*/i, '').split(/\s/)[0] || 'tool';
      updateBubble(responseId, b => {
        b.isLoading = false;
        b.tools = [...b.tools, {
          runId: event.toolCallId || nextBubbleId('wf-tool'),
          tool: toolName,
          input: event.toolInput || '',
          done: false,
        }];
      });
    }

    if (event.type === 'tool_result') {
      updateBubble(responseId, b => {
        const idx = event.toolCallId
          ? b.tools.findIndex(t => t.runId === event.toolCallId)
          : b.tools.findLastIndex(t => !t.done);
        if (idx >= 0) {
          b.tools[idx].done = true;
          b.tools[idx].output = event.toolOutput || '';
        }
      });
    }

    if (event.type === 'tool_discovery') {
      if (event.message?.includes('total tools')) {
        updateBubble(responseId, b => {
          b.isLoading = false;
          b.tools = [...b.tools, {
            runId: nextBubbleId('discovery'),
            tool: event.message || 'Tools discovered',
            input: '',
            done: true,
          }];
        });
      }
      updateBubble(responseId, b => {
        b.statusText = event.message || 'Discovering tools...';
      });
    }

    if (event.type === 'react_iteration' || event.type === 'workflow_start') {
      updateBubble(responseId, b => {
        b.statusText = event.message || 'Processing...';
        b.isLoading = false;
      });
    }

    tick().then(scrollToBottom);
  }

  function handleWorkflowInterrupt(sessionId: string, responseId: string, interruptData: { question?: string; threadId?: string }) {
    const wfState = workflowTasks.get(sessionId);
    if (!wfState) return;

    wfState.status = 'interrupted';
    const question = interruptData?.question || 'Input required';
    wfState.interruptState = {
      question,
      threadId: interruptData?.threadId || '',
      workflowName: wfState.workflowName,
    };

    updateBubble(responseId, b => {
      b.content = question;
      b.isLoading = false;
      b.statusText = 'Waiting for input...';
    });

    sessionStore.addMessage(sessionId, 'assistant', question);

    if (streamTimerInterval) {
      clearInterval(streamTimerInterval);
      streamTimerInterval = null;
    }
    isLoading = false;

    tick().then(() => chatInputRef?.focus());
  }

  function finishWorkflowStream(
    sessionId: string,
    responseId: string,
    result: { output?: Record<string, unknown> } | null,
    error: string | null,
    wasCancelled: boolean,
  ) {
    const wfState = workflowTasks.get(sessionId);
    if (!wfState) return;

    wfState.status = 'done';
    wfState.abortController = null;

    if (error) {
      updateBubble(responseId, b => {
        b.error = `Error: ${error}`;
        b.isLoading = false;
      });
    } else if (!wasCancelled && result?.output) {
      const output = result.output;
      const fmt = wfState.chatOutputFormat;
      const contentText = fmt === 'text'
        ? Object.values(output).join('\n\n')
        : '```json\n' + JSON.stringify(output, null, 2) + '\n```';
      updateBubble(responseId, b => {
        b.content = contentText;
        b.isLoading = false;
      });
    } else {
      updateBubble(responseId, b => { b.isLoading = false; });
    }

    let content = '';
    if (error) {
      content = `Error: ${error}`;
    } else if (result?.output) {
      content = wfState.chatOutputFormat === 'text'
        ? Object.values(result.output).join('\n\n')
        : '```json\n' + JSON.stringify(result.output, null, 2) + '\n```';
    }

    const elapsed = wfState.startTime ? Date.now() - wfState.startTime : 0;
    const meta: MessageMeta = {
      thinking: [],
      tools: wfState.events
        .filter(e => e.type === 'step_complete')
        .map(e => ({ runId: e.stepId || '', tool: e.stepId || '', input: e.agent || '', output: e.message || 'Completed' })),
      stats: {
        elapsed,
        inputTokens: Math.round((wfState.inputMessage || '').length / 4),
        outputTokens: Math.round(content.length / 4),
        cancelled: wasCancelled,
        estimated: true,
      },
    };
    sessionStore.addMessage(sessionId, 'assistant', content, meta);

    stopStreamTimer(responseId, wfState.inputMessage || '', content, wasCancelled);
    isLoading = false;
    refreshSessionList();

    // Don't delete — keep threadId for multi-turn continuations

    tick().then(() => chatInputRef?.focus());
  }

  function reconnectWorkflowStream(sessionId: string) {
    const wfState = workflowTasks.get(sessionId);
    if (!wfState || wfState.status === 'done') return;

    if (wfState.interruptState) {
      isLoading = false;
      return;
    }

    // Rebuild bubble from cached events
    const responseBubble = createResponseBubble(wfState.responseId);
    const toolEntries: ToolEntry[] = [];
    for (const event of wfState.events) {
      if (event.type === 'step_start') {
        toolEntries.push({
          runId: event.stepId || '',
          tool: event.stepId || '',
          input: '',
          done: false,
        });
      }
      if (event.type === 'step_complete') {
        const idx = toolEntries.findIndex(t => t.runId === event.stepId);
        if (idx >= 0) toolEntries[idx].done = true;
      }
      if (event.type === 'step_error') {
        const idx = toolEntries.findIndex(t => t.runId === event.stepId);
        if (idx >= 0) {
          toolEntries[idx].done = true;
          toolEntries[idx].output = event.error || 'Error';
        }
      }
    }
    responseBubble.tools = toolEntries;
    if (toolEntries.length > 0) responseBubble.isLoading = false;

    bubbles = [...bubbles, responseBubble];
    startStreamTimer(wfState.responseId, wfState.startTime);
    isLoading = true;
    currentAbortController = null;

    tick().then(scrollToBottom);
  }

  // --- Canvas ---

  function openCanvas(content: string, canvasTitle?: string, format?: string, language?: string, _mode?: string) {
    canvasState = {
      content,
      title: canvasTitle || 'Canvas',
      format: (format || 'markdown') as 'markdown' | 'html' | 'code',
      language: language || '',
      mode: _mode,
    };
    canvasOpen = true;
  }

  function appendCanvas(content: string) {
    if (!canvasState) return;
    canvasState = {
      ...canvasState,
      content: canvasState.content + content,
    };
  }

  function closeCanvas() {
    canvasOpen = false;
    canvasState = null;
  }

  function restoreCanvasFromHistory(messages: Session['messages']) {
    let restored: CanvasState | null = null;

    for (const msg of messages) {
      if (msg.role !== 'assistant' || !msg.meta?.tools) continue;
      for (const t of msg.meta.tools) {
        if (t.tool === 'canvas_write' && t.output !== undefined) {
          try {
            const input = typeof t.input === 'string' ? JSON.parse(t.input) : t.input;
            restored = {
              content: input.content,
              title: input.title || 'Canvas',
              format: input.format || 'markdown',
              language: input.language || '',
              mode: input.mode,
            };
          } catch { /* ignore */ }
        } else if (t.tool === 'canvas_append' && t.output !== undefined && restored) {
          try {
            const input = typeof t.input === 'string' ? JSON.parse(t.input) : t.input;
            restored.content += input.content;
          } catch { /* ignore */ }
        }
      }
    }

    if (restored) {
      canvasState = restored;
      canvasOpen = true;
    }
  }

  // --- Derived state ---

  const hasActiveSession = $derived(!!activeSessionId);
  const chatIsEmpty = $derived(bubbles.length === 0);

  const currentAgent = $derived.by(() => {
    if (!headerSession || headerSession.agentType !== 'agent') return null;
    return appStore.agents.find(a => a.name === headerSession!.agentName) || null;
  });

  const sampleQuestions = $derived.by(() => {
    const agent = appStore.selectedAgent;
    const workflow = appStore.selectedWorkflow;
    return agent?.sampleQuestions || workflow?.sampleQuestions || [];
  });

  function handleQuestionClick(q: string) {
    chatInputRef?.setValue(q);
    chatInputRef?.focus();
  }

  function handleInputClick() {
    if (!hasActiveSession) {
      showNewSessionModal();
    }
  }

  // --- Input context menu ---

  const FILE_ACCEPT = "image/*,audio/*,.wav,.mp3,.ogg,.flac,.pdf,.doc,.docx,.xls,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.go,.rs,.rb,.php,.sql,.sh,.log,.ini,.toml,.env";

  interface InputMenuItem {
    id: string;
    icon: string;
    label: string;
    description?: string;
    accept?: string;
    dividerBefore?: boolean;
  }

  const inputMenuItems = $derived.by((): InputMenuItem[] => {
    const items: InputMenuItem[] = [];
    const tools = toolNames;
    const hasTts = tools.some(t => t.startsWith('models:tts'));
    const hasImageGen = tools.some(t => t.startsWith('models:image'));

    if (hasTts) {
      items.push({
        id: 'upload-voice',
        icon: 'fa-microphone',
        label: 'Upload voice sample',
        description: 'WAV file, 5\u201310s clear speech',
        accept: 'audio/*,.wav,.mp3,.ogg,.flac',
      });
    }

    items.push({
      id: 'upload-image',
      icon: 'fa-image',
      label: 'Upload image',
      description: hasImageGen ? 'Reference for generation' : 'Vision analysis',
      accept: 'image/*',
    });

    items.push({
      id: 'upload-file',
      icon: 'fa-paperclip',
      label: 'Upload file',
      description: 'PDF, docs, code',
      accept: FILE_ACCEPT,
    });

    items.push({
      id: loopInterval ? 'stop-loop' : 'start-loop',
      icon: 'fa-rotate',
      label: loopInterval ? 'Stop loop' : 'Start loop',
      description: loopInterval ? `Every ${loopLabel}` : 'Run a prompt on a timer',
      dividerBefore: true,
    });

    return items;
  });

  function toggleInputMenu() {
    if (!hasActiveSession) {
      showNewSessionModal();
      return;
    }
    inputMenuOpen = !inputMenuOpen;
    if (inputMenuOpen && hasTts && availableVoices.length === 0) {
      loadVoices();
    }
  }

  function handleMenuSelect(id: string) {
    inputMenuOpen = false;

    if (id === 'start-loop') {
      loopDialogOpen = true;
      return;
    }
    if (id === 'stop-loop') {
      stopLoop();
      return;
    }

    const item = inputMenuItems.find(i => i.id === id);
    if (item?.accept) {
      chatInputRef?.triggerFileSelect(item.accept);
    }
  }

  function handleStartLoopDialog() {
    if (!loopDialogPrompt.trim() || loopDialogAmount < 1) return;
    const ms = loopDialogUnit === 'h' ? loopDialogAmount * 3600000 : loopDialogAmount * 60000;
    const label = `${loopDialogAmount}${loopDialogUnit}`;
    loopDialogOpen = false;
    startLoop(ms, loopDialogPrompt.trim(), label);
    loopDialogPrompt = '';
    loopDialogAmount = 5;
    loopDialogUnit = 'm';
  }

  // --- Prebuilt voices ---

  const hasTts = $derived(toolNames.some(t => t.startsWith('models:tts')));

  async function loadVoices() {
    try {
      availableVoices = await api.getVoices();
    } catch {
      availableVoices = [];
    }
  }

  async function selectVoice(voice: VoiceEntry) {
    inputMenuOpen = false;
    voiceLoading = voice.name;
    try {
      const data = await api.getVoiceData(voice.filename);
      pendingAttachments = [...pendingAttachments, {
        data: data.data,
        mediaType: data.mediaType,
        name: data.name,
      }];
      chatInputRef?.focus();
    } catch (e) {
      console.error('Failed to load voice:', e);
    } finally {
      voiceLoading = null;
    }
  }

  const hasArchitect = $derived(appStore.agents.some(a => a.name === 'architect'));

  // --- Session sidebar info ---

  function sessionIcon(s: Session): string {
    if (s.agentType === 'workflow') return 'fa-project-diagram';
    if (s.agentType === 'agent') return 'fa-robot';
    return 'fa-microchip';
  }

  function sessionDisplayName(s: Session): string {
    if (s.agentType === 'workflow') return s.workflowName || 'Workflow';
    if (s.agentType === 'agent') return s.agentName || 'Agent';
    return s.llmName || 'LLM';
  }

  // --- Header info ---

  function headerIcon(): string {
    if (!headerSession) return '';
    if (headerSession.agentType === 'workflow') return 'fa-project-diagram';
    if (headerSession.agentType === 'agent') return 'fa-robot';
    return 'fa-microchip';
  }

  function headerName(): string {
    if (!headerSession) return '';
    if (headerSession.agentType === 'workflow') return headerSession.workflowName || 'Workflow';
    if (headerSession.agentType === 'agent') return headerSession.agentName || 'Agent';
    return headerSession.llmName || 'LLM';
  }

  function headerBadge(): { text: string; variant: string } {
    if (!headerSession) return { text: '', variant: '' };
    if (headerSession.agentType === 'workflow') return { text: 'Workflow', variant: 'badge-orange' };
    if (headerSession.agentType === 'agent') return { text: 'Agent', variant: 'badge-blue' };
    return { text: 'LLM', variant: 'badge-purple' };
  }

  const isPublished = $derived(currentAgent?.publish === true || (currentAgent?.publish && typeof currentAgent.publish === 'object' && currentAgent.publish.enabled));
  const hasMemory = $derived(currentAgent?.memory === true || (currentAgent?.memory && typeof currentAgent.memory === 'object' && (currentAgent.memory as { enabled: boolean }).enabled));
  const toolNames = $derived.by(() => {
    if (!currentAgent?.tools?.length) return [];
    return currentAgent.tools.map(t => typeof t === 'string' ? t : t.name);
  });

  const currentWorkflow = $derived.by(() => {
    if (!headerSession || headerSession.agentType !== 'workflow') return null;
    return appStore.workflows.find(w => w.name === headerSession!.workflowName) || null;
  });
  const workflowAgentNames = $derived(currentWorkflow?.agents || []);
  const workflowToolNames = $derived(currentWorkflow?.tools || []);
</script>

<div class="agent-shell">
  <!-- Mobile sidebar backdrop -->
  <div
    class="sidebar-backdrop"
    class:visible={sidebarOpen}
    onclick={() => toggleSidebar(false)}
    role="presentation"
  ></div>

  <!-- Sidebar -->
  <div class="agent-sidebar" class:open={sidebarOpen}>
    <div class="p-3">
      <button class="new-chat-btn" onclick={() => showNewSessionModal()}>
        <i class="fas fa-plus text-xs text-accent"></i>
        <span>New chat</span>
      </button>
    </div>
    <div class="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2">
      {#if sessions.length === 0}
        <div class="text-muted text-sm text-center py-8">No conversations yet</div>
      {:else}
        {#each sessions as s}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="session-item"
            class:active={s.id === activeSessionId}
            onclick={(e: MouseEvent) => {
              if ((e.target as HTMLElement).closest('.session-delete-btn')) return;
              switchToSession(s.id);
            }}
          >
            <div class="flex-1 min-w-0">
              <div class="text-sm text-primary truncate">{s.title}</div>
              <div class="flex items-center gap-1 mt-1 text-xs text-muted">
                <i class="fas {sessionIcon(s)} text-2xs"></i>
                <span class="truncate">{sessionDisplayName(s)}</span>
              </div>
            </div>
            <button
              class="session-delete-btn"
              title="Delete"
              onclick={(e: MouseEvent) => { e.stopPropagation(); deleteSession(s.id); }}
            >
              <i class="fas fa-xmark text-xs"></i>
            </button>
          </div>
        {/each}
      {/if}
    </div>
    <div class="px-3 sidebar-bottom-action">
      <button class="sidebar-secondary-btn" onclick={() => showNewAgentModal()}>
        <i class="fas fa-robot text-xs text-blue"></i>
        <span>New agent</span>
      </button>
    </div>
  </div>

  <!-- Chat Area -->
  <div class="chat-area" class:canvas-open={canvasOpen}>
    <!-- Chat Header -->
    <div class="chat-header">
      <button class="sidebar-toggle-btn" title="Toggle sidebar" onclick={() => toggleSidebar(true)}>
        <i class="fas fa-bars"></i>
      </button>
      <div class="flex-1 min-w-0">
        {#if headerSession}
          <div class="flex items-center gap-2 flex-wrap">
            <i class="fas {headerIcon()} text-sm text-secondary"></i>
            <span class="font-medium text-primary">{headerName()}</span>
            <span class="badge badge-pill {headerBadge().variant}">{headerBadge().text}</span>
            {#if isPublished}
              <a href="/chat/{encodeURIComponent(headerSession.agentName || '')}" target="_blank" class="badge badge-pill badge-green no-underline" title="Open published chat">
                <i class="fas fa-globe text-2xs"></i> Published
              </a>
            {/if}
            {#if hasMemory}
              <span class="badge badge-pill badge-amber" title="Persistent memory enabled">
                <i class="fas fa-brain text-2xs"></i> Memory
              </span>
            {/if}
            {#if toolNames.length > 0}
              <span class="tools-badge-wrapper">
                <span class="badge badge-pill badge-gray">
                  <i class="fas fa-wrench text-2xs"></i> {toolNames.length} tool{toolNames.length !== 1 ? 's' : ''}
                </span>
                <div class="tools-popover">
                  {#each toolNames as t}
                    <div class="tools-popover-item">{t}</div>
                  {/each}
                </div>
              </span>
            {/if}
            {#if workflowAgentNames.length > 0}
              <span class="tools-badge-wrapper">
                <span class="badge badge-pill badge-blue">
                  <i class="fas fa-robot text-2xs"></i> {workflowAgentNames.length} agent{workflowAgentNames.length !== 1 ? 's' : ''}
                </span>
                <div class="tools-popover">
                  {#each workflowAgentNames as a}
                    <div class="tools-popover-item">{a}</div>
                  {/each}
                </div>
              </span>
            {/if}
            {#if workflowToolNames.length > 0}
              <span class="tools-badge-wrapper">
                <span class="badge badge-pill badge-gray">
                  <i class="fas fa-wrench text-2xs"></i> {workflowToolNames.length} tool{workflowToolNames.length !== 1 ? 's' : ''}
                </span>
                <div class="tools-popover">
                  {#each workflowToolNames as t}
                    <div class="tools-popover-item">{t}</div>
                  {/each}
                </div>
              </span>
            {/if}
          </div>
        {:else}
          <span class="text-muted">No conversation selected</span>
        {/if}
      </div>
    </div>

    <div class="chat-area-body">
      <div class="chat-main">
        <!-- Chat Messages -->
        <ChatMessages bind:this={chatMessagesRef}>
          {#if hasActiveSession}
            <WelcomeState questions={chatIsEmpty ? sampleQuestions : []} onquestionclick={handleQuestionClick} />
          {:else if chatIsEmpty}
            <div class="flex-1 flex items-center justify-center h-full">
              <div class="text-center text-muted">
                <i class="fas fa-comments text-4xl mb-4 text-muted"></i>
                <p class="text-lg">Start a new conversation</p>
                <p class="text-sm mt-1">Click "New chat" to begin</p>
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
            {:else if bubble.type === 'session-reset'}
              <div class="session-reset-banner">
                <div class="session-reset-line"></div>
                <span class="session-reset-label">
                  <i class="fas fa-rotate-right"></i>
                  Server restarted — new session
                </span>
                <div class="session-reset-line"></div>
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
                  {#if bubble.warningContent}
                    <div class="text-yellow text-sm">{bubble.warningContent}</div>
                  {/if}
                </ResponseBubble>
                {#if bubble.showStatusBar}
                  <StreamStatusBar
                    elapsed={bubble.elapsedDisplay}
                    statusText={bubble.statusText}
                    oncancel={cancelCurrentStream}
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
        </ChatMessages>
      </div>

      {#if canvasOpen && canvasState}
        <CanvasPane
          content={canvasState.content}
          title={canvasState.title}
          format={canvasState.format}
          language={canvasState.language}
          onclose={closeCanvas}
        />
      {/if}
    </div>

    <!-- Input Area -->
    <div class="chat-input-area">
      {#if inputMenuOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="input-menu-backdrop" onclick={() => { inputMenuOpen = false; }}></div>
        <div class="input-menu">
          {#each inputMenuItems as item}
            {#if item.dividerBefore}
              <div class="input-menu-divider"></div>
            {/if}
            <button class="input-menu-item" onclick={() => handleMenuSelect(item.id)}>
              <i class="fas {item.icon} input-menu-icon"></i>
              <div class="input-menu-text">
                <span class="input-menu-label">{item.label}</span>
                {#if item.description}
                  <span class="input-menu-desc">{item.description}</span>
                {/if}
              </div>
            </button>
            {#if item.id === 'upload-voice' && availableVoices.length > 0}
              <div class="input-menu-voices">
                {#each availableVoices as voice}
                  <button
                    class="voice-chip"
                    class:loading={voiceLoading === voice.name}
                    disabled={voiceLoading !== null}
                    title={voice.filename}
                    onclick={() => selectVoice(voice)}
                  >
                    {#if voiceLoading === voice.name}
                      <i class="fas fa-spinner fa-spin text-2xs"></i>
                    {:else}
                      <i class="fas fa-volume-high text-2xs"></i>
                    {/if}
                    {voice.name}
                  </button>
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      <AttachmentPreview attachments={pendingAttachments} onremove={removeAttachment} />
      <ChatInput
        bind:this={chatInputRef}
        disabled={isLoading}
        readonly={!hasActiveSession}
        placeholder="Ask anything"
        onsubmit={handleSubmit}
        onfileselect={handleFileAttach}
        onplusclick={toggleInputMenu}
        onclick={handleInputClick}
      />
    </div>
  </div>
</div>

<!-- New Session Modal -->
{#if newSessionModalOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
  <div class="modal-backdrop" onclick={(e: MouseEvent) => { if (e.target === e.currentTarget) newSessionModalOpen = false; }} role="dialog">
    <div class="modal-content modal-content-sm">
      <div class="modal-header">
        <h3 class="text-lg font-semibold text-primary">New conversation</h3>
        <button class="modal-close-btn" title="Close" onclick={() => { newSessionModalOpen = false; }}>
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <div class="overflow-y-auto custom-scrollbar flex-1">
        {#if appStore.agents.length > 0}
          <div class="modal-section-label">Agents</div>
          {#each appStore.agents as a}
            <button class="modal-pick-item" onclick={() => createSession('agent', a.name)}>
              <i class="fas fa-robot text-blue text-sm"></i>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-primary">{a.name}</div>
                <div class="text-xs text-muted truncate">{a.description || ''}</div>
              </div>
            </button>
          {/each}
        {/if}
        {#if appStore.workflows.length > 0}
          <div class="modal-section-label">Workflows</div>
          {#each appStore.workflows as w}
            <button class="modal-pick-item" onclick={() => createSession('workflow', w.name)}>
              <i class="fas fa-project-diagram text-orange text-sm"></i>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-primary">{w.name}</div>
                <div class="text-xs text-muted truncate">{w.description || ''}</div>
              </div>
            </button>
          {/each}
        {/if}
        {#if appStore.llms.length > 0}
          <div class="modal-section-label">LLMs</div>
          {#each appStore.llms as l}
            <button class="modal-pick-item" onclick={() => createSession('llm', l.name)}>
              <i class="fas fa-microchip text-purple text-sm"></i>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-primary">{l.name}</span>
                  {#if l.name === appStore.defaultLlmName}
                    <span class="badge badge-green text-2xs">default</span>
                  {/if}
                </div>
                <div class="text-xs text-muted truncate">{l.model || ''}</div>
              </div>
            </button>
          {/each}
        {/if}
        {#if appStore.agents.length === 0 && appStore.workflows.length === 0 && appStore.llms.length === 0}
          <div class="text-muted text-sm text-center py-8">No agents, workflows or LLMs available</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- New Agent Modal -->
{#if newAgentModalOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
  <div class="modal-backdrop" onclick={(e: MouseEvent) => { if (e.target === e.currentTarget) newAgentModalOpen = false; }} role="dialog">
    <div class="modal-content modal-content-sm">
      <div class="modal-header">
        <h3 class="text-lg font-semibold text-primary">Create a new agent</h3>
        <button class="modal-close-btn" title="Close" onclick={() => { newAgentModalOpen = false; }}>
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <div class="p-4 flex flex-col gap-3">
        {#if hasArchitect}
          <button class="new-agent-option" onclick={createAgentViaArchitect}>
            <div class="new-agent-option-icon bg-blue">
              <i class="fas fa-comments"></i>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-primary">Chat with Architect</div>
              <div class="text-xs text-muted">Describe what you need and the Architect agent will build it for you</div>
            </div>
            <i class="fas fa-chevron-right text-xs text-muted"></i>
          </button>
        {/if}
        <button class="new-agent-option" onclick={createAgentViaIde}>
          <div class="new-agent-option-icon bg-green">
            <i class="fas fa-code"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-primary">Create in IDE</div>
            <div class="text-xs text-muted">Open the IDE editor with a blank agent template</div>
          </div>
          <i class="fas fa-chevron-right text-xs text-muted"></i>
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Loop Dialog -->
{#if loopDialogOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
  <div class="modal-backdrop" onclick={(e: MouseEvent) => { if (e.target === e.currentTarget) loopDialogOpen = false; }} role="dialog">
    <div class="modal-content loop-dialog">
      <div class="modal-header">
        <h3 class="text-lg font-semibold text-primary">Start loop</h3>
        <button class="modal-close-btn" title="Close" onclick={() => { loopDialogOpen = false; }}>
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <div class="p-4">
        <div class="mb-3">
          <label class="text-sm text-muted mb-1 block">Interval</label>
          <div class="flex items-center gap-2">
            <input
              type="number"
              min="1"
              max="999"
              bind:value={loopDialogAmount}
              class="input loop-interval-num"
            />
            <select bind:value={loopDialogUnit} class="select loop-interval-unit">
              <option value="m">minutes</option>
              <option value="h">hours</option>
            </select>
          </div>
        </div>
        <div class="mb-4">
          <label class="text-sm text-muted mb-1 block">Prompt</label>
          <textarea
            bind:value={loopDialogPrompt}
            rows="3"
            class="textarea loop-prompt-textarea"
            placeholder="What should run each cycle?"
            onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleStartLoopDialog(); }}
          ></textarea>
        </div>
        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost" onclick={() => { loopDialogOpen = false; }}>Cancel</button>
          <button class="btn btn-accent" disabled={!loopDialogPrompt.trim() || loopDialogAmount < 1} onclick={handleStartLoopDialog}>
            <i class="fas fa-play text-xs"></i> Start
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
