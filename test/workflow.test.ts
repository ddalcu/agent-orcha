import { test, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { WorkflowExecutor } from '../lib/workflows/workflow-executor.js';
import type { AgentLoader } from '../lib/agents/agent-loader.js';
import type { AgentExecutor } from '../lib/agents/agent-executor.js';

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
});
