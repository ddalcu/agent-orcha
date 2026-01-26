import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentDefinition, AgentInstance, AgentResult, AgentInvokeOptions } from './types.js';
import { LLMFactory } from '../llm/llm-factory.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ConversationStore } from '../memory/conversation-store.js';
import { StructuredOutputWrapper } from './structured-output-wrapper.js';
import { logger } from '../logger.js';

export class AgentExecutor {
  private toolRegistry: ToolRegistry;
  private conversationStore: ConversationStore;

  constructor(toolRegistry: ToolRegistry, conversationStore: ConversationStore) {
    this.toolRegistry = toolRegistry;
    this.conversationStore = conversationStore;
  }

  async createInstance(definition: AgentDefinition): Promise<AgentInstance> {
    let llm = LLMFactory.create(definition.llm);

    // Wrap LLM with structured output if configured
    llm = StructuredOutputWrapper.wrapLLM(llm, definition.output);

    const tools = await this.toolRegistry.resolveTools(definition.tools);

    return {
      definition,
      invoke: async (input) => this.invoke(definition, llm, tools, input),
      stream: (input) => this.stream(definition, llm, tools, input),
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
      const agent = createReactAgent({
        llm,
        tools,
        stateModifier: definition.prompt.system,
      });

      const userMessage = this.formatUserMessage(definition, input);
      const messages = this.buildMessagesWithHistory(userMessage, sessionId);

      logger.info(`[Agent: ${definition.name}] Invoking with ${tools.length} tools...`);
      logger.info(`[Agent: ${definition.name}] User message: ${userMessage.substring(0, 100)}...`);
      if (sessionId) {
        logger.info(`[Agent: ${definition.name}] Using session: ${sessionId} with ${messages.length} messages`);
      }

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

      logger.info(`[Agent: ${definition.name}] Got ${result.messages?.length ?? 0} messages`);

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

      // Store AI response in session
      if (sessionId && typeof output === 'string') {
        this.conversationStore.addMessage(sessionId, new AIMessage(output));
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

    const result = await llm.invoke(allMessages);

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
      const agent = createReactAgent({
        llm,
        tools,
        stateModifier: definition.prompt.system,
      });

      const userMessage = this.formatUserMessage(definition, actualInput);
      const messages = this.buildMessagesWithHistory(userMessage, sessionId);

      const eventStream = await agent.streamEvents(
        { messages },
        {
          version: 'v2',
        }
      );

      let accumulatedOutput = '';

      for await (const event of eventStream) {
        if (event.event === 'on_chat_model_stream') {
          const chunk = event.data.chunk;
          if (chunk.content) {
            accumulatedOutput += chunk.content;
            yield { type: 'content', content: chunk.content };
          }
        } else if (event.event === 'on_tool_start') {
          yield {
            type: 'tool_start',
            tool: event.name,
            input: event.data.input,
            runId: event.run_id,
          };
        } else if (event.event === 'on_tool_end') {
          yield {
            type: 'tool_end',
            tool: event.name,
            output: event.data.output,
            runId: event.run_id,
          };
        }
      }

      // Store AI response in session after streaming completes
      if (sessionId && accumulatedOutput) {
        this.conversationStore.addMessage(sessionId, new AIMessage(accumulatedOutput));
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

      const stream = await llm.stream(allMessages);

      let accumulatedOutput = '';

      for await (const chunk of stream) {
        if (typeof chunk.content === 'string') {
          accumulatedOutput += chunk.content;
          yield { type: 'content', content: chunk.content };
        }
      }

      // Store AI response in session after streaming completes
      if (sessionId && accumulatedOutput) {
        this.conversationStore.addMessage(sessionId, new AIMessage(accumulatedOutput));
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
