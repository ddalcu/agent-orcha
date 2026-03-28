import type { TaskEvent } from './types.ts';

/**
 * Buffers per-token streaming events (thinking/content) into complete text blocks.
 * Tool events (tool_start/tool_end) flush accumulated text and pass through immediately.
 * This reduces event counts from ~500+ per-token events to ~15-25 meaningful events.
 */
export class StreamEventBuffer {
  private pending: { type: string; content: string; timestamp: number } = { type: '', content: '', timestamp: 0 };
  private lastThinkingContent = '';
  private emitFn: (event: TaskEvent) => void;

  constructor(emitFn: (event: TaskEvent) => void) {
    this.emitFn = emitFn;
  }

  /** Push a streaming event into the buffer. Text tokens accumulate; tool events flush and pass through. */
  push(event: { type: string; content?: string; tool?: string; input?: unknown; output?: unknown }): void {
    if (event.type === 'thinking' || event.type === 'content') {
      // Type changed — flush the previous block
      if (this.pending.type && this.pending.type !== event.type) {
        this.flush();
      }
      if (!this.pending.type) {
        this.pending.type = event.type;
        this.pending.timestamp = Date.now();
      }
      this.pending.content += event.content || '';
    } else if (event.type === 'tool_start' || event.type === 'tool_end') {
      // Tool boundary — flush text, then emit the tool event immediately
      this.flush();
      const toolEvent: TaskEvent = { type: event.type, timestamp: Date.now() };
      if (event.tool) toolEvent.tool = event.tool;
      if (event.input !== undefined) toolEvent.input = event.input;
      if (event.output !== undefined) toolEvent.output = summarizeOutput(event.output);
      this.emitFn(toolEvent);
    } else {
      // Other event types (react_iteration, usage, etc.) — just flush pending text
      this.flush();
    }
  }

  /** Flush any buffered text as a single event. Must be called at stream end. */
  flush(): void {
    const text = this.pending.content.trim();
    if (!text) {
      this.pending = { type: '', content: '', timestamp: 0 };
      return;
    }
    // Deduplicate repeated identical thinking blocks
    if (this.pending.type === 'thinking' && text === this.lastThinkingContent) {
      this.pending = { type: '', content: '', timestamp: 0 };
      return;
    }
    if (this.pending.type === 'thinking') {
      this.lastThinkingContent = text;
    }
    this.emitFn({
      type: this.pending.type as TaskEvent['type'],
      timestamp: this.pending.timestamp,
      content: text,
    });
    this.pending = { type: '', content: '', timestamp: 0 };
  }
}

/** Strip base64 image data and truncate large strings so stored events stay small. */
export function summarizeOutput(output: unknown): unknown {
  if (typeof output === 'string') return output.length > 500 ? output.slice(0, 500) + '...' : output;
  if (Array.isArray(output)) {
    return output.map((p: any) => {
      if (p?.type === 'image') return { type: 'image', mediaType: p.mediaType, bytes: p.data?.length ?? 0 };
      if (p?.type === 'text') return p;
      return p;
    });
  }
  return output;
}
