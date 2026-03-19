import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tool } from '../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../types/llm-types.ts';
import type { MCPConfig, MCPServerConfig } from './types.ts';
import { logger } from '../logger.ts';

interface MCPConnection {
  client: Client;
  config: MCPServerConfig;
}

export class MCPClientManager {
  private config: MCPConfig;
  private connections: Map<string, MCPConnection> = new Map();
  private connecting: Map<string, Promise<void>> = new Map();
  private failedServers: Set<string> = new Set();
  private toolsCache: Map<string, StructuredTool[]> = new Map();

  constructor(config: MCPConfig) {
    this.config = config;
  }

  /**
   * Start connecting to all configured MCP servers in the background.
   * Does not block — connections resolve asynchronously.
   */
  initialize(): void {
    for (const [name, serverConfig] of Object.entries(this.config.servers)) {
      if (serverConfig.enabled === false) continue;

      const connectPromise = this.connectWithTimeout(name, serverConfig)
        .then((connection) => {
          this.connections.set(name, connection);
          logger.info(`Connected to MCP server "${name}"`);
        })
        .catch((error) => {
          this.failedServers.add(name);
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`\n${'='.repeat(60)}\n  MCP SERVER FAILED: "${name}"\n  ${msg}\n${'='.repeat(60)}\n`);
        })
        .finally(() => {
          this.connecting.delete(name);
        });

      this.connecting.set(name, connectPromise);
    }
  }

  /** Wait for a specific server to finish connecting (used internally). */
  private async ensureConnected(serverName: string): Promise<void> {
    const pending = this.connecting.get(serverName);
    if (pending) await pending;
  }

  /** Wait for all servers to finish connecting. */
  async waitForAll(): Promise<void> {
    await Promise.all(this.connecting.values());
  }

  private async connectWithTimeout(name: string, serverConfig: MCPServerConfig): Promise<MCPConnection> {
    const timeout = serverConfig.timeout ?? 10000;
    return Promise.race([
      this.connectToServer(name, serverConfig),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Connection timed out after ${timeout}ms`)), timeout)
      ),
    ]);
  }

  private async connectToServer(name: string, config: MCPServerConfig): Promise<MCPConnection> {
    const client = new Client(
      { name: `agent-orcha-${name}`, version: '1.0.0' },
      { capabilities: {} }
    );

    if (config.transport === 'stdio') {
      // Use StdioClientTransport for local processes
      if (!config.command) {
        throw new Error(`MCP server "${name}" with stdio transport requires a command`);
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env,
      });
      await client.connect(transport);
    } else {
      // HTTP-based transports require a URL
      if (!config.url) {
        throw new Error(`MCP server "${name}" requires a URL for ${config.transport} transport`);
      }

      const url = new URL(config.url);

      if (config.transport === 'streamable-http' || config.transport === 'sse') {
        // Use StreamableHTTPClientTransport for remote servers
        // It handles both POST for messages and optional GET for SSE
        const transport = new StreamableHTTPClientTransport(url);
        await client.connect(transport);
      } else if (config.transport === 'sse-only') {
        // Legacy SSE-only transport (rarely needed)
        const transport = new SSEClientTransport(url);
        await client.connect(transport);
      } else {
        throw new Error(`Unsupported transport: ${config.transport}`);
      }
    }

    return { client, config };
  }

  async getTools(): Promise<StructuredTool[]> {
    const allTools: StructuredTool[] = [];

    for (const [serverName, connection] of this.connections) {
      const tools = await this.getToolsForServer(serverName, connection);
      allTools.push(...tools);
    }

    return allTools;
  }

  async getToolsByServer(serverName: string): Promise<StructuredTool[]> {
    const cached = this.toolsCache.get(serverName);
    if (cached) {
      return cached;
    }

    await this.ensureConnected(serverName);
    const connection = this.connections.get(serverName);
    if (!connection) {
      return [];
    }

    const tools = await this.getToolsForServer(serverName, connection);
    this.toolsCache.set(serverName, tools);
    return tools;
  }

  getServerNames(): string[] {
    // Return all active servers (connected + still connecting + failed, excluding disabled)
    return Object.entries(this.config.servers)
      .filter(([, cfg]) => cfg.enabled !== false)
      .map(([name]) => name);
  }

  getConfiguredServerNames(): string[] {
    return Object.keys(this.config.servers);
  }

  isConnected(serverName: string): boolean {
    return this.connections.has(serverName);
  }

  isFailed(serverName: string): boolean {
    return this.failedServers.has(serverName);
  }

  isConnecting(serverName: string): boolean {
    return this.connecting.has(serverName);
  }

  getServerConfig(serverName: string): MCPServerConfig | undefined {
    return this.config.servers[serverName] ?? this.connections.get(serverName)?.config;
  }

  async getServerToolSchemas(serverName: string): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
    await this.ensureConnected(serverName);
    const connection = this.connections.get(serverName);
    if (!connection) {
      return [];
    }

    const { tools: mcpTools } = await connection.client.listTools();
    return mcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureConnected(serverName);
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" not found or failed to connect`);
    }

    const result = await connection.client.callTool({
      name: toolName,
      arguments: args,
    });

    if (result.isError) {
      throw new Error(String(result.content));
    }

    return this.extractContent(result.content);
  }

  private async getToolsForServer(serverName: string, connection: MCPConnection): Promise<StructuredTool[]> {
    const { tools: mcpTools } = await connection.client.listTools();
    const prefix = this.config.globalOptions?.prefixToolNameWithServerName ? `${serverName}_` : '';

    return mcpTools.map((mcpTool) => {
      const inputSchema = this.convertJsonSchemaToZod(mcpTool.inputSchema);

      return tool(
        async (input) => {
          const result = await connection.client.callTool({
            name: mcpTool.name,
            arguments: input,
          });

          if (result.isError) {
            throw new Error(String(result.content));
          }

          return this.extractContent(result.content);
        },
        {
          name: `${prefix}${mcpTool.name}`,
          description: mcpTool.description ?? `Tool from ${serverName}`,
          schema: inputSchema,
        }
      );
    });
  }

  private convertJsonSchemaToZod(schema: unknown): z.ZodObject<Record<string, z.ZodTypeAny>> {
    const jsonSchema = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
    const properties = jsonSchema.properties ?? {};
    const required = new Set(jsonSchema.required ?? []);

    const zodShape: Record<string, z.ZodTypeAny> = {};

    for (const [key, prop] of Object.entries(properties)) {
      let zodType: z.ZodTypeAny;

      switch (prop.type) {
        case 'string':
          zodType = z.string();
          break;
        case 'number':
        case 'integer':
          zodType = z.number();
          break;
        case 'boolean':
          zodType = z.boolean();
          break;
        case 'array':
          zodType = z.array(z.unknown());
          break;
        case 'object':
          zodType = z.record(z.unknown());
          break;
        default:
          zodType = z.unknown();
      }

      if (prop.description) {
        zodType = zodType.describe(prop.description);
      }

      zodShape[key] = required.has(key) ? zodType : zodType.optional();
    }

    return z.object(zodShape);
  }

  private extractContent(content: unknown): string {
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'object' && item !== null && 'text' in item) {
            return (item as { text: string }).text;
          }
          return String(item);
        })
        .join('\n');
    }
    return String(content);
  }

  async close(): Promise<void> {
    for (const [, connection] of this.connections) {
      await connection.client.close();
    }
    this.connections.clear();
    this.toolsCache.clear();
  }
}
