import { tool } from '../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../types/llm-types.ts';
import type { AgentDefinition } from '../agents/types.ts';
import type { AgentExecutor } from '../agents/agent-executor.ts';
import type { AgentLoader } from '../agents/agent-loader.ts';
import { logger } from '../logger.ts';

/**
 * Wraps agents as tools so they can be called by other agents in ReAct workflows.
 */
export class AgentToolWrapper {
  /**
   * Creates a tool wrapper for a single agent.
   */
  static createTool(
    name: string,
    definition: AgentDefinition,
    executor: AgentExecutor
  ): StructuredTool {
    return tool(
      async ({ input }) => {
        try {
          const instance = await executor.createInstance(definition);
          const result = await instance.invoke({ input: { query: input } });

          return typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Agent tool "${name}" failed:`, error);
          return `Error executing agent "${name}": ${errorMessage}`;
        }
      },
      {
        name: `agent_${name}`,
        description: `${definition.description}. Use when you need: ${definition.prompt.system.substring(0, 150)}...`,
        schema: z.object({
          input: z.string().describe('The query or task for this agent'),
        }),
      }
    );
  }

  /**
   * Creates tool wrappers for multiple agents by name.
   */
  static async createTools(
    agentNames: string[],
    agentLoader: AgentLoader,
    executor: AgentExecutor
  ): Promise<StructuredTool[]> {
    const tools: StructuredTool[] = [];

    for (const name of agentNames) {
      const definition = agentLoader.get(name);
      if (!definition) {
        logger.warn(`Agent not found for tool wrapper: ${name}`);
        continue;
      }

      tools.push(this.createTool(name, definition, executor));
    }

    return tools;
  }

  /**
   * Creates tool wrappers for all available agents.
   */
  static async createAllTools(
    agentLoader: AgentLoader,
    executor: AgentExecutor
  ): Promise<StructuredTool[]> {
    const agentNames = agentLoader.names();
    return this.createTools(agentNames, agentLoader, executor);
  }
}
