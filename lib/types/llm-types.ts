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

export interface CompactContextOptions {
  /** Number of recent iteration groups to keep in full (default: 6). */
  keepRecent?: number;
  /** Total iteration count at which a "wrap up" nudge is injected (default: 10). */
  nudgeAfter?: number;
}

/**
 * Compacts message history for the LLM by summarising old iterations.
 * Returns a NEW array — never mutates input.
 *
 * Layout: [system, firstHuman, <action_history summary>, ...recentFullMessages]
 * Falls through to stripOldImages when there are <= keepRecent iteration groups.
 */
export function compactContext(messages: BaseMessage[], options: CompactContextOptions = {}): BaseMessage[] {
  const keepRecent = options.keepRecent ?? 6;
  const nudgeAfter = options.nudgeAfter ?? 10;

  if (messages.length < 3) return stripOldImages(messages);

  const system = messages[0]!;
  const firstHuman = messages[1]!;

  // Parse iteration groups: each group = ai message + its subsequent tool messages
  interface IterationGroup { ai: BaseMessage; tools: BaseMessage[] }
  const groups: IterationGroup[] = [];
  let idx = 2;
  while (idx < messages.length) {
    const msg = messages[idx]!;
    if (msg.role === 'human') { idx++; continue; }      // skip nudge messages
    if (msg.role === 'ai') {
      const group: IterationGroup = { ai: msg, tools: [] };
      idx++;
      while (idx < messages.length && messages[idx]!.role === 'tool') {
        group.tools.push(messages[idx]!);
        idx++;
      }
      groups.push(group);
    } else {
      idx++;
    }
  }

  if (groups.length <= keepRecent) return stripOldImages(messages);

  const oldGroups = groups.slice(0, -keepRecent);
  const recentGroups = groups.slice(-keepRecent);

  // Summarise old groups into numbered action lines
  const lines: string[] = [];
  for (const group of oldGroups) {
    const toolCalls = group.ai.tool_calls ?? [];
    for (const tc of toolCalls) {
      const argsStr = JSON.stringify(tc.args);
      const args = argsStr.length > 120 ? argsStr.slice(0, 120) + '…' : argsStr;
      const toolResult = group.tools.find(t => t.tool_call_id === tc.id);
      const raw = toolResult ? contentToText(toolResult.content) : 'no result';
      const result = raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
      lines.push(`${lines.length + 1}. ${tc.name}(${args}) → ${result}`);
    }
    // Include the AI's reasoning/observations so the model remembers what it saw
    const aiText = contentToText(group.ai.content);
    if (aiText && toolCalls.length > 0) {
      const obs = aiText.length > 1000 ? aiText.slice(0, 1000) + '…' : aiText;
      lines.push(`   Observed: ${obs}`);
    }
    if (toolCalls.length === 0) {
      if (aiText) lines.push(`${lines.length + 1}. [response] ${aiText.length > 150 ? aiText.slice(0, 150) + '…' : aiText}`);
    }
  }

  // Flatten recent groups back into messages
  const recentMessages: BaseMessage[] = [];
  for (const group of recentGroups) {
    recentMessages.push(group.ai, ...group.tools);
  }

  const out: BaseMessage[] = [system, firstHuman];
  if (lines.length > 0) {
    let historyBlock = `<action_history>\nActions already completed (do NOT repeat these):\n${lines.join('\n')}`;
    // Nudge the model to stop when many iterations have passed
    if (groups.length >= nudgeAfter) {
      historyBlock += `\n\n** You have already performed ${groups.length} actions. If the observations above contain the information you need, STOP and respond with your final answer now. Combine data from multiple tool results — do NOT repeat actions you have already completed. **`;
    }
    historyBlock += '\n</action_history>';
    out.push({ role: 'human', content: historyBlock });
  }
  out.push(...recentMessages);
  return stripOldImages(out);
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
