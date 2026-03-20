import { sessionStore } from './session.svelte.js';
import type { StreamEvent } from '../types/index.js';

export interface StreamState {
  streamType: 'agent' | 'llm';
  abortController: AbortController;
  inputMessage: string;
  responseId: string;
  content: string;
  events: StreamEvent[];
  status: 'streaming' | 'done' | 'cancelled' | 'error';
  startTime: number;
  usageData: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  error: string | null;
  listeners: Set<(event: StreamEvent) => void>;
  taskId: string | null;
}

class StreamManager {
  private streams = new Map<string, StreamState>();

  start(sessionId: string, opts: {
    response: Response;
    abortController: AbortController;
    streamType: 'agent' | 'llm';
    inputMessage: string;
    responseId: string;
  }): StreamState {
    const existing = this.streams.get(sessionId);
    if (existing?.abortController) {
      try { existing.abortController.abort(); } catch { /* noop */ }
    }

    const state: StreamState = {
      streamType: opts.streamType,
      abortController: opts.abortController,
      inputMessage: opts.inputMessage,
      responseId: opts.responseId,
      content: '',
      events: [],
      status: 'streaming',
      startTime: Date.now(),
      usageData: null,
      error: null,
      listeners: new Set(),
      taskId: null,
    };

    this.streams.set(sessionId, state);
    this._process(sessionId, opts.response, state);
    return state;
  }

  getState(sessionId: string): StreamState | null {
    return this.streams.get(sessionId) || null;
  }

  isActive(sessionId: string): boolean {
    return this.streams.get(sessionId)?.status === 'streaming';
  }

  subscribe(sessionId: string, callback: (event: StreamEvent) => void): () => void {
    const state = this.streams.get(sessionId);
    if (!state) return () => {};
    state.listeners.add(callback);
    return () => state.listeners.delete(callback);
  }

  cancel(sessionId: string) {
    const state = this.streams.get(sessionId);
    if (state?.abortController) state.abortController.abort();
  }

  buildMeta(state: StreamState) {
    const thinking: string[] = [];
    const tools: { runId: string; tool: string; input: unknown; output?: unknown }[] = [];
    let currentThinking = '';
    let lastWasThinking = false;

    for (const event of state.events) {
      if (event.type === 'thinking') {
        currentThinking += event.content || '';
        lastWasThinking = true;
      } else {
        if (lastWasThinking && currentThinking) {
          thinking.push(currentThinking);
          currentThinking = '';
        }
        lastWasThinking = false;
      }
      if (event.type === 'tool_start') {
        tools.push({ runId: event.runId!, tool: event.tool!, input: event.input });
      }
      if (event.type === 'tool_end') {
        const t = tools.find(t => t.runId === event.runId);
        if (t) t.output = event.output;
      }
    }
    if (currentThinking) thinking.push(currentThinking);

    const elapsed = state.startTime ? Date.now() - state.startTime : 0;
    const hasRealUsage = state.usageData && (state.usageData.input_tokens > 0 || state.usageData.output_tokens > 0);
    const stats = {
      elapsed,
      inputTokens: hasRealUsage ? state.usageData!.input_tokens : Math.round((state.inputMessage || '').length / 4),
      outputTokens: hasRealUsage ? state.usageData!.output_tokens : Math.round((state.content || '').length / 4),
      cancelled: state.status === 'cancelled',
      estimated: !hasRealUsage,
    };

    if (thinking.length === 0 && tools.length === 0 && !stats.elapsed) return null;
    return { thinking, tools, stats };
  }

  private async _process(sessionId: string, response: Response, state: StreamState) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
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

            if (event.type === 'task_id') {
              state.taskId = event.taskId || null;
              continue;
            }

            // Normalize typeless error events (e.g. {"error":"..."})
            if (!event.type && event.error) {
              event.type = 'error';
            }

            state.events.push(event);

            if (event.type === 'content' && event.content) state.content += event.content;
            if (event.type === 'usage') {
              state.usageData = {
                input_tokens: event.input_tokens || 0,
                output_tokens: event.output_tokens || 0,
                total_tokens: event.total_tokens || 0,
              };
            }
            if (event.error) state.error = event.error;

            for (const cb of state.listeners) cb(event);
          } catch { /* ignore parse errors */ }
        }
      }
      state.status = 'done';
    } catch (e: unknown) {
      const err = e as Error;
      state.status = err.name === 'AbortError' ? 'cancelled' : 'error';
      if (err.name !== 'AbortError') state.error = err.message;
    }

    if (state.content || state.events.length > 0) {
      const meta = this.buildMeta(state);
      sessionStore.addMessage(sessionId, 'assistant', state.content || '', meta || undefined);
    }

    for (const cb of state.listeners) {
      cb({ type: '_stream_end', status: state.status } as StreamEvent);
    }

    setTimeout(() => {
      if (this.streams.get(sessionId) === state) {
        this.streams.delete(sessionId);
      }
    }, 10000);
  }
}

export const streamManager = new StreamManager();
