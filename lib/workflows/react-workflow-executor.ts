import type { ChatModel, BaseMessage, StructuredTool } from '../types/llm-types.ts';
import { NodeInterrupt, aiMessage, toolMessage, contentToText } from '../types/llm-types.ts';
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
  /** Stores thread message state for pause/resume */
  private threadStates = new Map<string, BaseMessage[]>();

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
      const llm = LLMFactory.create(definition.graph.model);

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
      const llm = LLMFactory.create(definition.graph.model);

      // 3. Load saved thread state and append the user's answer
      const savedMessages = this.threadStates.get(threadId) ?? [];
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

      // Clean up
      this.interruptManager.removeInterrupt(threadId);
      this.threadStates.delete(threadId);

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

    const allMessages: BaseMessage[] = [
      { role: 'system', content: definition.prompt.system },
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

      const response = await modelToUse.invoke(effectiveMessages);

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

      // Execute each tool call
      toolExecutionCount++;
      for (const tc of response.tool_calls) {
        const tool = toolMap.get(tc.name);
        if (!tool) {
          onStatus?.({
            type: 'step_error',
            message: `Tool "${tc.name}" not found`,
            elapsed: elapsed(),
          });
          allMessages.push(toolMessage(`Tool "${tc.name}" not found`, tc.id, tc.name));
          continue;
        }

        onStatus?.({
          type: 'tool_call',
          message: `Calling: ${tc.name}`,
          elapsed: elapsed(),
        });

        try {
          const result = await tool.invoke(tc.args);
          onStatus?.({
            type: 'tool_result',
            message: `${tc.name} completed`,
            elapsed: elapsed(),
          });
          allMessages.push(toolMessage(result, tc.id, tc.name));
        } catch (error) {
          // Handle NodeInterrupt: save state and re-throw
          if (error instanceof NodeInterrupt) {
            this.threadStates.set(threadId, allMessages);
            throw error;
          }
          const errMsg = error instanceof Error ? error.message : String(error);
          onStatus?.({
            type: 'step_error',
            message: `${tc.name} failed: ${errMsg}`,
            elapsed: elapsed(),
          });
          allMessages.push(toolMessage(`Error: ${errMsg}`, tc.id, tc.name));
        }
      }
    }

    return allMessages;
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
