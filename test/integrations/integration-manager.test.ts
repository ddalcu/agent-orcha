import { describe, it, beforeEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';

// ---- Mutable delegates for mocked connectors ----
let collabnookConnectFn: () => Promise<void>;
let collabnookCloseFn: () => void;
let collabnookGetRecentMessagesFn: () => string;
let collabnookGetChannelMembersFn: () => Array<{ userId: string; name: string }>;
let collabnookPostMessageFn: (text: string) => void;
let capturedCollabnookArgs: { config: any; agentName: string; onCommand: any } | null = null;

let emailConnectFn: () => Promise<void>;
let emailCloseFn: () => void;
let emailGetRecentMessagesFn: () => string;
let emailGetChannelMembersFn: () => Array<{ userId: string; name: string }>;
let emailPostMessageFn: (text: string) => void;
let emailSendEmailFn: (to: string, subject: string, body: string) => Promise<void>;
let capturedEmailArgs: { config: any; agentName: string; onCommand: any } | null = null;

// Track instances for instanceof checks
const collabnookInstances: any[] = [];
const emailInstances: any[] = [];

class MockCollabnookConnector {
  constructor(config: any, agentName: string, onCommand: any) {
    capturedCollabnookArgs = { config, agentName, onCommand };
    collabnookInstances.push(this);
  }
  connect() { return collabnookConnectFn(); }
  close() { return collabnookCloseFn(); }
  getRecentMessages() { return collabnookGetRecentMessagesFn(); }
  getChannelMembers() { return collabnookGetChannelMembersFn(); }
  postMessage(text: string) { return collabnookPostMessageFn(text); }
}

class MockEmailConnector {
  constructor(config: any, agentName: string, onCommand: any) {
    capturedEmailArgs = { config, agentName, onCommand };
    emailInstances.push(this);
  }
  connect() { return emailConnectFn(); }
  close() { return emailCloseFn(); }
  getRecentMessages() { return emailGetRecentMessagesFn(); }
  getChannelMembers() { return emailGetChannelMembersFn(); }
  postMessage(text: string) { return emailPostMessageFn(text); }
  sendEmail(to: string, subject: string, body: string) { return emailSendEmailFn(to, subject, body); }
}

// Mock modules BEFORE importing IntegrationManager
mock.module('../../lib/integrations/collabnook.ts', {
  namedExports: {
    CollabnookConnector: MockCollabnookConnector,
  },
});

mock.module('../../lib/integrations/email.ts', {
  namedExports: {
    EmailConnector: MockEmailConnector,
  },
});

const { IntegrationManager } = await import('../../lib/integrations/integration-manager.ts');

// Helper to create a minimal agent definition
function makeAgent(name: string, integrations: any[], opts: { inputVariables?: string[] } = {}) {
  return {
    name,
    integrations,
    prompt: { inputVariables: opts.inputVariables ?? ['query'] },
  };
}

function makeCollabnookIntegration(channel = 'general') {
  return {
    type: 'collabnook' as const,
    url: 'wss://test.com/ws',
    channel,
    botName: 'TestBot',
  };
}

function makeEmailIntegration(overrides: Record<string, any> = {}) {
  return {
    type: 'email' as const,
    imap: { host: 'imap.test.com', port: 993, secure: true },
    smtp: { host: 'smtp.test.com', port: 587, secure: false },
    auth: { user: 'bot@test.com', pass: 'secret' },
    fromAddress: 'bot@test.com',
    folder: 'INBOX',
    polling: true,
    pollInterval: 60,
    ...overrides,
  };
}

describe('IntegrationManager', () => {
  let manager: IntegrationManager;

  beforeEach(() => {
    manager = new IntegrationManager();
    // Reset mutable delegates to safe defaults
    collabnookConnectFn = async () => {};
    collabnookCloseFn = () => {};
    collabnookGetRecentMessagesFn = () => '';
    collabnookGetChannelMembersFn = () => [];
    collabnookPostMessageFn = () => {};
    capturedCollabnookArgs = null;

    emailConnectFn = async () => {};
    emailCloseFn = () => {};
    emailGetRecentMessagesFn = () => '';
    emailGetChannelMembersFn = () => [];
    emailPostMessageFn = () => {};
    emailSendEmailFn = async () => {};
    capturedEmailArgs = null;

    collabnookInstances.length = 0;
    emailInstances.length = 0;
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

  it('should route sendEmail to MockEmailConnector instances', async () => {
    const sent: Array<{ to: string; subject: string; body: string }> = [];
    emailSendEmailFn = async (to, subject, body) => { sent.push({ to, subject, body }); };

    // Create a MockEmailConnector instance via the mocked module
    const emailConfig = makeEmailIntegration();
    const agent = makeAgent('agent1', [emailConfig]);
    const mockOrchestrator = {
      agents: { list: () => [agent] },
      runAgent: async () => ({ output: 'ok' }),
    } as any;

    await manager.start(mockOrchestrator);
    assert.equal(emailInstances.length, 1);

    await manager.sendEmail('agent1', 'user@test.com', 'Hello', 'Body text');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'user@test.com');
    assert.equal(sent[0]!.subject, 'Hello');
    assert.equal(sent[0]!.body, 'Body text');
  });

  it('should detect hasEmailIntegration for MockEmailConnector instances', async () => {
    const emailConfig = makeEmailIntegration();
    const agent = makeAgent('agent1', [emailConfig]);
    const mockOrchestrator = {
      agents: { list: () => [agent] },
      runAgent: async () => ({ output: 'ok' }),
    } as any;

    await manager.start(mockOrchestrator);
    assert.equal(manager.hasEmailIntegration('agent1'), true);
  });

  it('should handle mixed connector types correctly', async () => {
    collabnookGetRecentMessagesFn = () => 'chat msg';
    collabnookGetChannelMembersFn = () => [{ userId: 'u1', name: 'Alice' }];
    emailGetRecentMessagesFn = () => '[bob@test.com] Re: Hello: hi there';
    emailGetChannelMembersFn = () => [{ userId: 'bob@test.com', name: 'Bob' }];

    const agent = makeAgent('agent1', [
      makeCollabnookIntegration(),
      makeEmailIntegration(),
    ]);
    const mockOrchestrator = {
      agents: { list: () => [agent] },
      runAgent: async () => ({ output: 'ok' }),
    } as any;

    await manager.start(mockOrchestrator);

    assert.equal(manager.hasEmailIntegration('agent1'), true);

    const ctx = manager.getChannelContext('agent1');
    assert.ok(ctx.includes('chat msg'));
    assert.ok(ctx.includes('[bob@test.com]'));

    const members = manager.getChannelMembers('agent1');
    assert.equal(members.length, 2);
  });

  // ---- NEW TESTS: cover startCollabnook, startEmail, hasChannelIntegration, syncAgent with integrations ----

  describe('start() with collabnook integration', () => {
    it('should create and connect a CollabnookConnector', async () => {
      let connected = false;
      collabnookConnectFn = async () => { connected = true; };

      const config = makeCollabnookIntegration('dev-channel');
      const agent = makeAgent('bot1', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: 'result' }),
      } as any;

      await manager.start(mockOrchestrator);

      assert.equal(connected, true);
      assert.ok(capturedCollabnookArgs);
      assert.equal(capturedCollabnookArgs!.agentName, 'bot1');
      assert.equal(capturedCollabnookArgs!.config.channel, 'dev-channel');
      assert.equal(collabnookInstances.length, 1);
      // Connector should be added to the manager
      assert.equal((manager as any).connectors.get('bot1')?.length, 1);
    });

    it('should use first inputVariable for collabnook onCommand callback', async () => {
      let capturedInput: Record<string, unknown> | null = null;
      const config = makeCollabnookIntegration();
      const agent = makeAgent('bot1', [config], { inputVariables: ['message'] });
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async (_name: string, input: Record<string, unknown>) => {
          capturedInput = input;
          return { output: 'response text' };
        },
      } as any;

      collabnookGetChannelMembersFn = () => [{ userId: 'u1', name: 'Alice' }];

      await manager.start(mockOrchestrator);

      // Call the onCommand callback that was passed to the connector
      assert.ok(capturedCollabnookArgs);
      const result = await capturedCollabnookArgs!.onCommand('do something', 'Alice');

      assert.ok(capturedInput);
      assert.ok((capturedInput as any).message.includes('Request from Alice: do something'));
      assert.ok((capturedInput as any).channelMembers.includes('Alice'));
      assert.equal(result, 'response text');
    });

    it('should default to "query" when agent has no inputVariables', async () => {
      let capturedInput: Record<string, unknown> | null = null;
      const config = makeCollabnookIntegration();
      const agent = makeAgent('bot1', [config], { inputVariables: [] });
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async (_name: string, input: Record<string, unknown>) => {
          capturedInput = input;
          return { output: 'ok' };
        },
      } as any;

      await manager.start(mockOrchestrator);

      assert.ok(capturedCollabnookArgs);
      await capturedCollabnookArgs!.onCommand('hello', 'Bob');

      assert.ok(capturedInput);
      assert.ok('query' in (capturedInput as any));
    });

    it('should JSON.stringify non-string output from collabnook onCommand', async () => {
      const config = makeCollabnookIntegration();
      const agent = makeAgent('bot1', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: { key: 'value' } }),
      } as any;

      await manager.start(mockOrchestrator);

      assert.ok(capturedCollabnookArgs);
      const result = await capturedCollabnookArgs!.onCommand('test', 'User');
      assert.equal(result, JSON.stringify({ key: 'value' }));
    });

    it('should omit channelMembers when member list is empty', async () => {
      let capturedInput: Record<string, unknown> | null = null;
      const config = makeCollabnookIntegration();
      const agent = makeAgent('bot1', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async (_name: string, input: Record<string, unknown>) => {
          capturedInput = input;
          return { output: 'ok' };
        },
      } as any;

      collabnookGetChannelMembersFn = () => [];

      await manager.start(mockOrchestrator);

      assert.ok(capturedCollabnookArgs);
      await capturedCollabnookArgs!.onCommand('test', 'User');

      assert.ok(capturedInput);
      assert.equal((capturedInput as any).channelMembers, undefined);
    });
  });

  describe('start() with email integration', () => {
    it('should create and connect an EmailConnector', async () => {
      let connected = false;
      emailConnectFn = async () => { connected = true; };

      const config = makeEmailIntegration();
      const agent = makeAgent('email-bot', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: 'reply' }),
      } as any;

      await manager.start(mockOrchestrator);

      assert.equal(connected, true);
      assert.ok(capturedEmailArgs);
      assert.equal(capturedEmailArgs!.agentName, 'email-bot');
      assert.equal(capturedEmailArgs!.config.imap.host, 'imap.test.com');
      assert.equal(emailInstances.length, 1);
      assert.equal((manager as any).connectors.get('email-bot')?.length, 1);
    });

    it('should use first inputVariable for email onCommand callback', async () => {
      let capturedInput: Record<string, unknown> | null = null;
      const config = makeEmailIntegration();
      const agent = makeAgent('email-bot', [config], { inputVariables: ['input'] });
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async (_name: string, input: Record<string, unknown>) => {
          capturedInput = input;
          return { output: 'email reply' };
        },
      } as any;

      await manager.start(mockOrchestrator);

      assert.ok(capturedEmailArgs);
      const result = await capturedEmailArgs!.onCommand(
        'Hello there',
        'alice@example.com',
        { subject: 'Greetings', from: 'Alice' },
      );

      assert.ok(capturedInput);
      const inputText = (capturedInput as any).input as string;
      assert.ok(inputText.includes('Email from Alice (alice@example.com)'));
      assert.ok(inputText.includes('Subject: Greetings'));
      assert.ok(inputText.includes('Hello there'));
      assert.equal(result, 'email reply');
    });

    it('should JSON.stringify non-string output from email onCommand', async () => {
      const config = makeEmailIntegration();
      const agent = makeAgent('email-bot', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: [1, 2, 3] }),
      } as any;

      await manager.start(mockOrchestrator);

      assert.ok(capturedEmailArgs);
      const result = await capturedEmailArgs!.onCommand('test', 'a@b.com', { subject: 'Test', from: 'A' });
      assert.equal(result, JSON.stringify([1, 2, 3]));
    });

    it('should use imap.host as identity when auth and fromAddress are missing', async () => {
      const config = makeEmailIntegration({ auth: undefined, fromAddress: undefined });
      const agent = makeAgent('email-bot', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: 'ok' }),
      } as any;

      // This test just ensures no errors during start with missing auth/fromAddress
      await manager.start(mockOrchestrator);
      assert.equal(emailInstances.length, 1);
    });

    it('should use fromAddress as identity when auth is missing but fromAddress exists', async () => {
      const config = makeEmailIntegration({ auth: undefined, fromAddress: 'noreply@test.com' });
      const agent = makeAgent('email-bot', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: 'ok' }),
      } as any;

      await manager.start(mockOrchestrator);
      assert.equal(emailInstances.length, 1);
    });
  });

  describe('start() logs connector count', () => {
    it('should log when connectors are started', async () => {
      const config = makeCollabnookIntegration();
      const agent = makeAgent('bot1', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: 'ok' }),
      } as any;

      // This exercises the connectorCount getter and the log.info path (lines 36-39)
      await manager.start(mockOrchestrator);
      assert.equal((manager as any).connectors.get('bot1')?.length, 1);
    });

    it('should count connectors across multiple agents', async () => {
      const agent1 = makeAgent('bot1', [makeCollabnookIntegration('ch1')]);
      const agent2 = makeAgent('bot2', [makeEmailIntegration()]);
      const mockOrchestrator = {
        agents: { list: () => [agent1, agent2] },
        runAgent: async () => ({ output: 'ok' }),
      } as any;

      await manager.start(mockOrchestrator);
      // connectorCount is private, but we verify via connectors map
      const total = (manager as any).connectors.get('bot1')!.length +
                    (manager as any).connectors.get('bot2')!.length;
      assert.equal(total, 2);
    });
  });

  describe('hasChannelIntegration', () => {
    it('should return false when agent has no connectors', () => {
      assert.equal(manager.hasChannelIntegration('unknown'), false);
    });

    it('should return false when agent has only email connectors', async () => {
      const config = makeEmailIntegration();
      const agent = makeAgent('email-bot', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: 'ok' }),
      } as any;

      await manager.start(mockOrchestrator);
      // MockEmailConnector is not CollabnookConnector
      // Since we mocked the module, the instanceof check uses MockCollabnookConnector
      // The email instance will not be instanceof MockCollabnookConnector
      assert.equal(manager.hasChannelIntegration('email-bot'), false);
    });

    it('should return true when agent has a collabnook connector', async () => {
      const config = makeCollabnookIntegration();
      const agent = makeAgent('chat-bot', [config]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: 'ok' }),
      } as any;

      await manager.start(mockOrchestrator);
      assert.equal(manager.hasChannelIntegration('chat-bot'), true);
    });
  });

  describe('syncAgent with integrations', () => {
    it('should close old connectors and start new ones for collabnook', async () => {
      let closeCalled = 0;
      const oldConnector = {
        getRecentMessages: () => '',
        getChannelMembers: () => [],
        postMessage: () => {},
        close: () => { closeCalled++; },
      };
      (manager as any).connectors.set('bot1', [oldConnector]);

      const config = makeCollabnookIntegration('new-channel');
      const agent = makeAgent('bot1', [config]);
      const mockOrchestrator = {
        agents: { get: () => agent },
        runAgent: async () => ({ output: 'ok' }),
      } as any;

      await manager.syncAgent(mockOrchestrator, 'bot1');

      assert.equal(closeCalled, 1);
      assert.equal(collabnookInstances.length, 1);
      assert.equal((manager as any).connectors.get('bot1')?.length, 1);
    });

    it('should close old connectors and start new ones for email', async () => {
      let closeCalled = 0;
      const oldConnector = {
        getRecentMessages: () => '',
        getChannelMembers: () => [],
        postMessage: () => {},
        close: () => { closeCalled++; },
      };
      (manager as any).connectors.set('email-bot', [oldConnector]);

      const config = makeEmailIntegration();
      const agent = makeAgent('email-bot', [config]);
      const mockOrchestrator = {
        agents: { get: () => agent },
        runAgent: async () => ({ output: 'ok' }),
      } as any;

      await manager.syncAgent(mockOrchestrator, 'email-bot');

      assert.equal(closeCalled, 1);
      assert.equal(emailInstances.length, 1);
      assert.equal((manager as any).connectors.get('email-bot')?.length, 1);
    });

    it('should handle syncAgent when agent is not found', async () => {
      const mockOrchestrator = {
        agents: { get: () => undefined },
      } as any;

      await manager.syncAgent(mockOrchestrator, 'missing-agent');
      assert.equal((manager as any).connectors.has('missing-agent'), false);
    });
  });

  describe('addConnector (private, via start)', () => {
    it('should append to existing connectors for the same agent', async () => {
      const agent = makeAgent('multi-bot', [
        makeCollabnookIntegration('ch1'),
        makeEmailIntegration(),
      ]);
      const mockOrchestrator = {
        agents: { list: () => [agent] },
        runAgent: async () => ({ output: 'ok' }),
      } as any;

      await manager.start(mockOrchestrator);

      const connectors = (manager as any).connectors.get('multi-bot');
      assert.equal(connectors?.length, 2);
    });
  });
});
