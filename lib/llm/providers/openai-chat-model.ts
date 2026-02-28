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

interface OpenAIChatModelOptions {
  apiKey?: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string;
  streamUsage?: boolean;
}

export class OpenAIChatModel implements ChatModel {
  private client: OpenAI;
  private modelName: string;
  private temperature?: number;
  private maxTokens?: number;
  private streamUsage: boolean;
  private boundTools?: StructuredTool[];
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
            const parts: OpenAI.ChatCompletionContentPart[] = msg.content.map(p => {
              if (p.type === 'image') {
                return { type: 'image_url' as const, image_url: { url: `data:${p.mediaType};base64,${p.data}` } };
              }
              return { type: 'text' as const, text: p.text };
            });
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
    if (!this.boundTools?.length) return undefined;
    return this.boundTools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.schema) as Record<string, unknown>,
      },
    }));
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
        args: JSON.parse(tc.function.arguments || '{}'),
      }));
  }

  async invoke(messages: BaseMessage[]): Promise<ChatModelResponse> {
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.modelName,
      messages: this.toOpenAIMessages(messages),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
      ...(this.toOpenAITools() ? { tools: this.toOpenAITools() } : {}),
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
    };

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0]!;
    const reasoning = (choice.message as any)?.reasoning_content;

    return {
      content: choice.message.content ?? '',
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
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.modelName,
      messages: this.toOpenAIMessages(messages),
      stream: true,
      stream_options: this.streamUsage ? { include_usage: true } : undefined,
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
      ...(this.toOpenAITools() ? { tools: this.toOpenAITools() } : {}),
    };

    const stream = await this.client.chat.completions.create(params, {
      signal: options?.signal,
    });

    let accumulatedToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      // Yield content chunks
      if (delta?.content) {
        yield { content: delta.content };
      }

      // Yield reasoning chunks (e.g. Qwen3 reasoning_content)
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
              args: JSON.parse(tc.args || '{}'),
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
      }
    }
  }

  bindTools(tools: StructuredTool[]): ChatModel {
    const bound = new OpenAIChatModel({
      apiKey: this.client.apiKey,
      modelName: this.modelName,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      streamUsage: this.streamUsage,
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
    });
    wrapped.structuredSchema = schema;
    wrapped.boundTools = this.boundTools;
    wrapped.client = this.client;
    return wrapped;
  }
}
