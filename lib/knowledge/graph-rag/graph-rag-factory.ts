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
import { DirectMapper } from './direct-mapper.js';
import { ExtractionCache } from './extraction-cache.js';
import { CommunityDetector } from './community-detector.js';
import { CommunitySummarizer } from './community-summarizer.js';
import { LocalSearch } from './local-search.js';
import { GlobalSearch } from './global-search.js';
import { detectSearchMode } from './search-mode-detector.js';
import { LLMFactory } from '../../llm/llm-factory.js';
import { KnowledgeStoreFactory } from '../knowledge-store-factory.js';
import { createDefaultMetadata, type IndexingProgressCallback } from '../knowledge-store-metadata.js';
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

  static async create(
    config: GraphRagKnowledgeConfig,
    projectRoot: string,
    cacheDir?: string,
    onProgress?: IndexingProgressCallback
  ): Promise<KnowledgeStoreInstance> {
    const graphConfig = config.graph;
    const searchConfig = config.search;

    let metadata = createDefaultMetadata(config.name, 'graph-rag');
    metadata.embeddingModel = config.embedding;

    logger.info(`Creating GraphRAG store "${config.name}"...`);

    // Create embeddings and graph store
    const embeddings = KnowledgeStoreFactory.createEmbeddings(config.embedding);
    const store = this.createGraphStore(graphConfig, config.name);

    // Set up cache
    const cacheEnabled = graphConfig.cache.enabled;
    const cacheBase = cacheDir ? path.dirname(cacheDir) : graphConfig.cache.directory;
    const cache = new ExtractionCache(cacheBase, config.name);

    let entities: ExtractedEntity[] = [];
    let relationships: ExtractedRelationship[] = [];
    let communities: Community[] = [];
    let restored = false;

    // --- Path 1: Store already has data for THIS knowledge base (Neo4j persistence across restarts) ---
    // getAllNodes/getAllEdges are scoped to this KB via BELONGS_TO_KB when knowledgeBaseName is set
    const kbNodeId = normalizeId(config.name, 'KnowledgeBase');
    const kbNode = await store.getNode(kbNodeId);
    if (kbNode) {
      const ownNodes = await store.getAllNodes();
      const ownEdges = await store.getAllEdges();

      if (ownNodes.length > 0) {
        logger.info(`Store has ${ownNodes.length} nodes for "${config.name}" (persistent store), skipping pipeline`);
        onProgress?.({ name: config.name, phase: 'loading', progress: 50, message: 'Restoring from persistent store...' });

        communities = await store.getCommunities();

        // If communities empty (Neo4j doesn't persist them), try loading from cache
        if (communities.length === 0 && cacheEnabled && await cache.hasCache()) {
          try {
            const cached = await cache.load();
            communities = cached.communities;
            await store.setCommunities(communities);
            entities = cached.entities;
            relationships = cached.relationships;
          } catch {
            logger.warn('Failed to load communities from cache for persistent store');
          }
        }

        metadata.entityCount = ownNodes.length;
        metadata.edgeCount = ownEdges.length;
        metadata.communityCount = communities.length;
        restored = true;
      }
    }

    // --- Path 2: Restore from disk cache (memory stores on restart) ---
    if (!restored && cacheEnabled && await cache.hasCache()) {
      try {
        const cachedNodes = await cache.loadNodes();
        if (cachedNodes && cachedNodes.length > 0) {
          logger.info('Cache found with node embeddings - restoring without loading documents...');
          onProgress?.({ name: config.name, phase: 'loading', progress: 10, message: 'Restoring from cache...' });

          const cached = await cache.load();
          entities = cached.entities;
          relationships = cached.relationships;
          communities = cached.communities;

          onProgress?.({ name: config.name, phase: 'building', progress: 50, message: 'Rebuilding graph from cache...' });
          await this.populateStore(store, config, cachedNodes, relationships, communities);

          metadata.entityCount = entities.length;
          metadata.edgeCount = relationships.length;
          metadata.communityCount = communities.length;
          restored = true;

          logger.info(`GraphRAG "${config.name}" restored from cache: ${cachedNodes.length} nodes`);
        } else {
          logger.info('Cache found but no node embeddings - falling through to full pipeline');
        }
      } catch (cacheError) {
        logger.warn(`Cache restore failed, falling through to full pipeline: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
        entities = [];
        relationships = [];
        communities = [];
      }
    }

    // --- Path 3: Full pipeline (load docs, extract, embed, build, cache) ---
    if (!restored) {
      onProgress?.({ name: config.name, phase: 'loading', progress: 5, message: 'Loading documents...' });
      logger.info('Loading documents...');
      const documents = await KnowledgeStoreFactory.loadDocuments(config, projectRoot);
      logger.info(`Loaded ${documents.length} document(s)`);
      metadata.documentCount = documents.length;

      onProgress?.({ name: config.name, phase: 'splitting', progress: 15, message: `Splitting ${documents.length} documents...` });
      const splitDocs = await KnowledgeStoreFactory.splitDocuments(config, documents);
      logger.info(`Split into ${splitDocs.length} chunk(s)`);
      metadata.chunkCount = splitDocs.length;

      // Compute source hash for cache validation
      const docContents = splitDocs.map((d) => d.pageContent);
      const sourceHash = ExtractionCache.computeSourceHash(docContents);
      metadata.sourceHashes = await KnowledgeStoreFactory.computeFileHashes(config, projectRoot);

      let cachedNodes: GraphNode[] | null = null;
      let cacheHit = false;

      // Check cache with source hash validation
      if (cacheEnabled && await cache.isValid(sourceHash)) {
        try {
          logger.info('Cache HIT - loading from cache');
          onProgress?.({ name: config.name, phase: 'loading', progress: 20, message: 'Loading from cache...' });
          const cached = await cache.load();
          entities = cached.entities;
          relationships = cached.relationships;
          communities = cached.communities;

          cachedNodes = await cache.loadNodes();
          if (cachedNodes) {
            logger.info(`Loaded ${cachedNodes.length} cached nodes with embeddings`);
          }

          cacheHit = true;
        } catch (cacheError) {
          logger.warn(`Cache load failed, falling back to extraction: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
        }
      }

      if (!cacheHit) {
        if (cacheEnabled) {
          logger.info('Cache MISS - running extraction pipeline');
        }

        // Entity extraction
        if (graphConfig.extractionMode === 'direct' && graphConfig.directMapping) {
          onProgress?.({ name: config.name, phase: 'extracting', progress: 30, message: 'Running direct mapping...' });
          logger.info(`Using direct mapping mode for ${config.name}`);
          const result = DirectMapper.mapQueryResults(documents, graphConfig.directMapping);
          entities = result.entities;
          relationships = result.relationships;
          logger.info(`Direct mapping: ${entities.length} entities, ${relationships.length} relationships`);
        } else {
          onProgress?.({ name: config.name, phase: 'extracting', progress: 30, message: 'Extracting entities with LLM...' });
          logger.info(`Using LLM extraction mode for ${config.name}`);
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
        }

        // Build graph
        onProgress?.({ name: config.name, phase: 'embedding', progress: 55, message: `Embedding ${entities.length} entities...` });
        const nodes = await this.buildNodes(entities, embeddings);

        onProgress?.({ name: config.name, phase: 'building', progress: 65, message: 'Building graph...' });
        await this.populateStore(store, config, nodes, relationships, []);

        // Community detection
        onProgress?.({ name: config.name, phase: 'building', progress: 75, message: 'Detecting communities...' });
        if (store instanceof MemoryGraphStore) {
          const detector = new CommunityDetector(graphConfig.communities);
          communities = await detector.detect(store);

          if (communities.length > 0) {
            onProgress?.({ name: config.name, phase: 'building', progress: 80, message: `Summarizing ${communities.length} communities...` });
            const summaryLlm = LLMFactory.create(graphConfig.communities.summaryLlm);
            const summarizer = new CommunitySummarizer(summaryLlm);
            communities = await summarizer.summarize(communities, store);
          }
        } else {
          communities = [];
          logger.warn('Community detection not supported for Neo4j store (use memory store)');
        }

        await store.setCommunities(communities);

        // Save to cache
        if (cacheEnabled) {
          onProgress?.({ name: config.name, phase: 'caching', progress: 90, message: 'Saving to cache...' });
          await cache.save(sourceHash, entities, relationships, communities);
          await cache.saveNodes(nodes);
        }
      }

      // Cache hit but store empty: rebuild from cached data
      if (cacheHit && entities.length > 0 && (await store.getAllNodes()).length === 0) {
        onProgress?.({ name: config.name, phase: 'building', progress: 60, message: 'Rebuilding graph from cache...' });

        let nodes: GraphNode[];
        if (cachedNodes && cachedNodes.length > 0) {
          nodes = cachedNodes;
          logger.info(`Using ${nodes.length} cached nodes (skipping embedding)`);
        } else {
          onProgress?.({ name: config.name, phase: 'embedding', progress: 50, message: `Re-embedding ${entities.length} entities...` });
          nodes = await this.buildNodes(entities, embeddings);
        }

        await this.populateStore(store, config, nodes, relationships, communities);

        if (!cachedNodes && cacheEnabled) {
          await cache.saveNodes(nodes);
        }
      }

      // Update metadata counts
      metadata.entityCount = entities.length;
      metadata.edgeCount = relationships.length;
      metadata.communityCount = communities.length;
    }

    logger.info(`GraphRAG "${config.name}" ready: ${metadata.entityCount} entities, ${metadata.edgeCount} edges, ${metadata.communityCount} communities`);

    // Register graph store for API access
    this.graphStores.set(config.name, store);

    // Create search instances
    const localSearch = new LocalSearch(store, embeddings, searchConfig.localSearch);
    const globalSearchLlm = LLMFactory.create(searchConfig.globalSearch.llm);
    const globalSearch = new GlobalSearch(store, globalSearchLlm, searchConfig.globalSearch);

    onProgress?.({ name: config.name, phase: 'done', progress: 100, message: 'Complete' });

    return {
      config: config as any,
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
      refresh: async (refreshOnProgress?: IndexingProgressCallback): Promise<void> => {
        logger.info(`Refreshing GraphRAG store "${config.name}"...`);

        const newSourceHashes = await KnowledgeStoreFactory.computeFileHashes(config, projectRoot);
        const hashesChanged = JSON.stringify(metadata.sourceHashes) !== JSON.stringify(newSourceHashes);

        if (!hashesChanged) {
          logger.info(`No source changes detected for "${config.name}", skipping refresh`);
          return;
        }

        await store.clearByKnowledgeBase(config.name);
        if (cacheEnabled) {
          await cache.clear();
        }
        await GraphRagFactory.create(config, projectRoot, cacheDir, refreshOnProgress);
      },
      getMetadata: () => ({ ...metadata }),
    };
  }

  /**
   * Populate a graph store with nodes, edges, KB master node, and communities.
   */
  private static async populateStore(
    store: GraphStore,
    config: GraphRagKnowledgeConfig,
    nodes: GraphNode[],
    relationships: ExtractedRelationship[],
    communities: Community[]
  ): Promise<void> {
    const edges = this.buildEdges(relationships, nodes);
    await store.addNodes(nodes);
    await store.addEdges(edges);

    // Add knowledge base master node
    const kbNodeId = normalizeId(config.name, 'KnowledgeBase');
    const kbNode: GraphNode = {
      id: kbNodeId,
      type: 'KnowledgeBase',
      name: config.name,
      description: config.description || `Knowledge base: ${config.name}`,
      properties: {
        sourceType: config.source.type,
        createdAt: new Date().toISOString(),
        totalEntities: nodes.length,
        totalRelationships: edges.length,
      },
      sourceChunkIds: [],
      embedding: [],
    };
    await store.addNodes([kbNode]);

    const kbEdges: GraphEdge[] = nodes.map((node, idx) => ({
      id: `kb-edge-${idx}`,
      type: 'BELONGS_TO_KB',
      sourceId: node.id,
      targetId: kbNodeId,
      description: `Entity belongs to ${config.name} knowledge base`,
      weight: 1.0,
      properties: {},
    }));
    await store.addEdges(kbEdges);

    if (communities.length > 0) {
      await store.setCommunities(communities);
    }
  }

  private static createGraphStore(config: GraphConfig, knowledgeBaseName: string): GraphStore {
    switch (config.store.type) {
      case 'neo4j': {
        const opts = config.store.options as Record<string, string>;
        return new Neo4jGraphStore({
          uri: opts.uri ?? 'bolt://localhost:7687',
          username: opts.username ?? 'neo4j',
          password: opts.password ?? 'password',
          database: opts.database,
          knowledgeBaseName,
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
      const key = normalizeId(node.name, node.type);
      nodeIdMap.set(key, node.id);
    }

    const edges: GraphEdge[] = [];
    for (let i = 0; i < relationships.length; i++) {
      const rel = relationships[i]!;
      const sourceKey = normalizeId(rel.sourceName, rel.sourceType);
      const targetKey = normalizeId(rel.targetName, rel.targetType);

      const sourceId = nodeIdMap.get(sourceKey);
      const targetId = nodeIdMap.get(targetKey);

      if (!sourceId || !targetId) {
        logger.warn(`Skipping relationship ${rel.type}: missing node for ${rel.sourceName} (${rel.sourceType}) -> ${rel.targetName} (${rel.targetType})`);
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
