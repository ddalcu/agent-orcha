import { describe, it, beforeEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';

// ---- Mock WebSocket ----
type WsHandler = (...args: any[]) => void;
let wsHandlers: Map<string, WsHandler>;
let wsSentMessages: any[];
let wsReadyState: number;
let wsCloseFn: () => void;

// WebSocket.OPEN constant
const WS_OPEN = 1;

class MockWebSocket {
  static OPEN = WS_OPEN;
  url: string;

  constructor(url: string) {
    this.url = url;
    wsHandlers = new Map();
    // Auto-trigger 'open' on next tick so connect() resolves
    setTimeout(() => {
      const openHandler = wsHandlers.get('open');
      if (openHandler) openHandler();
    }, 5);
  }

  get readyState() {
    return wsReadyState;
  }

  on(event: string, handler: WsHandler) {
    wsHandlers.set(event, handler);
  }

  send(data: string) {
    wsSentMessages.push(JSON.parse(data));
  }

  close() {
    wsCloseFn();
  }
}

mock.module('ws', {
  defaultExport: MockWebSocket,
});

// ---- Mock logger ----
mock.module('../../lib/logger.ts', {
  namedExports: {
    createLogger: (_name: string) => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
});

const { CollabnookConnector } = await import('../../lib/integrations/collabnook.ts');

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    type: 'collabnook' as const,
    url: 'wss://test.collabnook.com/ws',
    channel: 'general',
    botName: 'TestBot',
    ...overrides,
  };
}

describe('CollabnookConnector', () => {
  let connector: InstanceType<typeof CollabnookConnector>;
  let onCommandFn: (command: string, requesterName: string) => Promise<string>;

  beforeEach(() => {
    wsSentMessages = [];
    wsReadyState = WS_OPEN;
    wsCloseFn = () => {};
    onCommandFn = async () => 'response';
  });

  describe('connect()', () => {
    it('should connect and send init message on open', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      await connector.connect();

      // Should have sent 'init' message
      const initMsg = wsSentMessages.find(m => m.type === 'init');
      assert.ok(initMsg);
      assert.equal(initMsg.sessionId, null);

      connector.close();
    });
  });

  describe('close()', () => {
    it('should set closed flag and close websocket', async () => {
      let wsClosed = false;
      wsCloseFn = () => { wsClosed = true; };

      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      await connector.connect();

      connector.close();

      assert.equal((connector as any).closed, true);
      assert.equal((connector as any).ws, null);
      assert.equal(wsClosed, true);
    });

    it('should be safe to call close without connecting', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      connector.close(); // ws is null, should not throw
    });
  });

  describe('postMessage()', () => {
    it('should send a chat message', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      await connector.connect();

      connector.postMessage('Hello channel');

      const chatMsg = wsSentMessages.find(m => m.type === 'chat');
      assert.ok(chatMsg);
      assert.equal(chatMsg.text, 'Hello channel');

      connector.close();
    });
  });

  describe('getRecentMessages()', () => {
    it('should return empty string when no messages', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      assert.equal(connector.getRecentMessages(), '');
    });

    it('should return logged messages', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      (connector as any).logMessage('Alice', 'Hello');
      (connector as any).logMessage('Bob', 'Hi there');

      const messages = connector.getRecentMessages();
      assert.ok(messages.includes('[Alice]: Hello'));
      assert.ok(messages.includes('[Bob]: Hi there'));
    });
  });

  describe('getChannelMembers()', () => {
    it('should return empty array when no members', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      assert.deepEqual(connector.getChannelMembers(), []);
    });

    it('should return tracked members', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      (connector as any).members.set('Alice', 'user-1');
      (connector as any).members.set('Bob', 'user-2');

      const members = connector.getChannelMembers();
      assert.equal(members.length, 2);
      assert.ok(members.some((m: any) => m.name === 'Alice' && m.userId === 'user-1'));
      assert.ok(members.some((m: any) => m.name === 'Bob' && m.userId === 'user-2'));
    });
  });

  describe('dispatch() - message handling', () => {
    function simulateMessage(connector: any, msg: Record<string, unknown>) {
      const raw = Buffer.from(JSON.stringify(msg));
      const handler = wsHandlers.get('message');
      if (handler) handler(raw);
    }

    describe('welcome', () => {
      it('should set userId, sessionId, and send set-name and set-bot-info', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'welcome',
          userId: 'u-123',
          sessionId: 's-456',
        });

        assert.equal((connector as any).userId, 'u-123');
        assert.equal((connector as any).sessionId, 's-456');

        const setName = wsSentMessages.find(m => m.type === 'set-name');
        assert.ok(setName);
        assert.equal(setName.name, 'TestBot');

        const setBotInfo = wsSentMessages.find(m => m.type === 'set-bot-info');
        assert.ok(setBotInfo);
        assert.equal(setBotInfo.botType, 'test-agent');

        connector.close();
      });
    });

    describe('error', () => {
      it('should retry with suffixed name when NAME_TAKEN', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        wsSentMessages = [];

        simulateMessage(connector, { type: 'error', code: 'NAME_TAKEN' });

        const setName = wsSentMessages.find(m => m.type === 'set-name');
        assert.ok(setName);
        assert.equal(setName.name, 'TestBot-1');

        // Second NAME_TAKEN
        wsSentMessages = [];
        simulateMessage(connector, { type: 'error', code: 'NAME_TAKEN' });

        const setName2 = wsSentMessages.find(m => m.type === 'set-name');
        assert.ok(setName2);
        assert.equal(setName2.name, 'TestBot-2');

        connector.close();
      });

      it('should ignore non-NAME_TAKEN errors', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        wsSentMessages = [];

        simulateMessage(connector, { type: 'error', code: 'SOMETHING_ELSE' });

        assert.equal(wsSentMessages.length, 0);

        connector.close();
      });
    });

    describe('channel-list', () => {
      it('should join existing channel by name (case insensitive)', async () => {
        const config = makeConfig({ channel: 'General' });
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'channel-list',
          channels: [
            { id: 'ch-1', name: 'general' },
            { id: 'ch-2', name: 'random' },
          ],
        });

        assert.equal((connector as any).targetChannelId, 'ch-1');

        const joinMsg = wsSentMessages.find(m => m.type === 'join-channel');
        assert.ok(joinMsg);
        assert.equal(joinMsg.channelId, 'ch-1');

        const switchMsg = wsSentMessages.find(m => m.type === 'switch-channel');
        assert.ok(switchMsg);

        const getUsersMsg = wsSentMessages.find(m => m.type === 'get-users');
        assert.ok(getUsersMsg);

        connector.close();
      });

      it('should include password when joining private channel', async () => {
        const config = makeConfig({ channel: 'private-ch', password: 'secret123' });
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'channel-list',
          channels: [{ id: 'ch-priv', name: 'private-ch' }],
        });

        const joinMsg = wsSentMessages.find(m => m.type === 'join-channel');
        assert.ok(joinMsg);
        assert.equal(joinMsg.password, 'secret123');

        connector.close();
      });

      it('should create channel when not found', async () => {
        const config = makeConfig({ channel: 'new-channel' });
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'channel-list',
          channels: [{ id: 'ch-1', name: 'other' }],
        });

        assert.equal((connector as any).pendingCreate, true);

        const createMsg = wsSentMessages.find(m => m.type === 'create-channel');
        assert.ok(createMsg);
        assert.equal(createMsg.name, 'new-channel');
        assert.equal(createMsg.channelType, 'public');

        connector.close();
      });

      it('should create private channel with password when configured', async () => {
        const config = makeConfig({ channel: 'secret-ch', password: 'pass123' });
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'channel-list',
          channels: [],
        });

        const createMsg = wsSentMessages.find(m => m.type === 'create-channel');
        assert.ok(createMsg);
        assert.equal(createMsg.channelType, 'private');
        assert.equal(createMsg.password, 'pass123');

        connector.close();
      });

      it('should skip when targetChannelId is already set', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        (connector as any).targetChannelId = 'existing-ch';
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'channel-list',
          channels: [{ id: 'ch-1', name: 'general' }],
        });

        assert.equal(wsSentMessages.length, 0);

        connector.close();
      });

      it('should skip create when pendingCreate is already true', async () => {
        const config = makeConfig({ channel: 'missing' });
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        (connector as any).pendingCreate = true;
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'channel-list',
          channels: [],
        });

        assert.equal(wsSentMessages.length, 0);

        connector.close();
      });
    });

    describe('channel-joined', () => {
      it('should set targetChannelId when pendingCreate and no targetChannelId', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        (connector as any).pendingCreate = true;
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'channel-joined',
          channelId: 'new-ch-id',
          channelName: 'general',
          users: [
            { id: 'u1', name: 'Alice' },
            { id: 'u2', name: 'Bob' },
          ],
        });

        assert.equal((connector as any).targetChannelId, 'new-ch-id');
        assert.equal((connector as any).pendingCreate, false);

        // Should have sent switch-channel and get-users
        const switchMsg = wsSentMessages.find(m => m.type === 'switch-channel');
        assert.ok(switchMsg);

        // Should have tracked users
        assert.equal((connector as any).members.get('Alice'), 'u1');
        assert.equal((connector as any).members.get('Bob'), 'u2');

        connector.close();
      });

      it('should populate members from join response', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();

        simulateMessage(connector, {
          type: 'channel-joined',
          channelId: 'ch-1',
          channelName: 'general',
          users: [{ id: 'u1', name: 'Charlie' }],
        });

        assert.equal((connector as any).members.get('Charlie'), 'u1');

        connector.close();
      });

      it('should handle channel-joined without users array', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();

        simulateMessage(connector, {
          type: 'channel-joined',
          channelId: 'ch-1',
          channelName: 'general',
        });

        // Should not throw
        assert.equal((connector as any).members.size, 0);

        connector.close();
      });
    });

    describe('user-joined', () => {
      it('should add member to the map', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();

        simulateMessage(connector, {
          type: 'user-joined',
          name: 'NewUser',
          userId: 'u-new',
        });

        assert.equal((connector as any).members.get('NewUser'), 'u-new');

        connector.close();
      });

      it('should not add if name or userId is missing', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();

        simulateMessage(connector, {
          type: 'user-joined',
          name: null,
          userId: 'u-1',
        });

        assert.equal((connector as any).members.size, 0);

        connector.close();
      });
    });

    describe('user-left', () => {
      it('should remove member from the map', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();

        (connector as any).members.set('LeavingUser', 'u-leave');

        simulateMessage(connector, {
          type: 'user-left',
          name: 'LeavingUser',
        });

        assert.equal((connector as any).members.has('LeavingUser'), false);

        connector.close();
      });
    });

    describe('user-list', () => {
      it('should populate members from user list', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();

        simulateMessage(connector, {
          type: 'user-list',
          users: [
            { id: 'u1', name: 'Alice' },
            { id: 'u2', name: 'Bob' },
          ],
        });

        assert.equal((connector as any).members.size, 2);
        assert.equal((connector as any).members.get('Alice'), 'u1');
        assert.equal((connector as any).members.get('Bob'), 'u2');

        connector.close();
      });

      it('should handle missing users array', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();

        simulateMessage(connector, { type: 'user-list' });

        assert.equal((connector as any).members.size, 0);

        connector.close();
      });

      it('should skip users with missing name or id', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();

        simulateMessage(connector, {
          type: 'user-list',
          users: [
            { id: 'u1', name: '' },
            { id: '', name: 'Bob' },
            { id: 'u3', name: 'Charlie' },
          ],
        });

        // Empty strings are falsy, so only Charlie should be added
        assert.equal((connector as any).members.size, 1);
        assert.equal((connector as any).members.get('Charlie'), 'u3');

        connector.close();
      });
    });

    describe('chat', () => {
      it('should track sender as member', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        (connector as any).userId = 'bot-id';

        simulateMessage(connector, {
          type: 'chat',
          name: 'Alice',
          userId: 'u-alice',
          text: 'Hello',
        });

        assert.equal((connector as any).members.get('Alice'), 'u-alice');

        connector.close();
      });

      it('should ignore own messages', async () => {
        const config = makeConfig();
        let commandCalled = false;
        connector = new CollabnookConnector(config, 'test-agent', async () => {
          commandCalled = true;
          return 'ok';
        });
        await connector.connect();
        (connector as any).userId = 'bot-id';

        simulateMessage(connector, {
          type: 'chat',
          name: 'TestBot',
          userId: 'bot-id',
          text: 'my own message',
          mentions: [{ userId: 'bot-id' }],
        });

        await new Promise(r => setTimeout(r, 20));
        assert.equal(commandCalled, false);

        connector.close();
      });

      it('should ignore messages without bot mention', async () => {
        const config = makeConfig();
        let commandCalled = false;
        connector = new CollabnookConnector(config, 'test-agent', async () => {
          commandCalled = true;
          return 'ok';
        });
        await connector.connect();
        (connector as any).userId = 'bot-id';

        simulateMessage(connector, {
          type: 'chat',
          name: 'Alice',
          userId: 'u-alice',
          text: 'Hello everyone',
          mentions: [{ userId: 'other-user' }],
        });

        await new Promise(r => setTimeout(r, 20));
        assert.equal(commandCalled, false);

        connector.close();
      });

      it('should ignore messages with no mentions', async () => {
        const config = makeConfig();
        let commandCalled = false;
        connector = new CollabnookConnector(config, 'test-agent', async () => {
          commandCalled = true;
          return 'ok';
        });
        await connector.connect();
        (connector as any).userId = 'bot-id';

        simulateMessage(connector, {
          type: 'chat',
          name: 'Alice',
          userId: 'u-alice',
          text: 'Hello bot',
        });

        await new Promise(r => setTimeout(r, 20));
        assert.equal(commandCalled, false);

        connector.close();
      });

      it('should respond with default message when command is empty after stripping mentions', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        (connector as any).userId = 'bot-id';
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'chat',
          name: 'Alice',
          userId: 'u-alice',
          text: '@TestBot',
          mentions: [{ userId: 'bot-id' }],
        });

        const chatMsg = wsSentMessages.find(m => m.type === 'chat' && m.text === 'What would you like me to do?');
        assert.ok(chatMsg);

        connector.close();
      });

      it('should process valid commands via onCommand', async () => {
        const config = makeConfig();
        const commands: string[] = [];
        connector = new CollabnookConnector(config, 'test-agent', async (cmd, requester) => {
          commands.push(cmd);
          return `Done: ${cmd}`;
        });
        await connector.connect();
        (connector as any).userId = 'bot-id';
        wsSentMessages = [];

        simulateMessage(connector, {
          type: 'chat',
          name: 'Alice',
          userId: 'u-alice',
          text: '@TestBot do something',
          mentions: [{ userId: 'bot-id' }],
        });

        await new Promise(r => setTimeout(r, 50));

        assert.equal(commands.length, 1);
        assert.equal(commands[0], 'do something');

        // Should have sent a reply
        const reply = wsSentMessages.find(m => m.type === 'chat' && m.text === 'Done: do something');
        assert.ok(reply);

        connector.close();
      });

      it('should log all messages including own', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();
        (connector as any).userId = 'bot-id';

        simulateMessage(connector, {
          type: 'chat',
          name: 'TestBot',
          userId: 'bot-id',
          text: 'I said something',
        });

        const messages = connector.getRecentMessages();
        assert.ok(messages.includes('[TestBot]: I said something'));

        connector.close();
      });
    });

    describe('malformed message', () => {
      it('should handle parse errors gracefully', async () => {
        const config = makeConfig();
        connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
        await connector.connect();

        const handler = wsHandlers.get('message');
        assert.ok(handler);

        // Send invalid JSON
        handler(Buffer.from('not json'));

        // Should not throw
        connector.close();
      });
    });
  });

  describe('send() (private)', () => {
    it('should not send when ws is null', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      // ws is null, should not throw
      (connector as any).send({ type: 'test' });
    });

    it('should not send when ws is not OPEN', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      await connector.connect();

      wsReadyState = 3; // CLOSED
      wsSentMessages = [];

      (connector as any).send({ type: 'test' });
      assert.equal(wsSentMessages.length, 0);

      connector.close();
    });
  });

  describe('resolveMentions() (private)', () => {
    it('should resolve @mentions to userIds', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      (connector as any).members.set('Alice', 'u-alice');
      (connector as any).members.set('Bob', 'u-bob');

      const mentions = (connector as any).resolveMentions('Hey @Alice and @Bob!');
      assert.equal(mentions.length, 2);
      assert.ok(mentions.some((m: any) => m.userId === 'u-alice'));
      assert.ok(mentions.some((m: any) => m.userId === 'u-bob'));
    });

    it('should skip unknown mentions', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      (connector as any).members.set('Alice', 'u-alice');

      const mentions = (connector as any).resolveMentions('@Alice @UnknownUser');
      assert.equal(mentions.length, 1);
      assert.equal(mentions[0].userId, 'u-alice');
    });

    it('should deduplicate mentions', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      (connector as any).members.set('Alice', 'u-alice');

      const mentions = (connector as any).resolveMentions('@Alice please @Alice');
      assert.equal(mentions.length, 1);
    });

    it('should return empty array when no mentions', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      const mentions = (connector as any).resolveMentions('no mentions here');
      assert.equal(mentions.length, 0);
    });
  });

  describe('sendChat() with mentions', () => {
    it('should include resolved mentions in chat message', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      await connector.connect();

      (connector as any).members.set('Alice', 'u-alice');
      wsSentMessages = [];

      (connector as any).sendChat('Hey @Alice check this');

      const chatMsg = wsSentMessages.find(m => m.type === 'chat');
      assert.ok(chatMsg);
      assert.equal(chatMsg.text, 'Hey @Alice check this');
      assert.ok(chatMsg.mentions);
      assert.equal(chatMsg.mentions.length, 1);
      assert.equal(chatMsg.mentions[0].userId, 'u-alice');

      connector.close();
    });

    it('should not include mentions field when no mentions resolved', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      await connector.connect();
      wsSentMessages = [];

      (connector as any).sendChat('Hello everyone');

      const chatMsg = wsSentMessages.find(m => m.type === 'chat');
      assert.ok(chatMsg);
      assert.equal(chatMsg.mentions, undefined);

      connector.close();
    });
  });

  describe('enqueue() and task processing', () => {
    it('should queue tasks when busy and process them sequentially', async () => {
      const config = makeConfig();
      const commands: string[] = [];
      connector = new CollabnookConnector(config, 'test-agent', async (cmd) => {
        commands.push(cmd);
        await new Promise(r => setTimeout(r, 30));
        return `Done: ${cmd}`;
      });
      await connector.connect();
      wsSentMessages = [];

      (connector as any).enqueue('first', 'Alice');
      (connector as any).enqueue('second', 'Bob');

      assert.equal((connector as any).taskQueue.length, 1);

      // Should have sent a queued message
      const queueMsg = wsSentMessages.find(m =>
        m.type === 'chat' && m.text.includes('Queued')
      );
      assert.ok(queueMsg);

      await new Promise(r => setTimeout(r, 150));

      assert.equal(commands.length, 2);
      assert.equal(commands[0], 'first');
      assert.equal(commands[1], 'second');

      connector.close();
    });

    it('should handle errors in onCommand and send error message', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', async () => {
        throw new Error('Agent failed');
      });
      await connector.connect();
      wsSentMessages = [];

      (connector as any).enqueue('fail task', 'Alice');

      await new Promise(r => setTimeout(r, 50));

      const errorMsg = wsSentMessages.find(m =>
        m.type === 'chat' && m.text.includes('Task failed')
      );
      assert.ok(errorMsg);
      assert.ok(errorMsg.text.includes('Agent failed'));

      assert.equal((connector as any).busy, false);

      connector.close();
    });

    it('should apply replyDelay when configured', async () => {
      const config = makeConfig({ replyDelay: 10 });
      const start = Date.now();
      connector = new CollabnookConnector(config, 'test-agent', async () => 'ok');
      await connector.connect();

      (connector as any).enqueue('delayed task', 'Alice');

      await new Promise(r => setTimeout(r, 50));

      // Verify it completed (delay was applied but small)
      assert.equal((connector as any).busy, false);

      connector.close();
    });
  });

  describe('splitMessage() (private)', () => {
    it('should return single item for short messages', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      const chunks = (connector as any).splitMessage('short', 100);
      assert.deepEqual(chunks, ['short']);
    });

    it('should split long messages into chunks', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      const long = 'a'.repeat(25);
      const chunks = (connector as any).splitMessage(long, 10);
      assert.equal(chunks.length, 3);
      assert.equal(chunks[0], 'a'.repeat(10));
      assert.equal(chunks[1], 'a'.repeat(10));
      assert.equal(chunks[2], 'a'.repeat(5));
    });
  });

  describe('formatDuration() (private)', () => {
    it('should format milliseconds', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      assert.equal((connector as any).formatDuration(500), '500ms');
    });

    it('should format seconds', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      assert.equal((connector as any).formatDuration(5000), '5s');
    });

    it('should format minutes and seconds', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      assert.equal((connector as any).formatDuration(90000), '1m 30s');
    });
  });

  describe('logMessage() (private)', () => {
    it('should evict old messages when exceeding MAX_MESSAGE_LOG_CHARS', () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);

      for (let i = 0; i < 100; i++) {
        (connector as any).logMessage(`User${i}`, 'A'.repeat(100));
      }

      const messages = connector.getRecentMessages();
      assert.ok(messages.length <= 4500);
      assert.ok((connector as any).messageLog.length < 100);
    });
  });

  describe('doConnect() reconnect on close', () => {
    it('should not reconnect when closed', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      await connector.connect();

      connector.close();

      // Trigger the 'close' event handler
      const closeHandler = wsHandlers.get('close');
      if (closeHandler) closeHandler();

      // Should not attempt reconnect since closed=true
      assert.equal((connector as any).ws, null);
    });
  });

  describe('ws error event', () => {
    it('should handle WebSocket errors gracefully', async () => {
      const config = makeConfig();
      connector = new CollabnookConnector(config, 'test-agent', onCommandFn);
      await connector.connect();

      const errorHandler = wsHandlers.get('error');
      assert.ok(errorHandler);

      // Should not throw
      errorHandler(new Error('Connection reset'));

      connector.close();
    });
  });
});
