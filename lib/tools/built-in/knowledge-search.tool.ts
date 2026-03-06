import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { KnowledgeStoreInstance } from '../../knowledge/types.ts';

export function createKnowledgeSearchTool(name: string, store: KnowledgeStoreInstance): StructuredTool {
  return tool(
    async ({ query, k }) => {
      const results = await store.search(query, Math.min(k ?? 4, 20));

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
      description: `Semantic search over "${name}". ${store.config.description ?? ''} Use descriptive queries (10+ words) for best results.`,
      schema: z.object({
        query: z.string().describe('Descriptive search query (10+ words for best results)'),
        k: z.number().optional().describe('Number of results (default 4, max 20)'),
      }),
    }
  );
}
