import { z } from 'zod';

// --- Content Types ---

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string };

export type MessageContent = string | ContentPart[];

export function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('');
}

// --- Message Types ---

export type MessageRole = 'system' | 'human' | 'ai' | 'tool';

export interface BaseMessage {
  role: MessageRole;
  content: MessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export function humanMessage(content: MessageContent): BaseMessage {
  return { role: 'human', content };
}

export function aiMessage(content: string, tool_calls?: ToolCall[]): BaseMessage {
  return { role: 'ai', content, ...(tool_calls?.length ? { tool_calls } : {}) };
}

export function systemMessage(content: string): BaseMessage {
  return { role: 'system', content };
}

export function toolMessage(content: MessageContent, tool_call_id: string, name: string): BaseMessage {
  return { role: 'tool', content, tool_call_id, name };
}

/**
 * Returns a shallow copy of messages where images are stripped from all but the
 * last message that contains images — regardless of role (tool, human, etc.).
 * Keeps text parts intact. Prevents flooding context with stale images across
 * multi-turn conversations and tool loops.
 */
export function stripOldImages(messages: BaseMessage[]): BaseMessage[] {
  // Find the last message (any role) that contains images
  let lastImageIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (Array.isArray(messages[i]!.content) && (messages[i]!.content as ContentPart[]).some(p => p.type === 'image')) {
      lastImageIdx = i;
      break;
    }
  }

  if (lastImageIdx === -1) return messages;

  // Check if there are any older images worth stripping
  let hasOlderImages = false;
  for (let i = 0; i < lastImageIdx; i++) {
    if (Array.isArray(messages[i]!.content) && (messages[i]!.content as ContentPart[]).some(p => p.type === 'image')) {
      hasOlderImages = true;
      break;
    }
  }
  if (!hasOlderImages) return messages;

  return messages.map((msg, i) => {
    if (i >= lastImageIdx) return msg;
    if (!Array.isArray(msg.content)) return msg;

    const parts = msg.content as ContentPart[];
    const hasImage = parts.some(p => p.type === 'image');
    if (!hasImage) return msg;

    const textParts = parts.filter(p => p.type === 'text') as { type: 'text'; text: string }[];
    const imageCount = parts.length - textParts.length;
    const text = textParts.map(p => p.text).join(' ');
    return {
      ...msg,
      content: [{ type: 'text' as const, text: `${text} (${imageCount} image(s) omitted)` }],
    };
  });
}

// --- Document Type ---

export interface Document {
  pageContent: string;
  metadata: Record<string, unknown>;
}

// --- Tool Type ---

export interface StructuredTool {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  invoke(input: Record<string, unknown>): Promise<string | ContentPart[]>;
}

// --- Embeddings Interface ---

export interface Embeddings {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

// --- Chat Model Interface ---

export interface ChatModelResponse {
  content: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
  usage_metadata?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface ChatModel {
  invoke(messages: BaseMessage[]): Promise<ChatModelResponse>;
  stream(messages: BaseMessage[], options?: { signal?: AbortSignal }): AsyncIterable<ChatModelResponse>;
  bindTools(tools: StructuredTool[]): ChatModel;
  withStructuredOutput(schema: Record<string, unknown>): ChatModel;
}

// --- NodeInterrupt ---

export class NodeInterrupt extends Error {
  public readonly data: Record<string, unknown>;
  constructor(data: Record<string, unknown>) {
    super(data.question ? String(data.question) : 'Workflow interrupted');
    this.name = 'NodeInterrupt';
    this.data = data;
  }
}
