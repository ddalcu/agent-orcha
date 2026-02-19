import type { ChatModel } from '../../types/llm-types.ts';
import { humanMessage, systemMessage } from '../../types/llm-types.ts';
import type { GraphStore, GlobalSearchConfig } from './types.ts';
import type { SearchResult } from '../types.ts';
import { createLogger } from '../../logger.ts';

const logger = createLogger('GraphGlobalSearch');

/**
 * Community-summary map-reduce search.
 * 1. Retrieve top N community summaries
 * 2. Map: ask LLM to answer query using each summary
 * 3. Reduce: synthesize all partial answers into final response
 */
export class GlobalSearch {
  private store: GraphStore;
  private llm: ChatModel;
  private config: GlobalSearchConfig;

  constructor(store: GraphStore, llm: ChatModel, config: GlobalSearchConfig) {
    this.store = store;
    this.llm = llm;
    this.config = config;
  }

  async search(query: string, _k: number): Promise<SearchResult[]> {
    logger.info(`Global search: "${query.substring(0, 50)}..." (topCommunities=${this.config.topCommunities})`);

    const communities = await this.store.getCommunities();
    if (communities.length === 0) {
      logger.warn('No communities found');
      return [];
    }

    // Take top N communities (sorted by size, largest first)
    const topCommunities = [...communities]
      .sort((a, b) => b.nodeIds.length - a.nodeIds.length)
      .slice(0, this.config.topCommunities);

    logger.info(`Using ${topCommunities.length} communities for map-reduce`);

    // Map phase: get partial answers from each community
    const partialAnswers: Array<{ communityId: string; title: string; answer: string }> = [];

    for (const community of topCommunities) {
      if (!community.summary) continue;

      try {
        const answer = await this.mapQuery(query, community.title ?? community.id, community.summary);
        if (answer && answer.trim().length > 0) {
          partialAnswers.push({
            communityId: community.id,
            title: community.title ?? community.id,
            answer,
          });
        }
      } catch (error) {
        logger.warn(`Map failed for community ${community.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (partialAnswers.length === 0) {
      logger.warn('No partial answers generated');
      return [];
    }

    // Reduce phase: synthesize final answer
    const synthesized = await this.reduceAnswers(query, partialAnswers);

    const result: SearchResult = {
      content: synthesized,
      metadata: {
        type: 'graph-global',
        communitiesUsed: partialAnswers.length,
        communityIds: partialAnswers.map((a) => a.communityId),
      },
      score: 1.0, // Global search is always fully relevant to broad queries
    };

    return [result];
  }

  private async mapQuery(query: string, communityTitle: string, communitySummary: string): Promise<string> {
    const response = await this.llm.invoke([
      systemMessage(
        `You are a helpful analyst. Given a community summary from a knowledge graph, answer the user's question based on the information available. If the community summary is not relevant to the question, respond with an empty string "".
Be concise and factual.`
      ),
      humanMessage(
        `Community: ${communityTitle}\n\nSummary:\n${communitySummary}\n\nQuestion: ${query}`
      ),
    ]);

    return response.content.trim();
  }

  private async reduceAnswers(
    query: string,
    partialAnswers: Array<{ communityId: string; title: string; answer: string }>
  ): Promise<string> {
    const answersText = partialAnswers
      .map((a, i) => `[${i + 1}] Community "${a.title}":\n${a.answer}`)
      .join('\n\n');

    const response = await this.llm.invoke([
      systemMessage(
        `You are a synthesis expert. Given multiple partial answers from different knowledge graph communities, synthesize them into a single comprehensive answer. Remove redundancies, reconcile any conflicts, and present a coherent response.`
      ),
      humanMessage(
        `Question: ${query}\n\nPartial answers from different communities:\n\n${answersText}\n\nProvide a synthesized comprehensive answer:`
      ),
    ]);

    return response.content.trim();
  }
}
