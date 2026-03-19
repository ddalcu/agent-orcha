import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { Duplex, PassThrough } from 'stream';
import { P2PProtocol } from '../../lib/p2p/p2p-protocol.ts';
import type { P2PMessage, HandshakeMessage, CatalogMessage, StreamMessage, LLMInvokeMessage, LLMStreamMessage, LLMStreamEndMessage, LLMStreamErrorMessage } from '../../lib/p2p/types.ts';

/**
 * Creates a pair of connected Duplex streams.
 * Writing to streamA delivers data to streamB's read side, and vice versa.
 */
function createSocketPair(): [Duplex, Duplex] {
  // Two PassThroughs act as the "wire" in each direction
  const aToB = new PassThrough();
  const bToA = new PassThrough();

  // streamA: write goes into aToB, read comes from bToA
  const streamA = new Duplex({
    read() {},
    write(chunk, encoding, cb) { aToB.write(chunk, encoding, cb); },
    final(cb) { aToB.end(cb); },
  });
  bToA.on('data', (d) => streamA.push(d));
  bToA.on('end', () => streamA.push(null));

  // streamB: write goes into bToA, read comes from aToB
  const streamB = new Duplex({
    read() {},
    write(chunk, encoding, cb) { bToA.write(chunk, encoding, cb); },
    final(cb) { bToA.end(cb); },
  });
  aToB.on('data', (d) => streamB.push(d));
  aToB.on('end', () => streamB.push(null));

  return [streamA, streamB];
}

describe('P2PProtocol', () => {
  let socketA: Duplex;
  let socketB: Duplex;
  let protoA: P2PProtocol;
  let protoB: P2PProtocol;

  beforeEach(() => {
    [socketA, socketB] = createSocketPair();
    protoA = new P2PProtocol(socketA as any);
    protoB = new P2PProtocol(socketB as any);
  });

  describe('send and receive', () => {
    it('should send and receive a handshake message', async () => {
      const received: P2PMessage[] = [];
      protoB.on('handshake', (msg) => received.push(msg));

      const handshake: HandshakeMessage = {
        type: 'handshake',
        peerId: 'peer-123',
        peerName: 'test-peer',
        version: '1.0.0',
        agents: [{ name: 'agent-a', description: 'Test agent', inputVariables: ['input'] }],
      };

      protoA.send(handshake);

      // Allow the pipe to flush
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const msg = received[0] as HandshakeMessage;
      assert.equal(msg.type, 'handshake');
      assert.equal(msg.peerId, 'peer-123');
      assert.equal(msg.peerName, 'test-peer');
      assert.equal(msg.agents.length, 1);
      assert.equal(msg.agents[0]!.name, 'agent-a');
    });

    it('should send and receive a catalog message', async () => {
      const received: P2PMessage[] = [];
      protoB.on('catalog', (msg) => received.push(msg));

      const catalog: CatalogMessage = {
        type: 'catalog',
        agents: [
          { name: 'a1', description: 'Agent 1', inputVariables: ['q'] },
          { name: 'a2', description: 'Agent 2', inputVariables: ['q'], sampleQuestions: ['hi'] },
        ],
      };

      protoA.send(catalog);
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const msg = received[0] as CatalogMessage;
      assert.equal(msg.agents.length, 2);
      assert.equal(msg.agents[1]!.sampleQuestions![0], 'hi');
    });

    it('should send and receive stream messages', async () => {
      const received: P2PMessage[] = [];
      protoB.on('stream', (msg) => received.push(msg));

      const stream: StreamMessage = {
        type: 'stream',
        requestId: 'req-1',
        chunk: { type: 'content', content: 'Hello world' },
      };

      protoA.send(stream);
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const msg = received[0] as StreamMessage;
      assert.equal(msg.requestId, 'req-1');
      assert.deepEqual(msg.chunk, { type: 'content', content: 'Hello world' });
    });
  });

  describe('message routing', () => {
    it('should route messages to type-specific handlers', async () => {
      const handshakes: P2PMessage[] = [];
      const catalogs: P2PMessage[] = [];
      protoB.on('handshake', (msg) => handshakes.push(msg));
      protoB.on('catalog', (msg) => catalogs.push(msg));

      protoA.send({ type: 'handshake', peerId: 'p1', peerName: 'n1', version: '1.0.0', agents: [] });
      protoA.send({ type: 'catalog', agents: [{ name: 'x', description: 'x', inputVariables: [] }] });
      protoA.send({ type: 'handshake', peerId: 'p2', peerName: 'n2', version: '1.0.0', agents: [] });

      await new Promise(r => setTimeout(r, 10));

      assert.equal(handshakes.length, 2);
      assert.equal(catalogs.length, 1);
    });

    it('should call onAny handler for all message types', async () => {
      const all: P2PMessage[] = [];
      protoB.onAny((msg) => all.push(msg));

      protoA.send({ type: 'handshake', peerId: 'p1', peerName: 'n1', version: '1.0.0', agents: [] });
      protoA.send({ type: 'catalog', agents: [] });
      protoA.send({ type: 'stream_end', requestId: 'r1' });

      await new Promise(r => setTimeout(r, 10));

      assert.equal(all.length, 3);
      assert.equal(all[0]!.type, 'handshake');
      assert.equal(all[1]!.type, 'catalog');
      assert.equal(all[2]!.type, 'stream_end');
    });

    it('should call both type-specific and onAny handlers', async () => {
      const specific: P2PMessage[] = [];
      const any: P2PMessage[] = [];
      protoB.on('catalog', (msg) => specific.push(msg));
      protoB.onAny((msg) => any.push(msg));

      protoA.send({ type: 'catalog', agents: [] });
      await new Promise(r => setTimeout(r, 10));

      assert.equal(specific.length, 1);
      assert.equal(any.length, 1);
    });
  });

  describe('NDJSON framing', () => {
    it('should handle multiple messages in a single data chunk', async () => {
      const received: P2PMessage[] = [];
      protoB.on('handshake', (msg) => received.push(msg));

      // Write two messages as a single chunk
      const msg1 = JSON.stringify({ type: 'handshake', peerId: 'p1', peerName: 'n1', version: '1.0.0', agents: [] });
      const msg2 = JSON.stringify({ type: 'handshake', peerId: 'p2', peerName: 'n2', version: '1.0.0', agents: [] });
      socketA.write(msg1 + '\n' + msg2 + '\n');

      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 2);
      assert.equal((received[0] as HandshakeMessage).peerId, 'p1');
      assert.equal((received[1] as HandshakeMessage).peerId, 'p2');
    });

    it('should handle messages split across multiple data chunks', async () => {
      const received: P2PMessage[] = [];
      protoB.on('catalog', (msg) => received.push(msg));

      const full = JSON.stringify({ type: 'catalog', agents: [{ name: 'test', description: 'desc', inputVariables: [] }] });
      const mid = Math.floor(full.length / 2);

      // Write first half (incomplete JSON line)
      socketA.write(full.slice(0, mid));
      await new Promise(r => setTimeout(r, 10));
      assert.equal(received.length, 0); // Not parsed yet

      // Write second half + newline
      socketA.write(full.slice(mid) + '\n');
      await new Promise(r => setTimeout(r, 10));
      assert.equal(received.length, 1);
      assert.equal((received[0] as CatalogMessage).agents[0]!.name, 'test');
    });

    it('should skip empty lines', async () => {
      const received: P2PMessage[] = [];
      protoB.on('catalog', (msg) => received.push(msg));

      socketA.write('\n\n' + JSON.stringify({ type: 'catalog', agents: [] }) + '\n\n');
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
    });

    it('should skip malformed JSON lines', async () => {
      const received: P2PMessage[] = [];
      protoB.on('catalog', (msg) => received.push(msg));

      socketA.write('not valid json\n');
      socketA.write(JSON.stringify({ type: 'catalog', agents: [] }) + '\n');
      socketA.write('{broken\n');
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
    });
  });

  describe('LLM message serialization', () => {
    it('should send and receive llm_invoke message', async () => {
      const received: P2PMessage[] = [];
      protoB.on('llm_invoke', (msg) => received.push(msg));

      const invoke: LLMInvokeMessage = {
        type: 'llm_invoke',
        requestId: 'llm-req-1',
        modelName: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      protoA.send(invoke);
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const msg = received[0] as LLMInvokeMessage;
      assert.equal(msg.type, 'llm_invoke');
      assert.equal(msg.requestId, 'llm-req-1');
      assert.equal(msg.modelName, 'gpt-4');
      assert.equal(msg.messages.length, 1);
      assert.equal(msg.messages[0]!.content, 'Hello');
      assert.equal(msg.temperature, 0.7);
    });

    it('should send and receive llm_stream content chunk', async () => {
      const received: P2PMessage[] = [];
      protoB.on('llm_stream', (msg) => received.push(msg));

      const stream: LLMStreamMessage = {
        type: 'llm_stream',
        requestId: 'llm-req-1',
        chunk: { type: 'content', content: 'Hello world' },
      };

      protoA.send(stream);
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const msg = received[0] as LLMStreamMessage;
      assert.equal(msg.requestId, 'llm-req-1');
      assert.deepEqual(msg.chunk, { type: 'content', content: 'Hello world' });
    });

    it('should send and receive llm_stream usage chunk', async () => {
      const received: P2PMessage[] = [];
      protoB.on('llm_stream', (msg) => received.push(msg));

      const stream: LLMStreamMessage = {
        type: 'llm_stream',
        requestId: 'llm-req-1',
        chunk: { type: 'usage', input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      };

      protoA.send(stream);
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const msg = received[0] as LLMStreamMessage;
      assert.deepEqual(msg.chunk, { type: 'usage', input_tokens: 10, output_tokens: 20, total_tokens: 30 });
    });

    it('should send and receive llm_stream_end message', async () => {
      const received: P2PMessage[] = [];
      protoB.on('llm_stream_end', (msg) => received.push(msg));

      const end: LLMStreamEndMessage = { type: 'llm_stream_end', requestId: 'llm-req-1' };

      protoA.send(end);
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      assert.equal((received[0] as LLMStreamEndMessage).requestId, 'llm-req-1');
    });

    it('should send and receive llm_stream_error message', async () => {
      const received: P2PMessage[] = [];
      protoB.on('llm_stream_error', (msg) => received.push(msg));

      const err: LLMStreamErrorMessage = { type: 'llm_stream_error', requestId: 'llm-req-1', error: 'Model not found' };

      protoA.send(err);
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const msg = received[0] as LLMStreamErrorMessage;
      assert.equal(msg.error, 'Model not found');
    });

    it('should include llms in handshake message', async () => {
      const received: P2PMessage[] = [];
      protoB.on('handshake', (msg) => received.push(msg));

      const handshake: HandshakeMessage = {
        type: 'handshake',
        peerId: 'peer-llm',
        peerName: 'llm-peer',
        version: '1.0.0',
        agents: [],
        llms: [{ name: 'gpt-4', provider: 'openai', model: 'gpt-4-turbo' }],
      };

      protoA.send(handshake);
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const msg = received[0] as HandshakeMessage;
      assert.equal(msg.llms?.length, 1);
      assert.equal(msg.llms![0]!.name, 'gpt-4');
      assert.equal(msg.llms![0]!.provider, 'openai');
    });

    it('should include llms in catalog message', async () => {
      const received: P2PMessage[] = [];
      protoB.on('catalog', (msg) => received.push(msg));

      const catalog: CatalogMessage = {
        type: 'catalog',
        agents: [],
        llms: [
          { name: 'llama', provider: 'local', model: 'llama-3-8b' },
          { name: 'claude', provider: 'anthropic', model: 'claude-3-sonnet' },
        ],
      };

      protoA.send(catalog);
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const msg = received[0] as CatalogMessage;
      assert.equal(msg.llms?.length, 2);
      assert.equal(msg.llms![0]!.name, 'llama');
      assert.equal(msg.llms![1]!.provider, 'anthropic');
    });
  });

  describe('destroy', () => {
    it('should not send messages after destroy', async () => {
      const received: P2PMessage[] = [];
      protoB.on('catalog', (msg) => received.push(msg));

      protoA.destroy();
      protoA.send({ type: 'catalog', agents: [] });
      await new Promise(r => setTimeout(r, 10));

      assert.equal(received.length, 0);
    });

    it('should report isDestroyed correctly', () => {
      assert.equal(protoA.isDestroyed, false);
      protoA.destroy();
      assert.equal(protoA.isDestroyed, true);
    });

    it('should be idempotent', () => {
      protoA.destroy();
      protoA.destroy(); // Should not throw
      assert.equal(protoA.isDestroyed, true);
    });
  });

  describe('bidirectional communication', () => {
    it('should allow both sides to send and receive', async () => {
      const receivedByA: P2PMessage[] = [];
      const receivedByB: P2PMessage[] = [];

      protoA.on('catalog', (msg) => receivedByA.push(msg));
      protoB.on('handshake', (msg) => receivedByB.push(msg));

      protoA.send({ type: 'handshake', peerId: 'a', peerName: 'A', version: '1.0.0', agents: [] });
      protoB.send({ type: 'catalog', agents: [] });

      await new Promise(r => setTimeout(r, 10));

      assert.equal(receivedByA.length, 1);
      assert.equal(receivedByA[0]!.type, 'catalog');
      assert.equal(receivedByB.length, 1);
      assert.equal(receivedByB[0]!.type, 'handshake');
    });
  });
});
