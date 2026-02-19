import type { StructuredTool } from '../types/llm-types.ts';
import type { MCPClientManager } from '../mcp/mcp-client.ts';
import type { KnowledgeStore } from '../knowledge/knowledge-store.ts';
import type { FunctionLoader } from '../functions/function-loader.ts';
import type { ToolReference } from '../agents/types.ts';
import { createKnowledgeTools } from './built-in/knowledge-tools-factory.ts';
import { logger } from '../logger.ts';

export class ToolRegistry {
  private mcpClient: MCPClientManager;
  private knowledgeStores: KnowledgeStore;
  private functionLoader: FunctionLoader;
  private builtInTools: Map<string, StructuredTool> = new Map();
  private sandboxTools: Map<string, StructuredTool>;
  private projectTools: Map<string, StructuredTool>;

  constructor(
    mcpClient: MCPClientManager,
    knowledgeStores: KnowledgeStore,
    functionLoader: FunctionLoader,
    sandboxTools: Map<string, StructuredTool> = new Map(),
    projectTools: Map<string, StructuredTool> = new Map(),
  ) {
    this.mcpClient = mcpClient;
    this.knowledgeStores = knowledgeStores;
    this.functionLoader = functionLoader;
    this.sandboxTools = sandboxTools;
    this.projectTools = projectTools;
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
            const sqliteStore = this.knowledgeStores.getSqliteStore(name);
            return createKnowledgeTools(name, initializedStore, sqliteStore);
          }
          return [];
        }
        const sqliteStore = this.knowledgeStores.getSqliteStore(name);
        return createKnowledgeTools(name, store, sqliteStore);
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

      case 'project': {
        const projectTool = this.projectTools.get(name);
        if (!projectTool) {
          logger.warn(`Project tool "${name}" not found (available: ${Array.from(this.projectTools.keys()).join(', ') || 'none'})`);
          return [];
        }
        return [projectTool];
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

  async getAllKnowledgeTools(): Promise<StructuredTool[]> {
    const configs = this.knowledgeStores.listConfigs();
    const tools: StructuredTool[] = [];

    for (const config of configs) {
      try {
        let store = this.knowledgeStores.get(config.name);
        if (!store) {
          store = await this.knowledgeStores.initialize(config.name);
        }

        const sqliteStore = this.knowledgeStores.getSqliteStore(config.name);
        const knowledgeTools = createKnowledgeTools(config.name, store, sqliteStore);
        tools.push(...knowledgeTools);
      } catch (error) {
        logger.warn(`Failed to create knowledge tools for "${config.name}":`, error);
      }
    }

    return tools;
  }

  getAllFunctionTools(): StructuredTool[] {
    return this.functionLoader.list().map((f) => f.tool);
  }

  getAllBuiltInTools(): StructuredTool[] {
    return Array.from(this.builtInTools.values());
  }

  getAllSandboxTools(): StructuredTool[] {
    return Array.from(this.sandboxTools.values());
  }

  getAllProjectTools(): StructuredTool[] {
    return Array.from(this.projectTools.values());
  }
}
