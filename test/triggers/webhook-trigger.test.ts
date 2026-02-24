import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { WebhookTriggerHandler } from '../../lib/triggers/webhook-trigger.ts';

describe('WebhookTriggerHandler', () => {
  const mockOrchestrator = {
    runAgent: async (_name: string, input: Record<string, unknown>) => ({
      output: `result for ${JSON.stringify(input)}`,
      metadata: { duration: 10 },
    }),
  } as any;

  it('should use custom path when provided', () => {
    const trigger = { type: 'webhook' as const, path: '/hook/custom', input: {} };
    const handler = new WebhookTriggerHandler('my-agent', trigger, mockOrchestrator);
    assert.equal(handler.path, '/hook/custom');
  });

  it('should generate default path when not provided', () => {
    const trigger = { type: 'webhook' as const, input: {} };
    const handler = new WebhookTriggerHandler('my-agent', trigger, mockOrchestrator);
    assert.equal(handler.path, '/api/triggers/webhooks/my-agent');
  });

  it('should register a POST route on fastify', () => {
    const trigger = { type: 'webhook' as const, path: '/hook/test', input: { key: 'val' } };
    const handler = new WebhookTriggerHandler('my-agent', trigger, mockOrchestrator);

    const registeredRoutes: Array<{ path: string; handler: Function }> = [];
    const mockFastify = {
      post: (path: string, fn: Function) => { registeredRoutes.push({ path, handler: fn }); },
    } as any;

    handler.register(mockFastify);

    assert.equal(registeredRoutes.length, 1);
    assert.equal(registeredRoutes[0]!.path, '/hook/test');
  });

  it('should invoke orchestrator.runAgent when route handler is called', async () => {
    let capturedInput: Record<string, unknown> = {};
    const capturingOrchestrator = {
      runAgent: async (_name: string, input: Record<string, unknown>) => {
        capturedInput = input;
        return { output: 'ok', metadata: { duration: 5 } };
      },
    } as any;

    const trigger = { type: 'webhook' as const, path: '/hook/test', input: { base: 'value' } };
    const handler = new WebhookTriggerHandler('my-agent', trigger, capturingOrchestrator);

    let routeHandler: Function = () => {};
    const mockFastify = {
      post: (_path: string, fn: Function) => { routeHandler = fn; },
    } as any;

    handler.register(mockFastify);

    let sentResponse: unknown;
    const mockReply = { send: (data: unknown) => { sentResponse = data; return mockReply; }, status: () => mockReply };
    const mockRequest = { body: { extra: 'data' } };

    await routeHandler(mockRequest, mockReply);

    assert.equal(capturedInput.base, 'value');
    assert.equal(capturedInput.extra, 'data');
    assert.deepEqual(sentResponse, { output: 'ok', metadata: { duration: 5 } });
  });

  it('should return 500 on orchestrator error', async () => {
    const failOrchestrator = {
      runAgent: async () => { throw new Error('Agent failed'); },
    } as any;

    const trigger = { type: 'webhook' as const, path: '/hook/test', input: {} };
    const handler = new WebhookTriggerHandler('my-agent', trigger, failOrchestrator);

    let routeHandler: Function = () => {};
    const mockFastify = {
      post: (_path: string, fn: Function) => { routeHandler = fn; },
    } as any;

    handler.register(mockFastify);

    let statusCode = 0;
    let sentResponse: unknown;
    const mockReply = {
      send: (data: unknown) => { sentResponse = data; return mockReply; },
      status: (code: number) => { statusCode = code; return mockReply; },
    };
    const mockRequest = { body: {} };

    await routeHandler(mockRequest, mockReply);

    assert.equal(statusCode, 500);
    assert.ok((sentResponse as any).error.includes('Agent failed'));
  });
});
