import type { StructuredTool } from '../types/llm-types.ts';
import type { ToolRegistry } from './tool-registry.ts';
import type { MCPClientManager } from '../mcp/mcp-client.ts';
import type { KnowledgeStoreManager } from '../knowledge/knowledge-store-manager.ts';
import type { FunctionLoader } from '../functions/function-loader.ts';
import type { GraphToolConfig, GraphAgentConfig } from '../workflows/types.ts';
import type { AgentLoader } from '../agents/agent-loader.ts';
import type { AgentExecutor } from '../agents/agent-executor.ts';
import { AgentToolWrapper } from './agent-tool-wrapper.ts';
import { createKnowledgeTools } from './built-in/knowledge-tools-factory.ts';
import { createAskUserTool } from './built-in/ask-user.tool.ts';
import { logger } from '../logger.ts';

/**
 * Centralized tool discovery for ReAct workflows.
 * Discovers tools from all configured sources and applies filtering.
 */
export class ToolDiscovery {
  private mcpClient: MCPClientManager;
  private knowledgeStoreManager: KnowledgeStoreManager;
  private functionLoader: FunctionLoader;
  private agentLoader: AgentLoader;
  private agentExecutor: AgentExecutor;

  constructor(
    _toolRegistry: ToolRegistry,
    mcpClient: MCPClientManager,
    knowledgeStoreManager: KnowledgeStoreManager,
    functionLoader: FunctionLoader,
    agentLoader: AgentLoader,
    agentExecutor: AgentExecutor
  ) {
    this.mcpClient = mcpClient;
    this.knowledgeStoreManager = knowledgeStoreManager;
    this.functionLoader = functionLoader;
    this.agentLoader = agentLoader;
    this.agentExecutor = agentExecutor;
  }

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
