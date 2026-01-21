import type { StructuredTool } from '@langchain/core/tools';
import type { MCPClientManager } from '../mcp/mcp-client.js';
import type { VectorStoreManager } from '../vectors/vector-store-manager.js';
import type { FunctionLoader } from '../functions/function-loader.js';
import type { ToolReference } from '../agents/types.js';
import { createVectorSearchTool } from './built-in/vector-search.tool.js';
import { logger } from '../logger.js';

export class ToolRegistry {
  private mcpClient: MCPClientManager;
  private vectorStores: VectorStoreManager;
  private functionLoader: FunctionLoader;
  private builtInTools: Map<string, StructuredTool> = new Map();

  constructor(mcpClient: MCPClientManager, vectorStores: VectorStoreManager, functionLoader: FunctionLoader) {
    this.mcpClient = mcpClient;
    this.vectorStores = vectorStores;
    this.functionLoader = functionLoader;
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

      case 'vector': {
        const store = this.vectorStores.get(name);
        if (!store) {
          await this.vectorStores.initialize(name);
          const initializedStore = this.vectorStores.get(name);
          if (initializedStore) {
            return [createVectorSearchTool(name, initializedStore)];
          }
          return [];
        }
        return [createVectorSearchTool(name, store)];
      }

      case 'function': {
        const func = this.functionLoader.getTool(name);
        return func ? [func] : [];
      }

      case 'builtin': {
        const builtin = this.builtInTools.get(name);
        return builtin ? [builtin] : [];
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
}
