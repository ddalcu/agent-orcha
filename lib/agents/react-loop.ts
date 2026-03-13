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
const MAX_SAME_TOOL_REPEATS = 3;

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
  const toolCallCounts = new Map<string, number>(); // "toolName:argsHash" → count

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
    const llmStart = Date.now();
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

    const llmTime = Date.now() - llmStart;

    if (accumulatedReasoning) {
      logger.debug(`[ReactLoop] iteration ${i + 1} — reasoning/thinking: ${accumulatedReasoning.length} chars`);
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
    const hasContent = messageContent.trim().length > 0;
    const hasToolCalls = accumulatedToolCalls.length > 0;

    // Only push AI message if it has content or tool calls — empty messages
    // confuse small LLMs (they see piling content:null and keep returning null)
    if (hasContent || hasToolCalls) {
      allMessages.push(aiMessage(messageContent, hasToolCalls ? accumulatedToolCalls : undefined));
    }

    // No tool calls — accept substantial text as final answer, nudge otherwise
    if (!hasToolCalls) {
      logger.info(`[ReactLoop] iteration ${i + 1} timing — LLM: ${(llmTime / 1000).toFixed(1)}s | no tools`);
      if (accumulatedContent.trim().length > 50 || (accumulatedReasoning && accumulatedContent.trim())) {
        logger.info(`[ReactLoop] iteration ${i + 1} — text response (${accumulatedContent.trim().length} chars), accepting as final answer`);
        break;
      }
      noToolStreak++;
      if (noToolStreak >= MAX_NO_TOOL_RETRIES) {
        logger.warn(`[ReactLoop] iteration ${i + 1} — no tool calls after ${noToolStreak} attempts, accepting as final answer`);
        break;
      }

      // Nudge the model based on context — small/local LLMs sometimes return
      // empty responses after tool results and need explicit guidance
      const lastMsg = allMessages[allMessages.length - 1];
      const nudge = lastMsg?.role === 'tool'
        ? 'The tool above returned results. Please respond to the user based on that data.'
        : 'Please continue. Either call a tool or provide your response.';
      logger.warn(`[ReactLoop] iteration ${i + 1} — empty response (attempt ${noToolStreak}/${MAX_NO_TOOL_RETRIES}), nudging model`);
      allMessages.push({ role: 'human', content: nudge });
      continue;
    }

    // Detect repeated identical tool calls (same tool + same args)
    let loopDetected = false;
    for (const tc of accumulatedToolCalls) {
      const key = `${tc.name}:${JSON.stringify(tc.args)}`;
      const count = (toolCallCounts.get(key) ?? 0) + 1;
      toolCallCounts.set(key, count);
      if (count >= MAX_SAME_TOOL_REPEATS) {
        logger.warn(`[ReactLoop] iteration ${i + 1} — tool "${tc.name}" called ${count} times with same args, breaking loop`);
        loopDetected = true;
      }
    }
    if (loopDetected) {
      allMessages.push(toolMessage(
        'You have already called this tool multiple times with the same arguments. Use the results you already have to answer the user.',
        accumulatedToolCalls[0]!.id,
        accumulatedToolCalls[0]!.name,
      ));
      noToolStreak++;
      if (noToolStreak >= MAX_NO_TOOL_RETRIES) {
        logger.warn(`[ReactLoop] iteration ${i + 1} — repeated loop detections (${noToolStreak}), stopping`);
        yield {
          event: 'on_loop_stopped',
          data: { reason: 'The model kept repeating the same tool calls and was stopped. Consider using a more capable model for this task.' },
        };
        break;
      }
      continue;
    }

    // Only reset streak when making genuine progress (non-repeated tool calls)
    noToolStreak = 0;

    // Execute tool calls in parallel
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const toolStart = Date.now();
    const toolEntries = accumulatedToolCalls.map((tc) => ({
      tc,
      runId: `run_${Math.random().toString(36).substring(7)}`,
      tool: toolMap.get(tc.name),
    }));

    // Emit all on_tool_start events before execution
    const pendingEvents: StreamEvent[] = [];
    for (const { tc, runId, tool } of toolEntries) {
      if (!tool) {
        pendingEvents.push({ event: 'on_tool_start', name: tc.name, run_id: runId, data: { input: tc.args } });
        pendingEvents.push({ event: 'on_tool_end', name: tc.name, run_id: runId, data: { output: `Tool "${tc.name}" not found` } });
      } else {
        pendingEvents.push({ event: 'on_tool_start', name: tc.name, run_id: runId, data: { input: tc.args } });
      }
    }
    for (const evt of pendingEvents) yield evt;

    // Run all tool calls concurrently
    const results = await Promise.all(
      toolEntries.map(async ({ tc, runId, tool }) => {
        if (!tool) {
          return { tc, runId, output: `Tool "${tc.name}" not found`, error: false };
        }
        try {
          const result = await tool.invoke(tc.args);
          return { tc, runId, output: result, error: false };
        } catch (error) {
          if (error instanceof Error && error.name === 'NodeInterrupt') throw error;
          const errMsg = error instanceof Error ? error.message : String(error);
          return { tc, runId, output: `Error: ${errMsg}`, error: true };
        }
      }),
    );

    // Push messages and emit on_tool_end events in original order
    for (const { tc, runId, output, error } of results) {
      const tool = toolMap.get(tc.name);
      if (!tool) {
        allMessages.push(toolMessage(output as string, tc.id, tc.name));
        continue; // on_tool_end already emitted above
      }
      allMessages.push(toolMessage(error ? output as string : output, tc.id, tc.name));
      yield { event: 'on_tool_end', name: tc.name, run_id: runId, data: { output } };
    }

    const toolTime = Date.now() - toolStart;
    logger.info(`[ReactLoop] iteration ${i + 1} timing — LLM: ${(llmTime / 1000).toFixed(1)}s | Tools: ${(toolTime / 1000).toFixed(1)}s (${accumulatedToolCalls.length} calls)`);
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
