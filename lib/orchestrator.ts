import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentLoader } from './agents/agent-loader.js';
import { AgentExecutor } from './agents/agent-executor.js';
import { WorkflowLoader } from './workflows/workflow-loader.js';
import { WorkflowExecutor } from './workflows/workflow-executor.js';
import { LangGraphExecutor } from './workflows/langgraph-executor.js';
import { InterruptManager } from './workflows/interrupt-manager.js';
import { KnowledgeStoreManager } from './knowledge/knowledge-store-manager.js';
import { MCPClientManager } from './mcp/mcp-client.js';
import { FunctionLoader, type LoadedFunction } from './functions/function-loader.js';
import { SkillLoader, type Skill } from './skills/index.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ToolDiscovery } from './tools/tool-discovery.js';
import { MCPConfigSchema } from './mcp/types.js';
import { loadLLMConfig } from './llm/llm-config.js';
import { ConversationStore } from './memory/conversation-store.js';
import { TaskManager } from './tasks/task-manager.js';
import { DockerManager } from './sandbox/docker-manager.js';
import { createSandboxExecTool } from './sandbox/sandbox-tool.js';
import { createSandboxReadTool, createSandboxWriteTool, createSandboxEditTool } from './sandbox/sandbox-file-tools.js';
import { createSandboxWebFetchTool, createSandboxWebSearchTool } from './sandbox/sandbox-web-tools.js';
import { createSandboxBrowserTool } from './sandbox/sandbox-browser-tool.js';
import { SandboxConfigSchema } from './sandbox/types.js';
import type { SandboxConfig } from './sandbox/types.js';
import type { AgentDefinition, AgentResult } from './agents/types.js';
import type {
  WorkflowDefinition,
  WorkflowResult,
  LangGraphWorkflowDefinition,
  InterruptState,
} from './workflows/types.js';
import type { KnowledgeStoreInstance, KnowledgeConfig, KnowledgeStoreMetadata, IndexingProgressCallback } from './knowledge/types.js';
import type { KnowledgeMetadataManager } from './knowledge/knowledge-store-metadata.js';
import type { StructuredTool } from '@langchain/core/tools';
import { logger } from './logger.js';

export interface OrchestratorConfig {
  projectRoot: string;
  agentsDir?: string;
  workflowsDir?: string;
  knowledgeDir?: string;
  functionsDir?: string;
  skillsDir?: string;
  mcpConfigPath?: string;
  llmConfigPath?: string;
  sandboxConfigPath?: string;
}

export class Orchestrator {
  private config: Required<OrchestratorConfig>;

  private agentLoader: AgentLoader;
  private agentExecutor!: AgentExecutor;
  private workflowLoader: WorkflowLoader;
  private workflowExecutor!: WorkflowExecutor;
  private langGraphExecutor!: LangGraphExecutor;
  private knowledgeStoreManager: KnowledgeStoreManager;
  private functionLoader: FunctionLoader;
  private skillLoader: SkillLoader;
  private mcpClient!: MCPClientManager;
  private toolRegistry!: ToolRegistry;
  private toolDiscovery!: ToolDiscovery;
  private interruptManager!: InterruptManager;
  private conversationStore: ConversationStore;
  private taskManager!: TaskManager;
  private dockerManager: DockerManager | null = null;
  private sandboxConfig: SandboxConfig | null = null;

  private initialized = false;

  constructor(config: OrchestratorConfig) {
    this.config = {
      projectRoot: config.projectRoot,
      agentsDir: config.agentsDir ?? path.join(config.projectRoot, 'agents'),
      workflowsDir: config.workflowsDir ?? path.join(config.projectRoot, 'workflows'),
      knowledgeDir: config.knowledgeDir ?? path.join(config.projectRoot, 'knowledge'),
      functionsDir: config.functionsDir ?? path.join(config.projectRoot, 'functions'),
      skillsDir: config.skillsDir ?? path.join(config.projectRoot, 'skills'),
      mcpConfigPath: config.mcpConfigPath ?? path.join(config.projectRoot, 'mcp.json'),
      llmConfigPath: config.llmConfigPath ?? path.join(config.projectRoot, 'llm.json'),
      sandboxConfigPath: config.sandboxConfigPath ?? path.join(config.projectRoot, 'sandbox.json'),
    };

    this.agentLoader = new AgentLoader(this.config.agentsDir);
    this.workflowLoader = new WorkflowLoader(this.config.workflowsDir);
    this.knowledgeStoreManager = new KnowledgeStoreManager(
      this.config.knowledgeDir,
      this.config.projectRoot
    );
    this.functionLoader = new FunctionLoader(this.config.functionsDir);
    this.skillLoader = new SkillLoader(this.config.skillsDir);
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

    // Load function tools and skills
    await this.functionLoader.loadAll();
    await this.skillLoader.loadAll();

    // Load sandbox config
    await this.loadSandboxConfig();
    const sandboxTools = this.buildSandboxTools();

    this.toolRegistry = new ToolRegistry(
      this.mcpClient,
      this.knowledgeStoreManager,
      this.functionLoader,
      sandboxTools,
    );
    this.agentExecutor = new AgentExecutor(this.toolRegistry, this.conversationStore, this.skillLoader);
    this.workflowExecutor = new WorkflowExecutor(this.agentLoader, this.agentExecutor);

    // Initialize LangGraph components
    this.interruptManager = new InterruptManager();
    this.toolDiscovery = new ToolDiscovery(
      this.toolRegistry,
      this.mcpClient,
      this.knowledgeStoreManager,
      this.functionLoader,
      this.agentLoader,
      this.agentExecutor
    );
    this.langGraphExecutor = new LangGraphExecutor(this.toolDiscovery, this.interruptManager);

    await this.agentLoader.loadAll();
    await this.workflowLoader.loadAll();
    await this.knowledgeStoreManager.loadAll();
    logger.info('[Orchestrator] Knowledge configs loaded (stores will initialize on demand)');

    this.taskManager = new TaskManager(this);

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

  private async loadSandboxConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.config.sandboxConfigPath, 'utf-8');
      const parsed = JSON.parse(content);
      this.sandboxConfig = SandboxConfigSchema.parse(parsed);
      if (this.sandboxConfig.enabled) {
        this.dockerManager = new DockerManager(this.sandboxConfig);
      }
    } catch {
      logger.debug('[Orchestrator] No sandbox.json found or invalid config, sandbox disabled');
      this.sandboxConfig = null;
      this.dockerManager = null;
    }
  }

  private buildSandboxTools(): Map<string, StructuredTool> {
    const tools = new Map<string, StructuredTool>();

    if (!this.sandboxConfig?.enabled || !this.dockerManager) {
      return tools;
    }

    tools.set('exec', createSandboxExecTool(this.dockerManager, this.sandboxConfig));
    tools.set('read', createSandboxReadTool(this.dockerManager, this.sandboxConfig));
    tools.set('write', createSandboxWriteTool(this.dockerManager, this.sandboxConfig));
    tools.set('edit', createSandboxEditTool(this.dockerManager, this.sandboxConfig));
    tools.set('web_fetch', createSandboxWebFetchTool(this.dockerManager, this.sandboxConfig));
    tools.set('web_search', createSandboxWebSearchTool(this.dockerManager, this.sandboxConfig));
    tools.set('browser', createSandboxBrowserTool(this.dockerManager, this.sandboxConfig));

    this.dockerManager.startPruning();
    logger.info('[Orchestrator] Sandbox enabled with tools: ' + Array.from(tools.keys()).join(', '));

    return tools;
  }

  get sandbox(): SandboxAccessor {
    return {
      getConfig: () => this.sandboxConfig,
      getDockerManager: () => this.dockerManager,
      isEnabled: () => this.sandboxConfig?.enabled ?? false,
    };
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

  get knowledge(): KnowledgeAccessor {
    return {
      list: () => this.knowledgeStoreManager.list(),
      listConfigs: () => this.knowledgeStoreManager.listConfigs(),
      get: (name: string) => this.knowledgeStoreManager.get(name),
      getConfig: (name: string) => this.knowledgeStoreManager.getConfig(name),
      initialize: (name: string, onProgress?: IndexingProgressCallback) =>
        this.knowledgeStoreManager.initialize(name, onProgress),
      refresh: (name: string, onProgress?: IndexingProgressCallback) =>
        this.knowledgeStoreManager.refresh(name, onProgress),
      getStatus: (name: string) => this.knowledgeStoreManager.getStatus(name),
      getAllStatuses: () => this.knowledgeStoreManager.getAllStatuses(),
      getMetadataManager: () => this.knowledgeStoreManager.getMetadataManager(),
      isIndexing: (name: string) => this.knowledgeStoreManager.isIndexing(name),
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

  get skills(): SkillAccessor {
    return {
      list: () => this.skillLoader.list(),
      get: (name: string) => this.skillLoader.get(name),
      names: () => this.skillLoader.names(),
      has: (name: string) => this.skillLoader.has(name),
    };
  }

  get tasks(): TaskAccessor {
    return {
      getManager: () => this.taskManager,
    };
  }

  get projectRoot(): string {
    return this.config.projectRoot;
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

  async reloadFile(relativePath: string): Promise<string> {
    this.ensureInitialized();

    const absolutePath = path.resolve(this.config.projectRoot, relativePath);

    if (relativePath.endsWith('.agent.yaml')) {
      await this.agentLoader.loadOne(absolutePath);
      return 'agent';
    }

    if (relativePath.endsWith('.workflow.yaml')) {
      await this.workflowLoader.loadOne(absolutePath);
      return 'workflow';
    }

    if (relativePath.endsWith('.knowledge.yaml')) {
      await this.knowledgeStoreManager.loadOne(absolutePath);
      return 'knowledge';
    }

    if (relativePath.endsWith('.function.js')) {
      await this.functionLoader.loadOne(absolutePath);
      return 'function';
    }

    if (relativePath.endsWith('SKILL.md')) {
      await this.skillLoader.loadOne(absolutePath);
      return 'skill';
    }

    if (relativePath === 'llm.json') {
      await loadLLMConfig(this.config.llmConfigPath);
      return 'llm';
    }

    if (relativePath === 'sandbox.json') {
      if (this.dockerManager) {
        await this.dockerManager.close();
      }
      await this.loadSandboxConfig();
      const sandboxTools = this.buildSandboxTools();
      this.toolRegistry = new ToolRegistry(
        this.mcpClient,
        this.knowledgeStoreManager,
        this.functionLoader,
        sandboxTools,
      );
      return 'sandbox';
    }

    return 'none';
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
    sessionId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<string | Record<string, unknown>, void, unknown> {
    this.ensureInitialized();

    const definition = this.agentLoader.get(name);
    if (!definition) {
      throw new Error(`Agent not found: ${name}`);
    }

    const instance = await this.agentExecutor.createInstance(definition);
    yield* instance.stream({ input, sessionId, signal });
  }

  async runWorkflow(name: string, input: Record<string, unknown>): Promise<WorkflowResult> {
    this.ensureInitialized();

    const definition = this.workflowLoader.get(name);
    if (!definition) {
      throw new Error(`Workflow not found: ${name}`);
    }

    // Route based on workflow type
    if (definition.type === 'langgraph') {
      return this.langGraphExecutor.execute(
        definition as LangGraphWorkflowDefinition,
        input
      );
    }

    // Default to step-based workflow
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

    // Route based on workflow type
    if (definition.type === 'langgraph') {
      yield* this.streamLangGraphWorkflow(
        definition as LangGraphWorkflowDefinition,
        input
      );
      return;
    }

    // Existing step-based streaming
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

  private async *streamLangGraphWorkflow(
    definition: LangGraphWorkflowDefinition,
    input: Record<string, unknown>
  ): AsyncGenerator<{ type: 'status' | 'result'; data: unknown }, void, unknown> {
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

    // Start execution in background
    const executionPromise = this.langGraphExecutor
      .execute(definition, input, undefined, onStatus)
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

    // Yield status updates
    while (!isComplete || statusQueue.length > 0) {
      if (statusQueue.length > 0) {
        yield statusQueue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    }

    await executionPromise;
  }

  async searchKnowledge(
    storeName: string,
    query: string,
    k?: number
  ): Promise<{ content: string; metadata: Record<string, unknown>; score: number }[]> {
    this.ensureInitialized();

    let store = this.knowledgeStoreManager.get(storeName);
    if (!store) {
      store = await this.knowledgeStoreManager.initialize(storeName);
    }

    return store.search(query, k);
  }

  // LangGraph workflow interrupt methods

  /**
   * Resumes a LangGraph workflow with the user's answer to an interrupt.
   */
  async resumeLangGraphWorkflow(
    name: string,
    threadId: string,
    answer: string
  ): Promise<WorkflowResult> {
    this.ensureInitialized();

    const definition = this.workflowLoader.get(name);
    if (!definition) {
      throw new Error(`Workflow not found: ${name}`);
    }

    if (definition.type !== 'langgraph') {
      throw new Error(`Workflow "${name}" is not a LangGraph workflow`);
    }

    return this.langGraphExecutor.resumeWithAnswer(
      definition as LangGraphWorkflowDefinition,
      threadId,
      answer
    );
  }

  /**
   * Gets all active interrupts for a workflow.
   */
  getLangGraphInterrupts(name: string): InterruptState[] {
    this.ensureInitialized();
    return this.interruptManager.getInterruptsByWorkflow(name);
  }

  /**
   * Gets a specific interrupt by thread ID.
   */
  getLangGraphInterrupt(threadId: string): InterruptState | undefined {
    this.ensureInitialized();
    return this.interruptManager.getInterrupt(threadId);
  }

  async close(): Promise<void> {
    if (this.dockerManager) {
      await this.dockerManager.close();
    }
    if (this.mcpClient) {
      await this.mcpClient.close();
    }
    if (this.conversationStore) {
      this.conversationStore.destroy();
    }
    if (this.taskManager) {
      this.taskManager.destroy();
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

interface KnowledgeAccessor {
  list: () => KnowledgeStoreInstance[];
  listConfigs: () => KnowledgeConfig[];
  get: (name: string) => KnowledgeStoreInstance | undefined;
  getConfig: (name: string) => KnowledgeConfig | undefined;
  initialize: (name: string, onProgress?: IndexingProgressCallback) => Promise<KnowledgeStoreInstance>;
  refresh: (name: string, onProgress?: IndexingProgressCallback) => Promise<void>;
  getStatus: (name: string) => Promise<KnowledgeStoreMetadata | null>;
  getAllStatuses: () => Promise<Map<string, KnowledgeStoreMetadata>>;
  getMetadataManager: () => KnowledgeMetadataManager;
  isIndexing: (name: string) => boolean;
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

interface SkillAccessor {
  list: () => Skill[];
  get: (name: string) => Skill | undefined;
  names: () => string[];
  has: (name: string) => boolean;
}

interface MemoryAccessor {
  getStore: () => ConversationStore;
  clearSession: (sessionId: string) => void;
  getSessionCount: () => number;
  getMessageCount: (sessionId: string) => number;
  hasSession: (sessionId: string) => boolean;
}

interface TaskAccessor {
  getManager: () => TaskManager;
}

interface SandboxAccessor {
  getConfig: () => SandboxConfig | null;
  getDockerManager: () => DockerManager | null;
  isEnabled: () => boolean;
}
