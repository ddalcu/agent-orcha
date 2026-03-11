import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { WorkflowExecutor } from '../../lib/workflows/workflow-executor.ts';
import type { WorkflowDefinition, WorkflowStatus } from '../../lib/workflows/types.ts';

// --- Mocks ---

function mockAgentLoader(agents: Record<string, any> = {}) {
  return {
    get: (name: string) => agents[name],
  } as any;
}

function mockAgentExecutor(responses: Record<string, string> = {}) {
  return {
    createInstance: async (def: any) => ({
      invoke: async () => ({
        output: responses[def.name] ?? `output from ${def.name}`,
        metadata: { duration: 10 },
      }),
    }),
  } as any;
}

function simpleWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'test-wf',
    description: 'Test workflow',
    type: 'steps',
    input: {
      schema: {
        topic: { type: 'string', description: 'Topic' },
      },
    },
    steps: [
      { id: 'step1', agent: 'writer', input: { message: '{{input.topic}}' } },
    ],
    output: { result: '{{steps.step1.output}}' },
    ...overrides,
  } as WorkflowDefinition;
}

const defaultAgents = {
  writer: { name: 'writer', description: 'Writer', prompt: { system: 'Write', inputVariables: ['message'] }, tools: [] },
  reviewer: { name: 'reviewer', description: 'Reviewer', prompt: { system: 'Review', inputVariables: ['message'] }, tools: [] },
};

// --- Tests ---

describe('WorkflowExecutor', () => {
  it('should execute a single-step workflow', async () => {
    const executor = new WorkflowExecutor(
      mockAgentLoader(defaultAgents),
      mockAgentExecutor({ writer: 'Hello from writer' })
    );

    const result = await executor.execute(simpleWorkflow(), { topic: 'AI' });

    assert.equal(result.output.result, 'Hello from writer');
    assert.equal(result.metadata.success, true);
    assert.equal(result.metadata.stepsExecuted, 1);
    assert.ok(result.metadata.duration >= 0);
  });

  it('should resolve input template variables', async () => {
    let capturedInput: any;
    const agentExecutor = {
      createInstance: async () => ({
        invoke: async (input: any) => {
          capturedInput = input;
          return { output: 'done', metadata: { duration: 0 } };
        },
      }),
    } as any;

    const executor = new WorkflowExecutor(mockAgentLoader(defaultAgents), agentExecutor);
    await executor.execute(simpleWorkflow(), { topic: 'Quantum Computing' });

    assert.equal(capturedInput.message, 'Quantum Computing');
  });

  it('should execute multi-step workflow with step references', async () => {
    const wf = simpleWorkflow({
      steps: [
        { id: 'step1', agent: 'writer', input: { message: '{{input.topic}}' } },
        { id: 'step2', agent: 'reviewer', input: { message: 'Review: {{steps.step1.output}}' } },
      ] as any,
      output: { result: '{{steps.step2.output}}' },
    });

    const executor = new WorkflowExecutor(
      mockAgentLoader(defaultAgents),
      mockAgentExecutor({ writer: 'Draft text', reviewer: 'Reviewed text' })
    );

    const result = await executor.execute(wf, { topic: 'AI' });
    assert.equal(result.output.result, 'Reviewed text');
    assert.equal(result.metadata.stepsExecuted, 2);
    assert.equal(result.metadata.success, true);
  });

  it('should handle missing agent gracefully', async () => {
    const wf = simpleWorkflow({
      steps: [{ id: 'step1', agent: 'nonexistent', input: { message: 'hi' } }] as any,
    });

    const executor = new WorkflowExecutor(mockAgentLoader({}), mockAgentExecutor());
    const result = await executor.execute(wf, {});

    assert.equal(result.stepResults.step1!.metadata.success, false);
    assert.ok(result.stepResults.step1!.metadata.error!.includes('Agent not found'));
  });

  it('should stop on error when onError is stop', async () => {
    const wf = simpleWorkflow({
      steps: [
        { id: 'step1', agent: 'nonexistent', input: { message: 'hi' } },
        { id: 'step2', agent: 'writer', input: { message: 'hi' } },
      ] as any,
      config: { onError: 'stop' },
    });

    const executor = new WorkflowExecutor(mockAgentLoader(defaultAgents), mockAgentExecutor());
    const result = await executor.execute(wf, {});

    assert.equal(result.metadata.success, false);
    assert.equal(result.metadata.stepsExecuted, 1); // step2 never ran
  });

  it('should continue on error by default', async () => {
    const wf = simpleWorkflow({
      steps: [
        { id: 'step1', agent: 'nonexistent', input: { message: 'hi' } },
        { id: 'step2', agent: 'writer', input: { message: 'hi' } },
      ] as any,
    });

    const executor = new WorkflowExecutor(
      mockAgentLoader(defaultAgents),
      mockAgentExecutor({ writer: 'ok' })
    );
    const result = await executor.execute(wf, {});

    assert.equal(result.metadata.stepsExecuted, 2);
  });

  it('should apply input defaults', async () => {
    let capturedInput: any;
    const agentExecutor = {
      createInstance: async () => ({
        invoke: async (input: any) => {
          capturedInput = input;
          return { output: 'done', metadata: { duration: 0 } };
        },
      }),
    } as any;

    const wf = simpleWorkflow({
      input: {
        schema: {
          topic: { type: 'string', description: 'Topic', default: 'Default Topic' },
        },
      },
    });

    const executor = new WorkflowExecutor(mockAgentLoader(defaultAgents), agentExecutor);
    await executor.execute(wf, {}); // No topic provided

    assert.equal(capturedInput.message, 'Default Topic');
  });

  it('should skip step when condition is false', async () => {
    const wf = simpleWorkflow({
      steps: [
        { id: 'step1', agent: 'writer', input: { message: 'hi' }, condition: 'false' },
      ] as any,
    });

    const executor = new WorkflowExecutor(mockAgentLoader(defaultAgents), mockAgentExecutor());
    const result = await executor.execute(wf, {});

    assert.equal(result.stepResults.step1!.output, null);
    assert.ok(result.stepResults.step1!.metadata.error!.includes('Condition not met'));
    assert.equal(result.stepResults.step1!.metadata.success, true); // skipped = success
  });

  it('should execute step when condition is true', async () => {
    const wf = simpleWorkflow({
      steps: [
        { id: 'step1', agent: 'writer', input: { message: 'hi' }, condition: 'true' },
      ] as any,
    });

    const executor = new WorkflowExecutor(
      mockAgentLoader(defaultAgents),
      mockAgentExecutor({ writer: 'executed' })
    );
    const result = await executor.execute(wf, {});

    assert.equal(result.stepResults.step1!.output, 'executed');
    assert.equal(result.stepResults.step1!.metadata.success, true);
  });

  it('should execute parallel steps', async () => {
    const wf = simpleWorkflow({
      steps: [
        {
          parallel: [
            { id: 'p1', agent: 'writer', input: { message: 'a' } },
            { id: 'p2', agent: 'reviewer', input: { message: 'b' } },
          ],
        },
      ] as any,
      output: { a: '{{steps.p1.output}}', b: '{{steps.p2.output}}' },
    });

    const executor = new WorkflowExecutor(
      mockAgentLoader(defaultAgents),
      mockAgentExecutor({ writer: 'result-a', reviewer: 'result-b' })
    );
    const result = await executor.execute(wf, {});

    assert.equal(result.output.a, 'result-a');
    assert.equal(result.output.b, 'result-b');
    assert.equal(result.metadata.stepsExecuted, 2);
  });

  it('should fire status callbacks', async () => {
    const statuses: WorkflowStatus[] = [];

    const executor = new WorkflowExecutor(
      mockAgentLoader(defaultAgents),
      mockAgentExecutor({ writer: 'ok' })
    );
    await executor.execute(simpleWorkflow(), { topic: 'AI' }, (s) => statuses.push(s));

    assert.ok(statuses.some(s => s.type === 'workflow_start'));
    assert.ok(statuses.some(s => s.type === 'step_start'));
    assert.ok(statuses.some(s => s.type === 'step_complete'));
    assert.ok(statuses.some(s => s.type === 'workflow_complete'));
  });

  it('should throw for react workflow type', async () => {
    const wf = simpleWorkflow({ type: 'react' as any });
    const executor = new WorkflowExecutor(mockAgentLoader(defaultAgents), mockAgentExecutor());

    await assert.rejects(() => executor.execute(wf, {}), /ReAct workflows/);
  });

  it('should handle agent execution errors', async () => {
    const failingExecutor = {
      createInstance: async () => ({
        invoke: async () => { throw new Error('Agent crashed'); },
      }),
    } as any;

    const executor = new WorkflowExecutor(mockAgentLoader(defaultAgents), failingExecutor);
    const result = await executor.execute(simpleWorkflow(), { topic: 'AI' });

    assert.equal(result.stepResults.step1!.metadata.success, false);
    assert.ok(result.stepResults.step1!.metadata.error!.includes('Agent crashed'));
  });

  it('should resolve output with multiple templates', async () => {
    const wf = simpleWorkflow({
      steps: [
        { id: 's1', agent: 'writer', input: { message: 'a' } },
        { id: 's2', agent: 'reviewer', input: { message: 'b' } },
      ] as any,
      output: {
        combined: '{{steps.s1.output}} and {{steps.s2.output}}',
        input_echo: '{{input.topic}}',
      },
    });

    const executor = new WorkflowExecutor(
      mockAgentLoader(defaultAgents),
      mockAgentExecutor({ writer: 'first', reviewer: 'second' })
    );
    const result = await executor.execute(wf, { topic: 'Test' });

    assert.equal(result.output.combined, 'first and second');
    assert.equal(result.output.input_echo, 'Test');
  });
});
