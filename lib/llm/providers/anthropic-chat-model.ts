import Anthropic from '@anthropic-ai/sdk';
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

interface AnthropicChatModelOptions {
  apiKey?: string;
  baseURL?: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
}

export class AnthropicChatModel implements ChatModel {
  private client: Anthropic;
  private modelName: string;
  private temperature?: number;
  private maxTokens: number;
  private thinkingBudget?: number;
  private boundTools?: StructuredTool[];
  private cachedProviderTools?: Anthropic.Tool[];
  private structuredSchema?: Record<string, unknown>;

  constructor(options: AnthropicChatModelOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? 'not-set',
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.modelName = options.modelName;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens ?? 8192;
    this.thinkingBudget = options.thinkingBudget;
  }

  private extractSystemAndMessages(
    messages: BaseMessage[]
  ): { system: string | undefined; messages: Anthropic.MessageParam[] } {
    let system: string | undefined;
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = contentToText(msg.content);
        system = system ? `${system}\n\n${text}` : text;
        continue;
      }

      if (msg.role === 'human') {
        if (Array.isArray(msg.content)) {
          const blocks: Anthropic.ContentBlockParam[] = msg.content.map(p => {
            if (p.type === 'image') {
              return {
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: p.mediaType as 'image/jpeg', data: p.data },
              };
            }
            return { type: 'text' as const, text: p.text };
          });
          anthropicMessages.push({ role: 'user', content: blocks });
        } else {
          anthropicMessages.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'ai') {
        const content: Anthropic.ContentBlockParam[] = [];
        const text = contentToText(msg.content);
        if (text) {
          content.push({ type: 'text', text });
        }
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.args,
            });
          }
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        if (Array.isArray(msg.content)) {
          const blocks: Anthropic.ToolResultBlockParam['content'] = msg.content.map((p) => {
            if (p.type === 'image') {
              return {
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: p.mediaType as 'image/jpeg', data: p.data },
              };
            }
            return { type: 'text' as const, text: p.text };
          });
          anthropicMessages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id!,
                content: blocks,
              },
            ],
          });
        } else {
          anthropicMessages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id!,
                content: msg.content,
              },
            ],
          });
        }
      }
    }

    return { system, messages: anthropicMessages };
  }

  private toAnthropicTools(): Anthropic.Tool[] | undefined {
    if (this.cachedProviderTools) return this.cachedProviderTools;
    if (!this.boundTools?.length) return undefined;
    this.cachedProviderTools = this.boundTools.map((t) => {
      const { $schema, ...input_schema } = zodToJsonSchema(t.schema) as Record<string, unknown>;
      return {
        name: t.name,
        description: t.description,
        input_schema: input_schema as Anthropic.Tool.InputSchema,
      };
    });
    return this.cachedProviderTools;
  }

  private parseResponse(response: Anthropic.Message): ChatModelResponse {
    let content = '';
    let reasoning = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'thinking') {
        reasoning += (block as any).thinking;
      } else if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
      }
    }

    if (reasoning) {
      logger.debug(`[Anthropic] Thinking content received (${reasoning.length} chars)`);
    }

    return {
      content,
      ...(reasoning ? { reasoning } : {}),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage_metadata: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  async invoke(messages: BaseMessage[]): Promise<ChatModelResponse> {
    const { system, messages: anthropicMessages } = this.extractSystemAndMessages(messages);

    const tools = this.toAnthropicTools();
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.modelName,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(!this.thinkingBudget && this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(tools ? { tools } : {}),
      ...(this.thinkingBudget ? { thinking: { type: 'enabled' as const, budget_tokens: this.thinkingBudget } } : {}),
    };

    const response = await this.client.messages.create(params);
    return this.parseResponse(response);
  }

  async *stream(
    messages: BaseMessage[],
    options?: { signal?: AbortSignal }
  ): AsyncIterable<ChatModelResponse> {
    const { system, messages: anthropicMessages } = this.extractSystemAndMessages(messages);

    const tools = this.toAnthropicTools();
    const stream = this.client.messages.stream({
      model: this.modelName,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(!this.thinkingBudget && this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(tools ? { tools } : {}),
      ...(this.thinkingBudget ? { thinking: { type: 'enabled' as const, budget_tokens: this.thinkingBudget } } : {}),
    }, { signal: options?.signal });

    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let inputTokens = 0;

    for await (const event of stream) {
      if (event.type === 'message_start') {
        const msg = (event as any).message;
        if (msg?.usage?.input_tokens) {
          inputTokens = msg.usage.input_tokens;
        }
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolCalls.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            args: '',
          });
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { content: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          yield { content: '', reasoning: (event.delta as any).thinking };
        } else if (event.delta.type === 'input_json_delta') {
          const existing = toolCalls.get(event.index);
          if (existing) {
            existing.args += event.delta.partial_json;
          }
        }
      } else if (event.type === 'message_delta') {
        // Final message with usage
        const parsedToolCalls: ToolCall[] | undefined = toolCalls.size > 0
          ? Array.from(toolCalls.values()).map((tc) => ({
              id: tc.id,
              name: tc.name,
              args: JSON.parse(tc.args || '{}'),
            }))
          : undefined;

        const outputTokens = event.usage?.output_tokens ?? 0;
        yield {
          content: '',
          tool_calls: parsedToolCalls,
          usage_metadata: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        };
      }
    }
  }

  bindTools(tools: StructuredTool[]): ChatModel {
    const bound = new AnthropicChatModel({
      apiKey: this.client.apiKey ?? undefined,
      modelName: this.modelName,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      thinkingBudget: this.thinkingBudget,
    });
    bound.client = this.client;
    bound.boundTools = tools;
    bound.structuredSchema = this.structuredSchema;
    return bound;
  }

  withStructuredOutput(schema: Record<string, unknown>): ChatModel {
    const wrapped = new AnthropicChatModel({
      apiKey: this.client.apiKey ?? undefined,
      modelName: this.modelName,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      thinkingBudget: this.thinkingBudget,
    });
    wrapped.client = this.client;
    wrapped.structuredSchema = schema;
    wrapped.boundTools = this.boundTools;
    return wrapped;
  }
}
