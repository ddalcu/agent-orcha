import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ChatModel, ChatModelResponse, BaseMessage, StructuredTool } from '../types/llm-types.ts';
import type { P2PManager } from './p2p-manager.ts';
import type { P2PWireMessage, P2PWireTool } from './types.ts';

function toWireMessages(messages: BaseMessage[]): P2PWireMessage[] {
  return messages.map(m => {
    const role = m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : m.role;
    const content = typeof m.content === 'string'
      ? m.content
      : m.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('');

    const wire: P2PWireMessage = { role, content };
    if (m.tool_calls?.length) wire.tool_calls = m.tool_calls;
    if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
    if (m.name) wire.name = m.name;
    return wire;
  });
}

export class P2PChatModel implements ChatModel {
  private manager: P2PManager;
  private peerId: string;
  private modelName: string;
  private temperature?: number;
  private serializedTools?: P2PWireTool[];

  constructor(manager: P2PManager, peerId: string, modelName: string, temperature?: number, serializedTools?: P2PWireTool[]) {
    this.manager = manager;
    this.peerId = peerId;
    this.modelName = modelName;
    this.temperature = temperature;
    this.serializedTools = serializedTools;
  }

  async invoke(messages: BaseMessage[]): Promise<ChatModelResponse> {
    const wireMessages = toWireMessages(messages);

    let content = '';
    let reasoning = '';
    let toolCalls: ChatModelResponse['tool_calls'];
    let usage: ChatModelResponse['usage_metadata'] | undefined;

    for await (const chunk of this.manager.invokeRemoteLLM(this.peerId, this.modelName, wireMessages, this.temperature, undefined, this.serializedTools)) {
      if (chunk.type === 'content') content += chunk.content;
      else if (chunk.type === 'thinking') reasoning += chunk.content;
      else if (chunk.type === 'tool_calls') toolCalls = (toolCalls ?? []).concat(chunk.tool_calls);
      else if (chunk.type === 'usage') usage = { input_tokens: chunk.input_tokens, output_tokens: chunk.output_tokens, total_tokens: chunk.total_tokens };
    }

    return {
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      ...(usage ? { usage_metadata: usage } : {}),
    };
  }

  async *stream(messages: BaseMessage[], options?: { signal?: AbortSignal }): AsyncIterable<ChatModelResponse> {
    const wireMessages = toWireMessages(messages);

    for await (const chunk of this.manager.invokeRemoteLLM(this.peerId, this.modelName, wireMessages, this.temperature, options?.signal, this.serializedTools)) {
      if (chunk.type === 'content') {
        yield { content: chunk.content };
      } else if (chunk.type === 'thinking') {
        yield { content: '', reasoning: chunk.content };
      } else if (chunk.type === 'tool_calls') {
        yield { content: '', tool_calls: chunk.tool_calls };
      } else if (chunk.type === 'usage') {
        yield { content: '', usage_metadata: { input_tokens: chunk.input_tokens, output_tokens: chunk.output_tokens, total_tokens: chunk.total_tokens } };
      }
    }
  }

  bindTools(tools: StructuredTool[]): ChatModel {
    const serialized: P2PWireTool[] = tools.map(t => {
      const { $schema, ...parameters } = zodToJsonSchema(t.schema) as Record<string, unknown>;
      return { name: t.name, description: t.description, parameters };
    });
    return new P2PChatModel(this.manager, this.peerId, this.modelName, this.temperature, serialized);
  }

  withStructuredOutput(_schema: Record<string, unknown>): ChatModel {
    return this;
  }
}
