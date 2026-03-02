import type {
  ChatModel,
  ChatModelResponse,
  BaseMessage,
  ContentPart,
  StructuredTool,
  ToolCall,
} from '../types/llm-types.ts';
import { aiMessage, toolMessage, stripOldImages } from '../types/llm-types.ts';
import { logger } from '../logger.ts';

function countImages(messages: BaseMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content as ContentPart[]) {
        if (part.type === 'image') count++;
      }
    }
  }
  return count;
}

function estimateContextChars(messages: BaseMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as ContentPart[]) {
        if (part.type === 'text') chars += part.text.length;
        else if (part.type === 'image') chars += part.data.length;
      }
    }
  }
  return chars;
}

export interface ReActAgentConfig {
  model: ChatModel;
  tools: StructuredTool[];
  systemPrompt: string;
}

export interface StreamEvent {
  event: string;
  name?: string;
  run_id?: string;
  data: Record<string, unknown>;
}

const MAX_NO_TOOL_RETRIES = 3;

/**
 * Single source of truth for the ReAct loop.
 * Both invoke() and streamEvents() delegate here.
 */
async function* runLoop(
  allMessages: BaseMessage[],
  modelWithTools: ChatModel,
  toolMap: Map<string, StructuredTool>,
  options?: { recursionLimit?: number; signal?: AbortSignal },
): AsyncGenerator<StreamEvent> {
  const maxIterations = options?.recursionLimit ?? 200;
  let noToolStreak = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const prepared = stripOldImages(allMessages);
    const contextChars = estimateContextChars(prepared);
    const contextKB = (contextChars / 1024).toFixed(1);
    const images = countImages(prepared);

    logger.info(
      `[ReactLoop] iteration ${i + 1} | messages: ${allMessages.length} | images: ${images} | context: ${contextKB} KB (~${Math.round(contextChars / 4).toLocaleString()} tokens)`,
    );

    yield {
      event: 'on_react_iteration',
      data: { iteration: i + 1, messageCount: allMessages.length, imageCount: images, contextChars, inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    };

    // Stream LLM response
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let accumulatedToolCalls: ToolCall[] = [];
    let usageMetadata: ChatModelResponse['usage_metadata'] | undefined;

    for await (const chunk of modelWithTools.stream(prepared, { signal: options?.signal })) {
      if (chunk.content) {
        accumulatedContent += chunk.content;
        yield { event: 'on_chat_model_stream', data: { chunk: { content: chunk.content } } };
      }
      if (chunk.reasoning) {
        accumulatedReasoning += chunk.reasoning;
        yield { event: 'on_chat_model_stream', data: { chunk: { reasoning: chunk.reasoning } } };
      }
      if (chunk.tool_calls?.length) {
        accumulatedToolCalls = chunk.tool_calls;
      }
      if (chunk.usage_metadata) {
        usageMetadata = chunk.usage_metadata;
      }
    }

    if (usageMetadata) {
      totalInputTokens += usageMetadata.input_tokens;
      totalOutputTokens += usageMetadata.output_tokens;
    }

    yield {
      event: 'on_chat_model_end',
      data: {
        output: { content: accumulatedContent, tool_calls: accumulatedToolCalls, usage_metadata: usageMetadata },
      },
    };

    // Store reasoning in AI message content so the model retains memory of
    // what it observed/thought across iterations.
    const messageContent = [accumulatedReasoning, accumulatedContent].filter(Boolean).join('\n\n');
    allMessages.push(aiMessage(messageContent, accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined));

    // No tool calls — accept substantial text as final answer, nudge otherwise
    if (accumulatedToolCalls.length === 0) {
      if (accumulatedContent.trim().length > 50) {
        logger.info(`[ReactLoop] iteration ${i + 1} — text response (${accumulatedContent.trim().length} chars), accepting as final answer`);
        break;
      }
      noToolStreak++;
      if (noToolStreak >= MAX_NO_TOOL_RETRIES) {
        logger.warn(`[ReactLoop] iteration ${i + 1} — no tool calls after ${noToolStreak} attempts, accepting as final answer`);
        break;
      }
      logger.warn(`[ReactLoop] iteration ${i + 1} — no tool call (attempt ${noToolStreak}/${MAX_NO_TOOL_RETRIES}), nudging model`);
      allMessages.push({ role: 'human', content: 'You MUST call a tool. Do not respond with text. Pick a tool and call it now.' });
      continue;
    }

    noToolStreak = 0;

    // Execute tool calls
    for (const tc of accumulatedToolCalls) {
      if (options?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const runId = `run_${Math.random().toString(36).substring(7)}`;
      const tool = toolMap.get(tc.name);

      if (!tool) {
        const errorResult = `Tool "${tc.name}" not found`;
        allMessages.push(toolMessage(errorResult, tc.id, tc.name));
        yield { event: 'on_tool_start', name: tc.name, run_id: runId, data: { input: tc.args } };
        yield { event: 'on_tool_end', name: tc.name, run_id: runId, data: { output: errorResult } };
        continue;
      }

      yield { event: 'on_tool_start', name: tc.name, run_id: runId, data: { input: tc.args } };

      try {
        const result = await tool.invoke(tc.args);
        allMessages.push(toolMessage(result, tc.id, tc.name));
        yield { event: 'on_tool_end', name: tc.name, run_id: runId, data: { output: result } };
      } catch (error) {
        if (error instanceof Error && error.name === 'NodeInterrupt') throw error;
        const errMsg = error instanceof Error ? error.message : String(error);
        allMessages.push(toolMessage(`Error: ${errMsg}`, tc.id, tc.name));
        yield { event: 'on_tool_end', name: tc.name, run_id: runId, data: { output: `Error: ${errMsg}` } };
      }
    }
  }
}

export function createReActAgent(config: ReActAgentConfig) {
  const { model, tools, systemPrompt } = config;
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const modelWithTools = tools.length > 0 ? model.bindTools(tools) : model;

  return {
    async invoke(
      input: { messages: BaseMessage[] },
      options?: { recursionLimit?: number; signal?: AbortSignal },
    ): Promise<{ messages: BaseMessage[] }> {
      const allMessages: BaseMessage[] = [{ role: 'system', content: systemPrompt }, ...input.messages];
      for await (const _ of runLoop(allMessages, modelWithTools, toolMap, options)) { /* consume events */ }
      return { messages: allMessages };
    },

    async *streamEvents(
      input: { messages: BaseMessage[] },
      options?: { version?: string; recursionLimit?: number; signal?: AbortSignal },
    ): AsyncGenerator<StreamEvent> {
      const allMessages: BaseMessage[] = [{ role: 'system', content: systemPrompt }, ...input.messages];
      yield* runLoop(allMessages, modelWithTools, toolMap, options);
    },
  };
}
