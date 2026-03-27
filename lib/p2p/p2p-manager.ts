import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { P2PProtocol } from './p2p-protocol.ts';
import { resolveP2PConfig } from '../agents/types.ts';
import { logger } from '../logger.ts';
import type { Orchestrator } from '../orchestrator.ts';
import { listModelConfigs, getModelConfig, listImageConfigs, listTtsConfigs, listVideoConfigs, getImageConfig, getTtsConfig } from '../llm/llm-config.ts';
import { LLMFactory } from '../llm/llm-factory.ts';
import { humanMessage, aiMessage, systemMessage, toolMessage } from '../types/llm-types.ts';
import { convertJsonSchemaToZod } from '../utils/json-schema-to-zod.ts';
import type {
  P2PModelInfo,
  P2PWireMessage,
  P2PWireTool,
  RemoteModel,
  ModelTaskInvokeMessage,
  ModelTaskResultMessage,
  ModelTaskStreamMessage,
  ModelTaskStreamEndMessage,
  ModelTaskErrorMessage,
} from './types.ts';
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
  private seed: Buffer;
  private started = false;

  // Rate limiting: sliding window of request timestamps
  private requestTimestamps: number[] = [];
  private _rateLimit = 60; // requests per minute, 0 = unlimited

  /** Path to the JSON settings file persisted across restarts */
  private get settingsPath(): string {
    return path.join(this.orchestrator.workspaceRoot, '.p2p-settings.json');
  }

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;

    // Defaults (env vars take priority over persisted settings)
    const saved = this.loadSettings();
    this.networkKey = process.env['P2P_NETWORK_KEY'] || saved.networkKey || 'agent-orcha-default';
    this.peerName = process.env['P2P_PEER_NAME'] || saved.peerName || os.hostname();
    this.seed = this.loadOrCreateSeed();
    this.peerId = crypto.createHash('sha256').update(this.seed).digest('hex').slice(0, 32);

    const envLimit = process.env['P2P_RATE_LIMIT'];
    if (envLimit !== undefined) {
      this._rateLimit = Math.max(0, parseInt(envLimit, 10) || 0);
    } else if (saved.rateLimit !== undefined) {
      this._rateLimit = Math.max(0, saved.rateLimit);
    }
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
    this.saveSettings();
  }

  private loadSettings(): Record<string, any> {
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'));
    } catch { return {}; }
  }

  /** Persist current settings to disk, preserving the enabled flag */
  saveSettings(): void {
    try {
      const existing = this.loadSettings();
      fs.writeFileSync(this.settingsPath, JSON.stringify({
        ...existing,
        peerName: this.peerName,
        networkKey: this.networkKey,
        rateLimit: this._rateLimit,
      }, null, 2));
    } catch (err: any) {
      logger.warn('[P2P] Could not persist settings:', err.message);
    }
  }

  /**
   * Read the persisted `enabled` flag from the settings file.
   * Called by the orchestrator BEFORE constructing a P2PManager to decide
   * whether P2P should start. Returns `undefined` if no setting was saved.
   */
  static loadEnabledFlag(workspaceRoot: string): boolean | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.p2p-settings.json'), 'utf-8'));
      return typeof data.enabled === 'boolean' ? data.enabled : undefined;
    } catch { return undefined; }
  }

  /** Persist just the enabled flag (called from toggle route when disabling) */
  static saveEnabledFlag(workspaceRoot: string, enabled: boolean): void {
    const settingsPath = path.join(workspaceRoot, '.p2p-settings.json');
    let data: Record<string, any> = {};
    try { data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* new file */ }
    data.enabled = enabled;
    try { fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
  }

  /**
   * Load or create a persistent 32-byte seed for Hyperswarm's DHT keypair.
   * Reusing the same seed across restarts lets the DHT remember this node,
   * dramatically speeding up peer discovery.
   */
  private loadOrCreateSeed(): Buffer {
    const seedPath = path.join(this.orchestrator.workspaceRoot, '.p2p-seed');
    try {
      const existing = fs.readFileSync(seedPath);
      if (existing.length === 32) return existing;
    } catch { /* file doesn't exist yet */ }

    const seed = crypto.randomBytes(32);
    try {
      fs.writeFileSync(seedPath, seed);
    } catch (err: any) {
      logger.warn('[P2P] Could not persist DHT seed:', err.message);
    }
    return seed;
  }

  async start(): Promise<void> {
    if (this.started) return;

    const Hyperswarm = (await import('hyperswarm')).default;
    this.swarm = new Hyperswarm({ seed: this.seed });

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
      models: this.getLocalSharedModels(),
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
        models: hs.models ?? [],
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
        peer.info.models = catalog.models ?? [];
        logger.info(`[P2P] Catalog update from "${peer.info.peerName}": ${catalog.agents.length} agent(s), ${(catalog.models ?? []).length} model(s)`);
      }
    });

    // Handle incoming agent invoke requests (we are the host)
    protocol.on('invoke', async (msg) => {
      const invoke = msg as InvokeMessage;
      await this.handleInvokeRequest(peerId, protocol, invoke);
    });

    // Handle incoming model task invoke requests (we are the host)
    protocol.on('model_task_invoke', async (msg) => {
      const invoke = msg as ModelTaskInvokeMessage;
      await this.handleModelTaskInvoke(peerId, protocol, invoke);
    });

    // Handle model task result responses (we are the caller — single-result tasks)
    protocol.on('model_task_result', (msg) => {
      const result = msg as ModelTaskResultMessage;
      const req = this.pendingRequests.get(result.requestId);
      if (req) {
        req.chunks.push(result);
        req.done = true;
        if (req.waiting) {
          req.waiting();
          req.waiting = null;
        }
      }
    });

    // Handle model task stream responses (we are the caller — streaming tasks)
    protocol.on('model_task_stream', (msg) => {
      const stream = msg as ModelTaskStreamMessage;
      const req = this.pendingRequests.get(stream.requestId);
      if (req) {
        req.chunks.push(stream.chunk);
        if (req.waiting) {
          req.waiting();
          req.waiting = null;
        }
      }
    });

    protocol.on('model_task_stream_end', (msg) => {
      const end = msg as ModelTaskStreamEndMessage;
      const req = this.pendingRequests.get(end.requestId);
      if (req) {
        req.done = true;
        if (req.waiting) {
          req.waiting();
          req.waiting = null;
        }
      }
    });

    protocol.on('model_task_error', (msg) => {
      const err = msg as ModelTaskErrorMessage;
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

    // Handle agent stream responses (we are the caller)
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
  }

  private getPeerName(peerId: string): string {
    return this.peers.get(peerId)?.info.peerName ?? peerId.slice(0, 8);
  }

  private async handleInvokeRequest(
    peerId: string,
    protocol: P2PProtocol,
    invoke: InvokeMessage,
  ): Promise<void> {
    const { requestId, agentName, input, sessionId } = invoke;

    if (!this.checkRateLimit()) {
      protocol.send({ type: 'stream_error', requestId, error: 'Rate limit exceeded. Try again later.' });
      return;
    }

    // Validate the agent exists and has p2p sharing enabled
    const agent = this.orchestrator.agents.get(agentName);
    if (!agent) {
      protocol.send({ type: 'stream_error', requestId, error: `Agent "${agentName}" not found` });
      return;
    }

    const p2pConfig = resolveP2PConfig(agent.p2p);
    if (!p2pConfig.share) {
      protocol.send({ type: 'stream_error', requestId, error: `Agent "${agentName}" is not shared via P2P` });
      return;
    }

    const taskManager = this.orchestrator.tasks.getManager();
    const task = taskManager.trackP2P('agent', agentName, input, {
      direction: 'incoming',
      peerId,
      peerName: this.getPeerName(peerId),
    }, sessionId);
    const abortController = new AbortController();
    taskManager.registerAbort(task.id, abortController);

    try {
      const stream = this.orchestrator.streamAgent(agentName, input, sessionId, abortController.signal);

      for await (const chunk of stream) {
        if (protocol.isDestroyed) {
          abortController.abort();
          taskManager.cancelTask(task.id);
          return;
        }
        protocol.send({ type: 'stream', requestId, chunk });
      }

      protocol.send({ type: 'stream_end', requestId });
      taskManager.resolve(task.id, { output: 'p2p stream completed' });
    } catch (error) {
      if (!protocol.isDestroyed) {
        const message = error instanceof Error ? error.message : String(error);
        protocol.send({ type: 'stream_error', requestId, error: message });
      }
      taskManager.reject(task.id, error);
    } finally {
      taskManager.unregisterAbort(task.id);
    }
  }

  /**
   * Unified handler for all model task invocations (chat, image, tts, video_frame).
   * Dispatches to the appropriate handler based on taskType.
   */
  private async handleModelTaskInvoke(
    peerId: string,
    protocol: P2PProtocol,
    invoke: ModelTaskInvokeMessage,
  ): Promise<void> {
    const { requestId, taskType, modelName, params } = invoke;

    if (!this.checkRateLimit()) {
      protocol.send({ type: 'model_task_error', requestId, error: 'Rate limit exceeded.' });
      return;
    }

    // Find matching model in local shared models
    const localModels = this.getLocalSharedModels();
    const match = localModels.find(l =>
      l.name === modelName ||
      l.model === modelName ||
      l.model.toLowerCase().includes(modelName.toLowerCase())
    );
    if (!match) {
      protocol.send({ type: 'model_task_error', requestId, error: `Model "${modelName}" not found or not shared` });
      return;
    }

    switch (taskType) {
      case 'chat':
        return this.handleChatTask(requestId, peerId, protocol, match.name, params);
      case 'image':
      case 'video_frame':
        return this.handleImageTask(requestId, protocol, match.name, taskType, params);
      case 'tts':
        return this.handleTtsTask(requestId, protocol, match.name, params);
      default:
        protocol.send({ type: 'model_task_error', requestId, error: `Unknown task type: ${taskType}` });
    }
  }

  /**
   * Handle a chat task: stream LLM responses back via model_task_stream messages.
   */
  private async handleChatTask(
    requestId: string,
    peerId: string,
    protocol: P2PProtocol,
    configName: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const messages = params['messages'] as P2PWireMessage[] | undefined;
    const temperature = params['temperature'] as number | undefined;
    const tools = params['tools'] as P2PWireTool[] | undefined;

    if (!messages?.length) {
      protocol.send({ type: 'model_task_error', requestId, error: 'Missing messages parameter' });
      return;
    }

    const taskManager = this.orchestrator.tasks.getManager();
    const task = taskManager.trackP2P('llm', configName, { messageCount: messages.length }, {
      direction: 'incoming',
      peerId,
      peerName: this.getPeerName(peerId),
    });

    try {
      // Use the matched config name (not the wire modelName which may be a model string)
      let llm = await LLMFactory.create(temperature !== undefined ? { llm: configName, temperature } : configName);

      // Convert wire messages to BaseMessage format (with tool context)
      const baseMessages = messages.map(m => {
        if (m.role === 'user' || m.role === 'human') return humanMessage(m.content);
        if (m.role === 'assistant' || m.role === 'ai') return aiMessage(m.content, m.tool_calls);
        if (m.role === 'system') return systemMessage(m.content);
        if (m.role === 'tool' && m.tool_call_id) return toolMessage(m.content, m.tool_call_id, m.name ?? '');
        return humanMessage(m.content);
      });

      // Bind tools if provided — create stub StructuredTool objects from JSON schemas
      if (tools?.length) {
        const stubs = tools.map(t => ({
          name: t.name,
          description: t.description,
          schema: convertJsonSchemaToZod(t.parameters),
          invoke: async () => { throw new Error('P2P tool stub — execution happens on caller side'); },
        }));
        llm = llm.bindTools(stubs);
      }

      for await (const chunk of llm.stream(baseMessages)) {
        if (protocol.isDestroyed) {
          taskManager.cancelTask(task.id);
          return;
        }

        if (chunk.content) {
          protocol.send({ type: 'model_task_stream', requestId, chunk: { type: 'content', content: chunk.content } });
        }
        if (chunk.reasoning) {
          protocol.send({ type: 'model_task_stream', requestId, chunk: { type: 'thinking', content: chunk.reasoning } });
        }
        if (chunk.tool_calls?.length) {
          protocol.send({ type: 'model_task_stream', requestId, chunk: { type: 'tool_calls', tool_calls: chunk.tool_calls } });
        }
        if (chunk.usage_metadata) {
          protocol.send({ type: 'model_task_stream', requestId, chunk: { type: 'usage', ...chunk.usage_metadata } });
        }
      }

      protocol.send({ type: 'model_task_stream_end', requestId });
      taskManager.resolve(task.id, { output: 'p2p model chat stream completed' });
    } catch (error) {
      if (!protocol.isDestroyed) {
        const message = error instanceof Error ? error.message : String(error);
        protocol.send({ type: 'model_task_error', requestId, error: message });
      }
      taskManager.reject(task.id, error);
    }
  }

  /**
   * Handle an image or video_frame task: generate image and send back as model_task_result.
   */
  private async handleImageTask(
    requestId: string,
    protocol: P2PProtocol,
    configName: string,
    taskType: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const prompt = params['prompt'] as string | undefined;
    if (!prompt) {
      protocol.send({ type: 'model_task_error', requestId, error: 'Missing prompt parameter' });
      return;
    }

    try {
      const { OmniModelCache } = await import('../llm/providers/omni-model-cache.ts');

      const config = getImageConfig(configName);
      if (!config) {
        protocol.send({ type: 'model_task_error', requestId, error: `Image config "${configName}" not found` });
        return;
      }

      const modelPath = config.modelPath ?? configName;
      const resolvedPath = path.isAbsolute(modelPath)
        ? modelPath
        : path.join(this.orchestrator.workspaceRoot, modelPath);

      const imageModel = await OmniModelCache.getImageModel(resolvedPath, {});
      const buffer = await imageModel.generate(prompt, {
        ...(params['steps'] !== undefined ? { steps: params['steps'] as number } : {}),
        ...(params['width'] !== undefined ? { width: params['width'] as number } : {}),
        ...(params['height'] !== undefined ? { height: params['height'] as number } : {}),
        ...(params['cfgScale'] !== undefined ? { cfgScale: params['cfgScale'] as number } : {}),
        ...(params['seed'] !== undefined ? { seed: params['seed'] as number } : {}),
      });

      const metadata: Record<string, unknown> = {};
      if (taskType === 'video_frame' && params['frameIndex'] !== undefined) {
        metadata['frameIndex'] = params['frameIndex'];
      }

      protocol.send({
        type: 'model_task_result',
        requestId,
        data: buffer.toString('base64'),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    } catch (error) {
      if (!protocol.isDestroyed) {
        const message = error instanceof Error ? error.message : String(error);
        protocol.send({ type: 'model_task_error', requestId, error: message });
      }
    }
  }

  /**
   * Handle a TTS task: generate audio and send back as model_task_result.
   */
  private async handleTtsTask(
    requestId: string,
    protocol: P2PProtocol,
    configName: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const text = params['text'] as string | undefined;
    if (!text) {
      protocol.send({ type: 'model_task_error', requestId, error: 'Missing text parameter' });
      return;
    }

    try {
      const { OmniModelCache } = await import('../llm/providers/omni-model-cache.ts');

      const config = getTtsConfig(configName);
      if (!config) {
        protocol.send({ type: 'model_task_error', requestId, error: `TTS config "${configName}" not found` });
        return;
      }

      const modelPath = config.modelPath;
      const resolvedPath = path.isAbsolute(modelPath)
        ? modelPath
        : path.join(this.orchestrator.workspaceRoot, modelPath);

      const ttsModel = await OmniModelCache.getTtsModel(resolvedPath);
      const buffer = await ttsModel.speak(text, {
        ...(params['referenceAudio'] ? { referenceAudioPath: params['referenceAudio'] as string } : {}),
      });

      protocol.send({
        type: 'model_task_result',
        requestId,
        data: buffer.toString('base64'),
      });
    } catch (error) {
      if (!protocol.isDestroyed) {
        const message = error instanceof Error ? error.message : String(error);
        protocol.send({ type: 'model_task_error', requestId, error: message });
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

  getRemoteModels(): RemoteModel[] {
    const models: RemoteModel[] = [];
    for (const peer of this.peers.values()) {
      for (const model of peer.info.models) {
        models.push({
          ...model,
          peerId: peer.info.peerId,
          peerName: peer.info.peerName,
        });
      }
    }
    return models;
  }

  /**
   * Find ALL remote models matching a name (case-insensitive, partial match).
   * Used for distributed workloads where we want to spread work across multiple peers
   * sharing the same model, regardless of what engine they run it on.
   */
  getRemoteModelsByName(modelRef: string): RemoteModel[] {
    if (!modelRef) return [];
    const ref = modelRef.toLowerCase();
    return this.getRemoteModels().filter(m =>
      m.name.toLowerCase() === ref ||
      m.model.toLowerCase() === ref ||
      m.model.toLowerCase().includes(ref)
    );
  }

  /**
   * Invoke a remote model for streaming (chat). Yields stream chunks.
   */
  async *invokeRemoteModelStream(
    peerId: string,
    modelName: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelTaskStreamMessage['chunk'], void, unknown> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Peer "${peerId}" not connected`);

    const requestId = `${peerId}-model-${crypto.randomBytes(8).toString('hex')}`;
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

    const invokeMsg: ModelTaskInvokeMessage = {
      type: 'model_task_invoke',
      requestId,
      taskType: 'chat',
      modelName,
      params,
    };
    peer.protocol.send(invokeMsg);

    try {
      while (!request.done || request.chunks.length > 0) {
        if (abortController.signal.aborted) break;

        if (request.chunks.length > 0) {
          yield request.chunks.shift()! as ModelTaskStreamMessage['chunk'];
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

  /**
   * Invoke a remote model for a single-result task (image, tts, video_frame).
   * Waits for a single model_task_result message.
   */
  async invokeRemoteModelTask(
    peerId: string,
    modelName: string,
    taskType: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: string; metadata?: Record<string, unknown> }> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Peer "${peerId}" not connected`);

    const requestId = `${peerId}-model-${crypto.randomBytes(8).toString('hex')}`;
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

    const invokeMsg: ModelTaskInvokeMessage = {
      type: 'model_task_invoke',
      requestId,
      taskType: taskType as ModelTaskInvokeMessage['taskType'],
      modelName,
      params,
    };
    peer.protocol.send(invokeMsg);

    try {
      // Wait for the single result
      while (!request.done || request.chunks.length > 0) {
        if (abortController.signal.aborted) {
          throw new Error('Request aborted');
        }

        if (request.chunks.length > 0) {
          const result = request.chunks.shift()! as ModelTaskResultMessage;
          return { data: result.data, metadata: result.metadata };
        } else if (!request.done) {
          await Promise.race([
            new Promise<void>(resolve => { request.waiting = resolve; }),
            errorPromise,
          ]);
        }
      }

      throw new Error('No result received from remote model');
    } finally {
      this.pendingRequests.delete(requestId);
    }
  }

  setPeerName(name: string): void {
    this.peerName = name;
    this.saveSettings();
    this.broadcastCatalog();
  }

  async setNetworkKey(key: string): Promise<void> {
    if (key === this.networkKey) return;
    this.networkKey = key;
    this.saveSettings();
    // Rejoin swarm with new topic
    if (this.started) {
      await this.close();
      await this.start();
    }
  }

  /** Broadcast updated catalog to all connected peers */
  broadcastCatalog(): void {
    const agents = this.getLocalP2PAgents();
    const models = this.getLocalSharedModels();
    const msg: CatalogMessage = { type: 'catalog', peerName: this.peerName, agents, models };
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
      .filter(a => resolveP2PConfig(a.p2p).share)
      .map(a => ({
        name: a.name,
        description: a.description,
        inputVariables: a.prompt.inputVariables,
        sampleQuestions: a.sampleQuestions,
      }));
  }

  getLocalSharedModels(): P2PModelInfo[] {
    const result: P2PModelInfo[] = [];

    // Chat models from 'llm' section
    const blanketShare = process.env['P2P_SHARE_LLMS'] === 'true';
    const names = listModelConfigs();
    for (const name of names) {
      try {
        const config = getModelConfig(name);
        if (config.active === false) continue;
        if (config.share || blanketShare) {
          result.push({ name, model: config.model, type: 'chat' });
        }
      } catch { /* skip bad configs */ }
    }

    // Image models from 'image' section
    for (const { name, config } of listImageConfigs()) {
      if (config.share) {
        result.push({ name, model: config.description || config.modelPath?.split('/').pop() || name, type: 'image' });
      }
    }

    // Video models from 'video' section
    for (const { name, config } of listVideoConfigs()) {
      if (config.share) {
        result.push({ name, model: config.description || config.modelPath?.split('/').pop() || config.model || name, type: 'image' }); // video models generate frames (images)
      }
    }

    // TTS models from 'tts' section
    for (const { name, config } of listTtsConfigs()) {
      if (config.share) {
        result.push({ name, model: config.description || config.modelPath?.split('/').pop() || name, type: 'tts' });
      }
    }

    return result;
  }
}
