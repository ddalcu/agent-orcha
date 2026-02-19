import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  ChatModel,
  ChatModelResponse,
  BaseMessage,
  StructuredTool,
  ToolCall,
} from '../../types/llm-types.ts';

interface AnthropicChatModelOptions {
  apiKey?: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
}

export class AnthropicChatModel implements ChatModel {
  private client: Anthropic;
  private modelName: string;
  private temperature?: number;
  private maxTokens: number;
  private boundTools?: StructuredTool[];
  private structuredSchema?: Record<string, unknown>;

  constructor(options: AnthropicChatModelOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? 'not-set' });
    this.modelName = options.modelName;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens ?? 4096;
  }

  private extractSystemAndMessages(
    messages: BaseMessage[]
  ): { system: string | undefined; messages: Anthropic.MessageParam[] } {
    let system: string | undefined;
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = system ? `${system}\n\n${msg.content}` : msg.content;
        continue;
      }

      if (msg.role === 'human') {
        anthropicMessages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'ai') {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
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

    return { system, messages: anthropicMessages };
  }

  private toAnthropicTools(): Anthropic.Tool[] | undefined {
    if (!this.boundTools?.length) return undefined;
    return this.boundTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.schema) as Anthropic.Tool.InputSchema,
    }));
  }

  private parseResponse(response: Anthropic.Message): ChatModelResponse {
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
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

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.modelName,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.toAnthropicTools() ? { tools: this.toAnthropicTools() } : {}),
    };

    const response = await this.client.messages.create(params);
    return this.parseResponse(response);
  }

  async *stream(
    messages: BaseMessage[],
    options?: { signal?: AbortSignal }
  ): AsyncIterable<ChatModelResponse> {
    const { system, messages: anthropicMessages } = this.extractSystemAndMessages(messages);

    const stream = this.client.messages.stream({
      model: this.modelName,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.toAnthropicTools() ? { tools: this.toAnthropicTools() } : {}),
    }, { signal: options?.signal });

    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { content: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          const existing = toolCalls.get(event.index);
          if (existing) {
            existing.args += event.delta.partial_json;
          }
        }
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolCalls.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            args: '',
          });
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

        yield {
          content: '',
          tool_calls: parsedToolCalls,
          usage_metadata: event.usage
            ? {
                input_tokens: 0,
                output_tokens: event.usage.output_tokens,
                total_tokens: event.usage.output_tokens,
              }
            : undefined,
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
    });
    wrapped.client = this.client;
    wrapped.structuredSchema = schema;
    wrapped.boundTools = this.boundTools;
    return wrapped;
  }
}
