
import { sessionStore } from './SessionStore.js';

class StreamManager {
    constructor() {
        this.streams = new Map();
    }

    start(sessionId, { response, abortController, streamType, inputMessage, responseId }) {
        const existing = this.streams.get(sessionId);
        if (existing?.abortController) {
            try { existing.abortController.abort(); } catch {}
        }

        const state = {
            streamType,
            abortController,
            inputMessage,
            responseId,
            content: '',
            events: [],
            status: 'streaming',
            startTime: Date.now(),
            usageData: null,
            error: null,
            listeners: new Set(),
        };

        this.streams.set(sessionId, state);
        this._process(sessionId, response, state);
        return state;
    }

    getState(sessionId) {
        return this.streams.get(sessionId) || null;
    }

    isActive(sessionId) {
        const s = this.streams.get(sessionId);
        return s?.status === 'streaming';
    }

    subscribe(sessionId, callback) {
        const state = this.streams.get(sessionId);
        if (!state) return () => {};
        state.listeners.add(callback);
        return () => state.listeners.delete(callback);
    }

    cancel(sessionId) {
        const state = this.streams.get(sessionId);
        if (state?.abortController) state.abortController.abort();
    }

    _buildMeta(state) {
        const thinking = [];
        const tools = [];
        let currentThinking = '';
        let lastWasThinking = false;

        for (const event of state.events) {
            if (event.type === 'thinking') {
                currentThinking += event.content;
                lastWasThinking = true;
            } else {
                if (lastWasThinking && currentThinking) {
                    thinking.push(currentThinking);
                    currentThinking = '';
                }
                lastWasThinking = false;
            }

            if (event.type === 'tool_start') {
                tools.push({ runId: event.runId, tool: event.tool, input: event.input });
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
            inputTokens: hasRealUsage ? state.usageData.input_tokens : Math.round((state.inputMessage || '').length / 4),
            outputTokens: hasRealUsage ? state.usageData.output_tokens : Math.round((state.content || '').length / 4),
            cancelled: state.status === 'cancelled',
            estimated: !hasRealUsage,
        };

        if (thinking.length === 0 && tools.length === 0 && !stats.elapsed) return null;
        return { thinking, tools, stats };
    }

    async _process(sessionId, response, state) {
        const reader = response.body.getReader();
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
                        const event = JSON.parse(data);
                        state.events.push(event);

                        if (state.streamType === 'agent') {
                            if (event.type === 'content') state.content += event.content;
                            if (event.type === 'usage') {
                                state.usageData = {
                                    input_tokens: event.input_tokens || 0,
                                    output_tokens: event.output_tokens || 0,
                                    total_tokens: event.total_tokens || 0,
                                };
                            }
                            if (event.error) state.error = event.error;
                        } else {
                            if (event.type === 'usage') {
                                state.usageData = {
                                    input_tokens: event.input_tokens || 0,
                                    output_tokens: event.output_tokens || 0,
                                    total_tokens: event.total_tokens || 0,
                                };
                            } else if (event.error) {
                                state.error = event.error;
                            } else if (event.content) {
                                state.content += event.content;
                            }
                        }

                        for (const cb of state.listeners) cb(event);
                    } catch (e) {
                        console.error('StreamManager parse error:', e);
                    }
                }
            }
            state.status = 'done';
        } catch (e) {
            state.status = e.name === 'AbortError' ? 'cancelled' : 'error';
            if (e.name !== 'AbortError') state.error = e.message;
        }

        if (state.content || state.events.length > 0) {
            const meta = this._buildMeta(state);
            sessionStore.addMessage(sessionId, 'assistant', state.content || '', meta);
        }

        for (const cb of state.listeners) {
            cb({ type: '_stream_end', status: state.status });
        }

        setTimeout(() => {
            if (this.streams.get(sessionId) === state) {
                this.streams.delete(sessionId);
            }
        }, 10000);
    }
}

export const streamManager = new StreamManager();
