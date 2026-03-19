import type { ChatModel, ChatModelResponse, BaseMessage, StructuredTool } from '../types/llm-types.ts';
import type { P2PManager } from './p2p-manager.ts';

export class P2PChatModel implements ChatModel {
  private manager: P2PManager;
  private peerId: string;
  private modelName: string;
  private temperature?: number;

  constructor(manager: P2PManager, peerId: string, modelName: string, temperature?: number) {
    this.manager = manager;
    this.peerId = peerId;
    this.modelName = modelName;
    this.temperature = temperature;
  }

  async invoke(messages: BaseMessage[]): Promise<ChatModelResponse> {
    const wireMessages = messages.map(m => ({
      role: m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : m.role,
      content: typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join(''),
    }));

    let content = '';
    let reasoning = '';
    let usage: ChatModelResponse['usage_metadata'] | undefined;

    for await (const chunk of this.manager.invokeRemoteLLM(this.peerId, this.modelName, wireMessages, this.temperature)) {
      if (chunk.type === 'content') content += chunk.content;
      else if (chunk.type === 'thinking') reasoning += chunk.content;
      else if (chunk.type === 'usage') usage = { input_tokens: chunk.input_tokens, output_tokens: chunk.output_tokens, total_tokens: chunk.total_tokens };
    }

    return { content, ...(reasoning ? { reasoning } : {}), ...(usage ? { usage_metadata: usage } : {}) };
  }

  async *stream(messages: BaseMessage[], options?: { signal?: AbortSignal }): AsyncIterable<ChatModelResponse> {
    const wireMessages = messages.map(m => ({
      role: m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : m.role,
      content: typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join(''),
    }));

    for await (const chunk of this.manager.invokeRemoteLLM(this.peerId, this.modelName, wireMessages, this.temperature, options?.signal)) {
      if (chunk.type === 'content') {
        yield { content: chunk.content };
      } else if (chunk.type === 'thinking') {
        yield { content: '', reasoning: chunk.content };
      } else if (chunk.type === 'usage') {
        yield { content: '', usage_metadata: { input_tokens: chunk.input_tokens, output_tokens: chunk.output_tokens, total_tokens: chunk.total_tokens } };
      }
    }
  }

  bindTools(_tools: StructuredTool[]): ChatModel {
    throw new Error('P2P LLMs do not support tool binding');
  }

  withStructuredOutput(_schema: Record<string, unknown>): ChatModel {
    throw new Error('P2P LLMs do not support structured output');
  }
}
