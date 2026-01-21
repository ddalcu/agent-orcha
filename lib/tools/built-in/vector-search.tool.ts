import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredTool } from '@langchain/core/tools';
import type { VectorStoreInstance } from '../../vectors/types.js';

export function createVectorSearchTool(name: string, store: VectorStoreInstance): StructuredTool {
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
      name: `vector_search_${name}`,
      description: `Search the "${name}" vector store for relevant documents. ${store.config.description ?? ''} IMPORTANT: Use descriptive, complete queries (at least 10-15 words) for best results. Examples: "list of items with details and specifications", "how to resolve common problems", "information about specific topics or concepts".`,
      schema: z.object({
        query: z.string().describe('A descriptive search query (use at least 10-15 words for best results). Examples: "list of items with details", "how to perform a task", "information about a topic"'),
        k: z.number().optional().describe('Number of results to return (default: 4)'),
      }),
    }
  );
}
