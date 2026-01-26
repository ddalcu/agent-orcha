import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentLoader } from './agents/agent-loader.js';
import { AgentExecutor } from './agents/agent-executor.js';
import { WorkflowLoader } from './workflows/workflow-loader.js';
import { WorkflowExecutor } from './workflows/workflow-executor.js';
import { VectorStoreManager } from './vectors/vector-store-manager.js';
import { MCPClientManager } from './mcp/mcp-client.js';
import { FunctionLoader, type LoadedFunction } from './functions/function-loader.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { MCPConfigSchema } from './mcp/types.js';
import { loadLLMConfig } from './llm/llm-config.js';
import { ConversationStore } from './memory/conversation-store.js';
import type { AgentDefinition, AgentResult } from './agents/types.js';
import type { WorkflowDefinition, WorkflowResult } from './workflows/types.js';
import type { VectorStoreInstance, VectorConfig } from './vectors/types.js';
import type { StructuredTool } from '@langchain/core/tools';
import { logger } from './logger.js';

export interface OrchestratorConfig {
  projectRoot: string;
  agentsDir?: string;
  workflowsDir?: string;
  vectorsDir?: string;
  functionsDir?: string;
  mcpConfigPath?: string;
  llmConfigPath?: string;
}

export class Orchestrator {
  private config: Required<OrchestratorConfig>;

  private agentLoader: AgentLoader;
  private agentExecutor!: AgentExecutor;
  private workflowLoader: WorkflowLoader;
  private workflowExecutor!: WorkflowExecutor;
  private vectorStoreManager: VectorStoreManager;
  private functionLoader: FunctionLoader;
  private mcpClient!: MCPClientManager;
  private toolRegistry!: ToolRegistry;
  private conversationStore: ConversationStore;

  private initialized = false;

  constructor(config: OrchestratorConfig) {
    this.config = {
      projectRoot: config.projectRoot,
      agentsDir: config.agentsDir ?? path.join(config.projectRoot, 'agents'),
      workflowsDir: config.workflowsDir ?? path.join(config.projectRoot, 'workflows'),
      vectorsDir: config.vectorsDir ?? path.join(config.projectRoot, 'vectors'),
      functionsDir: config.functionsDir ?? path.join(config.projectRoot, 'functions'),
      mcpConfigPath: config.mcpConfigPath ?? path.join(config.projectRoot, 'mcp.json'),
      llmConfigPath: config.llmConfigPath ?? path.join(config.projectRoot, 'llm.json'),
    };

    this.agentLoader = new AgentLoader(this.config.agentsDir);
    this.workflowLoader = new WorkflowLoader(this.config.workflowsDir);
    this.vectorStoreManager = new VectorStoreManager(
      this.config.vectorsDir,
      this.config.projectRoot
    );
    this.functionLoader = new FunctionLoader(this.config.functionsDir);
    this.conversationStore = new ConversationStore({
      maxMessagesPerSession: 50,
      sessionTTL: 3600000, // 1 hour
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load LLM config first - required for agents and embeddings
    logger.info('[Orchestrator] Loading LLM config...');
    await loadLLMConfig(this.config.llmConfigPath);

    await this.loadMCPConfig();
    await this.mcpClient.initialize();

    // Load function tools
    await this.functionLoader.loadAll();

    this.toolRegistry = new ToolRegistry(this.mcpClient, this.vectorStoreManager, this.functionLoader);
    this.agentExecutor = new AgentExecutor(this.toolRegistry, this.conversationStore);
    this.workflowExecutor = new WorkflowExecutor(this.agentLoader, this.agentExecutor);

    await this.agentLoader.loadAll();
    await this.workflowLoader.loadAll();
    await this.vectorStoreManager.loadAll();

    // Initialize all vector stores on startup (load documents and create embeddings)
    logger.info('[Orchestrator] Initializing vector stores...');
    await this.vectorStoreManager.initializeAll();
    logger.info('[Orchestrator] Vector stores ready');

    this.initialized = true;
  }

  private async loadMCPConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.config.mcpConfigPath, 'utf-8');
      const parsed = JSON.parse(content);
      const mcpConfig = MCPConfigSchema.parse(parsed);
      this.mcpClient = new MCPClientManager(mcpConfig);
    } catch (error) {
      logger.warn('Failed to load MCP config, using empty config:', error);
      this.mcpClient = new MCPClientManager({
        version: '1.0.0',
        servers: {},
      });
    }
  }

  get agents(): AgentAccessor {
    return {
      list: () => this.agentLoader.list(),
      get: (name: string) => this.agentLoader.get(name),
      names: () => this.agentLoader.names(),
    };
  }

  get workflows(): WorkflowAccessor {
    return {
      list: () => this.workflowLoader.list(),
      get: (name: string) => this.workflowLoader.get(name),
      names: () => this.workflowLoader.names(),
    };
  }

  get vectors(): VectorAccessor {
    return {
      list: () => this.vectorStoreManager.list(),
      listConfigs: () => this.vectorStoreManager.listConfigs(),
      get: (name: string) => this.vectorStoreManager.get(name),
      getConfig: (name: string) => this.vectorStoreManager.getConfig(name),
      initialize: (name: string) => this.vectorStoreManager.initialize(name),
      refresh: (name: string) => this.vectorStoreManager.refresh(name),
    };
  }

  get mcp(): MCPAccessor {
    return {
      getManager: () => this.mcpClient,
    };
  }

  get functions(): FunctionAccessor {
    return {
      list: () => this.functionLoader.list(),
      get: (name: string) => this.functionLoader.get(name),
      getTool: (name: string) => this.functionLoader.getTool(name),
      names: () => this.functionLoader.names(),
    };
  }

  get memory(): MemoryAccessor {
    return {
      getStore: () => this.conversationStore,
      clearSession: (sessionId: string) => this.conversationStore.clearSession(sessionId),
      getSessionCount: () => this.conversationStore.getSessionCount(),
      getMessageCount: (sessionId: string) => this.conversationStore.getMessageCount(sessionId),
      hasSession: (sessionId: string) => this.conversationStore.hasSession(sessionId),
    };
  }

  async runAgent(
    name: string,
    input: Record<string, unknown>,
    sessionId?: string
  ): Promise<AgentResult> {
    this.ensureInitialized();

    const definition = this.agentLoader.get(name);
    if (!definition) {
      throw new Error(`Agent not found: ${name}`);
    }

    const instance = await this.agentExecutor.createInstance(definition);
    return instance.invoke({ input, sessionId });
  }

  async *streamAgent(
    name: string,
    input: Record<string, unknown>,
    sessionId?: string
  ): AsyncGenerator<string | Record<string, unknown>, void, unknown> {
    this.ensureInitialized();

    const definition = this.agentLoader.get(name);
    if (!definition) {
      throw new Error(`Agent not found: ${name}`);
    }

    const instance = await this.agentExecutor.createInstance(definition);
    yield* instance.stream({ input, sessionId });
  }

  async runWorkflow(name: string, input: Record<string, unknown>): Promise<WorkflowResult> {
    this.ensureInitialized();

    const definition = this.workflowLoader.get(name);
    if (!definition) {
      throw new Error(`Workflow not found: ${name}`);
    }

    return this.workflowExecutor.execute(definition, input);
  }

  async *streamWorkflow(
    name: string,
    input: Record<string, unknown>
  ): AsyncGenerator<{ type: 'status' | 'result'; data: unknown }, void, unknown> {
    this.ensureInitialized();

    const definition = this.workflowLoader.get(name);
    if (!definition) {
      throw new Error(`Workflow not found: ${name}`);
    }

    const statusQueue: Array<{ type: 'status' | 'result'; data: unknown }> = [];
    let resolveNext: ((value: void) => void) | null = null;
    let isComplete = false;

    const onStatus = (status: import('./workflows/types.js').WorkflowStatus) => {
      statusQueue.push({ type: 'status', data: status });
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    // Start workflow execution in background
    const executionPromise = this.workflowExecutor
      .execute(definition, input, onStatus)
      .then((result) => {
        isComplete = true;
        statusQueue.push({ type: 'result', data: result });
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      })
      .catch((error) => {
        isComplete = true;
        statusQueue.push({
          type: 'result',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      });

    // Yield status updates as they come in
    while (!isComplete || statusQueue.length > 0) {
      if (statusQueue.length > 0) {
        yield statusQueue.shift()!;
      } else {
        // Wait for next status update
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    }

    // Ensure execution completes
    await executionPromise;
  }

  async searchVectors(
    storeName: string,
    query: string,
    k?: number
  ): Promise<{ content: string; metadata: Record<string, unknown>; score: number }[]> {
    this.ensureInitialized();

    let store = this.vectorStoreManager.get(storeName);
    if (!store) {
      store = await this.vectorStoreManager.initialize(storeName);
    }

    return store.search(query, k);
  }

  async close(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.close();
    }
    if (this.conversationStore) {
      this.conversationStore.destroy();
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Orchestrator not initialized. Call initialize() first.');
    }
  }
}

interface AgentAccessor {
  list: () => AgentDefinition[];
  get: (name: string) => AgentDefinition | undefined;
  names: () => string[];
}

interface WorkflowAccessor {
  list: () => WorkflowDefinition[];
  get: (name: string) => WorkflowDefinition | undefined;
  names: () => string[];
}

interface VectorAccessor {
  list: () => VectorStoreInstance[];
  listConfigs: () => VectorConfig[];
  get: (name: string) => VectorStoreInstance | undefined;
  getConfig: (name: string) => VectorConfig | undefined;
  initialize: (name: string) => Promise<VectorStoreInstance>;
  refresh: (name: string) => Promise<void>;
}

interface MCPAccessor {
  getManager: () => MCPClientManager;
}

interface FunctionAccessor {
  list: () => LoadedFunction[];
  get: (name: string) => LoadedFunction | undefined;
  getTool: (name: string) => StructuredTool | undefined;
  names: () => string[];
}

interface MemoryAccessor {
  getStore: () => ConversationStore;
  clearSession: (sessionId: string) => void;
  getSessionCount: () => number;
  getMessageCount: (sessionId: string) => number;
  hasSession: (sessionId: string) => boolean;
}
