import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LlmModel, ChatMessage, CompletionOptions, ToolDefinition } from 'node-omni-orcha';
import type { ChatModel, ChatModelResponse, BaseMessage, StructuredTool, ToolCall } from '../../types/llm-types.ts';
import { OmniModelCache } from './omni-model-cache.ts';
import { logger } from '../../logger.ts';

export interface OmniChatModelOptions {
  modelPath: string;
  contextSize?: number;
  gpuLayers?: number;
  flashAttn?: boolean;
  temperature?: number;
  maxTokens?: number;
}

function convertMessages(messages: BaseMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('\n');

    const roleMap: Record<string, 'system' | 'user' | 'assistant' | 'tool'> = {
      system: 'system',
      human: 'user',
      ai: 'assistant',
      tool: 'tool',
    };

    // Convert tool_calls from Orcha format (args: object) to omni format (args: JSON string)
    const toolCalls = msg.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.name,
      args: JSON.stringify(tc.args),
    }));

    return {
      role: roleMap[msg.role] ?? 'user',
      content,
      ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
      ...(msg.name ? { name: msg.name } : {}),
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    };
  });
}

function convertToolDefs(tools: StructuredTool[]): ToolDefinition[] {
  return tools.map(t => {
    const { $schema, ...parameters } = zodToJsonSchema(t.schema) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}

let _callCounter = 0;
function convertToolCalls(raw: Array<{ id: string; name: string; args: string }> | undefined): ToolCall[] | undefined {
  if (!raw?.length) return undefined;
  return raw.map(tc => ({
    id: tc.id || `call_${++_callCounter}`,
    name: tc.name,
    args: typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args,
  }));
}

export class OmniChatModel implements ChatModel {
  private options: OmniChatModelOptions;
  private llm: LlmModel | null = null;
  private boundTools: StructuredTool[] = [];

  constructor(options: OmniChatModelOptions) {
    this.options = options;
  }

  private async ensureModel(): Promise<LlmModel> {
    if (!this.llm) {
      this.llm = await OmniModelCache.getLlmChat(this.options.modelPath, {
        contextSize: this.options.contextSize,
        gpuLayers: this.options.gpuLayers ?? -1,
        flashAttn: this.options.flashAttn ?? true,
      });
    }
    return this.llm;
  }

  private buildOpts(signal?: AbortSignal): CompletionOptions {
    const opts: CompletionOptions = {};
    if (this.options.temperature !== undefined) opts.temperature = this.options.temperature;
    if (this.options.maxTokens !== undefined) opts.maxTokens = this.options.maxTokens;
    if (signal) opts.signal = signal;
    if (this.boundTools.length > 0) {
      opts.tools = convertToolDefs(this.boundTools);
      opts.toolChoice = 'auto';
    }
    return opts;
  }

  async invoke(messages: BaseMessage[]): Promise<ChatModelResponse> {
    const model = await this.ensureModel();
    const converted = convertMessages(messages);
    const result = await model.complete(converted, this.buildOpts());

    return {
      content: result.content,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      ...(result.toolCalls?.length ? { tool_calls: convertToolCalls(result.toolCalls) } : {}),
      usage_metadata: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
      },
    };
  }

  async *stream(messages: BaseMessage[], options?: { signal?: AbortSignal }): AsyncIterable<ChatModelResponse> {
    const model = await this.ensureModel();
    const converted = convertMessages(messages);
    const opts = this.buildOpts(options?.signal);

    for await (const chunk of model.stream(converted, opts)) {
      yield {
        content: chunk.content ?? '',
        ...(chunk.toolCalls?.length ? { tool_calls: convertToolCalls(chunk.toolCalls) } : {}),
        ...(chunk.usage ? {
          usage_metadata: {
            input_tokens: chunk.usage.inputTokens,
            output_tokens: chunk.usage.outputTokens,
            total_tokens: chunk.usage.totalTokens,
          },
        } : {}),
      };
    }
  }

  bindTools(tools: StructuredTool[]): ChatModel {
    const bound = new OmniChatModel({ ...this.options });
    bound.llm = this.llm;
    bound.boundTools = tools;
    return bound;
  }

  withStructuredOutput(_schema: Record<string, unknown>): ChatModel {
    logger.warn('[OmniChatModel] Structured output not yet supported — returning self');
    return this;
  }
}
