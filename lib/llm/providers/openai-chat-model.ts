import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  contentToText,
  type ChatModel,
  type ChatModelResponse,
  type BaseMessage,
  type StructuredTool,
  type ToolCall,
} from '../../types/llm-types.ts';
import { logger } from '../../logger.ts';

/**
 * Streaming parser for <think>...</think> tags embedded in content.
 * Models like Qwen3.5 output reasoning in <think> tags as regular content
 * when the inference server (LM Studio, llama.cpp) doesn't natively separate
 * reasoning_content. This parser extracts think blocks and routes them to
 * the reasoning channel so they don't pollute the stored AI message content.
 */
class ThinkTagParser {
  private buffer = '';
  private insideThink = false;

  feed(text: string): { content: string; reasoning: string } {
    this.buffer += text;
    let content = '';
    let reasoning = '';

    while (this.buffer.length > 0) {
      if (this.insideThink) {
        const endIdx = this.buffer.indexOf('</think>');
        if (endIdx !== -1) {
          reasoning += this.buffer.slice(0, endIdx);
          this.buffer = this.buffer.slice(endIdx + 8);
          this.insideThink = false;
        } else {
          // Only buffer if there's a `<` that could start `</think>`
          const lastLt = this.buffer.lastIndexOf('<');
          const safe = (lastLt >= 0 && this.buffer.length - lastLt < 8) ? lastLt : this.buffer.length;
          reasoning += this.buffer.slice(0, safe);
          this.buffer = this.buffer.slice(safe);
          break;
        }
      } else {
        const startIdx = this.buffer.indexOf('<think>');
        if (startIdx !== -1) {
          content += this.buffer.slice(0, startIdx);
          this.buffer = this.buffer.slice(startIdx + 7);
          this.insideThink = true;
        } else {
          // Only buffer if there's a `<` that could start `<think>`
          const lastLt = this.buffer.lastIndexOf('<');
          const safe = (lastLt >= 0 && this.buffer.length - lastLt < 7) ? lastLt : this.buffer.length;
          content += this.buffer.slice(0, safe);
          this.buffer = this.buffer.slice(safe);
          break;
        }
      }
    }

    return { content, reasoning };
  }

  flush(): { content: string; reasoning: string } {
    const remaining = this.buffer;
    this.buffer = '';
    if (this.insideThink) return { content: '', reasoning: remaining };
    return { content: remaining, reasoning: '' };
  }
}

/**
 * Parse tool call arguments JSON. Local models (LM Studio, Ollama) sometimes
 * return malformed JSON (single quotes, trailing commas, unquoted keys).
 * Falls back to an empty object so one bad tool call doesn't crash the stream.
 */
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Try fixing common issues: single quotes → double quotes
    try {
      return JSON.parse(raw.replace(/'/g, '"'));
    } catch {
      logger.warn(`[OpenAI] Failed to parse tool args: ${raw.slice(0, 200)}`);
      return { _parseError: `Could not parse your tool arguments as JSON. Raw text: ${raw.slice(0, 300)}` };
    }
  }
}

interface OpenAIChatModelOptions {
  apiKey?: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string;
  streamUsage?: boolean;
  provider?: 'openai' | 'local';
  supportsVision?: boolean;
  reasoningBudget?: number;
}

export class OpenAIChatModel implements ChatModel {
  private client: OpenAI;
  private modelName: string;
  private temperature?: number;
  private maxTokens?: number;
  private streamUsage: boolean;
  private provider: 'openai' | 'local';
  private supportsVision: boolean;
  private isReasoningModel: boolean;
  private reasoningBudget: number;
  private boundTools?: StructuredTool[];
  private cachedProviderTools?: OpenAI.ChatCompletionTool[];
  private structuredSchema?: Record<string, unknown>;

  constructor(options: OpenAIChatModelOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? 'not-set',
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.modelName = options.modelName;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.streamUsage = options.streamUsage ?? true;
    this.provider = options.provider ?? 'openai';
    this.supportsVision = options.supportsVision ?? true;
    this.isReasoningModel = this.provider === 'openai' && /^o[134]/.test(this.modelName);
    this.reasoningBudget = options.reasoningBudget ?? 0;
  }

  /**
   * OpenAI tool messages only accept string or text-part arrays — no image_url.
   * Images from tool results are extracted and injected as a user message with
   * image_url parts after the tool message sequence ends.
   */
  private toOpenAIMessages(messages: BaseMessage[]): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    const pendingImages: Array<{ toolName: string; data: string; mediaType: string }> = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;

      switch (msg.role) {
        case 'system':
          result.push({ role: 'system', content: contentToText(msg.content) });
          break;
        case 'human':
          if (Array.isArray(msg.content)) {
            const parts: OpenAI.ChatCompletionContentPart[] = [];
            for (const p of msg.content) {
              if (p.type === 'image') {
                if (this.supportsVision) {
                  parts.push({ type: 'image_url' as const, image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
                } else {
                  parts.push({ type: 'text' as const, text: '[Image omitted — model does not support vision]' });
                }
              } else {
                parts.push({ type: 'text' as const, text: p.text });
              }
            }
            result.push({ role: 'user', content: parts });
          } else {
            result.push({ role: 'user', content: msg.content });
          }
          break;
        case 'ai': {
          const aiMsg: OpenAI.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: contentToText(msg.content) || null,
          };
          if (msg.tool_calls?.length) {
            aiMsg.tool_calls = msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            }));
          }
          result.push(aiMsg);
          break;
        }
        case 'tool': {
          // Tool messages: always text-only, buffer images for injection
          if (Array.isArray(msg.content)) {
            for (const p of msg.content) {
              if (p.type === 'image') {
                pendingImages.push({ toolName: msg.name ?? 'tool', data: p.data, mediaType: p.mediaType });
              }
            }
            result.push({
              role: 'tool',
              tool_call_id: msg.tool_call_id!,
              content: contentToText(msg.content) || 'Image captured.',
            });
          } else {
            result.push({
              role: 'tool',
              tool_call_id: msg.tool_call_id!,
              content: msg.content,
            });
          }

          // Flush images as a user message once the tool sequence ends
          const nextMsg = messages[i + 1];
          if (!this.supportsVision) pendingImages.length = 0;
          if (pendingImages.length > 0 && (!nextMsg || nextMsg.role !== 'tool')) {
            const label = pendingImages.map((img) => img.toolName).join(', ');
            const parts: OpenAI.ChatCompletionContentPart[] = [
              { type: 'text' as const, text: `[Image from ${label}]` },
              ...pendingImages.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mediaType};base64,${img.data}` },
              })),
            ];
            result.push({ role: 'user', content: parts });
            pendingImages.length = 0;
          }
          break;
        }
        default:
          result.push({ role: 'user', content: contentToText(msg.content) });
      }
    }

    return result;
  }

  private toOpenAITools(): OpenAI.ChatCompletionTool[] | undefined {
    if (this.cachedProviderTools) return this.cachedProviderTools;
    if (!this.boundTools?.length) return undefined;
    this.cachedProviderTools = this.boundTools.map((t) => {
      const { $schema, ...parameters } = zodToJsonSchema(t.schema) as Record<string, unknown>;
      return {
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters },
      };
    });
    return this.cachedProviderTools;
  }

  private parseToolCalls(
    choices: OpenAI.ChatCompletion.Choice[]
  ): ToolCall[] | undefined {
    const toolCalls = choices[0]?.message?.tool_calls;
    if (!toolCalls?.length) return undefined;
    return toolCalls
      .filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: parseToolArgs(tc.function.arguments),
      }));
  }

  async invoke(messages: BaseMessage[]): Promise<ChatModelResponse> {
    const tools = this.toOpenAITools();
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming & { enable_thinking?: boolean } = {
      model: this.modelName,
      messages: this.toOpenAIMessages(messages),
      ...(!this.isReasoningModel && this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.maxTokens
        ? this.isReasoningModel
          ? { max_completion_tokens: this.maxTokens }
          : { max_tokens: this.maxTokens }
        : {}),
      ...(tools ? { tools } : {}),
      ...(this.structuredSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'structured_output',
                schema: this.structuredSchema,
                strict: true,
              },
            },
          }
        : {}),
      ...(this.reasoningBudget > 0 ? { enable_thinking: true } : {}),
    };

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0]!;
    let reasoning = (choice.message as any)?.reasoning_content ?? '';
    let content = choice.message.content ?? '';

    // Extract <think> tags from content (Qwen3.5 and similar models)
    if (!reasoning && content.includes('<think>')) {
      content = content.replace(/<think>([\s\S]*?)<\/think>/g, (_, think) => {
        reasoning += think;
        return '';
      }).trim();
    }

    if (reasoning) {
      logger.debug(`[OpenAI] Reasoning content received (${reasoning.length} chars)`);
    }

    return {
      content,
      ...(reasoning ? { reasoning } : {}),
      tool_calls: this.parseToolCalls(response.choices),
      usage_metadata: response.usage
        ? {
            input_tokens: response.usage.prompt_tokens,
            output_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *stream(
    messages: BaseMessage[],
    options?: { signal?: AbortSignal }
  ): AsyncIterable<ChatModelResponse> {
    const tools = this.toOpenAITools();
    const params: OpenAI.ChatCompletionCreateParamsStreaming & { enable_thinking?: boolean } = {
      model: this.modelName,
      messages: this.toOpenAIMessages(messages),
      stream: true,
      stream_options: this.streamUsage ? { include_usage: true } : undefined,
      ...(!this.isReasoningModel && this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.maxTokens
        ? this.isReasoningModel
          ? { max_completion_tokens: this.maxTokens }
          : { max_tokens: this.maxTokens }
        : {}),
      ...(tools ? { tools } : {}),
      ...(this.reasoningBudget > 0 ? { enable_thinking: true } : {}),
    };

    const stream = await this.client.chat.completions.create(params, {
      signal: options?.signal,
    });

    let accumulatedToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let chunkCount = 0;
    const thinkParser = new ThinkTagParser();

    for await (const chunk of stream) {
      chunkCount++;
      const delta = chunk.choices[0]?.delta;

      // Yield content chunks — parse <think> tags from models like Qwen3.5
      // that embed reasoning in content instead of using reasoning_content
      if (delta?.content) {
        const parsed = thinkParser.feed(delta.content);
        if (parsed.content) yield { content: parsed.content };
        if (parsed.reasoning) yield { content: '', reasoning: parsed.reasoning };
      }

      // Yield reasoning chunks (native API support, e.g. reasoning_content)
      const reasoning = (delta as any)?.reasoning_content;
      if (reasoning) {
        yield { content: '', reasoning };
      }

      // Accumulate tool call deltas
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = accumulatedToolCalls.get(tc.index);
          if (existing) {
            existing.args += tc.function?.arguments ?? '';
          } else {
            accumulatedToolCalls.set(tc.index, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          }
        }
      }

      // Yield usage from final chunk
      if (chunk.usage) {
        const toolCalls: ToolCall[] | undefined = accumulatedToolCalls.size > 0
          ? Array.from(accumulatedToolCalls.values()).map((tc) => ({
              id: tc.id,
              name: tc.name,
              args: parseToolArgs(tc.args),
            }))
          : undefined;

        yield {
          content: '',
          tool_calls: toolCalls,
          usage_metadata: {
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          },
        };
        accumulatedToolCalls.clear();
      }
    }

    // Flush any remaining buffered content from <think> tag parsing
    const remaining = thinkParser.flush();
    if (remaining.content) yield { content: remaining.content };
    if (remaining.reasoning) yield { content: '', reasoning: remaining.reasoning };

    logger.debug(`[OpenAI] stream completed — ${chunkCount} chunks`);

    // Flush any tool calls that weren't yielded (LM Studio / local models
    // often don't send a usage chunk, so the block above never fires).
    if (accumulatedToolCalls.size > 0) {
      yield {
        content: '',
        tool_calls: Array.from(accumulatedToolCalls.values()).map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: parseToolArgs(tc.args),
        })),
      };
    }
  }

  bindTools(tools: StructuredTool[]): ChatModel {
    const bound = new OpenAIChatModel({
      apiKey: this.client.apiKey,
      modelName: this.modelName,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      streamUsage: this.streamUsage,
      provider: this.provider,
      supportsVision: this.supportsVision,
      reasoningBudget: this.reasoningBudget,
    });
    bound.boundTools = tools;
    bound.structuredSchema = this.structuredSchema;
    // Share the same client instance
    bound.client = this.client;
    return bound;
  }

  withStructuredOutput(schema: Record<string, unknown>): ChatModel {
    const wrapped = new OpenAIChatModel({
      apiKey: this.client.apiKey,
      modelName: this.modelName,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      streamUsage: this.streamUsage,
      provider: this.provider,
      supportsVision: this.supportsVision,
      reasoningBudget: this.reasoningBudget,
    });
    wrapped.structuredSchema = schema;
    wrapped.boundTools = this.boundTools;
    wrapped.client = this.client;
    return wrapped;
  }
}
