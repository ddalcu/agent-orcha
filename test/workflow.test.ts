import { test, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { WorkflowExecutor } from '../lib/workflows/workflow-executor.ts';
import type { AgentLoader } from '../lib/agents/agent-loader.ts';
import type { AgentExecutor } from '../lib/agents/agent-executor.ts';

// Mocks
const mockAgentLoader = {
    get: (name: string) => ({
        name,
        description: 'Mock Agent',
        version: '1.0.0',
        type: 'chat',
        prompt: { template: '', inputVariables: [] },
        model: { provider: 'mock', name: 'mock' },
        tools: []
    })
} as unknown as AgentLoader;

const mockAgentExecutor = {
    createInstance: async () => ({
        invoke: async (input: any) => ({
            output: `Executed ${JSON.stringify(input)}`,
            metadata: {
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                model: 'mock',
                latency: 0
            }
        }),
        stream: async function* () { }
    })
} as unknown as AgentExecutor;

describe('WorkflowExecutor', () => {
    it('should execute a simple linear workflow', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'test-workflow',
            description: 'Test',
            version: '1.0.0',
            input: {
                schema: {
                    topic: { type: 'string' }
                }
            },
            steps: [
                {
                    id: 'step1',
                    agent: 'mock-agent',
                    input: {
                        query: '{{input.topic}}'
                    }
                }
            ],
            output: {
                result: '{{steps.step1.output}}'
            },
            metadata: {}
        };

        const result = await executor.execute(workflowDef as any, { topic: 'hello' });

        assert.equal(result.metadata.success, true);
        assert.equal(result.output.result, 'Executed {"query":"hello"}');
    });

    it('should handle conditions correctly', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'conditional-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: { run: { type: 'boolean' } } },
            steps: [
                {
                    id: 'conditional_step',
                    agent: 'mock-agent',
                    input: { query: 'run' },
                    condition: '{{input.run}}'
                }
            ],
            output: {
                did_run: '{{steps.conditional_step.output}}'
            },
            metadata: {}
        };

        // Case 1: run = true
        const resultTrue = await executor.execute(workflowDef as any, { run: true });
        assert.ok(resultTrue.stepResults['conditional_step'].output);

        // Case 2: run = false
        const resultFalse = await executor.execute(workflowDef as any, { run: false });
        assert.equal(resultFalse.stepResults['conditional_step'].output, null);
    });

    it('should execute parallel steps', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'parallel-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: { topic: { type: 'string' } } },
            steps: [
                {
                    parallel: [
                        { id: 'p1', agent: 'mock-agent', input: { query: 'a' } },
                        { id: 'p2', agent: 'mock-agent', input: { query: 'b' } },
                    ],
                },
            ],
            output: {
                r1: '{{steps.p1.output}}',
                r2: '{{steps.p2.output}}',
            },
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, { topic: 'test' });
        assert.equal(result.metadata.success, true);
        assert.ok(result.stepResults['p1']);
        assert.ok(result.stepResults['p2']);
    });

    it('should handle agent not found', async () => {
        const noAgentLoader = {
            get: () => undefined,
        } as unknown as AgentLoader;

        const executor = new WorkflowExecutor(noAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'missing-agent-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                { id: 'step1', agent: 'nonexistent', input: {} },
            ],
            output: {},
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, {});
        assert.equal(result.stepResults['step1'].metadata.success, false);
        assert.ok(result.stepResults['step1'].metadata.error?.includes('not found'));
    });

    it('should handle agent execution error with stop policy', async () => {
        const failingExecutor = {
            createInstance: async () => ({
                invoke: async () => { throw new Error('LLM failed'); },
            }),
        } as unknown as AgentExecutor;

        const executor = new WorkflowExecutor(mockAgentLoader, failingExecutor);

        const workflowDef = {
            name: 'error-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                { id: 'step1', agent: 'mock-agent', input: {} },
                { id: 'step2', agent: 'mock-agent', input: {} },
            ],
            output: {},
            metadata: {},
            config: { onError: 'stop' },
        };

        const result = await executor.execute(workflowDef as any, {});
        assert.equal(result.metadata.success, false);
        assert.equal(result.metadata.stepsExecuted, 1);
    });

    it('should handle agent execution error with continue policy', async () => {
        const failingExecutor = {
            createInstance: async () => ({
                invoke: async () => { throw new Error('LLM failed'); },
            }),
        } as unknown as AgentExecutor;

        const executor = new WorkflowExecutor(mockAgentLoader, failingExecutor);

        const workflowDef = {
            name: 'continue-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                { id: 'step1', agent: 'mock-agent', input: {} },
                { id: 'step2', agent: 'mock-agent', input: {} },
            ],
            output: {},
            metadata: {},
            config: { onError: 'continue' },
        };

        const result = await executor.execute(workflowDef as any, {});
        // With continue, step2 should also execute (and also fail)
        assert.equal(result.metadata.stepsExecuted, 2);
    });

    it('should apply input defaults', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'defaults-workflow',
            description: 'Test',
            version: '1.0.0',
            input: {
                schema: {
                    topic: { type: 'string', default: 'default-topic' },
                },
            },
            steps: [
                { id: 'step1', agent: 'mock-agent', input: { query: '{{input.topic}}' } },
            ],
            output: { result: '{{steps.step1.output}}' },
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, {});
        assert.ok(result.output.result?.toString().includes('default-topic'));
    });

    it('should resolve output from step metadata', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'meta-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                { id: 'step1', agent: 'mock-agent', input: { query: 'test' } },
            ],
            output: {
                agent: '{{steps.step1.metadata.agent}}',
            },
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, {});
        // metadata.agent should be the mock-agent name
        assert.ok(result.output.agent);
    });

    it('should resolve from path with from:step syntax', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'from-step-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                {
                    id: 'step1',
                    agent: 'mock-agent',
                    input: { query: 'first' },
                },
                {
                    id: 'step2',
                    agent: 'mock-agent',
                    input: {
                        prev: { from: 'step', path: 'step1.output' },
                    },
                },
            ],
            output: { result: '{{steps.step2.output}}' },
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, {});
        assert.equal(result.metadata.success, true);
    });

    it('should call onStatus callback', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);
        const statuses: string[] = [];

        const workflowDef = {
            name: 'status-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                { id: 'step1', agent: 'mock-agent', input: {} },
            ],
            output: {},
            metadata: {},
        };

        await executor.execute(workflowDef as any, {}, (status) => {
            statuses.push(status.stepId || 'unknown');
        });

        assert.ok(statuses.length > 0);
    });

    it('should resolve step metadata path in templates', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'metadata-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                { id: 'step1', agent: 'mock-agent', input: {} },
                {
                    id: 'step2',
                    agent: 'mock-agent',
                    input: { info: '{{steps.step1.metadata.duration}}' },
                },
            ],
            output: { result: '{{steps.step2.output}}' },
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, {});
        assert.equal(result.metadata.success, true);
    });

    it('should resolve step output without subpath', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'output-workflow',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                { id: 'step1', agent: 'mock-agent', input: {} },
                {
                    id: 'step2',
                    agent: 'mock-agent',
                    input: { prev: '{{steps.step1}}' },
                },
            ],
            output: {},
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, {});
        assert.equal(result.metadata.success, true);
    });

    it('should handle condition that evaluates to false string', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'condition-false',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                {
                    id: 'step1',
                    agent: 'mock-agent',
                    input: {},
                    condition: 'false',
                },
            ],
            output: {},
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, {});
        assert.equal(result.metadata.success, true);
        // stepsExecuted still counts the step (it was processed), but output is null
        assert.equal(result.stepResults.step1.output, null);
    });

    it('should resolve input from context', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'context-resolve',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                {
                    id: 'step1',
                    agent: 'mock-agent',
                    input: {
                        val: { from: 'context', path: 'input.message' },
                    },
                },
            ],
            output: {},
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, { message: 'hello' });
        assert.equal(result.metadata.success, true);
    });

    it('should handle unknown from in resolvePath', async () => {
        const executor = new WorkflowExecutor(mockAgentLoader, mockAgentExecutor);

        const workflowDef = {
            name: 'unknown-from',
            description: 'Test',
            version: '1.0.0',
            input: { schema: {} },
            steps: [
                {
                    id: 'step1',
                    agent: 'mock-agent',
                    input: {
                        val: { from: 'unknown_source', path: 'foo.bar' },
                    },
                },
            ],
            output: {},
            metadata: {},
        };

        const result = await executor.execute(workflowDef as any, {});
        assert.equal(result.metadata.success, true);
    });
});
