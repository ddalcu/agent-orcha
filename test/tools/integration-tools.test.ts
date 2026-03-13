import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createIntegrationTools } from '../../lib/tools/built-in/integration-tools.ts';
import type { IntegrationAccessor } from '../../lib/integrations/types.ts';

function createMockAccessor(overrides: Partial<IntegrationAccessor> = {}): IntegrationAccessor {
  return {
    getChannelContext: () => '',
    getChannelMembers: () => [],
    postMessage: () => {},
    sendEmail: async () => {},
    hasEmailIntegration: () => false,
    hasChannelIntegration: () => false,
    ...overrides,
  };
}

describe('createIntegrationTools', () => {
  it('should return empty array when no integrations are available', () => {
    const accessor = createMockAccessor();
    const tools = createIntegrationTools(accessor, 'test-agent');
    assert.equal(tools.length, 0);
  });

  describe('channel integration only', () => {
    it('should create integration_post and integration_context tools', () => {
      const accessor = createMockAccessor({
        hasChannelIntegration: () => true,
      });
      const tools = createIntegrationTools(accessor, 'test-agent');
      const names = tools.map(t => t.name);

      assert.equal(tools.length, 2);
      assert.ok(names.includes('integration_post'));
      assert.ok(names.includes('integration_context'));
    });

    it('integration_post should call postMessage and return success', async () => {
      let postedMessage = '';
      let postedAgent = '';
      const accessor = createMockAccessor({
        hasChannelIntegration: () => true,
        postMessage: (agent, msg) => {
          postedAgent = agent;
          postedMessage = msg;
        },
      });

      const tools = createIntegrationTools(accessor, 'my-agent');
      const postTool = tools.find(t => t.name === 'integration_post')!;
      const result = await postTool.invoke({ message: 'Hello channel!' });

      assert.equal(postedAgent, 'my-agent');
      assert.equal(postedMessage, 'Hello channel!');
      assert.equal(result, 'Message posted to integration channel successfully.');
    });

    it('integration_context should return channel context', async () => {
      const accessor = createMockAccessor({
        hasChannelIntegration: () => true,
        getChannelContext: (agent) => `Recent messages for ${agent}`,
      });

      const tools = createIntegrationTools(accessor, 'ctx-agent');
      const ctxTool = tools.find(t => t.name === 'integration_context')!;
      const result = await ctxTool.invoke({});

      assert.equal(result, 'Recent messages for ctx-agent');
    });

    it('integration_context should return fallback when no context', async () => {
      const accessor = createMockAccessor({
        hasChannelIntegration: () => true,
        getChannelContext: () => '',
      });

      const tools = createIntegrationTools(accessor, 'agent');
      const ctxTool = tools.find(t => t.name === 'integration_context')!;
      const result = await ctxTool.invoke({});

      assert.equal(result, 'No recent messages.');
    });
  });

  describe('email integration only', () => {
    it('should create integration_context and email_send tools', () => {
      const accessor = createMockAccessor({
        hasEmailIntegration: () => true,
      });
      const tools = createIntegrationTools(accessor, 'email-agent');
      const names = tools.map(t => t.name);

      assert.equal(tools.length, 2);
      assert.ok(names.includes('integration_context'));
      assert.ok(names.includes('email_send'));
      // No integration_post without channel
      assert.ok(!names.includes('integration_post'));
    });

    it('email_send should call sendEmail and return confirmation', async () => {
      let sentTo = '';
      let sentSubject = '';
      let sentBody = '';
      let sentAgent = '';
      const accessor = createMockAccessor({
        hasEmailIntegration: () => true,
        sendEmail: async (agent, to, subject, body) => {
          sentAgent = agent;
          sentTo = to;
          sentSubject = subject;
          sentBody = body;
        },
      });

      const tools = createIntegrationTools(accessor, 'mailer');
      const emailTool = tools.find(t => t.name === 'email_send')!;
      const result = await emailTool.invoke({
        to: 'user@example.com',
        subject: 'Test Subject',
        body: 'Hello there!',
      });

      assert.equal(sentAgent, 'mailer');
      assert.equal(sentTo, 'user@example.com');
      assert.equal(sentSubject, 'Test Subject');
      assert.equal(sentBody, 'Hello there!');
      assert.equal(result, 'Email sent to user@example.com with subject "Test Subject".');
    });
  });

  describe('both channel and email integrations', () => {
    it('should create all three tools', () => {
      const accessor = createMockAccessor({
        hasChannelIntegration: () => true,
        hasEmailIntegration: () => true,
      });
      const tools = createIntegrationTools(accessor, 'full-agent');
      const names = tools.map(t => t.name);

      assert.equal(tools.length, 3);
      assert.ok(names.includes('integration_post'));
      assert.ok(names.includes('integration_context'));
      assert.ok(names.includes('email_send'));
    });
  });
});
