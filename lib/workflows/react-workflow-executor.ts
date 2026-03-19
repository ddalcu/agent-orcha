import type { ChatModel, BaseMessage, StructuredTool } from '../types/llm-types.ts';
import { NodeInterrupt, aiMessage, toolMessage, contentToText, stripOldImages } from '../types/llm-types.ts';
import type {
  ReactWorkflowDefinition,
  WorkflowResult,
  WorkflowStatus,
  WorkflowInterrupt,
} from './types.ts';
import type { InterruptManager } from './interrupt-manager.ts';
import { ToolDiscovery } from '../tools/tool-discovery.ts';
import { LLMFactory } from '../llm/llm-factory.ts';
import { logLLMCallStart, logLLMCallEnd } from '../llm/llm-call-logger.ts';
import { logger } from '../logger.ts';

/**
 * Executes ReAct-style workflows (Reasoning + Acting).
 * Supports autonomous tool/agent discovery and human-in-the-loop via ask_user tool.
 */
export class ReactWorkflowExecutor {
  private toolDiscovery: ToolDiscovery;
  private interruptManager: InterruptManager;
  /** Stores thread message state for pause/resume and multi-turn continuations */
  private threadStates = new Map<string, { messages: BaseMessage[]; timestamp: number }>();
  private static readonly MAX_THREAD_STATES = 100;
  private static readonly THREAD_TTL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(toolDiscovery: ToolDiscovery, interruptManager: InterruptManager) {
    this.toolDiscovery = toolDiscovery;
    this.interruptManager = interruptManager;
  }

  async execute(
    definition: ReactWorkflowDefinition,
    input: Record<string, unknown>,
    threadId?: string,
    onStatus?: (status: WorkflowStatus) => void
  ): Promise<WorkflowResult> {
    const startTime = Date.now();
    const actualThreadId = threadId || this.generateThreadId();

    onStatus?.({
      type: 'workflow_start',
      message: `Starting ReAct workflow: ${definition.name}`,
      elapsed: 0,
    });

    try {
      // 1. Discover tools
      onStatus?.({
        type: 'tool_discovery',
        message: 'Discovering tools...',
        elapsed: Date.now() - startTime,
      });
      logger.info(`[ReactWorkflow] Discovering tools for workflow "${definition.name}"...`);
      const tools = await this.toolDiscovery.discoverAll(definition.graph.tools);
      onStatus?.({
        type: 'tool_discovery',
        message: `Discovered ${tools.length} tools`,
        elapsed: Date.now() - startTime,
      });
      logger.info(`[ReactWorkflow] Discovered ${tools.length} tools`);

      // 2. Discover agents
      onStatus?.({
        type: 'tool_discovery',
        message: 'Discovering agent tools...',
        elapsed: Date.now() - startTime,
      });
      logger.info(`[ReactWorkflow] Discovering agents for workflow "${definition.name}"...`);
      const agentTools = await this.toolDiscovery.discoverAgents(definition.graph.agents);
      onStatus?.({
        type: 'tool_discovery',
        message: `Discovered ${agentTools.length} agent tools`,
        elapsed: Date.now() - startTime,
      });
      logger.info(`[ReactWorkflow] Discovered ${agentTools.length} agent tools`);

      // 3. Combine all tools
      const allTools = [...tools, ...agentTools];
      onStatus?.({
        type: 'tool_discovery',
        message: `${allTools.length} total tools ready`,
        elapsed: Date.now() - startTime,
      });
      logger.info(`[ReactWorkflow] Total tools available: ${allTools.length}`);

      // 4. Get LLM
      const llm = await LLMFactory.create(definition.graph.model);

      // 5. Execute the ReAct loop
      const goal = this.interpolateGoal(definition.prompt.goal, input);
      logger.info(`[ReactWorkflow] Executing workflow with goal: ${goal}`);

      const messages: BaseMessage[] = [{ role: 'human', content: goal }];
      const result = await this.runReActLoop(
        llm,
        allTools,
        definition,
        messages,
        actualThreadId,
        onStatus,
        startTime
      );

      // Save thread state for multi-turn continuations (strip system message)
      this.saveThreadState(actualThreadId, result.slice(1));

      // 7. Extract output
      const output = this.extractOutput(definition.output, result);

      const duration = Date.now() - startTime;

      onStatus?.({
        type: 'workflow_complete',
        message: 'ReAct workflow completed',
        elapsed: duration,
      });

      logger.info(`[ReactWorkflow] Workflow completed in ${duration}ms`);

      return {
        output,
        metadata: {
          duration,
          stepsExecuted: result.length,
          success: true,
          threadId: actualThreadId,
        },
        stepResults: {},
      };
    } catch (error) {
      // Check if it's an interrupt
      if (error instanceof NodeInterrupt) {
        return this.handleInterrupt(
          error,
          definition,
          actualThreadId,
          startTime,
          onStatus
        );
      }

      const duration = Date.now() - startTime;

      onStatus?.({
        type: 'workflow_error',
        message: error instanceof Error ? error.message : String(error),
        elapsed: duration,
        error: String(error),
      });

      logger.error(`[ReactWorkflow] Workflow error:`, error);

      throw error;
    }
  }

  async resumeWithAnswer(
    definition: ReactWorkflowDefinition,
    threadId: string,
    answer: string,
    onStatus?: (status: WorkflowStatus) => void
  ): Promise<WorkflowResult> {
    const startTime = Date.now();

    logger.info(`[ReactWorkflow] Resuming workflow "${definition.name}" with thread ${threadId}`);

    // Resolve the interrupt
    const resolved = this.interruptManager.resolveInterrupt(threadId, answer);
    if (!resolved) {
      throw new Error(`No active interrupt found for thread ${threadId}`);
    }

    onStatus?.({
      type: 'workflow_start',
      message: `Resuming ReAct workflow: ${definition.name}`,
      elapsed: 0,
    });

    try {
      // 1. Discover tools (same as before)
      const tools = await this.toolDiscovery.discoverAll(definition.graph.tools);
      const agentTools = await this.toolDiscovery.discoverAgents(definition.graph.agents);
      const allTools = [...tools, ...agentTools];

      // 2. Get LLM
      const llm = await LLMFactory.create(definition.graph.model);

      // 3. Load saved thread state and append the user's answer
      const savedMessages = this.threadStates.get(threadId)?.messages ?? [];
      // Add the answer as a tool result for the pending ask_user call
      const lastAiMsg = [...savedMessages].reverse().find(m => m.role === 'ai' && m.tool_calls?.length);
      const askUserCall = lastAiMsg?.tool_calls?.find(tc => tc.name === 'ask_user');
      if (askUserCall) {
        savedMessages.push(toolMessage(answer, askUserCall.id, 'ask_user'));
      } else {
        // Fallback: add as a human message
        savedMessages.push({ role: 'human', content: answer });
      }

      // 4. Continue the ReAct loop
      const result = await this.runReActLoop(
        llm,
        allTools,
        definition,
        savedMessages,
        threadId,
        onStatus,
        startTime
      );

      // 5. Extract output
      const output = this.extractOutput(definition.output, result);

      const duration = Date.now() - startTime;

      onStatus?.({
        type: 'workflow_complete',
        message: 'ReAct workflow resumed and completed',
        elapsed: duration,
      });

      // Clean up interrupt state (keep thread state for continuations)
      this.interruptManager.removeInterrupt(threadId);
      this.saveThreadState(threadId, result.slice(1));

      return {
        output,
        metadata: {
          duration,
          stepsExecuted: result.length,
          success: true,
        },
        stepResults: {},
      };
    } catch (error) {
      // Check if it's another interrupt
      if (error instanceof NodeInterrupt) {
        return this.handleInterrupt(
          error,
          definition,
          threadId,
          startTime,
          onStatus
        );
      }

      const duration = Date.now() - startTime;

      onStatus?.({
        type: 'workflow_error',
        message: error instanceof Error ? error.message : String(error),
        elapsed: duration,
        error: String(error),
      });

      throw error;
    }
  }

  /**
   * Runs the ReAct loop: LLM -> tool calls -> LLM -> ... until done.
   * Returns the full message history.
   */
  private async runReActLoop(
    llm: ChatModel,
    tools: StructuredTool[],
    definition: ReactWorkflowDefinition,
    initialMessages: BaseMessage[],
    threadId: string,
    onStatus?: (status: WorkflowStatus) => void,
    loopStartTime?: number
  ): Promise<BaseMessage[]> {
    const executionMode = definition.graph.executionMode || 'react';
    const maxIterations = definition.graph.maxIterations ?? 200;
    const toolMap = new Map(tools.map(t => [t.name, t]));
    const elapsed = () => Date.now() - (loopStartTime || Date.now());

    const systemPrompt = definition.prompt.system + `\n\nWhen an agent returns a complete, well-formatted response, present it directly to the user without rewriting or summarizing. Only add your own commentary when combining outputs from multiple agents or when additional context is needed.`;

    const allMessages: BaseMessage[] = [
      { role: 'system', content: systemPrompt },
      ...initialMessages,
    ];

    let toolExecutionCount = 0;

    for (let i = 0; i < maxIterations; i++) {
      onStatus?.({
        type: 'react_iteration',
        message: `Iteration ${i + 1}: Reasoning...`,
        elapsed: elapsed(),
      });

      // In single-turn mode, after tools have executed once, don't bind tools
      const shouldBindTools = executionMode === 'react' || toolExecutionCount === 0;
      const modelToUse = shouldBindTools && tools.length > 0 ? llm.bindTools(tools) : llm;

      // Add instruction to wrap up if in single-turn mode after tools executed
      let effectiveMessages = allMessages;
      if (executionMode === 'single-turn' && toolExecutionCount > 0) {
        const augmentedSystem = `${definition.prompt.system}\n\nIMPORTANT: You have received tool results. Provide your final answer now without calling any more tools.`;
        effectiveMessages = [
          { role: 'system', content: augmentedSystem },
          ...allMessages.slice(1), // Skip original system message
        ];
      }

      const caller = `ReactWorkflow: ${definition.name}`;
      const { startTime: llmStart, stats } = logLLMCallStart({
        caller,
        systemPrompt: definition.prompt.system,
        messages: effectiveMessages,
        tools: shouldBindTools ? tools : undefined,
      });

      const response = await modelToUse.invoke(stripOldImages(effectiveMessages));

      const responseContent = response.content ?? '';
      logLLMCallEnd(caller, llmStart, stats, { contentLength: responseContent.length });

      allMessages.push(aiMessage(responseContent, response.tool_calls));

      // No tool calls = final answer
      if (!response.tool_calls || response.tool_calls.length === 0) {
        onStatus?.({
          type: 'react_iteration',
          message: `Iteration ${i + 1}: Final answer generated`,
          elapsed: elapsed(),
        });
        break;
      }

      // In single-turn mode, only allow one round of tool execution
      if (executionMode === 'single-turn' && toolExecutionCount > 0) {
        logger.info('[ReactWorkflow] Single-turn mode: tools already executed, ending workflow');
        break;
      }

      // Execute tool calls in parallel (LLM already decided they're independent by emitting them together)
      toolExecutionCount++;

      // Emit all tool_call status events upfront
      for (const tc of response.tool_calls) {
        const inputStr = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args, null, 2);
        onStatus?.({
          type: 'tool_call',
          message: `Calling: ${tc.name}`,
          elapsed: elapsed(),
          toolInput: inputStr,
          toolCallId: tc.id,
        });
      }

      const toolResults = await Promise.all(response.tool_calls.map(async (tc) => {
        const tool = toolMap.get(tc.name);
        if (!tool) {
          onStatus?.({
            type: 'step_error',
            message: `Tool "${tc.name}" not found`,
            elapsed: elapsed(),
          });
          return toolMessage(`Tool "${tc.name}" not found`, tc.id, tc.name);
        }

        try {
          const result = await tool.invoke(tc.args);
          const outputStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          onStatus?.({
            type: 'tool_result',
            message: `${tc.name} completed`,
            elapsed: elapsed(),
            toolOutput: outputStr,
            toolCallId: tc.id,
          });
          return toolMessage(result, tc.id, tc.name);
        } catch (error) {
          if (error instanceof NodeInterrupt) {
            this.saveThreadState(threadId, allMessages);
            throw error;
          }
          const errMsg = error instanceof Error ? error.message : String(error);
          onStatus?.({
            type: 'step_error',
            message: `${tc.name} failed: ${errMsg}`,
            elapsed: elapsed(),
          });
          return toolMessage(`Error: ${errMsg}`, tc.id, tc.name);
        }
      }));

      allMessages.push(...toolResults);
    }

    return allMessages;
  }

  /**
   * Continues a previously completed workflow thread with a new user message.
   */
  async continueThread(
    definition: ReactWorkflowDefinition,
    threadId: string,
    message: string,
    onStatus?: (status: WorkflowStatus) => void
  ): Promise<WorkflowResult> {
    const startTime = Date.now();

    const saved = this.threadStates.get(threadId);
    if (!saved) {
      throw new Error(`No thread state found for thread ${threadId}`);
    }

    logger.info(`[ReactWorkflow] Continuing thread ${threadId} for workflow "${definition.name}"`);

    onStatus?.({
      type: 'workflow_start',
      message: `Continuing ReAct workflow: ${definition.name}`,
      elapsed: 0,
    });

    try {
      const tools = await this.toolDiscovery.discoverAll(definition.graph.tools);
      const agentTools = await this.toolDiscovery.discoverAgents(definition.graph.agents);
      const allTools = [...tools, ...agentTools];

      const llm = await LLMFactory.create(definition.graph.model);

      // Append new user message to saved thread state
      const messages = [...saved.messages, { role: 'human' as const, content: message }];

      const result = await this.runReActLoop(
        llm,
        allTools,
        definition,
        messages,
        threadId,
        onStatus,
        startTime
      );

      // Save updated thread state (strip system message)
      this.saveThreadState(threadId, result.slice(1));

      const output = this.extractOutput(definition.output, result);
      const duration = Date.now() - startTime;

      onStatus?.({
        type: 'workflow_complete',
        message: 'ReAct workflow continued and completed',
        elapsed: duration,
      });

      return {
        output,
        metadata: {
          duration,
          stepsExecuted: result.length,
          success: true,
          threadId,
        },
        stepResults: {},
      };
    } catch (error) {
      if (error instanceof NodeInterrupt) {
        return this.handleInterrupt(error, definition, threadId, startTime, onStatus);
      }

      const duration = Date.now() - startTime;
      onStatus?.({
        type: 'workflow_error',
        message: error instanceof Error ? error.message : String(error),
        elapsed: duration,
        error: String(error),
      });
      throw error;
    }
  }

  hasThread(threadId: string): boolean {
    const state = this.threadStates.get(threadId);
    if (!state) return false;
    // Check TTL
    if (Date.now() - state.timestamp > ReactWorkflowExecutor.THREAD_TTL_MS) {
      this.threadStates.delete(threadId);
      return false;
    }
    return true;
  }

  private saveThreadState(threadId: string, messages: BaseMessage[]) {
    this.threadStates.set(threadId, { messages, timestamp: Date.now() });
    this.cleanupThreadStates();
  }

  private cleanupThreadStates() {
    const now = Date.now();
    // Remove expired entries
    for (const [id, state] of this.threadStates) {
      if (now - state.timestamp > ReactWorkflowExecutor.THREAD_TTL_MS) {
        this.threadStates.delete(id);
      }
    }
    // Evict oldest if over limit
    if (this.threadStates.size > ReactWorkflowExecutor.MAX_THREAD_STATES) {
      const sorted = [...this.threadStates.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = sorted.slice(0, sorted.length - ReactWorkflowExecutor.MAX_THREAD_STATES);
      for (const [id] of toRemove) {
        this.threadStates.delete(id);
      }
    }
  }

  private handleInterrupt(
    error: NodeInterrupt,
    definition: ReactWorkflowDefinition,
    threadId: string,
    startTime: number,
    onStatus?: (status: WorkflowStatus) => void
  ): WorkflowResult {
    const question = error.data?.question ? String(error.data.question) : error.message || 'Agent requires input';

    logger.info(`[ReactWorkflow] Workflow interrupted with question: ${question}`);

    // Store interrupt state
    this.interruptManager.addInterrupt({
      threadId,
      workflowName: definition.name,
      question,
      timestamp: Date.now(),
      resolved: false,
    });

    const interrupt: WorkflowInterrupt = {
      threadId,
      question,
      timestamp: Date.now(),
    };

    const duration = Date.now() - startTime;

    onStatus?.({
      type: 'workflow_interrupt',
      message: `Workflow paused: ${question}`,
      elapsed: duration,
      interrupt,
    });

    return {
      output: { interrupted: true, threadId, question },
      metadata: {
        duration,
        stepsExecuted: 0,
        success: false,
      },
      stepResults: {},
    };
  }

  private interpolateGoal(template: string, input: Record<string, unknown>): string {
    return template.replace(/\{\{input\.([^}]+)\}\}/g, (_, key: string) => {
      const value = input[key];
      return value !== undefined ? String(value) : '';
    });
  }

  private extractOutput(
    outputMapping: Record<string, string>,
    messages: BaseMessage[]
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};

    for (const [key, template] of Object.entries(outputMapping)) {
      if (template.includes('{{state.messages[-1].content}}')) {
        const lastMessage = messages[messages.length - 1];
        output[key] = lastMessage ? contentToText(lastMessage.content) : '';
      } else {
        output[key] = template;
      }
    }

    return output;
  }

  private generateThreadId(): string {
    return `thread_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
}
