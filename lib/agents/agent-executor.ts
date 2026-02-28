import { createReActAgent } from './react-loop.ts';
import { humanMessage, aiMessage, contentToText } from '../types/llm-types.ts';
import type { ChatModel, BaseMessage, MessageContent, ContentPart } from '../types/llm-types.ts';
import type { StructuredTool } from '../types/llm-types.ts';
import type { AgentDefinition, AgentInstance, AgentResult, AgentInvokeOptions, AgentMemoryConfig } from './types.ts';
import { LLMFactory } from '../llm/llm-factory.ts';
import type { ToolRegistry } from '../tools/tool-registry.ts';
import type { ConversationStore } from '../memory/conversation-store.ts';
import type { SkillLoader } from '../skills/skill-loader.ts';
import type { MemoryManager } from '../memory/memory-manager.ts';
import type { IntegrationAccessor } from '../integrations/types.ts';
import { createMemorySaveTool } from '../tools/built-in/memory-save.tool.ts';
import { createIntegrationTools } from '../tools/built-in/integration-tools.ts';
import { StructuredOutputWrapper } from './structured-output-wrapper.ts';
import { logLLMCallStart, logLLMCallEnd } from '../llm/llm-call-logger.ts';
import { logger } from '../logger.ts';

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

export class AgentExecutor {
  private toolRegistry: ToolRegistry;
  private conversationStore: ConversationStore;
  private skillLoader?: SkillLoader;
  private memoryManager?: MemoryManager;
  private integrations?: IntegrationAccessor;

  constructor(toolRegistry: ToolRegistry, conversationStore: ConversationStore, skillLoader?: SkillLoader, memoryManager?: MemoryManager, integrations?: IntegrationAccessor) {
    this.toolRegistry = toolRegistry;
    this.conversationStore = conversationStore;
    this.skillLoader = skillLoader;
    this.memoryManager = memoryManager;
    this.integrations = integrations;
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

    // Resolve memory and augment system prompt if configured
    const memoryConfig = this.normalizeMemoryConfig(definition.memory);
    if (memoryConfig && this.memoryManager) {
      const memoryContent = await this.memoryManager.load(definition.name);
      const memoryPrompt = this.buildMemoryPrompt(memoryContent, memoryConfig.maxLines);
      augmentedDefinition = {
        ...augmentedDefinition,
        prompt: {
          ...augmentedDefinition.prompt,
          system: `${augmentedDefinition.prompt.system}\n\n${memoryPrompt}`,
        },
      };
    }

    let llm = LLMFactory.create(augmentedDefinition.llm);

    // Wrap LLM with structured output if configured
    llm = StructuredOutputWrapper.wrapLLM(llm, augmentedDefinition.output);

    const tools = await this.toolRegistry.resolveTools(augmentedDefinition.tools);

    // Auto-inject memory tool if configured
    if (memoryConfig && this.memoryManager) {
      tools.push(createMemorySaveTool(this.memoryManager, definition.name, memoryConfig.maxLines));
      logger.info(`[AgentExecutor] Auto-injected save_memory tool for agent: ${definition.name}`);
    }

    // Auto-inject sandbox tools if any skill requires it (skip already-declared ones)
    if (skillsNeedSandbox) {
      const existingNames = new Set(tools.map((t) => t.name));
      const sandboxTools = this.toolRegistry.getAllSandboxTools()
        .filter((t) => !existingNames.has(t.name));
      if (sandboxTools.length > 0) {
        tools.push(...sandboxTools);
        logger.info(`[AgentExecutor] Auto-injected ${sandboxTools.length} sandbox tools for agent: ${definition.name}`);
      } else if (this.toolRegistry.getAllSandboxTools().length === 0) {
        logger.warn(`[AgentExecutor] Skill requires sandbox but sandbox is not configured`);
      }
    }

    // Auto-inject integration tools if agent has integrations configured
    if (definition.integrations?.length && this.integrations) {
      const existingNames = new Set(tools.map((t) => t.name));
      const integrationTools = createIntegrationTools(this.integrations, definition.name)
        .filter((t) => !existingNames.has(t.name));
      if (integrationTools.length > 0) {
        tools.push(...integrationTools);
        logger.info(`[AgentExecutor] Auto-injected ${integrationTools.length} integration tools for agent: ${definition.name}`);
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
    llm: ChatModel,
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
    signal?: AbortSignal;
  } {
    // Check if this is AgentInvokeOptions by checking for both 'input' property and if sessionId is present
    if ('input' in input && typeof input.input === 'object' && input.input !== null) {
      const options = input as AgentInvokeOptions;
      return {
        input: options.input,
        sessionId: options.sessionId,
        signal: options.signal,
      };
    }
    // Otherwise treat as direct input
    return { input: input as Record<string, unknown>, sessionId: undefined };
  }

  private async invokeWithTools(
    definition: AgentDefinition,
    llm: ChatModel,
    tools: StructuredTool[],
    input: Record<string, unknown>,
    startTime: number,
    sessionId?: string
  ): Promise<AgentResult> {
    try {
      const agent = createReActAgent({
        model: llm,
        tools,
        systemPrompt: definition.prompt.system,
      });

      const userText = this.formatUserMessage(definition, input);
      const userContent = this.buildUserContent(userText, input);
      const messages = this.buildMessagesWithHistory(userContent, sessionId);

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

      logger.info(`[${caller}] Reaching LLM provider...`);

      const result = await agent.invoke(
        {
          messages,
        },
        {
          recursionLimit: 200,
          signal: undefined,
        }
      );

      const lastMsg = result.messages?.[result.messages.length - 1];
      const responseContent = lastMsg && 'content' in lastMsg ? contentToText(lastMsg.content) : '';
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
          output = contentToText(lastMessage.content);
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
        this.conversationStore.addMessage(sessionId, aiMessage(storedMessage));
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
      const errorMsg = isAbortError(error)
        ? 'Request was aborted'
        : (error instanceof Error ? error.message : String(error));
      logger.error(`[Agent: ${definition.name}] Error: ${errorMsg}`);
      return {
        output: `Agent error: ${errorMsg}`,
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
    llm: ChatModel,
    input: Record<string, unknown>,
    startTime: number,
    sessionId?: string
  ): Promise<AgentResult> {
    const userText = this.formatUserMessage(definition, input);
    const userContent = this.buildUserContent(userText, input);

    // Build messages with history for session-based conversations
    const messageHistory = sessionId ? this.conversationStore.getMessages(sessionId) : [];
    const allMessages: BaseMessage[] = [
      humanMessage(definition.prompt.system),
      ...messageHistory,
      humanMessage(userContent),
    ];

    // Store user message in session before invoking (text only — no base64 in memory)
    if (sessionId) {
      this.conversationStore.addMessage(sessionId, humanMessage(userText));
    }

    const caller = `Agent: ${definition.name}`;
    const { startTime: llmStart, stats } = logLLMCallStart({
      caller,
      systemPrompt: definition.prompt.system,
      messages: allMessages,
    });

    logger.info(`[${caller}] Reaching LLM provider...`);

    const result = await llm.invoke(allMessages);

    logLLMCallEnd(caller, llmStart, stats, {
      contentLength: result.content.length,
    });

    let output: string | Record<string, unknown>;

    // Handle structured output
    if (definition.output?.format === 'structured') {
      output = this.extractStructuredOutput(result);
    } else {
      output = contentToText(result.content);
    }

    // Store AI response in session
    if (sessionId && typeof output === 'string') {
      this.conversationStore.addMessage(sessionId, aiMessage(output));
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

  private buildUserContent(text: string, input: Record<string, unknown>): MessageContent {
    const attachments = input.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) return text;

    const parts: ContentPart[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const att of attachments) {
      if (att && typeof att.data === 'string' && typeof att.mediaType === 'string') {
        parts.push({ type: 'image', data: att.data, mediaType: att.mediaType });
      }
    }
    return parts.length > 0 ? parts : text;
  }

  private async *stream(
    definition: AgentDefinition,
    llm: ChatModel,
    tools: StructuredTool[],
    input: Record<string, unknown> | AgentInvokeOptions
  ): AsyncGenerator<string | Record<string, unknown>, void, unknown> {
    const { input: actualInput, sessionId, signal } = this.parseInvokeOptions(input);

    if (tools.length > 0) {
      const agent = createReActAgent({
        model: llm,
        tools,
        systemPrompt: definition.prompt.system,
      });

      const userText = this.formatUserMessage(definition, actualInput);
      const userContent = this.buildUserContent(userText, actualInput);
      const messages = this.buildMessagesWithHistory(userContent, sessionId);

      const caller = `Agent: ${definition.name}`;
      const { startTime: llmStart, stats } = logLLMCallStart({
        caller,
        systemPrompt: definition.prompt.system,
        messages,
        tools,
      });

      logger.info(`[${caller}] Reaching LLM provider...`);

      const eventStream = agent.streamEvents(
        { messages },
        {
          version: 'v2',
          recursionLimit: 200,
          signal,
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
            const chunk = event.data.chunk as any;
            const text = contentToText(chunk.content ?? '');
            if (text) {
              accumulatedOutput += text;
              yield { type: 'content', content: text };
            }
            if (chunk.reasoning) {
              yield { type: 'thinking', content: chunk.reasoning };
            }
          } else if (event.event === 'on_chat_model_end') {
            finalMessage = event.data.output;
            const um = (event.data.output as any)?.usage_metadata;
            if (um) {
              totalInputTokens += um.input_tokens || 0;
              totalOutputTokens += um.output_tokens || 0;
            }
          } else if (event.event === 'on_tool_start') {
            pendingToolCalls.set(event.run_id!, { tool: event.name!, input: event.data.input });
            yield {
              type: 'tool_start',
              tool: event.name,
              input: event.data.input,
              runId: event.run_id,
            };
          } else if (event.event === 'on_tool_end') {
            const pending = pendingToolCalls.get(event.run_id!);
            toolCallSummaries.push({
              tool: event.name!,
              input: pending?.input ?? null,
              output: event.data.output,
            });
            pendingToolCalls.delete(event.run_id!);
            yield {
              type: 'tool_end',
              tool: event.name,
              output: event.data.output,
              runId: event.run_id,
            };
          }
        }
      } catch (streamError) {
        const errorMsg = isAbortError(streamError)
          ? 'Request was aborted'
          : (streamError instanceof Error ? streamError.message : String(streamError));
        logger.error(`[Agent: ${definition.name}] Stream error: ${errorMsg}`);
        yield { type: 'error', error: errorMsg };

        // Still store what we have so far
        if (sessionId && (accumulatedOutput || toolCallSummaries.length > 0)) {
          const partialMessage = this.buildStoredMessage(
            accumulatedOutput || '(agent encountered an error)',
            toolCallSummaries
          );
          this.conversationStore.addMessage(sessionId, aiMessage(partialMessage));
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
          this.conversationStore.addMessage(sessionId, aiMessage(JSON.stringify(structuredOutput)));
        }
      } else if (sessionId && storedMessage) {
        this.conversationStore.addMessage(sessionId, aiMessage(storedMessage));
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
      const userText = this.formatUserMessage(definition, actualInput);
      const userContent = this.buildUserContent(userText, actualInput);

      // Build messages with history for session-based conversations
      const messageHistory = sessionId ? this.conversationStore.getMessages(sessionId) : [];
      const allMessages: BaseMessage[] = [
        humanMessage(definition.prompt.system),
        ...messageHistory,
        humanMessage(userContent),
      ];

      // Store user message in session before streaming (text only — no base64 in memory)
      if (sessionId) {
        this.conversationStore.addMessage(sessionId, humanMessage(userText));
      }

      const caller = `Agent: ${definition.name}`;
      const { startTime: llmStart, stats } = logLLMCallStart({
        caller,
        systemPrompt: definition.prompt.system,
        messages: allMessages,
      });

      logger.info(`[${caller}] Reaching LLM provider...`);

      const stream = llm.stream(allMessages, { signal });

      let accumulatedOutput = '';
      let finalChunk: unknown = null;

      for await (const chunk of stream) {
        finalChunk = chunk;
        if (typeof chunk.content === 'string' && chunk.content) {
          accumulatedOutput += chunk.content;
          yield { type: 'content', content: chunk.content };
        }
        if (chunk.reasoning) {
          yield { type: 'thinking', content: chunk.reasoning };
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
          this.conversationStore.addMessage(sessionId, aiMessage(JSON.stringify(structuredOutput)));
        }
      } else if (sessionId && accumulatedOutput) {
        // Store AI response in session after streaming completes
        this.conversationStore.addMessage(sessionId, aiMessage(accumulatedOutput));
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
    userContent: MessageContent,
    sessionId?: string
  ): BaseMessage[] {
    const messages: BaseMessage[] = [];

    // Add history from store
    if (sessionId && this.conversationStore.hasSession(sessionId)) {
      const history = this.conversationStore.getMessages(sessionId);
      for (const msg of history) {
        messages.push(msg);
      }
    }

    // Add current user message (with attachments if present)
    messages.push(humanMessage(userContent));

    // Store user message (text only — no base64 in memory)
    if (sessionId) {
      this.conversationStore.addMessage(sessionId, humanMessage(contentToText(userContent)));
    }

    return messages;
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
    messages: BaseMessage[]
  ): Array<{ tool: string; input: unknown; output: unknown }> {
    const summaries: Array<{ tool: string; input: unknown; output: unknown }> = [];
    if (!messages) return summaries;

    // Collect tool call inputs from AI messages (tool_calls array)
    const toolCallInputs = new Map<string, { name: string; args: unknown }>();
    for (const msg of messages) {
      if (msg.role === 'ai' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          toolCallInputs.set(tc.id, { name: tc.name, args: tc.args });
        }
      }
    }

    // Match tool messages to their inputs
    for (const msg of messages) {
      if (msg.role === 'tool') {
        const callInfo = toolCallInputs.get(msg.tool_call_id!);
        summaries.push({
          tool: msg.name ?? callInfo?.name ?? 'unknown',
          input: callInfo?.args ?? null,
          output: msg.content ?? null,
        });
      }
    }
    return summaries;
  }

  private normalizeMemoryConfig(
    raw?: AgentMemoryConfig
  ): { enabled: boolean; maxLines: number } | null {
    if (!raw) return null;
    if (typeof raw === 'boolean') return raw ? { enabled: true, maxLines: 100 } : null;
    if (!raw.enabled) return null;
    return { enabled: true, maxLines: raw.maxLines ?? 100 };
  }

  private buildMemoryPrompt(content: string, maxLines: number): string {
    const memoryBlock = content
      ? `<long_term_memory>\n${content}\n</long_term_memory>`
      : '<long_term_memory>\n(empty - no memories saved yet)\n</long_term_memory>';

    const instructions = `<memory_instructions>
You have long-term memory that persists across conversations.

The content inside <long_term_memory> above is your current saved memory.

You have a "save_memory" tool to update your memory. When you call it, provide the COMPLETE updated memory content (it replaces the entire file, it does not append).

Guidelines for using your memory:
- Save important facts, user preferences, decisions, and key context worth remembering
- Keep entries concise: use short bullet points, not full paragraphs
- Remove outdated or irrelevant entries when saving to keep memory focused
- Do not save trivial or easily re-derivable information
- Organize entries by topic or category when it helps clarity
- Your memory is limited to approximately ${maxLines} lines, so prioritize what matters most
</memory_instructions>`;

    return `${memoryBlock}\n\n${instructions}`;
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
