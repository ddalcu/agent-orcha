import * as fs from 'fs/promises';
import * as path from 'path';
import { stringify as stringifyYaml } from 'yaml';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import type { IndexingProgressCallback } from '../../lib/knowledge/knowledge-store-metadata.ts';
import { KnowledgeConfigSchema } from '../../lib/knowledge/types.ts';
import { createLogger } from '../../lib/logger.ts';

const logger = createLogger('KnowledgeRoutes');

const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

interface KnowledgeParams {
  name: string;
}

interface SearchBody {
  query: string;
  k?: number;
}

interface AddDocumentsBody {
  documents: Array<{
    content: string;
    metadata?: Record<string, unknown>;
  }>;
}

interface CreateKnowledgeBody {
  name: string;
  description: string;
  source: {
    type: 'file' | 'directory' | 'web' | 'database';
    path?: string;
    pattern?: string;
    recursive?: boolean;
    url?: string;
    selector?: string;
    headers?: Record<string, string>;
    jsonPath?: string;
    connectionString?: string;
    query?: string;
    contentColumn?: string;
    metadataColumns?: string[];
    batchSize?: number;
  };
  loader?: { type: string; options?: Record<string, unknown> };
  splitter: { type: string; chunkSize: number; chunkOverlap: number; separator?: string };
  embedding?: string;
  search?: { defaultK?: number; scoreThreshold?: number };
  reindex?: { schedule: string };
  metadata?: Record<string, unknown>;
}

// Track active SSE connections for indexing progress
const sseConnections = new Map<string, Set<(event: string, data: string) => void>>();
// Track last progress event per store so reconnecting clients get current state
const lastProgressEvents = new Map<string, { event: string; data: string }>();

function addSSEListener(name: string, listener: (event: string, data: string) => void) {
  if (!sseConnections.has(name)) {
    sseConnections.set(name, new Set());
  }
  sseConnections.get(name)!.add(listener);
}

function removeSSEListener(name: string, listener: (event: string, data: string) => void) {
  sseConnections.get(name)?.delete(listener);
  if (sseConnections.get(name)?.size === 0) {
    sseConnections.delete(name);
  }
}

function broadcastSSE(name: string, event: string, data: string) {
  lastProgressEvents.set(name, { event, data });

  const parsed = JSON.parse(data);
  if (parsed.phase === 'done' || parsed.phase === 'error') {
    setTimeout(() => lastProgressEvents.delete(name), 5000);
  }

  const listeners = sseConnections.get(name);
  if (listeners) {
    for (const listener of listeners) {
      listener(event, data);
    }
  }
}

export const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  // Register multipart for file uploads (scoped to this plugin)
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // POST / - Create a new knowledge store
  fastify.post<{ Body: CreateKnowledgeBody }>('/', async (request, reply) => {
    const body = request.body;

    if (!body.name || !SAFE_NAME_RE.test(body.name)) {
      return reply.status(400).send({
        error: 'Invalid name. Must start with alphanumeric and contain only letters, numbers, hyphens, underscores.',
      });
    }

    const existing = fastify.orchestrator.knowledge.getConfig(body.name);
    if (existing) {
      return reply.status(409).send({ error: `Knowledge store "${body.name}" already exists` });
    }

    // For file/directory sources, default path to knowledge/<name>/
    if ((body.source.type === 'file' || body.source.type === 'directory') && !body.source.path) {
      body.source.path = `knowledge/${body.name}/`;
    }

    // Build the config object
    const config: Record<string, unknown> = {
      name: body.name,
      description: body.description,
      source: body.source,
      splitter: body.splitter,
    };
    if (body.loader) config.loader = body.loader;
    if (body.embedding) config.embedding = body.embedding;
    if (body.search) config.search = body.search;
    if (body.reindex) config.reindex = body.reindex;
    if (body.metadata) config.metadata = body.metadata;

    // Validate via Zod
    try {
      KnowledgeConfigSchema.parse(config);
    } catch (err) {
      return reply.status(400).send({
        error: 'Invalid knowledge store configuration',
        details: err instanceof Error ? err.message : String(err),
      });
    }

    // Write YAML to disk
    const knowledgeDir = fastify.orchestrator.knowledge.getKnowledgeDir();
    const yamlPath = path.join(knowledgeDir, `${body.name}.knowledge.yaml`);
    const workspaceRoot = fastify.orchestrator.knowledge.getWorkspaceRoot();
    const relativePath = path.relative(workspaceRoot, yamlPath);

    try {
      await fs.mkdir(knowledgeDir, { recursive: true });
      await fs.writeFile(yamlPath, stringifyYaml(config));
    } catch (err) {
      logger.error(`Failed to write knowledge config for "${body.name}":`, err);
      return reply.status(500).send({ error: 'Failed to write configuration file' });
    }

    // Hot-load into orchestrator
    try {
      await fastify.orchestrator.reloadFile(relativePath);
    } catch (err) {
      logger.error(`Failed to reload knowledge config for "${body.name}":`, err);
      // Clean up the file we just wrote
      await fs.unlink(yamlPath).catch(() => {});
      return reply.status(500).send({ error: 'Failed to load configuration' });
    }

    // Create upload directory for file/directory sources
    if (body.source.type === 'file' || body.source.type === 'directory') {
      const uploadDir = path.resolve(workspaceRoot, body.source.path!);
      await fs.mkdir(uploadDir, { recursive: true });
    }

    logger.info(`Created knowledge store "${body.name}"`);
    return { success: true, name: body.name };
  });

  // PUT /:name - Update an existing knowledge store
  fastify.put<{ Params: KnowledgeParams; Body: CreateKnowledgeBody }>(
    '/:name',
    async (request, reply) => {
      const { name } = request.params;
      const body = request.body;

      const existingConfig = fastify.orchestrator.knowledge.getConfig(name);
      if (!existingConfig) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      if (fastify.orchestrator.knowledge.isIndexing(name)) {
        return reply.status(409).send({ error: `"${name}" is currently being indexed, cannot update` });
      }

      if (body.name && body.name !== name) {
        return reply.status(400).send({ error: 'Cannot rename a knowledge store. Delete and recreate instead.' });
      }

      // For file/directory sources, default path to knowledge/<name>/
      if ((body.source.type === 'file' || body.source.type === 'directory') && !body.source.path) {
        body.source.path = `knowledge/${name}/`;
      }

      // Build config
      const config: Record<string, unknown> = {
        name,
        description: body.description,
        source: body.source,
        splitter: body.splitter,
      };
      if (body.loader) config.loader = body.loader;
      if (body.embedding) config.embedding = body.embedding;
      if (body.search) config.search = body.search;
      if (body.reindex) config.reindex = body.reindex;
      if (body.metadata) config.metadata = body.metadata;

      // Validate via Zod
      try {
        KnowledgeConfigSchema.parse(config);
      } catch (err) {
        return reply.status(400).send({
          error: 'Invalid knowledge store configuration',
          details: err instanceof Error ? err.message : String(err),
        });
      }

      // Find existing YAML file path
      const filePath = fastify.orchestrator.knowledge.getFilePath(name);
      const workspaceRoot = fastify.orchestrator.knowledge.getWorkspaceRoot();
      const yamlPath = filePath || path.join(fastify.orchestrator.knowledge.getKnowledgeDir(), `${name}.knowledge.yaml`);
      const relativePath = path.relative(workspaceRoot, yamlPath);

      try {
        await fs.writeFile(yamlPath, stringifyYaml(config));
      } catch (err) {
        logger.error(`Failed to write knowledge config for "${name}":`, err);
        return reply.status(500).send({ error: 'Failed to write configuration file' });
      }

      // Reload (evicts old, loads new)
      try {
        await fastify.orchestrator.reloadFile(relativePath);
      } catch (err) {
        logger.error(`Failed to reload knowledge config for "${name}":`, err);
        return reply.status(500).send({ error: 'Failed to reload configuration' });
      }

      logger.info(`Updated knowledge store "${name}"`);
      return { success: true, name };
    }
  );

  // DELETE /:name - Delete a knowledge store and all its data
  fastify.delete<{ Params: KnowledgeParams }>(
    '/:name',
    async (request, reply) => {
      const { name } = request.params;

      const existingConfig = fastify.orchestrator.knowledge.getConfig(name);
      if (!existingConfig) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      if (fastify.orchestrator.knowledge.isIndexing(name)) {
        return reply.status(409).send({ error: `"${name}" is currently being indexed, cannot delete` });
      }

      // Find YAML file path before unloading
      const filePath = fastify.orchestrator.knowledge.getFilePath(name);
      const workspaceRoot = fastify.orchestrator.knowledge.getWorkspaceRoot();

      // Unload from memory
      if (filePath) {
        const relativePath = path.relative(workspaceRoot, filePath);
        await fastify.orchestrator.unloadFile(relativePath);
      }

      // Delete YAML file
      if (filePath) {
        try {
          await fs.unlink(filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn(`Failed to delete config file for "${name}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Delete SQLite database
      await fastify.orchestrator.knowledge.deleteData(name);

      // Delete metadata cache
      await fastify.orchestrator.knowledge.getMetadataManager().delete(name);

      logger.info(`Deleted knowledge store "${name}"`);
      return { success: true, name };
    }
  );

  // POST /:name/upload - Upload files to a file/directory-based knowledge store
  fastify.post<{ Params: KnowledgeParams }>(
    '/:name/upload',
    async (request, reply) => {
      const { name } = request.params;

      const config = fastify.orchestrator.knowledge.getConfig(name);
      if (!config) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      if (config.source.type !== 'file' && config.source.type !== 'directory') {
        return reply.status(400).send({
          error: `File upload is only supported for file/directory source types, not "${config.source.type}"`,
        });
      }

      const sourcePath = config.source.path;
      const workspaceRoot = fastify.orchestrator.knowledge.getWorkspaceRoot();
      const uploadDir = path.resolve(workspaceRoot, sourcePath);

      // Ensure the upload directory exists
      await fs.mkdir(uploadDir, { recursive: true });

      const uploadedFiles: { name: string; size: number }[] = [];

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type !== 'file') continue;

        // Sanitize filename — strip path separators and traversal
        const sanitized = part.filename
          .replace(/\.\./g, '')
          .replace(/[/\\]/g, '')
          .replace(/\0/g, '');

        if (!sanitized) {
          logger.warn(`Skipping file with invalid name: "${part.filename}"`);
          continue;
        }

        const destPath = path.join(uploadDir, sanitized);

        // Ensure we're still within the upload directory (path traversal protection)
        if (!destPath.startsWith(uploadDir)) {
          logger.warn(`Path traversal attempt blocked: "${part.filename}"`);
          continue;
        }

        const buffer = await part.toBuffer();
        await fs.writeFile(destPath, buffer);
        uploadedFiles.push({ name: sanitized, size: buffer.length });
        logger.info(`Uploaded file "${sanitized}" (${buffer.length} bytes) to "${name}"`);
      }

      return { success: true, files: uploadedFiles };
    }
  );

  // GET / - List all knowledge stores with status metadata
  fastify.get('/', async () => {
    const configs = fastify.orchestrator.knowledge.listConfigs();
    const statuses = await fastify.orchestrator.knowledge.getAllStatuses();

    return configs.map((config) => {
      const status = statuses.get(config.name);
      const hasGraph = !!config.graph;
      return {
        name: config.name,
        hasGraph,
        description: config.description,
        source: config.source,
        defaultK: config.search?.defaultK ?? 4,

        status: status?.status ?? 'not_indexed',
        lastIndexedAt: status?.lastIndexedAt ?? null,
        lastIndexDurationMs: status?.lastIndexDurationMs ?? null,
        documentCount: status?.documentCount ?? 0,
        chunkCount: status?.chunkCount ?? 0,
        entityCount: status?.entityCount ?? 0,
        edgeCount: status?.edgeCount ?? 0,
        embeddingModel: status?.embeddingModel ?? config.embedding,
        errorMessage: status?.errorMessage ?? null,
        isIndexing: fastify.orchestrator.knowledge.isIndexing(config.name),
      };
    });
  });

  // GET /:name - Get config for a specific store
  fastify.get<{ Params: KnowledgeParams }>('/:name', async (request, reply) => {
    const config = fastify.orchestrator.knowledge.getConfig(request.params.name);

    if (!config) {
      return reply.status(404).send({
        error: 'Knowledge store not found',
        name: request.params.name,
      });
    }

    return config;
  });

  // GET /:name/status - Get metadata/status for a specific store
  fastify.get<{ Params: KnowledgeParams }>(
    '/:name/status',
    async (request, reply) => {
      const { name } = request.params;
      const config = fastify.orchestrator.knowledge.getConfig(name);

      if (!config) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      const statusData = await fastify.orchestrator.knowledge.getStatus(name);
      return {
        name,
        hasGraph: !!config.graph,
        isIndexing: fastify.orchestrator.knowledge.isIndexing(name),
        status: statusData?.status ?? 'not_indexed',
        lastIndexedAt: statusData?.lastIndexedAt ?? null,
        lastIndexDurationMs: statusData?.lastIndexDurationMs ?? null,
        documentCount: statusData?.documentCount ?? 0,
        chunkCount: statusData?.chunkCount ?? 0,
        entityCount: statusData?.entityCount ?? 0,
        edgeCount: statusData?.edgeCount ?? 0,
        embeddingModel: statusData?.embeddingModel ?? config.embedding,
        errorMessage: statusData?.errorMessage ?? null,
      };
    }
  );

  // POST /:name/index - Trigger async indexing
  fastify.post<{ Params: KnowledgeParams }>(
    '/:name/index',
    async (request, reply) => {
      const { name } = request.params;
      const config = fastify.orchestrator.knowledge.getConfig(name);

      if (!config) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      if (fastify.orchestrator.knowledge.isIndexing(name)) {
        return reply.status(409).send({ error: `"${name}" is already being indexed` });
      }

      const onProgress: IndexingProgressCallback = (event) => {
        broadcastSSE(name, 'progress', JSON.stringify(event));
      };

      const existingStore = fastify.orchestrator.knowledge.get(name);

      if (existingStore) {
        fastify.orchestrator.knowledge.refresh(name, onProgress).catch((error) => {
          broadcastSSE(name, 'error', JSON.stringify({
            name,
            phase: 'error',
            progress: 0,
            message: error instanceof Error ? error.message : String(error),
          }));
        });
      } else {
        fastify.orchestrator.knowledge.initialize(name, onProgress).catch((error) => {
          broadcastSSE(name, 'error', JSON.stringify({
            name,
            phase: 'error',
            progress: 0,
            message: error instanceof Error ? error.message : String(error),
          }));
        });
      }

      return { success: true, message: `Indexing started for "${name}"` };
    }
  );

  // GET /:name/index/stream - SSE endpoint for indexing progress
  fastify.get<{ Params: KnowledgeParams }>(
    '/:name/index/stream',
    async (request, reply) => {
      const { name } = request.params;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const listener = (event: string, data: string) => {
        reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);

        const parsed = JSON.parse(data);
        if (parsed.phase === 'done' || parsed.phase === 'error') {
          setTimeout(() => {
            removeSSEListener(name, listener);
            reply.raw.end();
          }, 100);
        }
      };

      addSSEListener(name, listener);

      reply.raw.write(`event: connected\ndata: {"name":"${name}"}\n\n`);

      const lastProgress = lastProgressEvents.get(name);
      if (lastProgress) {
        reply.raw.write(`event: ${lastProgress.event}\ndata: ${lastProgress.data}\n\n`);
      }

      request.raw.on('close', () => {
        removeSSEListener(name, listener);
      });
    }
  );

  // POST /:name/search
  fastify.post<{ Params: KnowledgeParams; Body: SearchBody }>(
    '/:name/search',
    async (request, reply) => {
      const { name } = request.params;
      const { query, k } = request.body;

      try {
        const results = await fastify.orchestrator.searchKnowledge(name, query, k);
        return { results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('not found')) {
          return reply.status(404).send({ error: message });
        }

        return reply.status(500).send({ error: message });
      }
    }
  );

  // POST /:name/refresh
  fastify.post<{ Params: KnowledgeParams }>(
    '/:name/refresh',
    async (request, reply) => {
      const { name } = request.params;

      try {
        await fastify.orchestrator.knowledge.refresh(name);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(500).send({ error: message });
      }
    }
  );

  // POST /:name/add
  fastify.post<{ Params: KnowledgeParams; Body: AddDocumentsBody }>(
    '/:name/add',
    async (request, reply) => {
      const { name } = request.params;
      const { documents } = request.body;

      try {
        const store = fastify.orchestrator.knowledge.get(name);

        if (!store) {
          await fastify.orchestrator.knowledge.initialize(name);
          const initializedStore = fastify.orchestrator.knowledge.get(name);

          if (!initializedStore) {
            return reply.status(404).send({
              error: 'Knowledge store not found',
              name,
            });
          }

          await initializedStore.addDocuments(documents);
        } else {
          await store.addDocuments(documents);
        }

        return { success: true, added: documents.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(500).send({ error: message });
      }
    }
  );

  // --- Entity endpoints (available for stores with entities) ---

  fastify.get<{ Params: KnowledgeParams }>(
    '/:name/entities',
    async (request, reply) => {
      const { name } = request.params;
      const sqliteStore = fastify.orchestrator.knowledge.getSqliteStore(name);

      if (!sqliteStore) {
        return reply.status(404).send({ error: `Store not initialized for "${name}"` });
      }

      if (sqliteStore.getEntityCount() === 0) {
        return reply.status(400).send({ error: `"${name}" has no entities` });
      }

      const entities = sqliteStore.getAllEntities();
      return {
        count: entities.length,
        entities: entities.map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          description: e.description,
          sourceChunkIds: JSON.parse(e.source_chunk_ids),
        })),
      };
    }
  );

  fastify.get<{ Params: KnowledgeParams }>(
    '/:name/edges',
    async (request, reply) => {
      const { name } = request.params;
      const sqliteStore = fastify.orchestrator.knowledge.getSqliteStore(name);

      if (!sqliteStore) {
        return reply.status(404).send({ error: `Store not initialized for "${name}"` });
      }

      if (sqliteStore.getEntityCount() === 0) {
        return reply.status(400).send({ error: `"${name}" has no entities` });
      }

      const relationships = sqliteStore.getAllRelationships();
      return {
        count: relationships.length,
        edges: relationships.map((r) => ({
          id: r.id,
          type: r.type,
          sourceId: r.source_id,
          targetId: r.target_id,
          description: r.description,
          weight: r.weight,
        })),
      };
    }
  );
};
