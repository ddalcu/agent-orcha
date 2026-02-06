import { createAgent } from "langchain";
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentDefinition, AgentInstance, AgentResult, AgentInvokeOptions } from './types.js';
import { LLMFactory } from '../llm/llm-factory.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ConversationStore } from '../memory/conversation-store.js';
import type { SkillLoader } from '../skills/skill-loader.js';
import { StructuredOutputWrapper } from './structured-output-wrapper.js';
import { logLLMCallStart, logLLMCallEnd } from '../llm/llm-call-logger.js';
import { logger } from '../logger.js';

export class AgentExecutor {
  private toolRegistry: ToolRegistry;
  private conversationStore: ConversationStore;
  private skillLoader?: SkillLoader;

  constructor(toolRegistry: ToolRegistry, conversationStore: ConversationStore, skillLoader?: SkillLoader) {
    this.toolRegistry = toolRegistry;
    this.conversationStore = conversationStore;
    this.skillLoader = skillLoader;
  }

  async createInstance(definition: AgentDefinition): Promise<AgentInstance> {
    // Resolve skills and augment system prompt if configured
    let augmentedDefinition = definition;
    let skillsNeedSandbox = false;

    if (definition.skills && this.skillLoader) {
      const { content, needsSandbox } = this.skillLoader.resolveForAgentWithMeta(definition.skills);
      skillsNeedSandbox = needsSandbox;
      if (content) {
        augmentedDefinition = {
          ...definition,
          prompt: {
            ...definition.prompt,
            system: `${definition.prompt.system}\n\n${content}`,
          },
        };
      }
    }

    let llm = LLMFactory.create(augmentedDefinition.llm);

    // Wrap LLM with structured output if configured
    llm = StructuredOutputWrapper.wrapLLM(llm, augmentedDefinition.output);

    const tools = await this.toolRegistry.resolveTools(augmentedDefinition.tools);

    // Auto-inject sandbox tool if any skill requires it
    if (skillsNeedSandbox) {
      const sandboxTools = this.toolRegistry.getAllSandboxTools();
      if (sandboxTools.length > 0) {
        tools.push(...sandboxTools);
        logger.info(`[AgentExecutor] Auto-injected sandbox tool for agent: ${definition.name}`);
      } else {
        logger.warn(`[AgentExecutor] Skill requires sandbox but sandbox is not configured`);
      }
    }

    return {
      definition: augmentedDefinition,
      invoke: async (input) => this.invoke(augmentedDefinition, llm, tools, input),
      stream: (input) => this.stream(augmentedDefinition, llm, tools, input),
    };
  }

  private async invoke(
    definition: AgentDefinition,
    llm: BaseChatModel,
    tools: StructuredTool[],
    input: Record<string, unknown> | AgentInvokeOptions
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const { input: actualInput, sessionId } = this.parseInvokeOptions(input);

    if (tools.length > 0) {
      return this.invokeWithTools(definition, llm, tools, actualInput, startTime, sessionId);
    }

    return this.invokeWithoutTools(definition, llm, actualInput, startTime, sessionId);
  }

  private parseInvokeOptions(input: Record<string, unknown> | AgentInvokeOptions): {
    input: Record<string, unknown>;
    sessionId?: string;
  } {
    // Check if this is AgentInvokeOptions by checking for both 'input' property and if sessionId is present
    if ('input' in input && typeof input.input === 'object' && input.input !== null) {
      const options = input as AgentInvokeOptions;
      return {
        input: options.input,
        sessionId: options.sessionId,
      };
    }
    // Otherwise treat as direct input
    return { input: input as Record<string, unknown>, sessionId: undefined };
  }

  private async invokeWithTools(
    definition: AgentDefinition,
    llm: BaseChatModel,
    tools: StructuredTool[],
    input: Record<string, unknown>,
    startTime: number,
    sessionId?: string
  ): Promise<AgentResult> {
    try {
      const agent = createAgent({
        model: llm,
        tools,
        systemPrompt: definition.prompt.system,
      });

      const userMessage = this.formatUserMessage(definition, input);
      const messages = this.buildMessagesWithHistory(userMessage, sessionId);

      const caller = `Agent: ${definition.name}`;

      if (sessionId) {
        logger.info(`[${caller}] Using session: ${sessionId}`);
      }

      const { startTime: llmStart, stats } = logLLMCallStart({
        caller,
        systemPrompt: definition.prompt.system,
        messages,
        tools,
      });

      // Increase recursion limit to prevent premature termination
      // Default is 25, increase to 50 for complex workflows
      const result = await agent.invoke(
        {
          messages,
        },
        {
          recursionLimit: 50,
        }
      );

      const lastMsg = result.messages?.[result.messages.length - 1];
      const responseContent = lastMsg && 'content' in lastMsg ? String(lastMsg.content) : '';
      logLLMCallEnd(caller, llmStart, stats, {
        contentLength: responseContent.length,
        messageCount: result.messages?.length ?? 0,
      });

      if (!result.messages || result.messages.length === 0) {
        logger.warn(`[Agent: ${definition.name}] No messages returned`);
        return {
          output: 'Agent returned no response',
          metadata: {
            duration: Date.now() - startTime,
            toolCalls: [],
            sessionId,
            messagesInSession: sessionId ? this.conversationStore.getMessageCount(sessionId) : undefined,
          },
        };
      }

      const lastMessage = result.messages[result.messages.length - 1];
      let output: string | Record<string, unknown>;

      // Handle structured output
      if (definition.output?.format === 'structured') {
        output = this.extractStructuredOutput(lastMessage);
      } else if (typeof lastMessage === 'object' && lastMessage !== null) {
        if ('content' in lastMessage) {
          output = String(lastMessage.content);
        } else {
          output = JSON.stringify(lastMessage);
        }
      } else {
        output = String(lastMessage);
      }

      // Extract tool call summaries from the message chain and store with response
      if (sessionId && typeof output === 'string') {
        const toolSummaries = this.extractToolSummariesFromMessages(result.messages);
        const storedMessage = this.buildStoredMessage(output, toolSummaries);
        this.conversationStore.addMessage(sessionId, new AIMessage(storedMessage));
      }

      if (typeof output === 'string' && (!output || output === 'null' || output === 'undefined')) {
        logger.warn(`[Agent: ${definition.name}] Empty output, last message:`, lastMessage);
        output = 'Agent returned empty response';
      }

      logger.info(`[Agent: ${definition.name}] Output: ${typeof output === 'string' ? output.substring(0, 100) : JSON.stringify(output).substring(0, 100)}...`);

      // Validate structured output if applicable
      let structuredOutputValid: boolean | undefined;
      if (definition.output?.format === 'structured' && definition.output.schema) {
        const validation = StructuredOutputWrapper.validateOutput(output, definition.output.schema);
        structuredOutputValid = validation.valid;
        if (!validation.valid) {
          logger.warn(`[Agent: ${definition.name}] Structured output validation failed: ${validation.error}`);
        }
      }

      return {
        output,
        metadata: {
          duration: Date.now() - startTime,
          toolCalls: [],
          sessionId,
          messagesInSession: sessionId ? this.conversationStore.getMessageCount(sessionId) : undefined,
          structuredOutputValid,
        },
      };
    } catch (error) {
      logger.error(`[Agent: ${definition.name}] Error:`, error);
      return {
        output: `Agent error: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          duration: Date.now() - startTime,
          toolCalls: [],
          sessionId,
          messagesInSession: sessionId ? this.conversationStore.getMessageCount(sessionId) : undefined,
        },
      };
    }
  }

  private async invokeWithoutTools(
    definition: AgentDefinition,
    llm: BaseChatModel,
    input: Record<string, unknown>,
    startTime: number,
    sessionId?: string
  ): Promise<AgentResult> {
    const userMessage = this.formatUserMessage(definition, input);

    // Build messages with history for session-based conversations
    const messageHistory = sessionId ? this.conversationStore.getMessages(sessionId) : [];
    const allMessages = [
      new HumanMessage(definition.prompt.system),
      ...messageHistory,
      new HumanMessage(userMessage),
    ];

    // Store user message in session before invoking
    if (sessionId) {
      this.conversationStore.addMessage(sessionId, new HumanMessage(userMessage));
    }

    const caller = `Agent: ${definition.name}`;
    const { startTime: llmStart, stats } = logLLMCallStart({
      caller,
      systemPrompt: definition.prompt.system,
      messages: allMessages,
    });

    const result = await llm.invoke(allMessages);

    logLLMCallEnd(caller, llmStart, stats, {
      contentLength: typeof result.content === 'string' ? result.content.length : JSON.stringify(result.content).length,
    });

    let output: string | Record<string, unknown>;

    // Handle structured output
    if (definition.output?.format === 'structured') {
      output = this.extractStructuredOutput(result);
    } else {
      output = String(result.content);
    }

    // Store AI response in session
    if (sessionId && typeof output === 'string') {
      this.conversationStore.addMessage(sessionId, new AIMessage(output));
    }

    // Validate structured output if applicable
    let structuredOutputValid: boolean | undefined;
    if (definition.output?.format === 'structured' && definition.output.schema) {
      const validation = StructuredOutputWrapper.validateOutput(output, definition.output.schema);
      structuredOutputValid = validation.valid;
      if (!validation.valid) {
        logger.warn(`[Agent: ${definition.name}] Structured output validation failed: ${validation.error}`);
      }
    }

    return {
      output,
      metadata: {
        duration: Date.now() - startTime,
        sessionId,
        messagesInSession: sessionId ? this.conversationStore.getMessageCount(sessionId) : undefined,
        structuredOutputValid,
      },
    };
  }

  private formatUserMessage(definition: AgentDefinition, input: Record<string, unknown>): string {
    if (definition.prompt.inputVariables.length === 0) {
      return JSON.stringify(input);
    }

    if (definition.prompt.inputVariables.length === 1) {
      const key = definition.prompt.inputVariables[0];
      const value = key ? input[key] : undefined;
      return value !== undefined ? String(value) : '';
    }

    return definition.prompt.inputVariables
      .map((variable) => {
        const value = input[variable];
        return `${variable}: ${value !== undefined ? String(value) : ''}`;
      })
      .join('\n');
  }

  private async *stream(
    definition: AgentDefinition,
    llm: BaseChatModel,
    tools: StructuredTool[],
    input: Record<string, unknown> | AgentInvokeOptions
  ): AsyncGenerator<string | Record<string, unknown>, void, unknown> {
    const { input: actualInput, sessionId } = this.parseInvokeOptions(input);

    if (tools.length > 0) {
      const agent = createAgent({
        model: llm,
        tools,
        systemPrompt: definition.prompt.system,
      });

      const userMessage = this.formatUserMessage(definition, actualInput);
      const messages = this.buildMessagesWithHistory(userMessage, sessionId);

      const caller = `Agent: ${definition.name}`;
      const { startTime: llmStart, stats } = logLLMCallStart({
        caller,
        systemPrompt: definition.prompt.system,
        messages,
        tools,
      });

      const eventStream = await agent.streamEvents(
        { messages },
        {
          version: 'v2',
        }
      );

      let accumulatedOutput = '';
      let finalMessage: unknown = null;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const toolCallSummaries: Array<{ tool: string; input: unknown; output: unknown }> = [];
      const pendingToolCalls = new Map<string, { tool: string; input: unknown }>();

      try {
        for await (const event of eventStream) {
          if (event.event === 'on_chat_model_stream') {
            const chunk = event.data.chunk;
            const text = this.extractTextContent(chunk.content);
            if (text) {
              accumulatedOutput += text;
              yield { type: 'content', content: text };
            }
          } else if (event.event === 'on_chat_model_end') {
            finalMessage = event.data.output;
            const um = (event.data.output as any)?.usage_metadata;
            if (um) {
              totalInputTokens += um.input_tokens || 0;
              totalOutputTokens += um.output_tokens || 0;
            }
          } else if (event.event === 'on_tool_start') {
            pendingToolCalls.set(event.run_id, { tool: event.name, input: event.data.input });
            yield {
              type: 'tool_start',
              tool: event.name,
              input: event.data.input,
              runId: event.run_id,
            };
          } else if (event.event === 'on_tool_end') {
            const pending = pendingToolCalls.get(event.run_id);
            toolCallSummaries.push({
              tool: event.name,
              input: pending?.input ?? null,
              output: event.data.output,
            });
            pendingToolCalls.delete(event.run_id);
            yield {
              type: 'tool_end',
              tool: event.name,
              output: event.data.output,
              runId: event.run_id,
            };
          }
        }
      } catch (streamError) {
        const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
        logger.error(`[Agent: ${definition.name}] Stream error after tool calls:`, streamError);
        yield { type: 'error', error: errorMsg };

        // Still store what we have so far
        if (sessionId && (accumulatedOutput || toolCallSummaries.length > 0)) {
          const partialMessage = this.buildStoredMessage(
            accumulatedOutput || '(agent encountered an error)',
            toolCallSummaries
          );
          this.conversationStore.addMessage(sessionId, new AIMessage(partialMessage));
        }
        return;
      }

      logLLMCallEnd(caller, llmStart, stats, {
        contentLength: accumulatedOutput.length,
      });

      // Build the message to store: text response + tool call summaries
      const storedMessage = this.buildStoredMessage(accumulatedOutput, toolCallSummaries);

      // Handle structured output
      if (definition.output?.format === 'structured' && finalMessage) {
        const structuredOutput = this.extractStructuredOutput(finalMessage);
        yield { type: 'result', output: structuredOutput };

        if (sessionId) {
          this.conversationStore.addMessage(sessionId, new AIMessage(JSON.stringify(structuredOutput)));
        }
      } else if (sessionId && storedMessage) {
        this.conversationStore.addMessage(sessionId, new AIMessage(storedMessage));
      }

      // Yield usage stats if available
      if (totalInputTokens > 0 || totalOutputTokens > 0) {
        yield {
          type: 'usage',
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          total_tokens: totalInputTokens + totalOutputTokens,
        };
      }
    } else {
      const userMessage = this.formatUserMessage(definition, actualInput);

      // Build messages with history for session-based conversations
      const messageHistory = sessionId ? this.conversationStore.getMessages(sessionId) : [];
      const allMessages = [
        new HumanMessage(definition.prompt.system),
        ...messageHistory,
        new HumanMessage(userMessage),
      ];

      // Store user message in session before streaming
      if (sessionId) {
        this.conversationStore.addMessage(sessionId, new HumanMessage(userMessage));
      }

      const caller = `Agent: ${definition.name}`;
      const { startTime: llmStart, stats } = logLLMCallStart({
        caller,
        systemPrompt: definition.prompt.system,
        messages: allMessages,
      });

      const stream = await llm.stream(allMessages);

      let accumulatedOutput = '';
      let finalChunk: unknown = null;

      for await (const chunk of stream) {
        finalChunk = chunk;
        if (typeof chunk.content === 'string') {
          accumulatedOutput += chunk.content;
          yield { type: 'content', content: chunk.content };
        }
      }

      logLLMCallEnd(caller, llmStart, stats, {
        contentLength: accumulatedOutput.length,
      });

      // Handle structured output
      if (definition.output?.format === 'structured' && finalChunk) {
        const structuredOutput = this.extractStructuredOutput(finalChunk);
        yield { type: 'result', output: structuredOutput };

        // Store structured output as JSON string in session
        if (sessionId) {
          this.conversationStore.addMessage(sessionId, new AIMessage(JSON.stringify(structuredOutput)));
        }
      } else if (sessionId && accumulatedOutput) {
        // Store AI response in session after streaming completes
        this.conversationStore.addMessage(sessionId, new AIMessage(accumulatedOutput));
      }

      // Yield usage stats from the final chunk if available
      const um = (finalChunk as any)?.usage_metadata;
      if (um) {
        yield {
          type: 'usage',
          input_tokens: um.input_tokens ?? 0,
          output_tokens: um.output_tokens ?? 0,
          total_tokens: um.total_tokens ?? 0,
        };
      }
    }
  }

  private buildMessagesWithHistory(
    userMessage: string,
    sessionId?: string
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    // Add history from store
    if (sessionId && this.conversationStore.hasSession(sessionId)) {
      const history = this.conversationStore.getMessages(sessionId);
      for (const msg of history) {
        messages.push({
          role: msg._getType() === 'human' ? 'user' : 'assistant',
          content: String(msg.content),
        });
      }
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    // Store user message
    if (sessionId) {
      this.conversationStore.addMessage(sessionId, new HumanMessage(userMessage));
    }

    return messages;
  }

  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((block: any) => block.type === 'text' && block.text)
        .map((block: any) => block.text)
        .join('');
    }
    return '';
  }

  private buildStoredMessage(
    textResponse: string,
    toolSummaries: Array<{ tool: string; input: unknown; output: unknown }>
  ): string {
    if (toolSummaries.length === 0) return textResponse;

    const summaryLines = toolSummaries.map((tc) => {
      const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
      const outputStr = typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output);
      // Truncate to keep token usage reasonable
      const truncated = (s: string, max: number) => s.length > max ? s.slice(0, max) + '...' : s;
      return `[Tool: ${tc.tool}] Input: ${truncated(inputStr, 200)} → Output: ${truncated(outputStr, 500)}`;
    });

    return `${textResponse}\n\n<tool_history>\n${summaryLines.join('\n')}\n</tool_history>`;
  }

  private extractToolSummariesFromMessages(
    messages: unknown[]
  ): Array<{ tool: string; input: unknown; output: unknown }> {
    const summaries: Array<{ tool: string; input: unknown; output: unknown }> = [];
    if (!messages) return summaries;

    // Collect tool call inputs from AIMessages (tool_calls array)
    const toolCallInputs = new Map<string, { name: string; args: unknown }>();
    for (const msg of messages) {
      const m = msg as any;
      if (m?._getType?.() === 'ai' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          toolCallInputs.set(tc.id, { name: tc.name, args: tc.args });
        }
      }
    }

    // Match ToolMessages to their inputs
    for (const msg of messages) {
      const m = msg as any;
      if (m?._getType?.() === 'tool') {
        const callInfo = toolCallInputs.get(m.tool_call_id);
        summaries.push({
          tool: m.name ?? callInfo?.name ?? 'unknown',
          input: callInfo?.args ?? null,
          output: m.content ?? null,
        });
      }
    }
    return summaries;
  }

  private extractStructuredOutput(message: unknown): Record<string, unknown> {
    try {
      // If message is already an object, return it
      if (typeof message === 'object' && message !== null && !('content' in message)) {
        return message as Record<string, unknown>;
      }

      // If message has content property, try to parse it as JSON
      if (typeof message === 'object' && message !== null && 'content' in message) {
        const content = (message as { content: unknown }).content;

        if (typeof content === 'string') {
          // Try to parse JSON from string
          try {
            return JSON.parse(content) as Record<string, unknown>;
          } catch {
            // If parsing fails, return as-is wrapped in object
            return { content };
          }
        }

        if (typeof content === 'object' && content !== null) {
          return content as Record<string, unknown>;
        }
      }

      // Fallback: try to convert to object
      if (typeof message === 'string') {
        try {
          return JSON.parse(message) as Record<string, unknown>;
        } catch {
          return { content: message };
        }
      }

      return { content: String(message) };
    } catch (error) {
      logger.error('[AgentExecutor] Failed to extract structured output:', error);
      return { error: 'Failed to extract structured output' };
    }
  }
}
