import * as crypto from 'crypto';
import * as os from 'os';
import { P2PProtocol } from './p2p-protocol.ts';
import { resolveP2PConfig } from '../agents/types.ts';
import { logger } from '../logger.ts';
import type { Orchestrator } from '../orchestrator.ts';
import { listModelConfigs, getModelConfig } from '../llm/llm-config.ts';
import { detectProvider } from '../llm/provider-detector.ts';
import { LLMFactory } from '../llm/llm-factory.ts';
import { humanMessage, aiMessage, systemMessage, toolMessage } from '../types/llm-types.ts';
import { convertJsonSchemaToZod } from '../utils/json-schema-to-zod.ts';
import type { P2PLLMInfo, P2PWireMessage, P2PWireTool, RemoteLLM, LLMInvokeMessage, LLMStreamMessage, LLMStreamEndMessage, LLMStreamErrorMessage } from './types.ts';
import type {
  P2PAgentInfo,
  PeerInfo,
  RemoteAgent,
  P2PStatus,
  InvokeMessage,
  StreamMessage,
  StreamEndMessage,
  StreamErrorMessage,
  HandshakeMessage,
  CatalogMessage,
} from './types.ts';

const VERSION = '1.0.0';

export class P2PManager {
  private swarm: any = null;
  private peers = new Map<string, { info: PeerInfo; protocol: P2PProtocol }>();
  private pendingRequests = new Map<string, {
    resolve: (value: void) => void;
    reject: (error: Error) => void;
    chunks: unknown[];
    done: boolean;
    waiting: ((value: void) => void) | null;
    abortController: AbortController;
  }>();

  private orchestrator: Orchestrator;
  private networkKey: string;
  private peerName: string;
  private peerId: string;
  private started = false;

  // Rate limiting: sliding window of request timestamps
  private requestTimestamps: number[] = [];
  private _rateLimit = 60; // requests per minute, 0 = unlimited

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
    this.networkKey = process.env['P2P_NETWORK_KEY'] || 'agent-orcha-default';
    this.peerName = process.env['P2P_PEER_NAME'] || os.hostname();
    this.peerId = crypto.randomBytes(16).toString('hex');
    const envLimit = process.env['P2P_RATE_LIMIT'];
    if (envLimit !== undefined) this._rateLimit = Math.max(0, parseInt(envLimit, 10) || 0);
  }

  /** Check rate limit, returns true if request is allowed */
  private checkRateLimit(): boolean {
    if (this._rateLimit <= 0) return true;
    const now = Date.now();
    const windowStart = now - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter(t => t > windowStart);
    if (this.requestTimestamps.length >= this._rateLimit) return false;
    this.requestTimestamps.push(now);
    return true;
  }

  get rateLimit(): number { return this._rateLimit; }

  setRateLimit(limit: number): void {
    this._rateLimit = Math.max(0, limit);
  }

  async start(): Promise<void> {
    if (this.started) return;

    const Hyperswarm = (await import('hyperswarm')).default;
    this.swarm = new Hyperswarm();

    const topicBuffer = crypto.createHash('sha256').update(this.networkKey).digest();

    this.swarm.on('connection', (socket: any, info: any) => {
      this.onConnection(socket, info);
    });

    const discovery = this.swarm.join(topicBuffer, { server: true, client: true });
    await discovery.flushed();

    this.started = true;
    logger.info(`[P2P] Started as "${this.peerName}" (${this.peerId.slice(0, 8)}...) on network "${this.networkKey}"`);
  }

  private onConnection(socket: any, _info: any): void {
    const protocol = new P2PProtocol(socket);

    // Send handshake immediately
    const handshake: HandshakeMessage = {
      type: 'handshake',
      peerId: this.peerId,
      peerName: this.peerName,
      version: VERSION,
      agents: this.getLocalP2PAgents(),
      llms: this.getLocalP2PLLMs(),
    };
    protocol.send(handshake);

    // Handle incoming handshake
    protocol.on('handshake', (msg) => {
      const hs = msg as HandshakeMessage;
      if (hs.peerId === this.peerId) {
        // Connected to ourselves — ignore
        protocol.destroy();
        return;
      }

      // Deduplicate: if we already have this peer, keep the existing connection
      if (this.peers.has(hs.peerId)) {
        protocol.destroy();
        return;
      }

      const peerInfo: PeerInfo = {
        peerId: hs.peerId,
        peerName: hs.peerName,
        version: hs.version,
        agents: hs.agents,
        llms: hs.llms ?? [],
        connectedAt: Date.now(),
      };

      this.peers.set(hs.peerId, { info: peerInfo, protocol });
      logger.info(`[P2P] Peer connected: "${hs.peerName}" (${hs.peerId.slice(0, 8)}...) with ${hs.agents.length} agent(s)`);

      // Set up message handlers for this peer
      this.setupPeerHandlers(hs.peerId, protocol);
    });

    // Handle disconnect
    socket.on('close', () => {
      // Find and remove the peer that used this protocol
      for (const [peerId, peer] of this.peers) {
        if (peer.protocol === protocol) {
          logger.info(`[P2P] Peer disconnected: "${peer.info.peerName}" (${peerId.slice(0, 8)}...)`);
          this.peers.delete(peerId);

          // Abort any pending requests from this peer
          for (const [reqId, req] of this.pendingRequests) {
            if (reqId.startsWith(peerId)) {
              req.abortController.abort();
              req.reject(new Error('Peer disconnected'));
              this.pendingRequests.delete(reqId);
            }
          }
          break;
        }
      }
    });
  }

  private setupPeerHandlers(peerId: string, protocol: P2PProtocol): void {
    // Handle catalog updates
    protocol.on('catalog', (msg) => {
      const catalog = msg as CatalogMessage;
      const peer = this.peers.get(peerId);
      if (peer) {
        if (catalog.peerName) peer.info.peerName = catalog.peerName;
        peer.info.agents = catalog.agents;
        peer.info.llms = catalog.llms ?? [];
        logger.info(`[P2P] Catalog update from "${peer.info.peerName}": ${catalog.agents.length} agent(s), ${(catalog.llms ?? []).length} LLM(s)`);
      }
    });

    // Handle incoming invoke requests (we are the host)
    protocol.on('invoke', async (msg) => {
      const invoke = msg as InvokeMessage;
      await this.handleInvokeRequest(peerId, protocol, invoke);
    });

    // Handle incoming LLM invoke requests (we are the host)
    protocol.on('llm_invoke', async (msg) => {
      const invoke = msg as LLMInvokeMessage;
      await this.handleLLMInvokeRequest(peerId, protocol, invoke);
    });

    // Handle stream responses (we are the caller) — shared by agent and LLM streams
    protocol.on('stream', (msg) => {
      const stream = msg as StreamMessage;
      const req = this.pendingRequests.get(stream.requestId);
      if (req) {
        req.chunks.push(stream.chunk);
        if (req.waiting) {
          req.waiting();
          req.waiting = null;
        }
      }
    });

    protocol.on('stream_end', (msg) => {
      const end = msg as StreamEndMessage;
      const req = this.pendingRequests.get(end.requestId);
      if (req) {
        req.done = true;
        if (req.waiting) {
          req.waiting();
          req.waiting = null;
        }
      }
    });

    protocol.on('stream_error', (msg) => {
      const err = msg as StreamErrorMessage;
      const req = this.pendingRequests.get(err.requestId);
      if (req) {
        req.done = true;
        req.reject(new Error(err.error));
        if (req.waiting) {
          req.waiting();
          req.waiting = null;
        }
      }
    });

    // Handle LLM stream responses (we are the caller)
    protocol.on('llm_stream', (msg) => {
      const stream = msg as LLMStreamMessage;
      const req = this.pendingRequests.get(stream.requestId);
      if (req) {
        req.chunks.push(stream.chunk);
        if (req.waiting) {
          req.waiting();
          req.waiting = null;
        }
      }
    });

    protocol.on('llm_stream_end', (msg) => {
      const end = msg as LLMStreamEndMessage;
      const req = this.pendingRequests.get(end.requestId);
      if (req) {
        req.done = true;
        if (req.waiting) {
          req.waiting();
          req.waiting = null;
        }
      }
    });

    protocol.on('llm_stream_error', (msg) => {
      const err = msg as LLMStreamErrorMessage;
      const req = this.pendingRequests.get(err.requestId);
      if (req) {
        req.done = true;
        req.reject(new Error(err.error));
        if (req.waiting) {
          req.waiting();
          req.waiting = null;
        }
      }
    });
  }

  private async handleInvokeRequest(
    _peerId: string,
    protocol: P2PProtocol,
    invoke: InvokeMessage,
  ): Promise<void> {
    const { requestId, agentName, input, sessionId } = invoke;

    if (!this.checkRateLimit()) {
      protocol.send({ type: 'stream_error', requestId, error: 'Rate limit exceeded. Try again later.' });
      return;
    }

    // Validate the agent exists and has p2p enabled
    const agent = this.orchestrator.agents.get(agentName);
    if (!agent) {
      protocol.send({ type: 'stream_error', requestId, error: `Agent "${agentName}" not found` });
      return;
    }

    const p2pConfig = resolveP2PConfig(agent.p2p);
    if (!p2pConfig.enabled) {
      protocol.send({ type: 'stream_error', requestId, error: `Agent "${agentName}" is not shared via P2P` });
      return;
    }

    const abortController = new AbortController();

    try {
      const stream = this.orchestrator.streamAgent(agentName, input, sessionId, abortController.signal);

      for await (const chunk of stream) {
        if (protocol.isDestroyed) {
          abortController.abort();
          return;
        }
        protocol.send({ type: 'stream', requestId, chunk });
      }

      protocol.send({ type: 'stream_end', requestId });
    } catch (error) {
      if (!protocol.isDestroyed) {
        const message = error instanceof Error ? error.message : String(error);
        protocol.send({ type: 'stream_error', requestId, error: message });
      }
    }
  }

  // --- Public API ---

  getStatus(): P2PStatus {
    return {
      enabled: true,
      connected: this.started,
      peerCount: this.peers.size,
      peerName: this.peerName,
      networkKey: this.networkKey,
      rateLimit: this._rateLimit,
    };
  }

  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values()).map(p => p.info);
  }

  getRemoteAgents(): RemoteAgent[] {
    const agents: RemoteAgent[] = [];
    for (const peer of this.peers.values()) {
      for (const agent of peer.info.agents) {
        agents.push({
          ...agent,
          peerId: peer.info.peerId,
          peerName: peer.info.peerName,
        });
      }
    }
    return agents;
  }

  async *invokeRemoteAgent(
    peerId: string,
    agentName: string,
    input: Record<string, unknown>,
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown, void, unknown> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Peer "${peerId}" not connected`);

    const requestId = `${peerId}-${crypto.randomBytes(8).toString('hex')}`;
    const abortController = new AbortController();

    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const request: {
      resolve: (value: void) => void;
      reject: (error: Error) => void;
      chunks: unknown[];
      done: boolean;
      waiting: ((value: void) => void) | null;
      abortController: AbortController;
    } = {
      resolve: () => {},
      reject: () => {},
      chunks: [],
      done: false,
      waiting: null,
      abortController,
    };

    // Set up the promise for error rejection
    const errorPromise = new Promise<void>((_, reject) => {
      request.reject = reject;
    });
    // Prevent unhandled rejection
    errorPromise.catch(() => {});

    this.pendingRequests.set(requestId, request);

    // Send invoke message
    const invokeMsg: InvokeMessage = {
      type: 'invoke',
      requestId,
      agentName,
      input,
      sessionId,
    };
    peer.protocol.send(invokeMsg);

    try {
      while (!request.done || request.chunks.length > 0) {
        if (abortController.signal.aborted) break;

        if (request.chunks.length > 0) {
          yield request.chunks.shift()!;
        } else if (!request.done) {
          // Wait for next chunk or completion
          await Promise.race([
            new Promise<void>(resolve => { request.waiting = resolve; }),
            errorPromise,
          ]);
        }
      }
    } finally {
      this.pendingRequests.delete(requestId);
    }
  }

  getRemoteLLMs(): RemoteLLM[] {
    const llms: RemoteLLM[] = [];
    for (const peer of this.peers.values()) {
      for (const llm of peer.info.llms) {
        llms.push({
          ...llm,
          peerId: peer.info.peerId,
          peerName: peer.info.peerName,
        });
      }
    }
    return llms;
  }

  async *invokeRemoteLLM(
    peerId: string,
    modelName: string,
    messages: P2PWireMessage[],
    temperature?: number,
    signal?: AbortSignal,
    tools?: P2PWireTool[],
  ): AsyncGenerator<LLMStreamMessage['chunk'], void, unknown> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Peer "${peerId}" not connected`);

    const requestId = `${peerId}-llm-${crypto.randomBytes(8).toString('hex')}`;
    const abortController = new AbortController();

    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const request: {
      resolve: (value: void) => void;
      reject: (error: Error) => void;
      chunks: unknown[];
      done: boolean;
      waiting: ((value: void) => void) | null;
      abortController: AbortController;
    } = {
      resolve: () => {},
      reject: () => {},
      chunks: [],
      done: false,
      waiting: null,
      abortController,
    };

    const errorPromise = new Promise<void>((_, reject) => {
      request.reject = reject;
    });
    errorPromise.catch(() => {});

    this.pendingRequests.set(requestId, request);

    const invokeMsg: LLMInvokeMessage = {
      type: 'llm_invoke',
      requestId,
      modelName,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(tools?.length ? { tools } : {}),
    };
    peer.protocol.send(invokeMsg);

    try {
      while (!request.done || request.chunks.length > 0) {
        if (abortController.signal.aborted) break;

        if (request.chunks.length > 0) {
          yield request.chunks.shift()! as LLMStreamMessage['chunk'];
        } else if (!request.done) {
          await Promise.race([
            new Promise<void>(resolve => { request.waiting = resolve; }),
            errorPromise,
          ]);
        }
      }
    } finally {
      this.pendingRequests.delete(requestId);
    }
  }

  setPeerName(name: string): void {
    this.peerName = name;
    this.broadcastCatalog();
  }

  async setNetworkKey(key: string): Promise<void> {
    if (key === this.networkKey) return;
    this.networkKey = key;
    // Rejoin swarm with new topic
    if (this.started) {
      await this.close();
      await this.start();
    }
  }

  /** Broadcast updated catalog to all connected peers */
  broadcastCatalog(): void {
    const agents = this.getLocalP2PAgents();
    const llms = this.getLocalP2PLLMs();
    const msg: CatalogMessage = { type: 'catalog', peerName: this.peerName, agents, llms };
    for (const peer of this.peers.values()) {
      peer.protocol.send(msg);
    }
  }

  async close(): Promise<void> {
    if (!this.started) return;

    // Abort all pending requests
    for (const [reqId, req] of this.pendingRequests) {
      req.abortController.abort();
      req.reject(new Error('P2P shutting down'));
      this.pendingRequests.delete(reqId);
    }

    // Destroy all peer protocols
    for (const peer of this.peers.values()) {
      peer.protocol.destroy();
    }
    this.peers.clear();

    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }

    this.started = false;
    logger.info('[P2P] Shut down');
  }

  getLocalP2PAgents(): P2PAgentInfo[] {
    return this.orchestrator.agents.list()
      .filter(a => resolveP2PConfig(a.p2p).enabled)
      .map(a => ({
        name: a.name,
        description: a.description,
        inputVariables: a.prompt.inputVariables,
        sampleQuestions: a.sampleQuestions,
      }));
  }

  getLocalP2PLLMs(): P2PLLMInfo[] {
    const blanketShare = process.env['P2P_SHARE_LLMS'] === 'true';
    const names = listModelConfigs();
    const result: P2PLLMInfo[] = [];
    for (const name of names) {
      try {
        const config = getModelConfig(name);
        if (config.active === false) continue;
        if (config.p2p || blanketShare) {
          const provider = detectProvider(config);
          result.push({ name, provider, model: config.model });
        }
      } catch { /* skip bad configs */ }
    }
    return result;
  }

  private async handleLLMInvokeRequest(
    _peerId: string,
    protocol: P2PProtocol,
    invoke: LLMInvokeMessage,
  ): Promise<void> {
    const { requestId, modelName, messages, temperature } = invoke;

    if (!this.checkRateLimit()) {
      protocol.send({ type: 'llm_stream_error', requestId, error: 'Rate limit exceeded. Try again later.' });
      return;
    }

    // Validate the model exists and is shared
    const localLLMs = this.getLocalP2PLLMs();
    const match = localLLMs.find(l => l.name === modelName);
    if (!match) {
      protocol.send({ type: 'llm_stream_error', requestId, error: `Model "${modelName}" not found or not shared via P2P` });
      return;
    }

    try {
      let llm = await LLMFactory.create(temperature !== undefined ? { name: modelName, temperature } : modelName);

      // Convert wire messages to BaseMessage format (with tool context)
      const baseMessages = messages.map(m => {
        if (m.role === 'user' || m.role === 'human') return humanMessage(m.content);
        if (m.role === 'assistant' || m.role === 'ai') return aiMessage(m.content, m.tool_calls);
        if (m.role === 'system') return systemMessage(m.content);
        if (m.role === 'tool' && m.tool_call_id) return toolMessage(m.content, m.tool_call_id, m.name ?? '');
        return humanMessage(m.content);
      });

      // Bind tools if provided — create stub StructuredTool objects from JSON schemas
      if (invoke.tools?.length) {
        const stubs = invoke.tools.map(t => ({
          name: t.name,
          description: t.description,
          schema: convertJsonSchemaToZod(t.parameters),
          invoke: async () => { throw new Error('P2P tool stub — execution happens on caller side'); },
        }));
        llm = llm.bindTools(stubs);
      }

      for await (const chunk of llm.stream(baseMessages)) {
        if (protocol.isDestroyed) return;

        if (chunk.content) {
          protocol.send({ type: 'llm_stream', requestId, chunk: { type: 'content', content: chunk.content } });
        }
        if (chunk.reasoning) {
          protocol.send({ type: 'llm_stream', requestId, chunk: { type: 'thinking', content: chunk.reasoning } });
        }
        if (chunk.tool_calls?.length) {
          protocol.send({ type: 'llm_stream', requestId, chunk: { type: 'tool_calls', tool_calls: chunk.tool_calls } });
        }
        if (chunk.usage_metadata) {
          protocol.send({ type: 'llm_stream', requestId, chunk: { type: 'usage', ...chunk.usage_metadata } });
        }
      }

      protocol.send({ type: 'llm_stream_end', requestId });
    } catch (error) {
      if (!protocol.isDestroyed) {
        const message = error instanceof Error ? error.message : String(error);
        protocol.send({ type: 'llm_stream_error', requestId, error: message });
      }
    }
  }
}
