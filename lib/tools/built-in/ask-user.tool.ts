import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { NodeInterrupt } from '@langchain/langgraph';
import type { StructuredTool } from '@langchain/core/tools';

/**
 * Creates a tool that allows agents to ask the user for input during workflow execution.
 * When called, this tool throws a NodeInterrupt which pauses the graph and waits for user response.
 */
export function createAskUserTool(): StructuredTool {
  return tool(
    async ({ question }) => {
      // Throw NodeInterrupt to pause the graph
      // The question is stored in the interrupt state
      throw new NodeInterrupt({ question });
    },
    {
      name: 'ask_user',
      description:
        'Ask the user a question and wait for their response. Use when you need information that was not provided in the original request or when clarification is needed.',
      schema: z.object({
        question: z
          .string()
          .describe(
            'The question to ask the user. Be specific and clear about what information you need.'
          ),
      }),
    }
  );
}
