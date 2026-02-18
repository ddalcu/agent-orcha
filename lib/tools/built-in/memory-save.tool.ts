import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredTool } from '@langchain/core/tools';
import type { MemoryManager } from '../../memory/memory-manager.js';

export function createMemorySaveTool(
  memoryManager: MemoryManager,
  agentName: string,
  maxLines: number,
): StructuredTool {
  return tool(
    async ({ content }) => {
      await memoryManager.save(agentName, content, maxLines);
      const lineCount = content.split('\n').length;
      return `Memory saved successfully (${lineCount} lines).`;
    },
    {
      name: 'save_memory',
      description:
        'Save or update your long-term memory. Provide the COMPLETE memory content ' +
        'that should be persisted. This replaces the entire memory file. ' +
        'Use this to remember important facts, user preferences, and key context across conversations.',
      schema: z.object({
        content: z
          .string()
          .describe(
            'The full memory content to save. This replaces any existing memory. ' +
            'Use markdown formatting with bullet points for clarity.'
          ),
      }),
    },
  );
}
