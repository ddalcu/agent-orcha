import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { KnowledgeStoreInstance } from '../../knowledge/types.ts';

export function createKnowledgeSearchTool(name: string, store: KnowledgeStoreInstance): StructuredTool {
  return tool(
    async ({ query, k }) => {
      const results = await store.search(query, k);

      if (results.length === 0) {
        return 'No relevant documents found.';
      }

      return results
        .map((result, index) => {
          const metadata = Object.entries(result.metadata)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ');

          return `[${index + 1}] (score: ${result.score.toFixed(3)})${metadata ? ` [${metadata}]` : ''}\n${result.content}`;
        })
        .join('\n\n---\n\n');
    },
    {
      name: `knowledge_search_${name}`,
      description: `Search the "${name}" knowledge store for relevant documents. ${store.config.description ?? ''} IMPORTANT: Use descriptive, complete queries (at least 10-15 words) for best results. Examples: "list of items with details and specifications", "how to resolve common problems", "information about specific topics or concepts".`,
      schema: z.object({
        query: z.string().describe('A descriptive search query (use at least 10-15 words for best results). Examples: "list of items with details", "how to perform a task", "information about a topic"'),
        k: z.number().optional().describe('Number of results to return (default: 4)'),
      }),
    }
  );
}
