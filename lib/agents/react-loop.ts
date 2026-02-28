import type {
  ChatModel,
  ChatModelResponse,
  BaseMessage,
  StructuredTool,
  ToolCall,
} from '../types/llm-types.ts';
import { aiMessage, toolMessage } from '../types/llm-types.ts';

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

export function createReActAgent(config: ReActAgentConfig) {
  const { model, tools, systemPrompt } = config;
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const modelWithTools = tools.length > 0 ? model.bindTools(tools) : model;

  return {
    async invoke(
      input: { messages: BaseMessage[] },
      options?: { recursionLimit?: number; signal?: AbortSignal }
    ): Promise<{ messages: BaseMessage[] }> {
      const maxIterations = options?.recursionLimit ?? 200;
      const allMessages: BaseMessage[] = [
        { role: 'system', content: systemPrompt },
        ...input.messages,
      ];

      for (let i = 0; i < maxIterations; i++) {
        if (options?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        const response = await modelWithTools.invoke(allMessages);
        allMessages.push(
          aiMessage(response.content, response.tool_calls)
        );

        // No tool calls = final answer
        if (!response.tool_calls || response.tool_calls.length === 0) {
          break;
        }

        // Execute each tool call
        for (const tc of response.tool_calls) {
          if (options?.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          const tool = toolMap.get(tc.name);
          if (!tool) {
            allMessages.push(
              toolMessage(`Tool "${tc.name}" not found`, tc.id, tc.name)
            );
            continue;
          }

          try {
            const result = await tool.invoke(tc.args);
            allMessages.push(toolMessage(result, tc.id, tc.name));
          } catch (error) {
            // Re-throw NodeInterrupt for HITL support
            if (error instanceof Error && error.name === 'NodeInterrupt') {
              throw error;
            }
            const errMsg =
              error instanceof Error ? error.message : String(error);
            allMessages.push(
              toolMessage(`Error: ${errMsg}`, tc.id, tc.name)
            );
          }
        }
      }

      return { messages: allMessages };
    },

    async *streamEvents(
      input: { messages: BaseMessage[] },
      options?: {
        version?: string;
        recursionLimit?: number;
        signal?: AbortSignal;
      }
    ): AsyncGenerator<StreamEvent> {
      const maxIterations = options?.recursionLimit ?? 200;
      const allMessages: BaseMessage[] = [
        { role: 'system', content: systemPrompt },
        ...input.messages,
      ];

      for (let i = 0; i < maxIterations; i++) {
        if (options?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        // Stream the LLM response
        let accumulatedContent = '';
        let accumulatedToolCalls: ToolCall[] = [];
        let usageMetadata: ChatModelResponse['usage_metadata'] | undefined;

        for await (const chunk of modelWithTools.stream(allMessages, {
          signal: options?.signal,
        })) {
          if (chunk.content) {
            accumulatedContent += chunk.content;
            yield {
              event: 'on_chat_model_stream',
              data: { chunk: { content: chunk.content } },
            };
          }

          if (chunk.reasoning) {
            yield {
              event: 'on_chat_model_stream',
              data: { chunk: { reasoning: chunk.reasoning } },
            };
          }

          if (chunk.tool_calls?.length) {
            accumulatedToolCalls = chunk.tool_calls;
          }

          if (chunk.usage_metadata) {
            usageMetadata = chunk.usage_metadata;
          }
        }

        // Emit model end event with usage
        yield {
          event: 'on_chat_model_end',
          data: {
            output: {
              content: accumulatedContent,
              tool_calls: accumulatedToolCalls,
              usage_metadata: usageMetadata,
            },
          },
        };

        allMessages.push(
          aiMessage(accumulatedContent, accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined)
        );

        // No tool calls = final answer
        if (accumulatedToolCalls.length === 0) {
          break;
        }

        // Execute each tool call
        for (const tc of accumulatedToolCalls) {
          if (options?.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          const runId = `run_${Math.random().toString(36).substring(7)}`;
          const tool = toolMap.get(tc.name);

          if (!tool) {
            const errorResult = `Tool "${tc.name}" not found`;
            allMessages.push(toolMessage(errorResult, tc.id, tc.name));
            yield {
              event: 'on_tool_start',
              name: tc.name,
              run_id: runId,
              data: { input: tc.args },
            };
            yield {
              event: 'on_tool_end',
              name: tc.name,
              run_id: runId,
              data: { output: errorResult },
            };
            continue;
          }

          yield {
            event: 'on_tool_start',
            name: tc.name,
            run_id: runId,
            data: { input: tc.args },
          };

          try {
            const result = await tool.invoke(tc.args);
            allMessages.push(toolMessage(result, tc.id, tc.name));
            yield {
              event: 'on_tool_end',
              name: tc.name,
              run_id: runId,
              data: { output: result },
            };
          } catch (error) {
            // Re-throw NodeInterrupt for HITL support
            if (error instanceof Error && error.name === 'NodeInterrupt') {
              throw error;
            }
            const errMsg =
              error instanceof Error ? error.message : String(error);
            allMessages.push(toolMessage(`Error: ${errMsg}`, tc.id, tc.name));
            yield {
              event: 'on_tool_end',
              name: tc.name,
              run_id: runId,
              data: { output: `Error: ${errMsg}` },
            };
          }
        }
      }
    },
  };
}
