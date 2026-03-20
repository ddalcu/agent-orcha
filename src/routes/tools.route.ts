import type { FastifyPluginAsync } from 'fastify';
import { logger } from '../../lib/logger.ts';

export const toolsRoutes: FastifyPluginAsync = async (fastify) => {
  // List all tools grouped by type
  fastify.get('/', async () => {
    const registry = fastify.orchestrator.tools.getRegistry();
    const mcpManager = fastify.orchestrator.mcp.getManager();

    const serialize = (tools: { name: string; description: string }[]) =>
      tools.map((t) => ({ name: t.name, description: t.description }));

    // MCP: group by server
    const mcp: Record<string, { name: string; description: string }[]> = {};
    for (const serverName of mcpManager.getServerNames()) {
      try {
        const schemas = await mcpManager.getServerToolSchemas(serverName);
        mcp[serverName] = schemas.map((s) => ({ name: s.name, description: s.description || '' }));
      } catch (err) {
        logger.warn(`Failed to list tools for MCP server "${serverName}":`, err);
        mcp[serverName] = [];
      }
    }

    // Knowledge: list tool names from config without initializing stores
    const knowledge: Record<string, { name: string; description: string }[]> = {};
    const knowledgeConfigs = fastify.orchestrator.knowledge.listConfigs();
    for (const config of knowledgeConfigs) {
      const store = fastify.orchestrator.knowledge.get(config.name);
      if (store) {
        // Already initialized — list actual tools
        try {
          const sqliteStore = fastify.orchestrator.knowledge.getSqliteStore(config.name);
          const { createKnowledgeTools } = await import('../../lib/tools/built-in/knowledge-tools-factory.ts');
          const tools = createKnowledgeTools(config.name, store, sqliteStore);
          knowledge[config.name] = serialize(tools);
        } catch (err) {
          logger.warn(`Failed to list tools for knowledge store "${config.name}":`, err);
          knowledge[config.name] = [];
        }
      } else {
        // Not initialized — return expected tool names without triggering indexing
        const baseTools = [
          { name: `${config.name}_search`, description: `Search the ${config.name} knowledge store` },
        ];
        if (config.graph) {
          baseTools.push(
            { name: `${config.name}_traverse`, description: `Traverse relationships in ${config.name}` },
            { name: `${config.name}_entity_lookup`, description: `Look up entities in ${config.name}` },
            { name: `${config.name}_graph_schema`, description: `Get graph schema for ${config.name}` },
          );
        }
        knowledge[config.name] = baseTools;
      }
    }

    return {
      mcp,
      function: serialize(registry.getAllFunctionTools()),
      knowledge,
      builtin: serialize(registry.getAllBuiltInTools()),
      sandbox: serialize(registry.getAllSandboxTools()),
      workspace: serialize(registry.getAllWorkspaceTools()),
    };
  });
};
