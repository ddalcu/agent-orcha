import type { FastifyPluginAsync } from 'fastify';
import { logger } from '../../lib/logger.ts';

interface MCPParams {
  name: string;
}

interface CallToolBody {
  tool: string;
  arguments: Record<string, unknown>;
}

export const mcpRoutes: FastifyPluginAsync = async (fastify) => {
  // List all available MCP servers
  fastify.get('/', async () => {
    const mcpManager = fastify.orchestrator.mcp.getManager();
    const serverNames = mcpManager.getServerNames();

    return serverNames.map((name) => {
      const config = mcpManager.getServerConfig(name);
      return {
        name,
        transport: config?.transport || 'unknown',
        command: config?.command || null,
        url: config?.url || null,
      };
    });
  });

  // Get a specific MCP server
  fastify.get<{ Params: MCPParams }>('/:name', async (request, reply) => {
    try {
      const mcpManager = fastify.orchestrator.mcp.getManager();
      const config = mcpManager.getServerConfig(request.params.name);

      if (!config) {
        return reply.status(404).send({ error: `MCP server "${request.params.name}" not found` });
      }

      return {
        name: request.params.name,
        transport: config.transport,
        command: config.command || null,
        url: config.url || null,
        args: config.args || [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(404).send({ error: message });
    }
  });

  // Get tools for a specific MCP server
  fastify.get<{ Params: MCPParams }>('/:name/tools', async (request, reply) => {
    try {
      const mcpManager = fastify.orchestrator.mcp.getManager();
      const tools = await mcpManager.getServerToolSchemas(request.params.name);

      return tools;
    } catch (error) {
      logger.error('[MCP Route] Error listing tools:', error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: message });
    }
  });

  // Call a tool on a specific MCP server
  fastify.post<{ Params: MCPParams; Body: CallToolBody }>(
    '/:name/call',
    async (request, reply) => {
      const { name } = request.params;
      const { tool, arguments: args } = request.body;

      if (!tool || typeof tool !== 'string') {
        return reply.status(400).send({ error: 'tool name is required' });
      }

      if (!args || typeof args !== 'object') {
        return reply.status(400).send({ error: 'arguments object is required' });
      }

      try {
        const mcpManager = fastify.orchestrator.mcp.getManager();
        const result = await mcpManager.callTool(name, tool, args);

        return {
          content: result,
          tool,
          server: name,
        };
      } catch (error) {
        logger.error('[MCP Route] Error calling tool:', error);
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        fastify.log.error({ error, stack }, 'MCP tool call error');
        return reply.status(500).send({ error: message });
      }
    }
  );
};
