import type { StructuredTool } from '@langchain/core/tools';
import type { ToolRegistry } from './tool-registry.js';
import type { MCPClientManager } from '../mcp/mcp-client.js';
import type { KnowledgeStoreManager } from '../knowledge/knowledge-store-manager.js';
import type { FunctionLoader } from '../functions/function-loader.js';
import type { GraphToolConfig, GraphAgentConfig } from '../workflows/types.js';
import type { AgentLoader } from '../agents/agent-loader.js';
import type { AgentExecutor } from '../agents/agent-executor.js';
import { AgentToolWrapper } from './agent-tool-wrapper.js';
import { createKnowledgeTools } from './built-in/knowledge-tools-factory.js';
import { createAskUserTool } from './built-in/ask-user.tool.js';
import { logger } from '../logger.js';

/**
 * Centralized tool discovery for LangGraph workflows.
 * Discovers tools from all configured sources and applies filtering.
 */
export class ToolDiscovery {
  constructor(
    _toolRegistry: ToolRegistry, // Unused but kept for future use
    private mcpClient: MCPClientManager,
    private knowledgeStoreManager: KnowledgeStoreManager,
    private functionLoader: FunctionLoader,
    private agentLoader: AgentLoader,
    private agentExecutor: AgentExecutor
  ) {}

  /**
   * Discovers all tools based on configuration.
   */
  async discoverAll(config: GraphToolConfig): Promise<StructuredTool[]> {
    const tools: StructuredTool[] = [];

    // Discover from each source
    for (const source of config.sources) {
      switch (source) {
        case 'mcp':
          tools.push(...(await this.discoverMCP()));
          break;
        case 'knowledge':
          tools.push(...(await this.discoverKnowledge()));
          break;
        case 'function':
          tools.push(...this.discoverFunction());
          break;
        case 'builtin':
          tools.push(...this.discoverBuiltin());
          break;
      }
    }

    return this.filterTools(tools, config);
  }

  /**
   * Discovers agent tools based on configuration.
   */
  async discoverAgents(config: GraphAgentConfig): Promise<StructuredTool[]> {
    if (config.mode === 'none') {
      return [];
    }

    const allAgentNames = this.agentLoader.names();
    let agentNames: string[] = [];

    if (config.mode === 'all') {
      agentNames = allAgentNames;
      // Apply exclusions
      if (config.exclude) {
        agentNames = agentNames.filter((name) => !config.exclude!.includes(name));
      }
    } else if (config.mode === 'include' && config.include) {
      agentNames = config.include.filter((name) => allAgentNames.includes(name));
    } else if (config.mode === 'exclude') {
      agentNames = allAgentNames;
      if (config.exclude) {
        agentNames = agentNames.filter((name) => !config.exclude!.includes(name));
      }
    }

    logger.info(`Discovered ${agentNames.length} agents as tools: ${agentNames.join(', ')}`);
    return AgentToolWrapper.createTools(agentNames, this.agentLoader, this.agentExecutor);
  }

  /**
   * Filters tools based on mode and include/exclude lists.
   */
  private filterTools(tools: StructuredTool[], config: GraphToolConfig): StructuredTool[] {
    if (config.mode === 'none') {
      return [];
    }

    if (config.mode === 'all') {
      // Apply exclusions
      if (config.exclude) {
        return tools.filter((t) => !config.exclude!.includes(t.name));
      }
      return tools;
    }

    if (config.mode === 'include' && config.include) {
      return tools.filter((t) => config.include!.includes(t.name));
    }

    if (config.mode === 'exclude') {
      if (config.exclude) {
        return tools.filter((t) => !config.exclude!.includes(t.name));
      }
      return tools;
    }

    return tools;
  }

  /**
   * Discovers MCP tools from all servers.
   */
  private async discoverMCP(): Promise<StructuredTool[]> {
    const allTools: StructuredTool[] = [];

    try {
      const serverNames = this.mcpClient.getServerNames();

      for (const serverName of serverNames) {
        try {
          const tools = await this.mcpClient.getToolsByServer(serverName);
          allTools.push(...tools);
          logger.info(`Discovered ${tools.length} MCP tools from server "${serverName}"`);
        } catch (error) {
          logger.warn(`Failed to discover MCP tools from server "${serverName}":`, error);
        }
      }
    } catch (error) {
      logger.warn('Failed to discover MCP tools:', error);
    }

    return allTools;
  }

  /**
   * Discovers knowledge search tools for all knowledge stores.
   */
  private async discoverKnowledge(): Promise<StructuredTool[]> {
    const tools: StructuredTool[] = [];

    try {
      const configs = this.knowledgeStoreManager.listConfigs();

      for (const config of configs) {
        try {
          // Initialize store if needed
          let store = this.knowledgeStoreManager.get(config.name);
          if (!store) {
            store = await this.knowledgeStoreManager.initialize(config.name);
          }

          // Create all knowledge tools for this store
          const knowledgeTools = createKnowledgeTools(config.name, store);
          tools.push(...knowledgeTools);
          logger.info(`Discovered ${knowledgeTools.length} knowledge tool(s) for "${config.name}"`);
        } catch (error) {
          logger.warn(`Failed to create knowledge tools for "${config.name}":`, error);
        }
      }
    } catch (error) {
      logger.warn('Failed to discover knowledge tools:', error);
    }

    return tools;
  }

  /**
   * Discovers custom function tools.
   */
  private discoverFunction(): StructuredTool[] {
    try {
      const functions = this.functionLoader.list();
      const tools = functions.map((f) => f.tool);
      logger.info(`Discovered ${tools.length} function tools`);
      return tools;
    } catch (error) {
      logger.warn('Failed to discover function tools:', error);
      return [];
    }
  }

  /**
   * Discovers built-in tools (ask_user is always included).
   */
  private discoverBuiltin(): StructuredTool[] {
    const tools: StructuredTool[] = [];

    // ask_user tool is always included for HITL
    tools.push(createAskUserTool());

    logger.info(`Discovered ${tools.length} built-in tools`);
    return tools;
  }
}
