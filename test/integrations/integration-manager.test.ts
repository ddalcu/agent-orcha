import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { IntegrationManager } from '../../lib/integrations/integration-manager.ts';
import { EmailConnector } from '../../lib/integrations/email.ts';

describe('IntegrationManager', () => {
  let manager: IntegrationManager;

  beforeEach(() => {
    manager = new IntegrationManager();
  });

  it('should return empty channel context for unknown agent', () => {
    const ctx = manager.getChannelContext('nonexistent');
    assert.equal(ctx, '');
  });

  it('should return empty members for unknown agent', () => {
    const members = manager.getChannelMembers('nonexistent');
    assert.deepEqual(members, []);
  });

  it('should not throw when posting to unknown agent', () => {
    manager.postMessage('nonexistent', 'hello');
  });

  it('should close without error when no connectors', () => {
    manager.close();
  });

  it('should handle agents with no integrations', async () => {
    const mockOrchestrator = {
      agents: { list: () => [{ name: 'a1', integrations: [] }] },
    } as any;

    await manager.start(mockOrchestrator);
    assert.equal(manager.getChannelContext('a1'), '');
  });

  it('should handle agents with undefined integrations', async () => {
    const mockOrchestrator = {
      agents: { list: () => [{ name: 'a1' }] },
    } as any;

    await manager.start(mockOrchestrator);
    assert.equal(manager.getChannelContext('a1'), '');
  });

  it('should get channel context from injected connectors', () => {
    const mockConnector = {
      getRecentMessages: () => 'User: hello\nBot: hi',
      getChannelMembers: () => [],
      postMessage: () => {},
      close: () => {},
    };
    (manager as any).connectors.set('agent1', [mockConnector]);

    const ctx = manager.getChannelContext('agent1');
    assert.ok(ctx.includes('User: hello'));
  });

  it('should merge members from multiple connectors with deduplication', () => {
    const connector1 = {
      getRecentMessages: () => '',
      getChannelMembers: () => [
        { userId: 'u1', name: 'Alice' },
        { userId: 'u2', name: 'Bob' },
      ],
      postMessage: () => {},
      close: () => {},
    };
    const connector2 = {
      getRecentMessages: () => '',
      getChannelMembers: () => [
        { userId: 'u2', name: 'Bob' },  // duplicate
        { userId: 'u3', name: 'Charlie' },
      ],
      postMessage: () => {},
      close: () => {},
    };
    (manager as any).connectors.set('agent1', [connector1, connector2]);

    const members = manager.getChannelMembers('agent1');
    assert.equal(members.length, 3);
    const names = members.map((m: any) => m.name);
    assert.ok(names.includes('Alice'));
    assert.ok(names.includes('Bob'));
    assert.ok(names.includes('Charlie'));
  });

  it('should post message to all connectors for an agent', () => {
    const posted: string[] = [];
    const connector1 = {
      getRecentMessages: () => '',
      getChannelMembers: () => [],
      postMessage: (msg: string) => { posted.push('c1:' + msg); },
      close: () => {},
    };
    const connector2 = {
      getRecentMessages: () => '',
      getChannelMembers: () => [],
      postMessage: (msg: string) => { posted.push('c2:' + msg); },
      close: () => {},
    };
    (manager as any).connectors.set('agent1', [connector1, connector2]);

    manager.postMessage('agent1', 'hello');
    assert.equal(posted.length, 2);
    assert.ok(posted.includes('c1:hello'));
    assert.ok(posted.includes('c2:hello'));
  });

  it('should close all connectors', () => {
    let closeCalled = 0;
    const connector = {
      getRecentMessages: () => '',
      getChannelMembers: () => [],
      postMessage: () => {},
      close: () => { closeCalled++; },
    };
    (manager as any).connectors.set('a1', [connector]);
    (manager as any).connectors.set('a2', [connector]);

    manager.close();
    assert.equal(closeCalled, 2);
    assert.equal((manager as any).connectors.size, 0);
  });

  it('syncAgent should close existing connectors and remove them when agent has no integrations', async () => {
    let closeCalled = 0;
    const connector = {
      getRecentMessages: () => '',
      getChannelMembers: () => [],
      postMessage: () => {},
      close: () => { closeCalled++; },
    };
    (manager as any).connectors.set('agent1', [connector]);

    const mockOrchestrator = {
      agents: { get: (name: string) => ({ name, integrations: undefined }) },
    } as any;

    await manager.syncAgent(mockOrchestrator, 'agent1');
    assert.equal(closeCalled, 1);
    assert.equal((manager as any).connectors.has('agent1'), false);
  });

  it('syncAgent should be a no-op when agent has no existing connectors and no integrations', async () => {
    const mockOrchestrator = {
      agents: { get: (name: string) => ({ name }) },
    } as any;

    await manager.syncAgent(mockOrchestrator, 'agent1');
    assert.equal((manager as any).connectors.has('agent1'), false);
  });

  it('should filter empty messages in getChannelContext', () => {
    const connector1 = {
      getRecentMessages: () => '',
      getChannelMembers: () => [],
      postMessage: () => {},
      close: () => {},
    };
    const connector2 = {
      getRecentMessages: () => 'some context',
      getChannelMembers: () => [],
      postMessage: () => {},
      close: () => {},
    };
    (manager as any).connectors.set('agent1', [connector1, connector2]);

    const ctx = manager.getChannelContext('agent1');
    assert.equal(ctx, 'some context');
  });

  // Email integration tests

  it('should return false for hasEmailIntegration when no connectors', () => {
    assert.equal(manager.hasEmailIntegration('unknown'), false);
  });

  it('should return false for hasEmailIntegration when only non-email connectors', () => {
    const mockConnector = {
      getRecentMessages: () => '',
      getChannelMembers: () => [],
      postMessage: () => {},
      close: () => {},
    };
    (manager as any).connectors.set('agent1', [mockConnector]);
    assert.equal(manager.hasEmailIntegration('agent1'), false);
  });

  it('should not throw when sendEmail called for unknown agent', async () => {
    await manager.sendEmail('unknown', 'a@b.com', 'test', 'body');
  });

  it('should not throw when sendEmail called for agent with only non-email connectors', async () => {
    const mockConnector = {
      getRecentMessages: () => '',
      getChannelMembers: () => [],
      postMessage: () => {},
      close: () => {},
    };
    (manager as any).connectors.set('agent1', [mockConnector]);
    await manager.sendEmail('agent1', 'a@b.com', 'test', 'body');
  });

  it('should route sendEmail to EmailConnector instances', async () => {
    const sent: Array<{ to: string; subject: string; body: string }> = [];
    const mockEmailConnector = Object.create(EmailConnector.prototype);
    mockEmailConnector.sendEmail = async (to: string, subject: string, body: string) => {
      sent.push({ to, subject, body });
    };
    mockEmailConnector.getRecentMessages = () => '';
    mockEmailConnector.getChannelMembers = () => [];
    mockEmailConnector.postMessage = () => {};
    mockEmailConnector.close = () => {};

    (manager as any).connectors.set('agent1', [mockEmailConnector]);

    await manager.sendEmail('agent1', 'user@test.com', 'Hello', 'Body text');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'user@test.com');
    assert.equal(sent[0]!.subject, 'Hello');
    assert.equal(sent[0]!.body, 'Body text');
  });

  it('should detect hasEmailIntegration for EmailConnector instances', () => {
    const mockEmailConnector = Object.create(EmailConnector.prototype);
    mockEmailConnector.getRecentMessages = () => '';
    mockEmailConnector.getChannelMembers = () => [];
    mockEmailConnector.postMessage = () => {};
    mockEmailConnector.close = () => {};

    (manager as any).connectors.set('agent1', [mockEmailConnector]);

    assert.equal(manager.hasEmailIntegration('agent1'), true);
  });

  it('should handle mixed connector types correctly', () => {
    const chatConnector = {
      getRecentMessages: () => 'chat msg',
      getChannelMembers: () => [{ userId: 'u1', name: 'Alice' }],
      postMessage: () => {},
      close: () => {},
    };
    const emailConnector = Object.create(EmailConnector.prototype);
    emailConnector.getRecentMessages = () => '[bob@test.com] Re: Hello: hi there';
    emailConnector.getChannelMembers = () => [{ userId: 'bob@test.com', name: 'Bob' }];
    emailConnector.postMessage = () => {};
    emailConnector.close = () => {};

    (manager as any).connectors.set('agent1', [chatConnector, emailConnector]);

    assert.equal(manager.hasEmailIntegration('agent1'), true);

    const ctx = manager.getChannelContext('agent1');
    assert.ok(ctx.includes('chat msg'));
    assert.ok(ctx.includes('[bob@test.com]'));

    const members = manager.getChannelMembers('agent1');
    assert.equal(members.length, 2);
  });
});
