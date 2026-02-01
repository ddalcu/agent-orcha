import { StateGraph, MessagesAnnotation, MemorySaver } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { NodeInterrupt } from '@langchain/langgraph';
import type { StructuredTool } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  LangGraphWorkflowDefinition,
  WorkflowResult,
  WorkflowStatus,
  WorkflowInterrupt,
} from './types.js';
import type { InterruptManager } from './interrupt-manager.js';
import { ToolDiscovery } from '../tools/tool-discovery.js';
import { LLMFactory } from '../llm/llm-factory.js';
import { logLLMCallStart, logLLMCallEnd } from '../llm/llm-call-logger.js';
import { logger } from '../logger.js';

/**
 * Executes LangGraph workflows using ReAct pattern (Reasoning + Acting).
 * Supports autonomous tool/agent discovery and human-in-the-loop via ask_user tool.
 */
export class LangGraphExecutor {
  private checkpointer = new MemorySaver();

  constructor(
    private toolDiscovery: ToolDiscovery,
    private interruptManager: InterruptManager
  ) {}

  /**
   * Executes a LangGraph workflow.
   * @param definition - The LangGraph workflow definition
   * @param input - Input values for the workflow
   * @param threadId - Optional thread ID for resuming interrupted workflows
   * @param onStatus - Optional callback for status updates
   * @returns Workflow result
   */
  async execute(
    definition: LangGraphWorkflowDefinition,
    input: Record<string, unknown>,
    threadId?: string,
    onStatus?: (status: WorkflowStatus) => void
  ): Promise<WorkflowResult> {
    const startTime = Date.now();
    const actualThreadId = threadId || this.generateThreadId();

    onStatus?.({
      type: 'workflow_start',
      message: `Starting LangGraph workflow: ${definition.name}`,
      elapsed: 0,
    });

    try {
      // 1. Discover tools
      logger.info(`[LangGraph] Discovering tools for workflow "${definition.name}"...`);
      const tools = await this.toolDiscovery.discoverAll(definition.graph.tools);
      logger.info(`[LangGraph] Discovered ${tools.length} tools`);

      // 2. Discover agents
      logger.info(`[LangGraph] Discovering agents for workflow "${definition.name}"...`);
      const agentTools = await this.toolDiscovery.discoverAgents(definition.graph.agents);
      logger.info(`[LangGraph] Discovered ${agentTools.length} agent tools`);

      // 3. Combine all tools
      const allTools = [...tools, ...agentTools];
      logger.info(`[LangGraph] Total tools available: ${allTools.length}`);

      // 4. Get LLM
      const llm = LLMFactory.create(definition.graph.model);

      // 5. Build and compile graph
      const app = this.buildReActGraph(llm, allTools, definition);

      // 6. Execute
      const goal = this.interpolateGoal(definition.prompt.goal, input);
      const config = {
        recursionLimit: definition.graph.maxIterations,
        configurable: { thread_id: actualThreadId },
      };

      logger.info(`[LangGraph] Executing workflow with goal: ${goal}`);

      const result = await app.invoke(
        { messages: [{ role: 'user', content: goal }] },
        config
      );

      // 7. Extract output
      const output = this.extractOutput(definition.output, result);

      const duration = Date.now() - startTime;

      onStatus?.({
        type: 'workflow_complete',
        message: 'LangGraph workflow completed',
        elapsed: duration,
      });

      logger.info(`[LangGraph] Workflow completed in ${duration}ms`);

      return {
        output,
        metadata: {
          duration,
          stepsExecuted: result.messages?.length || 0,
          success: true,
        },
        stepResults: {}, // No explicit steps in LangGraph
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

      logger.error(`[LangGraph] Workflow error:`, error);

      throw error;
    }
  }

  /**
   * Resumes a workflow that was interrupted by ask_user.
   */
  async resumeWithAnswer(
    definition: LangGraphWorkflowDefinition,
    threadId: string,
    answer: string,
    onStatus?: (status: WorkflowStatus) => void
  ): Promise<WorkflowResult> {
    const startTime = Date.now();

    logger.info(`[LangGraph] Resuming workflow "${definition.name}" with thread ${threadId}`);

    // Resolve the interrupt
    const resolved = this.interruptManager.resolveInterrupt(threadId, answer);
    if (!resolved) {
      throw new Error(`No active interrupt found for thread ${threadId}`);
    }

    onStatus?.({
      type: 'workflow_start',
      message: `Resuming LangGraph workflow: ${definition.name}`,
      elapsed: 0,
    });

    try {
      // 1. Discover tools (same as before)
      const tools = await this.toolDiscovery.discoverAll(definition.graph.tools);
      const agentTools = await this.toolDiscovery.discoverAgents(definition.graph.agents);
      const allTools = [...tools, ...agentTools];

      // 2. Get LLM
      const llm = LLMFactory.create(definition.graph.model);

      // 3. Build and compile graph
      const app = this.buildReActGraph(llm, allTools, definition);

      // 4. Resume with answer
      const config = {
        recursionLimit: definition.graph.maxIterations,
        configurable: { thread_id: threadId },
      };

      // The answer is passed as a command to resume
      const result = await app.invoke(null, config);

      // 5. Extract output
      const output = this.extractOutput(definition.output, result);

      const duration = Date.now() - startTime;

      onStatus?.({
        type: 'workflow_complete',
        message: 'LangGraph workflow resumed and completed',
        elapsed: duration,
      });

      // Clean up interrupt
      this.interruptManager.removeInterrupt(threadId);

      return {
        output,
        metadata: {
          duration,
          stepsExecuted: result.messages?.length || 0,
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
   * Handles workflow interrupts (ask_user).
   */
  private handleInterrupt(
    error: NodeInterrupt,
    definition: LangGraphWorkflowDefinition,
    threadId: string,
    startTime: number,
    onStatus?: (status: WorkflowStatus) => void
  ): WorkflowResult {
    // NodeInterrupt contains the interrupt data passed from the tool
    // Access it via the error's properties
    const interruptData = (error as any).args?.[0] || {};
    const question =
      interruptData.question || (error as any).message || 'Agent requires input';

    logger.info(`[LangGraph] Workflow interrupted with question: ${question}`);

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

    // Return partial result with interrupt info
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

  /**
   * Builds a ReAct graph with the given LLM and tools.
   */
  private buildReActGraph(
    llm: any,
    tools: StructuredTool[],
    definition: LangGraphWorkflowDefinition
  ) {
    const executionMode = definition.graph.executionMode || 'react';
    let toolExecutionCount = 0;

    const graph = new StateGraph(MessagesAnnotation)
      .addNode('agent', async (state) => {
        // In single-turn mode, after tools have executed once, don't bind tools
        // This forces the agent to generate a final response without more tool calls
        const shouldBindTools =
          executionMode === 'react' || toolExecutionCount === 0;

        const modelToUse = shouldBindTools ? llm.bindTools(tools) : llm;

        // Add instruction to wrap up if in single-turn mode after tools executed
        const systemPrompt =
          executionMode === 'single-turn' && toolExecutionCount > 0
            ? `${definition.prompt.system}\n\nIMPORTANT: You have received tool results. Provide your final answer now without calling any more tools.`
            : definition.prompt.system;

        const caller = `LangGraph: ${definition.name}`;
        const { startTime: llmStart, stats } = logLLMCallStart({
          caller,
          systemPrompt,
          messages: state.messages,
          tools: shouldBindTools ? tools : undefined,
        });

        const response = await modelToUse.invoke([
          { role: 'system', content: systemPrompt },
          ...state.messages,
        ]);

        const responseContent = 'content' in response ? String(response.content) : '';
        logLLMCallEnd(caller, llmStart, stats, { contentLength: responseContent.length });

        return { messages: [response] };
      })
      .addNode('tools', async (state: any) => {
        toolExecutionCount++;
        const toolNode = new ToolNode(tools as any);
        return toolNode.invoke(state);
      })
      .addEdge('__start__', 'agent')
      .addConditionalEdges('agent', (state) =>
        this.shouldContinue(state, executionMode, toolExecutionCount)
      )
      .addEdge('tools', 'agent');

    // Compile with checkpointer (enables pause/resume)
    return graph.compile({
      checkpointer: this.checkpointer,
    });
  }

  /**
   * Decides whether to continue to tools or end.
   */
  private shouldContinue(
    state: { messages: BaseMessage[] },
    executionMode: string,
    toolExecutionCount: number
  ): string {
    if (!state.messages || state.messages.length === 0) {
      return '__end__';
    }

    const lastMessage = state.messages[state.messages.length - 1];

    // Check if there are tool calls
    const hasToolCalls =
      lastMessage &&
      'tool_calls' in lastMessage &&
      Array.isArray(lastMessage.tool_calls) &&
      lastMessage.tool_calls.length > 0;

    if (!hasToolCalls) {
      return '__end__';
    }

    // In single-turn mode, only allow one round of tool execution
    if (executionMode === 'single-turn' && toolExecutionCount > 0) {
      logger.info(
        '[LangGraph] Single-turn mode: tools already executed, ending workflow'
      );
      return '__end__';
    }

    return 'tools';
  }

  /**
   * Interpolates template variables in the goal.
   */
  private interpolateGoal(template: string, input: Record<string, unknown>): string {
    return template.replace(/\{\{input\.([^}]+)\}\}/g, (_, key: string) => {
      const value = input[key];
      return value !== undefined ? String(value) : '';
    });
  }

  /**
   * Extracts output from graph state.
   */
  private extractOutput(
    outputMapping: Record<string, string>,
    state: { messages?: BaseMessage[] }
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};

    for (const [key, template] of Object.entries(outputMapping)) {
      // Simple extraction: just get the last message content
      if (template.includes('{{state.messages[-1].content}}')) {
        const lastMessage = state.messages?.[state.messages.length - 1];
        if (lastMessage && 'content' in lastMessage) {
          output[key] = lastMessage.content;
        } else {
          output[key] = '';
        }
      } else {
        // For other templates, just use as-is for now
        output[key] = template;
      }
    }

    return output;
  }

  /**
   * Generates a unique thread ID.
   */
  private generateThreadId(): string {
    return `thread_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
}
