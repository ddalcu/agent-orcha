import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Orchestrator } from '../lib/orchestrator.ts';

describe('Orchestrator', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-test-'));
    // Create required directories
    await fs.mkdir(path.join(tempDir, 'agents'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'workflows'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'knowledge'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'functions'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should construct with workspaceRoot', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.ok(orch);
  });

  it('should construct with custom dirs', () => {
    const orch = new Orchestrator({
      workspaceRoot: tempDir,
      agentsDir: path.join(tempDir, 'agents'),
      workflowsDir: path.join(tempDir, 'workflows'),
      knowledgeDir: path.join(tempDir, 'knowledge'),
      functionsDir: path.join(tempDir, 'functions'),
      skillsDir: path.join(tempDir, 'skills'),
    });
    assert.ok(orch);
  });

  it('should expose agents accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.ok(orch.agents);
    assert.ok(typeof orch.agents.list === 'function');
  });

  it('should expose workflows accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.ok(orch.workflows);
    assert.ok(typeof orch.workflows.list === 'function');
  });

  it('should expose knowledge accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.ok(orch.knowledge);
  });

  it('should expose memory accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.ok(orch.memory);
  });

  it('should expose functions accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.ok(orch.functions);
  });

  it('should expose skills accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.ok(orch.skills);
  });

  it('should initialize with LLM config', async () => {
    // Write a minimal LLM config
    const llmConfig = {
      version: '1.0',
      models: {
        default: { model: 'gpt-4o-mini', provider: 'openai', maxTokens: 4096 },
      },
      embeddings: {
        default: { model: 'text-embedding-3-small', provider: 'openai' },
      },
    };
    await fs.writeFile(path.join(tempDir, 'llm.json'), JSON.stringify(llmConfig));

    const orch = new Orchestrator({ workspaceRoot: tempDir });
    await orch.initialize();

    // After initialization, tasks should be accessible
    assert.ok(orch.tasks);

    await orch.close();
  });

  it('should not re-initialize if already initialized', async () => {
    const llmConfig = {
      version: '1.0',
      models: {
        default: { model: 'gpt-4o-mini', provider: 'openai', maxTokens: 4096 },
      },
      embeddings: {
        default: { model: 'text-embedding-3-small', provider: 'openai' },
      },
    };
    await fs.writeFile(path.join(tempDir, 'llm.json'), JSON.stringify(llmConfig));

    const orch = new Orchestrator({ workspaceRoot: tempDir });
    await orch.initialize();
    await orch.initialize(); // should be no-op

    await orch.close();
  });

  it('should list empty resources before initialization', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const agents = orch.agents.list();
    assert.deepEqual(agents, []);
  });

  it('should expose workspaceRoot', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.equal(orch.workspaceRoot, tempDir);
  });

  it('should expose sandbox accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const sandbox = orch.sandbox;
    assert.ok(sandbox);
    assert.equal(sandbox.isEnabled(), false);
    assert.equal(sandbox.getConfig(), null);
    assert.equal(sandbox.getVmExecutor(), null);
  });

  it('should expose integrations accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const integrations = orch.integrations;
    assert.ok(integrations);
    assert.equal(integrations.getChannelContext('agent1'), '');
    assert.deepEqual(integrations.getChannelMembers('agent1'), []);
    // postMessage should not throw
    integrations.postMessage('agent1', 'hello');
  });

  it('should expose triggers accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const triggers = orch.triggers;
    assert.ok(triggers);
    assert.equal(triggers.getManager(), null);
  });

  it('should expose longTermMemory accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const ltm = orch.longTermMemory;
    assert.ok(ltm);
    assert.ok(typeof ltm.load === 'function');
  });

  it('should list empty workflows', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.deepEqual(orch.workflows.list(), []);
    assert.deepEqual(orch.workflows.names(), []);
    assert.equal(orch.workflows.get('nonexistent'), undefined);
  });

  it('should list empty functions', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.deepEqual(orch.functions.list(), []);
    assert.deepEqual(orch.functions.names(), []);
    assert.equal(orch.functions.get('nonexistent'), undefined);
  });

  it('should list empty skills', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.deepEqual(orch.skills.list(), []);
    assert.deepEqual(orch.skills.names(), []);
    assert.equal(orch.skills.get('nonexistent'), undefined);
    assert.equal(orch.skills.has('nonexistent'), false);
  });

  it('should expose knowledge accessor methods', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const k = orch.knowledge;
    assert.deepEqual(k.list(), []);
    assert.deepEqual(k.listConfigs(), []);
    assert.equal(k.get('nonexistent'), undefined);
    assert.equal(k.getConfig('nonexistent'), undefined);
    assert.equal(k.isIndexing('nonexistent'), false);
    assert.ok(k.getMetadataManager());
  });

  it('should expose memory accessor methods', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const m = orch.memory;
    assert.ok(m.getStore());
    assert.equal(m.getSessionCount(), 0);
    assert.equal(m.hasSession('s1'), false);
    assert.equal(m.getMessageCount('s1'), 0);
    // clearSession should not throw
    m.clearSession('s1');
  });

  it('should expose triggers.setManager', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const mockManager = { close: () => {} } as any;
    orch.triggers.setManager(mockManager);
    assert.equal(orch.triggers.getManager(), mockManager);
  });

  it('should expose mcp accessor', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    // mcp accessor exists even before initialization (mcpClient not set yet)
    const mcpAccessor = orch.mcp;
    assert.ok(mcpAccessor);
    assert.ok(typeof mcpAccessor.getManager === 'function');
  });

  it('should throw when calling ensureInitialized methods before init', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.throws(
      () => (orch as any).ensureInitialized(),
      /not initialized/,
    );
  });

  it('should close cleanly without initialization', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    // close() should not throw even if never initialized
    await orch.close();
  });

  it('should construct with all custom dir paths', () => {
    const orch = new Orchestrator({
      workspaceRoot: tempDir,
      agentsDir: path.join(tempDir, 'agents'),
      workflowsDir: path.join(tempDir, 'workflows'),
      knowledgeDir: path.join(tempDir, 'knowledge'),
      functionsDir: path.join(tempDir, 'functions'),
      skillsDir: path.join(tempDir, 'skills'),
      mcpConfigPath: path.join(tempDir, 'mcp.json'),
      llmConfigPath: path.join(tempDir, 'llm.json'),
      sandboxConfigPath: path.join(tempDir, 'sandbox.json'),
    });
    assert.ok(orch);
    assert.equal(orch.workspaceRoot, tempDir);
  });

  it('should expose agents.names and agents.get', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.deepEqual(orch.agents.names(), []);
    assert.equal(orch.agents.get('nonexistent'), undefined);
  });

  it('should expose knowledge.isIndexing', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.equal(orch.knowledge.isIndexing('test'), false);
  });

  it('should expose functions.getTool', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.equal(orch.functions.getTool('nonexistent'), undefined);
  });

  it('should throw ensureInitialized for runAgent', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    await assert.rejects(
      () => orch.runAgent('test', {}),
      /not initialized/,
    );
  });

  it('should throw ensureInitialized for runWorkflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    await assert.rejects(
      () => orch.runWorkflow('test', {}),
      /not initialized/,
    );
  });

  it('should throw ensureInitialized for searchKnowledge', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    await assert.rejects(
      () => orch.searchKnowledge('test', 'query'),
      /not initialized/,
    );
  });

  it('should throw ensureInitialized for streamAgent', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const gen = orch.streamAgent('test', {});
    await assert.rejects(() => gen.next(), /not initialized/);
  });

  it('should throw ensureInitialized for streamWorkflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    const gen = orch.streamWorkflow('test', {});
    await assert.rejects(() => gen.next(), /not initialized/);
  });

  it('should throw ensureInitialized for reloadFile', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    await assert.rejects(
      () => orch.reloadFile('test.agent.yaml'),
      /not initialized/,
    );
  });

  it('should throw ensureInitialized for getReactWorkflowInterrupts', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.throws(
      () => orch.getReactWorkflowInterrupts('test'),
      /not initialized/,
    );
  });

  it('should throw ensureInitialized for getReactWorkflowInterrupt', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    assert.throws(
      () => orch.getReactWorkflowInterrupt('thread-1'),
      /not initialized/,
    );
  });

  it('should throw ensureInitialized for resumeReactWorkflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    await assert.rejects(
      () => orch.resumeReactWorkflow('test', 'thread-1', 'answer'),
      /not initialized/,
    );
  });

  it('should handle reloadFile after manual initialization', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });

    // Manually set initialized and inject required deps
    (orch as any).initialized = true;
    (orch as any).agentLoader = { loadOne: async () => {} };
    (orch as any).workflowLoader = { loadOne: async () => {} };
    (orch as any).knowledgeStoreManager = { loadOne: async () => {} };
    (orch as any).functionLoader = { loadOne: async () => {} };
    (orch as any).skillLoader = { loadOne: async () => {} };

    assert.equal(await orch.reloadFile('test.agent.yaml'), 'agent');
    assert.equal(await orch.reloadFile('test.workflow.yaml'), 'workflow');
    assert.equal(await orch.reloadFile('test.knowledge.yaml'), 'knowledge');
    assert.equal(await orch.reloadFile('test.function.js'), 'function');
    assert.equal(await orch.reloadFile('skills/SKILL.md'), 'skill');
    assert.equal(await orch.reloadFile('unknown.txt'), 'none');
  });

  it('should handle reloadFile for llm.json', async () => {
    // Write a valid LLM config
    const llmConfig = {
      version: '1.0',
      models: {
        default: { model: 'gpt-4o-mini', provider: 'openai', maxTokens: 4096 },
      },
      embeddings: {
        default: { model: 'text-embedding-3-small', provider: 'openai' },
      },
    };
    await fs.writeFile(path.join(tempDir, 'llm.json'), JSON.stringify(llmConfig));

    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;

    const result = await orch.reloadFile('llm.json');
    assert.equal(result, 'llm');
  });

  it('should handle reloadFile for sandbox.json', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).vmExecutor = null;
    (orch as any).sandboxConfig = null;
    (orch as any).mcpClient = { getServerNames: () => [], getToolsByServer: async () => [] };
    (orch as any).knowledgeStoreManager = { listConfigs: () => [] };
    (orch as any).functionLoader = { list: () => [], getTool: () => undefined };
    (orch as any).agentLoader = { list: () => [] };
    (orch as any).workflowLoader = { list: () => [] };
    (orch as any).skillLoader = { list: () => [] };

    // No sandbox.json exists, so loadSandboxConfig will use defaults (enabled)
    const result = await orch.reloadFile('sandbox.json');
    assert.equal(result, 'sandbox');
  });

  it('should close with trigger and integration managers', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    let triggerClosed = false;
    let integrationClosed = false;

    (orch as any).triggerManager = { close: () => { triggerClosed = true; } };
    (orch as any).integrationManager = { close: () => { integrationClosed = true; } };

    await orch.close();
    assert.ok(triggerClosed);
    assert.ok(integrationClosed);
  });

  it('runAgent should throw when agent not found', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).agentLoader = { get: () => undefined };

    await assert.rejects(
      () => orch.runAgent('nonexistent', {}),
      /Agent not found/,
    );
  });

  it('runWorkflow should throw when workflow not found', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = { get: () => undefined };

    await assert.rejects(
      () => orch.runWorkflow('nonexistent', {}),
      /Workflow not found/,
    );
  });

  it('streamAgent should throw when agent not found', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).agentLoader = { get: () => undefined };

    const gen = orch.streamAgent('nonexistent', {});
    await assert.rejects(() => gen.next(), /Agent not found/);
  });

  it('streamWorkflow should throw when workflow not found', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = { get: () => undefined };

    const gen = orch.streamWorkflow('nonexistent', {});
    await assert.rejects(() => gen.next(), /Workflow not found/);
  });

  it('searchKnowledge should initialize store on demand', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;

    const mockStore = {
      search: async (query: string, k?: number) => [{ content: 'found', metadata: {}, score: 0.9 }],
    };
    (orch as any).knowledgeStoreManager = {
      get: () => undefined,
      initialize: async () => mockStore,
    };

    const results = await orch.searchKnowledge('kb1', 'test');
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'found');
  });

  it('searchKnowledge should use existing store', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;

    const mockStore = {
      search: async () => [{ content: 'cached', metadata: {}, score: 0.8 }],
    };
    (orch as any).knowledgeStoreManager = {
      get: () => mockStore,
    };

    const results = await orch.searchKnowledge('kb1', 'test', 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'cached');
  });

  it('resumeReactWorkflow should throw for non-react workflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = {
      get: () => ({ name: 'test', type: 'sequential' }),
    };

    await assert.rejects(
      () => orch.resumeReactWorkflow('test', 'thread-1', 'answer'),
      /not a ReAct workflow/,
    );
  });

  it('resumeReactWorkflow should throw for unknown workflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = { get: () => undefined };

    await assert.rejects(
      () => orch.resumeReactWorkflow('nonexistent', 'thread-1', 'answer'),
      /Workflow not found/,
    );
  });

  it('getReactWorkflowInterrupts should return interrupts', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).interruptManager = {
      getInterruptsByWorkflow: () => [{ threadId: 't1', question: 'q1' }],
    };

    const interrupts = orch.getReactWorkflowInterrupts('test');
    assert.equal(interrupts.length, 1);
  });

  it('getReactWorkflowInterrupt should return single interrupt', () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).interruptManager = {
      getInterrupt: (tid: string) => tid === 't1' ? { threadId: 't1' } : undefined,
    };

    assert.ok(orch.getReactWorkflowInterrupt('t1'));
    assert.equal(orch.getReactWorkflowInterrupt('t2'), undefined);
  });

  it('should close all resources including task manager', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    let taskManagerDestroyed = false;
    let conversationStoreDestroyed = false;
    let mcpClosed = false;

    (orch as any).taskManager = { destroy: () => { taskManagerDestroyed = true; } };
    (orch as any).conversationStore = { destroy: () => { conversationStoreDestroyed = true; } };
    (orch as any).mcpClient = { close: async () => { mcpClosed = true; } };
    (orch as any).vmExecutor = null;
    (orch as any).triggerManager = null;
    (orch as any).integrationManager = null;

    await orch.close();
    assert.ok(taskManagerDestroyed);
    assert.ok(conversationStoreDestroyed);
    assert.ok(mcpClosed);
  });

  it('should close vm executor', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    let vmClosed = false;

    (orch as any).vmExecutor = { close: () => { vmClosed = true; } };
    (orch as any).mcpClient = null;
    (orch as any).conversationStore = null;
    (orch as any).taskManager = null;
    (orch as any).triggerManager = null;
    (orch as any).integrationManager = null;

    await orch.close();
    assert.ok(vmClosed);
  });

  it('should run step-based workflow with mock executor', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = {
      get: () => ({ name: 'test', type: 'sequential', steps: [] }),
    };
    (orch as any).workflowExecutor = {
      execute: async () => ({
        output: { result: 'done' },
        metadata: { success: true, duration: 100, stepsExecuted: 1 },
        stepResults: {},
      }),
    };

    const result = await orch.runWorkflow('test', { input: 'hello' });
    assert.equal(result.metadata.success, true);
  });

  it('should route react workflow to reactWorkflowExecutor', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = {
      get: () => ({ name: 'test', type: 'react' }),
    };
    (orch as any).reactWorkflowExecutor = {
      execute: async () => ({
        output: { result: 'react done' },
        metadata: { success: true, duration: 50, stepsExecuted: 1 },
        stepResults: {},
      }),
    };

    const result = await orch.runWorkflow('test', {});
    assert.equal(result.metadata.success, true);
  });

  it('should run agent with mock executor', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).agentLoader = {
      get: () => ({ name: 'test-agent', description: 'test', prompt: { system: 'test', inputVariables: ['message'] }, tools: [] }),
    };
    (orch as any).agentExecutor = {
      createInstance: async () => ({
        invoke: async () => ({ output: 'mock response', metadata: { duration: 10 } }),
      }),
    };

    const result = await orch.runAgent('test-agent', { message: 'hello' });
    assert.equal(result.output, 'mock response');
  });

  it('should stream step-based workflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = {
      get: () => ({ name: 'test', type: 'sequential', steps: [] }),
    };
    (orch as any).workflowExecutor = {
      execute: async (_def: any, _input: any, onStatus?: Function) => {
        onStatus?.({ step: 'step1', status: 'running' });
        return {
          output: { result: 'done' },
          metadata: { success: true, duration: 100, stepsExecuted: 1 },
          stepResults: {},
        };
      },
    };

    const events: any[] = [];
    for await (const event of orch.streamWorkflow('test', {})) {
      events.push(event);
    }
    assert.ok(events.length >= 2); // at least status + result
    assert.ok(events.some(e => e.type === 'status'));
    assert.ok(events.some(e => e.type === 'result'));
  });

  it('should stream react workflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = {
      get: () => ({ name: 'test', type: 'react' }),
    };
    (orch as any).reactWorkflowExecutor = {
      execute: async (_def: any, _input: any, _thread?: any, onStatus?: Function) => {
        onStatus?.({ step: 'node1', status: 'running' });
        return {
          output: { result: 'done' },
          metadata: { success: true, duration: 50, stepsExecuted: 1 },
          stepResults: {},
        };
      },
    };

    const events: any[] = [];
    for await (const event of orch.streamWorkflow('test', {})) {
      events.push(event);
    }
    assert.ok(events.length >= 2);
    assert.ok(events.some(e => e.type === 'status'));
    assert.ok(events.some(e => e.type === 'result'));
  });

  it('should handle workflow execution error in streamWorkflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = {
      get: () => ({ name: 'test', type: 'sequential', steps: [] }),
    };
    (orch as any).workflowExecutor = {
      execute: async () => { throw new Error('Execution failed'); },
    };

    const events: any[] = [];
    for await (const event of orch.streamWorkflow('test', {})) {
      events.push(event);
    }
    assert.ok(events.some(e => e.type === 'result' && (e.data as any).error === 'Execution failed'));
  });

  it('should handle langgraph execution error in streamWorkflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = {
      get: () => ({ name: 'test', type: 'react' }),
    };
    (orch as any).reactWorkflowExecutor = {
      execute: async () => { throw new Error('ReactWorkflow failed'); },
    };

    const events: any[] = [];
    for await (const event of orch.streamWorkflow('test', {})) {
      events.push(event);
    }
    assert.ok(events.some(e => e.type === 'result' && (e.data as any).error === 'ReactWorkflow failed'));
  });

  it('should stream agent with mock executor', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).agentLoader = {
      get: () => ({ name: 'test-agent', description: 'test', prompt: { system: 'test', inputVariables: ['message'] }, tools: [] }),
    };
    (orch as any).agentExecutor = {
      createInstance: async () => ({
        stream: async function* () { yield 'chunk1'; yield 'chunk2'; },
      }),
    };

    const chunks: any[] = [];
    for await (const chunk of orch.streamAgent('test-agent', { message: 'hello' })) {
      chunks.push(chunk);
    }
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], 'chunk1');
  });

  it('should resume react workflow', async () => {
    const orch = new Orchestrator({ workspaceRoot: tempDir });
    (orch as any).initialized = true;
    (orch as any).workflowLoader = {
      get: () => ({ name: 'test', type: 'react' }),
    };
    (orch as any).reactWorkflowExecutor = {
      resumeWithAnswer: async () => ({
        output: { result: 'resumed' },
        metadata: { success: true, duration: 30, stepsExecuted: 1 },
        stepResults: {},
      }),
    };

    const result = await orch.resumeReactWorkflow('test', 'thread-1', 'yes');
    assert.equal(result.metadata.success, true);
  });
});
