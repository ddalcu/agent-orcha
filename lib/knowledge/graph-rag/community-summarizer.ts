import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Community, GraphNode, GraphEdge, GraphStore } from './types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('CommunitySummarizer');

/**
 * Generates natural language summaries for graph communities using an LLM.
 * Each community summary describes the key entities and relationships within it.
 */
export class CommunitySummarizer {
  private llm: BaseChatModel;

  constructor(llm: BaseChatModel) {
    this.llm = llm;
  }

  /**
   * Generate summaries for all communities.
   */
  async summarize(communities: Community[], store: GraphStore): Promise<Community[]> {
    const summarized: Community[] = [];

    for (let i = 0; i < communities.length; i++) {
      const community = communities[i]!;
      logger.info(`Summarizing community ${i + 1}/${communities.length} (${community.nodeIds.length} nodes)`);

      try {
        const { title, summary } = await this.summarizeSingle(community, store);
        summarized.push({ ...community, title, summary });
      } catch (error) {
        logger.error(`Failed to summarize community ${community.id}: ${error instanceof Error ? error.message : String(error)}`);
        summarized.push({
          ...community,
          title: `Community ${community.id}`,
          summary: `Community with ${community.nodeIds.length} entities.`,
        });
      }
    }

    return summarized;
  }

  private async summarizeSingle(community: Community, store: GraphStore): Promise<{ title: string; summary: string }> {
    // Gather all nodes and their relationships within the community
    const nodes: GraphNode[] = [];
    for (const nodeId of community.nodeIds) {
      const node = await store.getNode(nodeId);
      if (node) nodes.push(node);
    }

    const allEdges = await store.getAllEdges();
    const communityNodeIds = new Set(community.nodeIds);
    const internalEdges = allEdges.filter(
      (e) => communityNodeIds.has(e.sourceId) && communityNodeIds.has(e.targetId)
    );

    const context = this.buildCommunityContext(nodes, internalEdges);

    const response = await this.llm.invoke([
      new SystemMessage(
        `You are a knowledge graph analyst. Given a set of entities and relationships from a community in a knowledge graph, provide:
1. A short title (5-10 words) that captures the main theme
2. A comprehensive summary (2-4 sentences) that describes the key entities, their relationships, and the overall theme

Respond ONLY with valid JSON:
{
  "title": "Short descriptive title",
  "summary": "Comprehensive summary of the community..."
}`
      ),
      new HumanMessage(`Analyze this community:\n\n${context}`),
    ]);

    const responseText = typeof response.content === 'string'
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map((c) => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
        : '';

    try {
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, responseText];
      const parsed = JSON.parse((jsonMatch[1] ?? responseText).trim());
      return {
        title: String(parsed.title ?? `Community ${community.id}`),
        summary: String(parsed.summary ?? ''),
      };
    } catch {
      logger.warn(`Failed to parse community summary, using raw response`);
      return {
        title: `Community ${community.id}`,
        summary: responseText.substring(0, 500),
      };
    }
  }

  private buildCommunityContext(nodes: GraphNode[], edges: GraphEdge[]): string {
    const entityLines = nodes.map((n) => `- ${n.name} (${n.type}): ${n.description}`).join('\n');
    const relLines = edges.map(
      (e) => `- ${e.sourceId} -[${e.type}]-> ${e.targetId}: ${e.description}`
    ).join('\n');

    return `Entities:\n${entityLines}\n\nRelationships:\n${relLines}`;
  }
}
