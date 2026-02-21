import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentLoader } from './agents/agent-loader.ts';
import { AgentExecutor } from './agents/agent-executor.ts';
import { WorkflowLoader } from './workflows/workflow-loader.ts';
import { WorkflowExecutor } from './workflows/workflow-executor.ts';
import { ReactWorkflowExecutor } from './workflows/react-workflow-executor.ts';
import { InterruptManager } from './workflows/interrupt-manager.ts';
import { KnowledgeStore } from './knowledge/knowledge-store.ts';
import { MCPClientManager } from './mcp/mcp-client.ts';
import { FunctionLoader, type LoadedFunction } from './functions/function-loader.ts';
import { SkillLoader, type Skill } from './skills/index.ts';
import { ToolRegistry } from './tools/tool-registry.ts';
import { ToolDiscovery } from './tools/tool-discovery.ts';
import { MCPConfigSchema } from './mcp/types.ts';
import { loadLLMConfig } from './llm/llm-config.ts';
import { ConversationStore } from './memory/conversation-store.ts';
import { MemoryManager } from './memory/memory-manager.ts';
import { TaskManager } from './tasks/task-manager.ts';
import { VmExecutor } from './sandbox/vm-executor.ts';
import { createSandboxExecTool } from './sandbox/sandbox-exec.ts';
import { createSandboxWebFetchTool, createSandboxWebSearchTool } from './sandbox/sandbox-web.ts';
import { SandboxConfigSchema } from './sandbox/types.ts';
import { buildWorkspaceTools, type WorkspaceToolDeps, type WorkspaceResourceSummary } from './tools/workspace/workspace-tools.ts';
import { IntegrationManager } from './integrations/integration-manager.ts';
import { TriggerManager } from './triggers/trigger-manager.ts';
import type { SandboxConfig } from './sandbox/types.ts';
import type { AgentDefinition, AgentResult } from './agents/types.ts';
import type {
  WorkflowDefinition,
  WorkflowResult,
  ReactWorkflowDefinition,
  InterruptState,
} from './workflows/types.ts';
import type { KnowledgeStoreInstance, KnowledgeConfig, KnowledgeStoreMetadata, IndexingProgressCallback } from './knowledge/types.ts';
import type { KnowledgeMetadataManager } from './knowledge/knowledge-store-metadata.ts';
import type { SqliteStore } from './knowledge/sqlite-store.ts';
import type { StructuredTool } from './types/llm-types.ts';
import { logger } from './logger.ts';

export interface OrchestratorConfig {
  workspaceRoot: string;
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
  private reactWorkflowExecutor!: ReactWorkflowExecutor;
  private knowledgeStoreManager: KnowledgeStore;
  private functionLoader: FunctionLoader;
  private skillLoader: SkillLoader;
  private mcpClient!: MCPClientManager;
  private toolRegistry!: ToolRegistry;
  private toolDiscovery!: ToolDiscovery;
  private interruptManager!: InterruptManager;
  private conversationStore: ConversationStore;
  private taskManager!: TaskManager;
  private vmExecutor: VmExecutor | null = null;
  private sandboxConfig: SandboxConfig | null = null;
  private memoryManager: MemoryManager;
  private integrationManager: IntegrationManager | null = null;
  private triggerManager: TriggerManager | null = null;

  private initialized = false;

  constructor(config: OrchestratorConfig) {
    this.config = {
      workspaceRoot: config.workspaceRoot,
      agentsDir: config.agentsDir ?? path.join(config.workspaceRoot, 'agents'),
      workflowsDir: config.workflowsDir ?? path.join(config.workspaceRoot, 'workflows'),
      knowledgeDir: config.knowledgeDir ?? path.join(config.workspaceRoot, 'knowledge'),
      functionsDir: config.functionsDir ?? path.join(config.workspaceRoot, 'functions'),
      skillsDir: config.skillsDir ?? path.join(config.workspaceRoot, 'skills'),
      mcpConfigPath: config.mcpConfigPath ?? path.join(config.workspaceRoot, 'mcp.json'),
      llmConfigPath: config.llmConfigPath ?? path.join(config.workspaceRoot, 'llm.json'),
      sandboxConfigPath: config.sandboxConfigPath ?? path.join(config.workspaceRoot, 'sandbox.json'),
    };

    this.agentLoader = new AgentLoader(this.config.agentsDir);
    this.workflowLoader = new WorkflowLoader(this.config.workflowsDir);
    this.knowledgeStoreManager = new KnowledgeStore(
      this.config.knowledgeDir,
      this.config.workspaceRoot
    );
    this.functionLoader = new FunctionLoader(this.config.functionsDir);
    this.skillLoader = new SkillLoader(this.config.skillsDir);
    this.conversationStore = new ConversationStore({
      maxMessagesPerSession: 50,
      sessionTTL: 3600000, // 1 hour
    });
    this.memoryManager = new MemoryManager(config.workspaceRoot);
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
    const workspaceTools = this.buildWorkspaceToolsMap();

    this.toolRegistry = new ToolRegistry(
      this.mcpClient,
      this.knowledgeStoreManager,
      this.functionLoader,
      sandboxTools,
      workspaceTools,
    );
    this.agentExecutor = new AgentExecutor(this.toolRegistry, this.conversationStore, this.skillLoader, this.memoryManager);
    this.workflowExecutor = new WorkflowExecutor(this.agentLoader, this.agentExecutor);

    // Initialize ReAct workflow components
    this.interruptManager = new InterruptManager();
    this.toolDiscovery = new ToolDiscovery(
      this.toolRegistry,
      this.mcpClient,
      this.knowledgeStoreManager,
      this.functionLoader,
      this.agentLoader,
      this.agentExecutor
    );
    this.reactWorkflowExecutor = new ReactWorkflowExecutor(this.toolDiscovery, this.interruptManager);

    await this.agentLoader.loadAll();
    await this.workflowLoader.loadAll();
    await this.knowledgeStoreManager.loadAll();
    logger.info('[Orchestrator] Knowledge configs loaded (stores will initialize on demand)');

    this.taskManager = new TaskManager(this);

    this.initialized = true;

    // Start integrations after initialization (non-blocking)
    this.integrationManager = new IntegrationManager();
    await this.integrationManager.start(this);
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
    } catch {
      // No sandbox.json — use defaults (enabled by default)
      this.sandboxConfig = SandboxConfigSchema.parse({});
    }

    if (this.sandboxConfig.enabled) {
      this.vmExecutor = new VmExecutor();
    } else {
      this.vmExecutor = null;
    }
  }

  private buildSandboxTools(): Map<string, StructuredTool> {
    const tools = new Map<string, StructuredTool>();

    if (!this.sandboxConfig?.enabled || !this.vmExecutor) {
      return tools;
    }

    tools.set('exec', createSandboxExecTool(this.vmExecutor, this.sandboxConfig));
    tools.set('web_fetch', createSandboxWebFetchTool(this.sandboxConfig));
    tools.set('web_search', createSandboxWebSearchTool());

    logger.info('[Orchestrator] Sandbox enabled with tools: ' + Array.from(tools.keys()).join(', '));

    return tools;
  }

  private buildWorkspaceToolsMap(): Map<string, StructuredTool> {
    const deps: WorkspaceToolDeps = {
      workspaceRoot: this.config.workspaceRoot,
      reloadFile: (relativePath: string) => this.reloadFile(relativePath),
      listResources: (): WorkspaceResourceSummary => ({
        agents: this.agentLoader.list().map(a => ({ name: a.name, description: a.description })),
        workflows: this.workflowLoader.list().map(w => ({ name: w.name, description: w.description })),
        skills: this.skillLoader.list().map(s => ({ name: s.name, description: s.description })),
        functions: this.functionLoader.list().map(f => ({ name: f.name, description: f.metadata.description })),
        knowledge: this.knowledgeStoreManager.listConfigs().map(k => ({ name: k.name, description: k.description })),
      }),
    };
    return buildWorkspaceTools(deps);
  }

  get sandbox(): SandboxAccessor {
    return {
      getConfig: () => this.sandboxConfig,
      getVmExecutor: () => this.vmExecutor,
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
      getSqliteStore: (name: string) => this.knowledgeStoreManager.getSqliteStore(name),
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

  get integrations(): IntegrationAccessor {
    return {
      getChannelContext: (agentName: string) => {
        return this.integrationManager?.getChannelContext(agentName) ?? '';
      },
      getChannelMembers: (agentName: string) => {
        return this.integrationManager?.getChannelMembers(agentName) ?? [];
      },
      postMessage: (agentName: string, message: string) => {
        this.integrationManager?.postMessage(agentName, message);
      },
    };
  }

  get triggers(): TriggerAccessor {
    return {
      getManager: () => this.triggerManager,
      setManager: (manager: TriggerManager) => { this.triggerManager = manager; },
    };
  }

  get workspaceRoot(): string {
    return this.config.workspaceRoot;
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

  get longTermMemory(): LongTermMemoryAccessor {
    return {
      load: (agentName: string) => this.memoryManager.load(agentName),
    };
  }

  async reloadFile(relativePath: string): Promise<string> {
    this.ensureInitialized();

    const absolutePath = path.resolve(this.config.workspaceRoot, relativePath);

    if (relativePath.endsWith('.agent.yaml')) {
      const agent = await this.agentLoader.loadOne(absolutePath);
      await this.integrationManager?.syncAgent(this, agent.name);
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
      if (this.vmExecutor) {
        this.vmExecutor.close();
      }
      await this.loadSandboxConfig();
      const sandboxTools = this.buildSandboxTools();
      const workspaceTools = this.buildWorkspaceToolsMap();
      this.toolRegistry = new ToolRegistry(
        this.mcpClient,
        this.knowledgeStoreManager,
        this.functionLoader,
        sandboxTools,
        workspaceTools,
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
    if (definition.type === 'react') {
      return this.reactWorkflowExecutor.execute(
        definition as ReactWorkflowDefinition,
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
    if (definition.type === 'react') {
      yield* this.streamReactWorkflow(
        definition as ReactWorkflowDefinition,
        input
      );
      return;
    }

    // Existing step-based streaming
    const statusQueue: Array<{ type: 'status' | 'result'; data: unknown }> = [];
    let resolveNext: ((value: void) => void) | null = null;
    let isComplete = false;

    const onStatus = (status: import('./workflows/types.ts').WorkflowStatus) => {
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

  private async *streamReactWorkflow(
    definition: ReactWorkflowDefinition,
    input: Record<string, unknown>
  ): AsyncGenerator<{ type: 'status' | 'result'; data: unknown }, void, unknown> {
    const statusQueue: Array<{ type: 'status' | 'result'; data: unknown }> = [];
    let resolveNext: ((value: void) => void) | null = null;
    let isComplete = false;

    const onStatus = (status: import('./workflows/types.ts').WorkflowStatus) => {
      statusQueue.push({ type: 'status', data: status });
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    // Start execution in background
    const executionPromise = this.reactWorkflowExecutor
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

  // ReAct workflow interrupt methods

  /**
   * Resumes a ReAct workflow with the user's answer to an interrupt.
   */
  async resumeReactWorkflow(
    name: string,
    threadId: string,
    answer: string
  ): Promise<WorkflowResult> {
    this.ensureInitialized();

    const definition = this.workflowLoader.get(name);
    if (!definition) {
      throw new Error(`Workflow not found: ${name}`);
    }

    if (definition.type !== 'react') {
      throw new Error(`Workflow "${name}" is not a ReAct workflow`);
    }

    return this.reactWorkflowExecutor.resumeWithAnswer(
      definition as ReactWorkflowDefinition,
      threadId,
      answer
    );
  }

  /**
   * Gets all active interrupts for a workflow.
   */
  getReactWorkflowInterrupts(name: string): InterruptState[] {
    this.ensureInitialized();
    return this.interruptManager.getInterruptsByWorkflow(name);
  }

  /**
   * Gets a specific interrupt by thread ID.
   */
  getReactWorkflowInterrupt(threadId: string): InterruptState | undefined {
    this.ensureInitialized();
    return this.interruptManager.getInterrupt(threadId);
  }

  async close(): Promise<void> {
    if (this.triggerManager) {
      this.triggerManager.close();
    }
    if (this.integrationManager) {
      this.integrationManager.close();
    }
    if (this.vmExecutor) {
      this.vmExecutor.close();
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
  getSqliteStore: (name: string) => SqliteStore | undefined;
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

interface LongTermMemoryAccessor {
  load: (agentName: string) => Promise<string>;
}

interface TaskAccessor {
  getManager: () => TaskManager;
}

interface TriggerAccessor {
  getManager: () => TriggerManager | null;
  setManager: (manager: TriggerManager) => void;
}

interface IntegrationAccessor {
  getChannelContext: (agentName: string) => string;
  getChannelMembers: (agentName: string) => Array<{ userId: string; name: string }>;
  postMessage: (agentName: string, message: string) => void;
}

interface SandboxAccessor {
  getConfig: () => SandboxConfig | null;
  getVmExecutor: () => VmExecutor | null;
  isEnabled: () => boolean;
}
