import type { Embeddings } from '@langchain/core/embeddings';
import type {
  GraphConfig,
  GraphNode,
  GraphEdge,
  GraphStore,
  ExtractedEntity,
  ExtractedRelationship,
  Community,
} from './types.js';
import type { KnowledgeStoreInstance, SearchResult } from '../types.js';
import type { GraphRagKnowledgeConfig } from '../types.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { Neo4jGraphStore } from './neo4j-graph-store.js';
import { EntityExtractor } from './entity-extractor.js';
import { ExtractionCache } from './extraction-cache.js';
import { CommunityDetector } from './community-detector.js';
import { CommunitySummarizer } from './community-summarizer.js';
import { LocalSearch } from './local-search.js';
import { GlobalSearch } from './global-search.js';
import { detectSearchMode } from './search-mode-detector.js';
import { LLMFactory } from '../../llm/llm-factory.js';
import { KnowledgeStoreFactory } from '../knowledge-store-factory.js';
import { createLogger } from '../../logger.js';
import * as path from 'path';

const logger = createLogger('GraphRAGFactory');

/**
 * Creates a GraphRAG KnowledgeStoreInstance from a graph-rag configuration.
 * Orchestrates: load → split → extract entities → build graph → detect communities → summarize → index.
 */
export class GraphRagFactory {
  /** Graph store references for API access (keyed by knowledge store name) */
  private static graphStores = new Map<string, GraphStore>();

  /** Get a graph store by knowledge store name (for API endpoints) */
  static getGraphStore(name: string): GraphStore | undefined {
    return this.graphStores.get(name);
  }

  static async create(config: GraphRagKnowledgeConfig, projectRoot: string): Promise<KnowledgeStoreInstance> {
    const graphConfig = config.graph;
    const searchConfig = config.search;

    logger.info(`Creating GraphRAG store "${config.name}"...`);

    // 1. Load and split documents (reuse existing infrastructure)
    logger.info('Loading documents...');
    const documents = await KnowledgeStoreFactory.loadDocuments(config, projectRoot);
    logger.info(`Loaded ${documents.length} document(s)`);

    const splitDocs = await KnowledgeStoreFactory.splitDocuments(config, documents);
    logger.info(`Split into ${splitDocs.length} chunk(s)`);

    // 2. Create embeddings for entity descriptions
    const embeddings = KnowledgeStoreFactory.createEmbeddings(config.embedding);

    // 3. Create graph store
    const store = this.createGraphStore(graphConfig);

    // 4. Check cache
    const cacheEnabled = graphConfig.cache.enabled;
    const cachePath = path.resolve(projectRoot, graphConfig.cache.directory);
    const cache = new ExtractionCache(cachePath, config.name);

    const docContents = splitDocs.map((d) => d.pageContent);
    const sourceHash = ExtractionCache.computeSourceHash(docContents);

    let entities: ExtractedEntity[] = [];
    let relationships: ExtractedRelationship[] = [];
    let communities: Community[] = [];

    let cacheHit = false;
    if (cacheEnabled && await cache.isValid(sourceHash)) {
      try {
        logger.info('Cache HIT - loading from cache');
        const cached = await cache.load();
        entities = cached.entities;
        relationships = cached.relationships;
        communities = cached.communities;
        cacheHit = true;
      } catch (cacheError) {
        logger.warn(`Cache load failed, falling back to extraction: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
      }
    }

    if (!cacheHit) {
      if (cacheEnabled) {
        logger.info('Cache MISS - running extraction pipeline');
      }

      // 5. Entity extraction
      const extractionLlm = LLMFactory.create(graphConfig.extraction.llm);
      const extractor = new EntityExtractor({
        llm: extractionLlm,
        entityTypes: graphConfig.extraction.entityTypes,
        relationshipTypes: graphConfig.extraction.relationshipTypes,
      });

      const chunks = splitDocs.map((doc, idx) => ({
        id: `chunk-${idx}`,
        content: doc.pageContent,
      }));

      const extracted = await extractor.extractFromChunks(chunks);
      entities = extracted.entities;
      relationships = extracted.relationships;

      // 6. Build graph
      const nodes = await this.buildNodes(entities, embeddings);
      const edges = this.buildEdges(relationships, nodes);

      await store.addNodes(nodes);
      await store.addEdges(edges);

      // 7. Community detection
      if (store instanceof MemoryGraphStore) {
        const detector = new CommunityDetector(graphConfig.communities);
        communities = await detector.detect(store);

        // 8. Community summarization
        if (communities.length > 0) {
          const summaryLlm = LLMFactory.create(graphConfig.communities.summaryLlm);
          const summarizer = new CommunitySummarizer(summaryLlm);
          communities = await summarizer.summarize(communities, store);
        }
      } else {
        // Neo4j: community detection not yet supported directly
        communities = [];
        logger.warn('Community detection not supported for Neo4j store (use memory store)');
      }

      await store.setCommunities(communities);

      // 9. Save to cache
      if (cacheEnabled) {
        await cache.save(sourceHash, entities, relationships, communities);
      }
    }

    // If loading from cache, we need to rebuild the graph store
    if (cacheEnabled && entities.length > 0 && (await store.getAllNodes()).length === 0) {
      const nodes = await this.buildNodes(entities, embeddings);
      const edges = this.buildEdges(relationships, nodes);
      await store.addNodes(nodes);
      await store.addEdges(edges);
      await store.setCommunities(communities);
    }

    logger.info(`GraphRAG "${config.name}" ready: ${entities.length} entities, ${relationships.length} relationships, ${communities.length} communities`);

    // Register graph store for API access
    this.graphStores.set(config.name, store);

    // 10. Create search instances
    const localSearch = new LocalSearch(store, embeddings, searchConfig.localSearch);
    const globalSearchLlm = LLMFactory.create(searchConfig.globalSearch.llm);
    const globalSearch = new GlobalSearch(store, globalSearchLlm, searchConfig.globalSearch);

    // 11. Return KnowledgeStoreInstance
    return {
      config: config as any, // GraphRagKnowledgeConfig is compatible with KnowledgeConfig via the union
      search: async (query: string, k?: number): Promise<SearchResult[]> => {
        const numResults = k ?? searchConfig.defaultK;
        const mode = detectSearchMode(query);
        logger.info(`Search mode: ${mode} for query: "${query.substring(0, 50)}..."`);

        if (mode === 'global') {
          return globalSearch.search(query, numResults);
        }
        return localSearch.search(query, numResults);
      },
      addDocuments: async (): Promise<void> => {
        logger.warn('addDocuments not supported for GraphRAG stores - use refresh() instead');
      },
      refresh: async (): Promise<void> => {
        logger.info(`Refreshing GraphRAG store "${config.name}"...`);
        await store.clear();
        if (cacheEnabled) {
          await cache.clear();
        }
        // Re-run the full pipeline
        await GraphRagFactory.create(config, projectRoot);
      },
    };
  }

  private static createGraphStore(config: GraphConfig): GraphStore {
    switch (config.store.type) {
      case 'neo4j': {
        const opts = config.store.options as Record<string, string>;
        return new Neo4jGraphStore({
          uri: opts.uri ?? 'bolt://localhost:7687',
          username: opts.username ?? 'neo4j',
          password: opts.password ?? 'password',
          database: opts.database,
        });
      }
      case 'memory':
      default:
        return new MemoryGraphStore();
    }
  }

  /**
   * Build GraphNode objects from extracted entities, creating embeddings for each.
   */
  private static async buildNodes(entities: ExtractedEntity[], embeddings: Embeddings): Promise<GraphNode[]> {
    const nodes: GraphNode[] = [];

    // Batch embed all entity descriptions
    const descriptions = entities.map((e) => `${e.name}: ${e.description}`);
    let embeddingVectors: number[][] = [];

    try {
      embeddingVectors = await embeddings.embedDocuments(descriptions);
    } catch (error) {
      logger.error(`Failed to embed entity descriptions: ${error instanceof Error ? error.message : String(error)}`);
      // Fall back to empty embeddings
      embeddingVectors = entities.map(() => []);
    }

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i]!;
      const nodeId = normalizeId(entity.name, entity.type);
      nodes.push({
        id: nodeId,
        type: entity.type,
        name: entity.name,
        description: entity.description,
        properties: entity.properties,
        sourceChunkIds: (entity.properties.sourceChunkIds as string[]) ?? [],
        embedding: embeddingVectors[i],
      });
    }

    return nodes;
  }

  /**
   * Build GraphEdge objects from extracted relationships, resolving entity names to node IDs.
   */
  private static buildEdges(relationships: ExtractedRelationship[], nodes: GraphNode[]): GraphEdge[] {
    const nodeIdMap = new Map<string, string>();
    for (const node of nodes) {
      const key = `${node.name.toLowerCase()}::${node.type.toLowerCase()}`;
      nodeIdMap.set(key, node.id);
    }

    const edges: GraphEdge[] = [];
    for (let i = 0; i < relationships.length; i++) {
      const rel = relationships[i]!;
      const sourceKey = `${rel.sourceName.toLowerCase()}::${rel.sourceType.toLowerCase()}`;
      const targetKey = `${rel.targetName.toLowerCase()}::${rel.targetType.toLowerCase()}`;

      const sourceId = nodeIdMap.get(sourceKey);
      const targetId = nodeIdMap.get(targetKey);

      if (!sourceId || !targetId) {
        logger.debug(`Skipping relationship: missing node for ${rel.sourceName} -> ${rel.targetName}`);
        continue;
      }

      edges.push({
        id: `edge-${i}-${rel.type}`,
        type: rel.type,
        sourceId,
        targetId,
        description: rel.description,
        weight: rel.weight,
        properties: {},
      });
    }

    return edges;
  }
}

/**
 * Create a deterministic node ID from entity name and type.
 */
function normalizeId(name: string, type: string): string {
  const normalized = `${type}::${name}`
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized;
}
