import { describe, it, beforeEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';

// ---- Mock nodemailer ----
let smtpSendMailFn: (opts: any) => Promise<any>;
let smtpCloseFn: () => void;
const capturedTransportOpts: any[] = [];

mock.module('nodemailer', {
  defaultExport: {
    createTransport(opts: any) {
      capturedTransportOpts.push(opts);
      return {
        sendMail: (mailOpts: any) => smtpSendMailFn(mailOpts),
        close: () => smtpCloseFn(),
      };
    },
  },
});

// ---- Mock imapflow ----
let imapConnectFn: () => Promise<void>;
let imapLogoutFn: () => Promise<void>;
let imapCloseFn: () => void;
let imapGetMailboxLockFn: (folder: string) => Promise<{ release: () => void }>;
let imapSearchFn: (criteria: any, opts: any) => Promise<number[]>;
let imapFetchFn: (uids: number[], opts: any) => AsyncIterable<any>;
let imapMessageFlagsAddFn: (uids: number[], flags: string[], opts: any) => Promise<void>;
let imapOnFn: (event: string, handler: Function) => void;

class MockImapFlow {
  constructor(_opts: any) {}
  on(event: string, handler: Function) { imapOnFn(event, handler); }
  connect() { return imapConnectFn(); }
  logout() { return imapLogoutFn(); }
  close() { return imapCloseFn(); }
  getMailboxLock(folder: string) { return imapGetMailboxLockFn(folder); }
  search(criteria: any, opts: any) { return imapSearchFn(criteria, opts); }
  fetch(uids: number[], opts: any) { return imapFetchFn(uids, opts); }
  messageFlagsAdd(uids: number[], flags: string[], opts: any) { return imapMessageFlagsAddFn(uids, flags, opts); }
}

mock.module('imapflow', {
  namedExports: {
    ImapFlow: MockImapFlow,
  },
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

const { EmailConnector } = await import('../../lib/integrations/email.ts');

function makeConfig(overrides: Record<string, any> = {}) {
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

describe('EmailConnector', () => {
  let connector: InstanceType<typeof EmailConnector>;
  let onCommandFn: (body: string, senderEmail: string, meta: any) => Promise<string>;
  let sentEmails: any[];

  beforeEach(() => {
    sentEmails = [];
    smtpSendMailFn = async (opts) => { sentEmails.push(opts); };
    smtpCloseFn = () => {};
    capturedTransportOpts.length = 0;

    imapConnectFn = async () => {};
    imapLogoutFn = async () => {};
    imapCloseFn = () => {};
    imapGetMailboxLockFn = async () => ({ release: () => {} });
    imapSearchFn = async () => [];
    imapFetchFn = async function* () {};
    imapMessageFlagsAddFn = async () => {};
    imapOnFn = () => {};

    onCommandFn = async () => 'reply text';
  });

  describe('connect()', () => {
    it('should create SMTP transport with auth', async () => {
      const config = makeConfig();
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      // Disable polling to avoid timer issues
      (connector as any).config.polling = false;
      await connector.connect();

      assert.equal(capturedTransportOpts.length, 1);
      assert.equal(capturedTransportOpts[0].host, 'smtp.test.com');
      assert.equal(capturedTransportOpts[0].port, 587);
      assert.deepEqual(capturedTransportOpts[0].auth, { user: 'bot@test.com', pass: 'secret' });

      connector.close();
    });

    it('should create SMTP transport without auth when not provided', async () => {
      const config = makeConfig({ auth: undefined });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      (connector as any).config.polling = false;
      await connector.connect();

      assert.equal(capturedTransportOpts.length, 1);
      assert.equal(capturedTransportOpts[0].auth, undefined);

      connector.close();
    });

    it('should start poll timer when polling is enabled', async () => {
      const config = makeConfig({ pollInterval: 30 });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      await connector.connect();

      assert.notEqual((connector as any).pollTimer, null);

      connector.close();
    });

    it('should not start poll timer when polling is disabled', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      await connector.connect();

      assert.equal((connector as any).pollTimer, null);

      connector.close();
    });
  });

  describe('close()', () => {
    it('should set closed flag and clear timer and smtp', async () => {
      const config = makeConfig();
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      await connector.connect();

      connector.close();

      assert.equal((connector as any).closed, true);
      assert.equal((connector as any).pollTimer, null);
      assert.equal((connector as any).smtp, null);
    });

    it('should be safe to call close multiple times', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      connector.close();
      connector.close(); // should not throw
    });
  });

  describe('sendEmail()', () => {
    it('should send email with correct options', async () => {
      const config = makeConfig({ fromName: 'Agent Bot' });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      (connector as any).config.polling = false;
      await connector.connect();

      await connector.sendEmail('user@example.com', 'Hello', 'Body text');

      assert.equal(sentEmails.length, 1);
      assert.equal(sentEmails[0].to, 'user@example.com');
      assert.equal(sentEmails[0].subject, 'Hello');
      assert.equal(sentEmails[0].text, 'Body text');
      assert.equal(sentEmails[0].from, '"Agent Bot" <bot@test.com>');

      connector.close();
    });

    it('should use fromAddress without fromName', async () => {
      const config = makeConfig({ fromName: undefined, fromAddress: 'noreply@test.com' });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      (connector as any).config.polling = false;
      await connector.connect();

      await connector.sendEmail('user@test.com', 'Test', 'Body');

      assert.equal(sentEmails[0].from, 'noreply@test.com');

      connector.close();
    });

    it('should fall back to auth user when no fromAddress', async () => {
      const config = makeConfig({ fromAddress: undefined, fromName: undefined });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      (connector as any).config.polling = false;
      await connector.connect();

      await connector.sendEmail('user@test.com', 'Test', 'Body');

      assert.equal(sentEmails[0].from, 'bot@test.com');

      connector.close();
    });

    it('should fall back to agent@localhost when no auth and no fromAddress', async () => {
      const config = makeConfig({ auth: undefined, fromAddress: undefined, fromName: undefined });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      (connector as any).config.polling = false;
      await connector.connect();

      await connector.sendEmail('user@test.com', 'Test', 'Body');

      assert.equal(sentEmails[0].from, 'agent@localhost');

      connector.close();
    });

    it('should include inReplyTo and references when provided', async () => {
      const config = makeConfig();
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      (connector as any).config.polling = false;
      await connector.connect();

      await connector.sendEmail('user@test.com', 'Re: Test', 'Reply body', '<msg-123@test.com>');

      assert.equal(sentEmails[0].inReplyTo, '<msg-123@test.com>');
      assert.equal(sentEmails[0].references, '<msg-123@test.com>');

      connector.close();
    });

    it('should do nothing when smtp is null', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      // Don't connect — smtp is null
      await connector.sendEmail('user@test.com', 'Test', 'Body');

      assert.equal(sentEmails.length, 0);
    });
  });

  describe('postMessage()', () => {
    it('should be a no-op', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      connector.postMessage('hello'); // should not throw
    });
  });

  describe('getRecentMessages()', () => {
    it('should return empty string when no messages', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      assert.equal(connector.getRecentMessages(), '');
    });

    it('should return logged messages joined by newlines', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      // Use the private logMessage method
      (connector as any).logMessage('Alice', 'Hi', 'Hello there');
      (connector as any).logMessage('Bob', 'Re: Hi', 'Hey');

      const messages = connector.getRecentMessages();
      assert.ok(messages.includes('[Alice] Hi: Hello there'));
      assert.ok(messages.includes('[Bob] Re: Hi: Hey'));
    });
  });

  describe('getChannelMembers()', () => {
    it('should return empty array when no senders known', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      assert.deepEqual(connector.getChannelMembers(), []);
    });

    it('should return known senders as members', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      (connector as any).senders.set('alice@test.com', 'Alice');
      (connector as any).senders.set('bob@test.com', '');

      const members = connector.getChannelMembers();
      assert.equal(members.length, 2);

      const alice = members.find((m: any) => m.userId === 'alice@test.com');
      assert.ok(alice);
      assert.equal(alice!.name, 'Alice');

      const bob = members.find((m: any) => m.userId === 'bob@test.com');
      assert.ok(bob);
      assert.equal(bob!.name, 'bob@test.com'); // falls back to email
    });
  });

  describe('extractTextBody() (private)', () => {
    it('should extract plain body from simple email', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      const source = Buffer.from('Subject: Test\r\nFrom: a@b.com\r\n\r\nHello world');
      const body = (connector as any).extractTextBody(source);
      assert.equal(body, 'Hello world');
    });

    it('should return raw text when no header separator found', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      const source = Buffer.from('No headers here just text');
      const body = (connector as any).extractTextBody(source);
      assert.equal(body, 'No headers here just text');
    });

    it('should extract text/plain from multipart email', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      const raw = [
        'Content-Type: multipart/alternative; boundary="abc123"',
        '',
        '--abc123',
        'Content-Type: text/plain',
        '',
        'Plain text body',
        '--abc123',
        'Content-Type: text/html',
        '',
        '<p>HTML body</p>',
        '--abc123--',
      ].join('\r\n');

      const body = (connector as any).extractTextBody(Buffer.from(raw));
      assert.equal(body, 'Plain text body');
    });

    it('should decode base64 content', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      const encoded = Buffer.from('Hello decoded').toString('base64');
      const raw = [
        'Content-Type: multipart/alternative; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain',
        'Content-Transfer-Encoding: base64',
        '',
        encoded,
        '--b1--',
      ].join('\r\n');

      const body = (connector as any).extractTextBody(Buffer.from(raw));
      assert.equal(body, 'Hello decoded');
    });

    it('should decode quoted-printable content', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      const raw = [
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Hello=20World=0ALine2',
      ].join('\r\n');

      const body = (connector as any).extractTextBody(Buffer.from(raw));
      assert.equal(body, 'Hello World\nLine2');
    });

    it('should handle quoted-printable soft line breaks', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      const decoded = (connector as any).decodeBody('long=\r\nline', 'content-transfer-encoding: quoted-printable');
      assert.equal(decoded, 'longline');
    });
  });

  describe('logMessage() (private)', () => {
    it('should truncate long message bodies in the preview', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      const longBody = 'x'.repeat(300);
      (connector as any).logMessage('Sender', 'Subject', longBody);

      const messages = connector.getRecentMessages();
      assert.ok(messages.includes('...'));
      assert.ok(messages.length < 300);
    });

    it('should evict old messages when exceeding MAX_MESSAGE_LOG_CHARS', () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      // Add many messages to exceed the 4000 char limit
      for (let i = 0; i < 100; i++) {
        (connector as any).logMessage(`Sender${i}`, `Subject ${i}`, 'A'.repeat(100));
      }

      const messages = connector.getRecentMessages();
      assert.ok(messages.length <= 4500); // some tolerance for last message
      assert.ok((connector as any).messageLog.length < 100);
    });
  });

  describe('poll() (private)', () => {
    it('should skip polling when closed', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      (connector as any).closed = true;

      await (connector as any).poll();
      // Should return immediately without error
    });

    it('should skip polling when already polling', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      (connector as any).polling = true;

      await (connector as any).poll();
      // Should return immediately without error
    });

    it('should handle empty search results', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      imapSearchFn = async () => [];
      let lockReleased = false;
      imapGetMailboxLockFn = async () => ({ release: () => { lockReleased = true; } });

      await (connector as any).poll();

      assert.equal(lockReleased, true);
      assert.equal((connector as any).polling, false);
    });

    it('should process messages and mark them as seen', async () => {
      const config = makeConfig({ polling: false });
      const commandCalls: any[] = [];
      connector = new EmailConnector(config, 'test-agent', async (body, sender, meta) => {
        commandCalls.push({ body, sender, meta });
        return 'reply';
      });

      imapSearchFn = async () => [1];
      imapGetMailboxLockFn = async () => ({ release: () => {} });

      const emailSource = Buffer.from(
        'Subject: Test\r\nFrom: alice@test.com\r\n\r\nHello agent'
      );

      const messages = [
        {
          uid: 1,
          envelope: {
            from: [{ address: 'alice@test.com', name: 'Alice' }],
            subject: 'Test Subject',
            messageId: '<msg-1@test.com>',
          },
          source: emailSource,
        },
      ];

      imapFetchFn = async function* () {
        for (const msg of messages) yield msg;
      };

      let flaggedUids: number[] = [];
      imapMessageFlagsAddFn = async (uids) => { flaggedUids = uids as number[]; };

      await (connector as any).poll();

      // Wait for async executeTask to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      assert.deepEqual(flaggedUids, [1]);
      assert.equal((connector as any).polling, false);

      // Verify sender was tracked
      const members = connector.getChannelMembers();
      assert.ok(members.some((m: any) => m.userId === 'alice@test.com'));
    });

    it('should skip messages without envelope', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      imapSearchFn = async () => [1];
      imapGetMailboxLockFn = async () => ({ release: () => {} });

      imapFetchFn = async function* () {
        yield { uid: 1, envelope: null, source: Buffer.from('test') };
      };

      let flagsCalled = false;
      imapMessageFlagsAddFn = async () => { flagsCalled = true; };

      await (connector as any).poll();

      assert.equal(flagsCalled, false); // no pending messages
    });

    it('should skip messages without source', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      imapSearchFn = async () => [1];
      imapGetMailboxLockFn = async () => ({ release: () => {} });

      imapFetchFn = async function* () {
        yield {
          uid: 1,
          envelope: {
            from: [{ address: 'a@b.com', name: 'A' }],
            subject: 'Test',
            messageId: '<1>',
          },
          source: null,
        };
      };

      let flagsCalled = false;
      imapMessageFlagsAddFn = async () => { flagsCalled = true; };

      await (connector as any).poll();

      assert.equal(flagsCalled, false);
    });

    it('should handle IMAP connection errors gracefully', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      imapConnectFn = async () => { throw new Error('Connection refused'); };

      await (connector as any).poll();

      assert.equal((connector as any).polling, false);
    });

    it('should call imap.close() when logout fails', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      imapSearchFn = async () => [];
      imapGetMailboxLockFn = async () => ({ release: () => {} });
      imapLogoutFn = async () => { throw new Error('Logout failed'); };

      let closeCalled = false;
      imapCloseFn = () => { closeCalled = true; };

      await (connector as any).poll();

      assert.equal(closeCalled, true);
      assert.equal((connector as any).polling, false);
    });

    it('should handle missing from address in envelope', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      imapSearchFn = async () => [1];
      imapGetMailboxLockFn = async () => ({ release: () => {} });

      imapFetchFn = async function* () {
        yield {
          uid: 1,
          envelope: {
            from: [{}],
            subject: null,
            messageId: null,
          },
          source: Buffer.from('Headers\r\n\r\nBody'),
        };
      };

      imapMessageFlagsAddFn = async () => {};

      await (connector as any).poll();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should use 'unknown' as sender and '(no subject)' as subject
      const members = connector.getChannelMembers();
      assert.ok(members.some((m: any) => m.userId === 'unknown'));
    });

    it('should pass IMAP auth when config has auth', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      imapSearchFn = async () => [];
      imapGetMailboxLockFn = async () => ({ release: () => {} });

      await (connector as any).poll();
      // No assertion needed — just verifying no error with auth present
      assert.equal((connector as any).polling, false);
    });

    it('should work without IMAP auth', async () => {
      const config = makeConfig({ auth: undefined, polling: false });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);

      imapSearchFn = async () => [];
      imapGetMailboxLockFn = async () => ({ release: () => {} });

      await (connector as any).poll();
      assert.equal((connector as any).polling, false);
    });
  });

  describe('enqueue() and task processing', () => {
    it('should execute task immediately when not busy', async () => {
      const config = makeConfig({ polling: false });
      const commandCalls: string[] = [];
      connector = new EmailConnector(config, 'test-agent', async (body) => {
        commandCalls.push(body);
        return 'ok';
      });
      (connector as any).config.polling = false;
      await connector.connect();

      const meta = { subject: 'Test', from: 'Alice', messageId: '<1>' };
      (connector as any).enqueue('hello', 'alice@test.com', meta);

      await new Promise(resolve => setTimeout(resolve, 50));

      assert.equal(commandCalls.length, 1);
      assert.equal(commandCalls[0], 'hello');

      connector.close();
    });

    it('should queue tasks when busy and process them sequentially', async () => {
      const config = makeConfig({ polling: false });
      const commandCalls: string[] = [];
      connector = new EmailConnector(config, 'test-agent', async (body) => {
        commandCalls.push(body);
        await new Promise(r => setTimeout(r, 30));
        return 'ok';
      });
      (connector as any).config.polling = false;
      await connector.connect();

      const meta1 = { subject: 'T1', from: 'Alice', messageId: '<1>' };
      const meta2 = { subject: 'T2', from: 'Bob', messageId: '<2>' };

      (connector as any).enqueue('first', 'alice@test.com', meta1);
      (connector as any).enqueue('second', 'bob@test.com', meta2);

      assert.equal((connector as any).taskQueue.length, 1);

      await new Promise(resolve => setTimeout(resolve, 150));

      assert.equal(commandCalls.length, 2);
      assert.equal(commandCalls[0], 'first');
      assert.equal(commandCalls[1], 'second');

      connector.close();
    });

    it('should handle errors in onCommand gracefully', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', async () => {
        throw new Error('Agent error');
      });
      (connector as any).config.polling = false;
      await connector.connect();

      const meta = { subject: 'Test', from: 'Alice', messageId: '<1>' };
      (connector as any).enqueue('hello', 'alice@test.com', meta);

      await new Promise(resolve => setTimeout(resolve, 50));

      // Should not throw, busy should be reset
      assert.equal((connector as any).busy, false);

      connector.close();
    });

    it('should prepend Re: to subject when not already present', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', async () => 'reply');
      (connector as any).config.polling = false;
      await connector.connect();

      const meta = { subject: 'Hello', from: 'Alice', messageId: '<1>' };
      (connector as any).enqueue('hello', 'alice@test.com', meta);

      await new Promise(resolve => setTimeout(resolve, 50));

      assert.equal(sentEmails.length, 1);
      assert.equal(sentEmails[0].subject, 'Re: Hello');

      connector.close();
    });

    it('should not double prepend Re: to subject', async () => {
      const config = makeConfig({ polling: false });
      connector = new EmailConnector(config, 'test-agent', async () => 'reply');
      (connector as any).config.polling = false;
      await connector.connect();

      const meta = { subject: 'Re: Hello', from: 'Alice', messageId: '<1>' };
      (connector as any).enqueue('hello', 'alice@test.com', meta);

      await new Promise(resolve => setTimeout(resolve, 50));

      assert.equal(sentEmails[0].subject, 'Re: Hello');

      connector.close();
    });
  });

  describe('connect() port warning', () => {
    it('should warn when port 993 is used without secure', async () => {
      const config = makeConfig({
        imap: { host: 'imap.test.com', port: 993, secure: false },
        polling: false,
      });
      connector = new EmailConnector(config, 'test-agent', onCommandFn);
      // This should not throw, just warn
      await connector.connect();
      connector.close();
    });
  });
});
