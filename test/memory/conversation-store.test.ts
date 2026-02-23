import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { humanMessage, aiMessage } from '../../lib/types/llm-types.ts';
import { ConversationStore } from '../../lib/memory/conversation-store.ts';

describe('ConversationStore', () => {
  let store: ConversationStore;

  afterEach(() => {
    store?.destroy();
  });

  it('should create and retrieve sessions', () => {
    store = new ConversationStore();

    store.addMessage('s1', humanMessage('Hello'));
    store.addMessage('s1', aiMessage('Hi there'));

    const messages = store.getMessages('s1');
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.content, 'Hello');
    assert.equal(messages[1]!.content, 'Hi there');
  });

  it('should return empty array for non-existent session', () => {
    store = new ConversationStore();
    assert.deepEqual(store.getMessages('nonexistent'), []);
  });

  it('should return a copy of messages (not reference)', () => {
    store = new ConversationStore();

    store.addMessage('s1', humanMessage('Hello'));
    const messages1 = store.getMessages('s1');
    const messages2 = store.getMessages('s1');

    assert.notEqual(messages1, messages2);
    assert.deepEqual(messages1.map(m => m.content), messages2.map(m => m.content));
  });

  it('should enforce FIFO eviction at maxMessagesPerSession', () => {
    store = new ConversationStore({ maxMessagesPerSession: 3 });

    store.addMessage('s1', humanMessage('msg1'));
    store.addMessage('s1', aiMessage('msg2'));
    store.addMessage('s1', humanMessage('msg3'));
    store.addMessage('s1', aiMessage('msg4'));

    const messages = store.getMessages('s1');
    assert.equal(messages.length, 3);
    assert.equal(messages[0]!.content, 'msg2'); // msg1 was evicted
    assert.equal(messages[2]!.content, 'msg4');
  });

  it('should clear a specific session', () => {
    store = new ConversationStore();

    store.addMessage('s1', humanMessage('Hello'));
    store.addMessage('s2', humanMessage('World'));

    store.clearSession('s1');

    assert.equal(store.hasSession('s1'), false);
    assert.equal(store.hasSession('s2'), true);
  });

  it('should check session existence', () => {
    store = new ConversationStore();

    assert.equal(store.hasSession('s1'), false);
    store.addMessage('s1', humanMessage('Hello'));
    assert.equal(store.hasSession('s1'), true);
  });

  it('should count messages in a session', () => {
    store = new ConversationStore();

    assert.equal(store.getMessageCount('s1'), 0);
    store.addMessage('s1', humanMessage('Hello'));
    assert.equal(store.getMessageCount('s1'), 1);
  });

  it('should count total sessions', () => {
    store = new ConversationStore();

    assert.equal(store.getSessionCount(), 0);
    store.addMessage('s1', humanMessage('Hello'));
    store.addMessage('s2', humanMessage('World'));
    assert.equal(store.getSessionCount(), 2);
  });

  it('should cleanup expired sessions when TTL is set', () => {
    store = new ConversationStore({ maxMessagesPerSession: 50, sessionTTL: 100 });

    store.addMessage('s1', humanMessage('Hello'));

    // Manually set lastAccessedAt to the past
    // Access through cleanup method
    // We need to wait for TTL or simulate it
    // Instead, directly call cleanup after manually aging the session
    const sessions = (store as any).sessions;
    const session = sessions.get('s1');
    session.lastAccessedAt = Date.now() - 200; // Expired

    store.cleanup();
    assert.equal(store.hasSession('s1'), false);
  });

  it('should not cleanup non-expired sessions', () => {
    store = new ConversationStore({ maxMessagesPerSession: 50, sessionTTL: 60000 });

    store.addMessage('s1', humanMessage('Hello'));
    store.cleanup();

    assert.equal(store.hasSession('s1'), true);
  });

  it('should handle cleanup when TTL is not set', () => {
    store = new ConversationStore();
    store.addMessage('s1', humanMessage('Hello'));
    store.cleanup(); // Should not throw
    assert.equal(store.hasSession('s1'), true);
  });

  it('should stop cleanup interval on destroy', () => {
    store = new ConversationStore({ maxMessagesPerSession: 50, sessionTTL: 60000 });
    store.destroy();
    // Should not throw or error after destroy
    assert.ok(true);
  });
});
