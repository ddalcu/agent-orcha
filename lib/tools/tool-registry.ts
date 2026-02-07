import type { StructuredTool } from '@langchain/core/tools';
import type { MCPClientManager } from '../mcp/mcp-client.js';
import type { KnowledgeStoreManager } from '../knowledge/knowledge-store-manager.js';
import type { FunctionLoader } from '../functions/function-loader.js';
import type { ToolReference } from '../agents/types.js';
import { createKnowledgeTools } from './built-in/knowledge-tools-factory.js';
import { logger } from '../logger.js';

export class ToolRegistry {
  private mcpClient: MCPClientManager;
  private knowledgeStores: KnowledgeStoreManager;
  private functionLoader: FunctionLoader;
  private builtInTools: Map<string, StructuredTool> = new Map();
  private sandboxTools: Map<string, StructuredTool>;

  constructor(
    mcpClient: MCPClientManager,
    knowledgeStores: KnowledgeStoreManager,
    functionLoader: FunctionLoader,
    sandboxTools: Map<string, StructuredTool> = new Map(),
  ) {
    this.mcpClient = mcpClient;
    this.knowledgeStores = knowledgeStores;
    this.functionLoader = functionLoader;
    this.sandboxTools = sandboxTools;
  }

  async resolveTools(toolRefs: ToolReference[]): Promise<StructuredTool[]> {
    const tools: StructuredTool[] = [];

    for (const ref of toolRefs) {
      const resolved = await this.resolveTool(ref);
      tools.push(...resolved);
    }

    return tools;
  }

  private async resolveTool(ref: ToolReference): Promise<StructuredTool[]> {
    if (typeof ref === 'string') {
      return this.resolveStringRef(ref);
    }

    return this.resolveObjectRef(ref);
  }

  private async resolveStringRef(ref: string): Promise<StructuredTool[]> {
    const colonIndex = ref.indexOf(':');
    if (colonIndex === -1) {
      const builtin = this.builtInTools.get(ref);
      return builtin ? [builtin] : [];
    }

    const source = ref.substring(0, colonIndex);
    const name = ref.substring(colonIndex + 1);

    switch (source) {
      case 'mcp':
        return this.mcpClient.getToolsByServer(name);

      case 'knowledge': {
        const store = this.knowledgeStores.get(name);
        if (!store) {
          await this.knowledgeStores.initialize(name);
          const initializedStore = this.knowledgeStores.get(name);
          if (initializedStore) {
            return createKnowledgeTools(name, initializedStore);
          }
          return [];
        }
        return createKnowledgeTools(name, store);
      }

      case 'function': {
        const func = this.functionLoader.getTool(name);
        return func ? [func] : [];
      }

      case 'builtin': {
        const builtin = this.builtInTools.get(name);
        return builtin ? [builtin] : [];
      }

      case 'sandbox': {
        const sandboxTool = this.sandboxTools.get(name);
        if (!sandboxTool) {
          logger.warn(`Sandbox tool "${name}" not found (available: ${Array.from(this.sandboxTools.keys()).join(', ') || 'none'})`);
          return [];
        }
        return [sandboxTool];
      }

      default:
        logger.warn(`Unknown tool source: ${source}`);
        return [];
    }
  }

  private async resolveObjectRef(ref: { name: string; source: string; config?: Record<string, unknown> }): Promise<StructuredTool[]> {
    return this.resolveStringRef(`${ref.source}:${ref.name}`);
  }

  registerBuiltIn(name: string, tool: StructuredTool): void {
    this.builtInTools.set(name, tool);
  }

  unregisterBuiltIn(name: string): boolean {
    return this.builtInTools.delete(name);
  }

  listBuiltIn(): string[] {
    return Array.from(this.builtInTools.keys());
  }

  // Methods for bulk tool discovery (used by LangGraph workflows)

  /**
   * Gets all MCP tools from all servers.
   */
  async getAllMCPTools(): Promise<StructuredTool[]> {
    const serverNames = this.mcpClient.getServerNames();
    const allTools: StructuredTool[] = [];

    for (const serverName of serverNames) {
      try {
        const tools = await this.mcpClient.getToolsByServer(serverName);
        allTools.push(...tools);
      } catch (error) {
        logger.warn(`Failed to get tools from MCP server "${serverName}":`, error);
      }
    }

    return allTools;
  }

  /**
   * Gets all knowledge search tools for all configured knowledge stores.
   */
  async getAllKnowledgeTools(): Promise<StructuredTool[]> {
    const configs = this.knowledgeStores.listConfigs();
    const tools: StructuredTool[] = [];

    for (const config of configs) {
      try {
        // Initialize store if needed
        let store = this.knowledgeStores.get(config.name);
        if (!store) {
          store = await this.knowledgeStores.initialize(config.name);
        }

        // Create all knowledge tools for this store
        const knowledgeTools = createKnowledgeTools(config.name, store);
        tools.push(...knowledgeTools);
      } catch (error) {
        logger.warn(`Failed to create knowledge tools for "${config.name}":`, error);
      }
    }

    return tools;
  }

  /**
   * Gets all custom function tools.
   */
  getAllFunctionTools(): StructuredTool[] {
    return this.functionLoader.list().map((f) => f.tool);
  }

  /**
   * Gets all built-in tools.
   */
  getAllBuiltInTools(): StructuredTool[] {
    return Array.from(this.builtInTools.values());
  }

  /**
   * Gets the sandbox tool if configured.
   */
  getAllSandboxTools(): StructuredTool[] {
    return Array.from(this.sandboxTools.values());
  }
}
