import type { FastifyPluginAsync } from 'fastify';
import { P2PManager } from '../../lib/p2p/p2p-manager.ts';
import { LLMFactory } from '../../lib/llm/index.ts';
import type { VideoSettings, RemoteModel } from '../../lib/p2p/types.ts';

interface InvokeParams {
  peerId: string;
  agentName: string;
}

interface InvokeBody {
  input: Record<string, unknown>;
  sessionId?: string;
}

interface LLMStreamParams {
  peerId: string;
  modelName: string;
}

interface Attachment {
  data: string;
  mediaType: string;
  name?: string;
}

interface LLMStreamBody {
  message: string;
  sessionId?: string;
  attachments?: Attachment[];
}

export const p2pRoutes: FastifyPluginAsync = async (fastify) => {
  function getManager(): P2PManager | null {
    return (fastify.orchestrator as any)._p2pManager ?? null;
  }

  const disabledByEnv = process.env['P2P_ENABLED'] === 'false';

  // GET /api/p2p/status
  fastify.get('/status', async () => {
    const manager = getManager();
    if (!manager) {
      return { enabled: false, connected: false, peerCount: 0, peerName: '', networkKey: '', rateLimit: 0, disabledByEnv };
    }
    return { ...manager.getStatus(), disabledByEnv: false };
  });

  // POST /api/p2p/toggle — enable or disable P2P at runtime
  fastify.post<{ Body: { enabled: boolean } }>('/toggle', async (request, reply) => {
    if (disabledByEnv) {
      return reply.status(403).send({ error: 'P2P was disabled at startup via P2P_ENABLED=false. Remove or change the environment variable and restart to enable P2P.' });
    }
    const { enabled } = request.body as any;
    const orch = fastify.orchestrator as any;

    if (enabled) {
      if (!orch._p2pManager) {
        orch._p2pManager = new P2PManager(fastify.orchestrator);
        await orch._p2pManager.start();
        LLMFactory.setP2PManager(orch._p2pManager);
        orch.agentExecutor.p2pManager = orch._p2pManager;
        fastify.orchestrator.registerP2PTools();
      }
    } else {
      if (orch._p2pManager) {
        await orch._p2pManager.close();
        orch._p2pManager = null;
        LLMFactory.setP2PManager(null as any);
        orch.agentExecutor.p2pManager = undefined;
        fastify.orchestrator.registerP2PTools();
      }
    }

    P2PManager.saveEnabledFlag(fastify.orchestrator.workspaceRoot, enabled);

    const manager = getManager();
    return manager ? manager.getStatus() : { enabled: false, connected: false, peerCount: 0, peerName: '', networkKey: '', rateLimit: 0 };
  });

  // PATCH /api/p2p/settings — update peer name, network key, and/or rate limit
  fastify.patch<{ Body: { peerName?: string; networkKey?: string; rateLimit?: number } }>('/settings', async (request, reply) => {
    const manager = getManager();
    if (!manager) return reply.status(503).send({ error: 'P2P not enabled' });

    const { peerName, networkKey, rateLimit } = request.body as any;
    if (peerName && typeof peerName === 'string') {
      manager.setPeerName(peerName.trim());
    }
    if (networkKey && typeof networkKey === 'string') {
      await manager.setNetworkKey(networkKey.trim());
    }
    if (rateLimit !== undefined && typeof rateLimit === 'number') {
      manager.setRateLimit(rateLimit);
    }

    return manager.getStatus();
  });

  // GET /api/p2p/peers
  fastify.get('/peers', async (_req, reply) => {
    const manager = getManager();
    if (!manager) return reply.status(200).send([]);
    return manager.getPeers();
  });

  // GET /api/p2p/config — what this instance is sharing
  fastify.get('/config', async () => {
    const manager = getManager();
    if (!manager) return { sharedAgents: [], sharedModels: [] };
    return {
      sharedAgents: manager.getLocalP2PAgents(),
      sharedModels: manager.getLocalSharedModels(),
    };
  });

  // GET /api/p2p/agents
  fastify.get('/agents', async (_req, reply) => {
    const manager = getManager();
    if (!manager) return reply.status(200).send([]);
    return manager.getRemoteAgents();
  });

  // POST /api/p2p/agents/:peerId/:agentName/stream
  fastify.post<{ Params: InvokeParams; Body: InvokeBody }>(
    '/agents/:peerId/:agentName/stream',
    async (request, reply) => {
      const manager = getManager();
      if (!manager) {
        return reply.status(503).send({ error: 'P2P not enabled' });
      }

      const { peerId, agentName } = request.params;
      const { input, sessionId } = request.body;
      const sid = sessionId || `p2p-${peerId}-${Date.now()}`;

      const taskManager = fastify.orchestrator.tasks.getManager();
      const peerName = manager.getPeers().find(p => p.peerId === peerId)?.peerName ?? peerId.slice(0, 8);
      const task = taskManager.trackP2P('agent', agentName, input, {
        direction: 'outgoing',
        peerId,
        peerName,
      }, sid);

      const abortController = new AbortController();
      taskManager.registerAbort(task.id, abortController);

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      reply.raw.on('close', () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      });

      try {
        const stream = manager.invokeRemoteAgent(peerId, agentName, input, sid, abortController.signal);
        let totalCharsConsumed = 0;

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;

          if (typeof chunk === 'string') {
            totalCharsConsumed += chunk.length;
            reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: chunk })}\n\n`);
          } else {
            if (chunk && typeof chunk === 'object' && 'content' in chunk) totalCharsConsumed += String((chunk as any).content).length;
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        }

        // Record consumed tokens (estimate from content)
        if (totalCharsConsumed > 0) {
          manager.recordConsumedTokens({ agent: agentName, inputTokens: 0, outputTokens: Math.ceil(totalCharsConsumed / 4) });
        }

        if (!abortController.signal.aborted) {
          taskManager.resolve(task.id, { output: 'p2p remote agent stream completed' });
          reply.raw.write('data: [DONE]\n\n');
        } else {
          taskManager.cancelTask(task.id);
        }
        reply.raw.end();
      } catch (error) {
        if (abortController.signal.aborted) {
          taskManager.cancelTask(task.id);
          reply.raw.end();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        taskManager.reject(task.id, error);
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        reply.raw.end();
      } finally {
        taskManager.unregisterAbort(task.id);
      }
    }
  );

  // GET /api/p2p/llms
  fastify.get('/llms', async (_req, reply) => {
    const manager = getManager();
    if (!manager) return reply.status(200).send([]);
    return manager.getRemoteModels();
  });

  // POST /api/p2p/llms/:peerId/:modelName/stream
  fastify.post<{ Params: LLMStreamParams; Body: LLMStreamBody }>(
    '/llms/:peerId/:modelName/stream',
    async (request, reply) => {
      const manager = getManager();
      if (!manager) {
        return reply.status(503).send({ error: 'P2P not enabled' });
      }

      const { peerId, modelName } = request.params;
      const { message, sessionId, attachments } = request.body;
      const sid = sessionId || `p2p-llm-${peerId}-${Date.now()}`;

      const taskManager = fastify.orchestrator.tasks.getManager();
      const peerName = manager.getPeers().find(p => p.peerId === peerId)?.peerName ?? peerId.slice(0, 8);
      const task = taskManager.trackP2P('llm', modelName, { message }, {
        direction: 'outgoing',
        peerId,
        peerName,
      }, sid);

      // Manage conversation history on caller side
      const store = fastify.orchestrator.memory.getStore();
      store.addMessage(sid, { role: 'human', content: message });
      const history = store.getMessages(sid);

      const wireMessages = history.map(m => ({
        role: m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : m.role,
        content: typeof m.content === 'string' ? m.content : '',
      }));

      // Attach images to the last user message (the one we just added)
      if (attachments?.length) {
        const last = wireMessages[wireMessages.length - 1];
        if (last && last.role === 'user') {
          const parts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mediaType: string }> = [];
          if (last.content) parts.push({ type: 'text', text: last.content as string });
          for (const att of attachments) {
            if (att.mediaType.startsWith('image/')) {
              parts.push({ type: 'image', data: att.data, mediaType: att.mediaType });
            } else {
              // Non-image files: include as labeled text
              const label = att.name ? `[File: ${att.name}]` : '[Attached file]';
              parts.push({ type: 'text', text: `${label}\n(base64 data omitted — non-image attachment)` });
            }
          }
          last.content = parts as any;
        }
      }

      const abortController = new AbortController();
      taskManager.registerAbort(task.id, abortController);

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      reply.raw.on('close', () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      });

      let fullContent = '';
      let usageAccumulator: { input_tokens: number; output_tokens: number } | null = null;

      try {
        const stream = manager.invokeRemoteModelStream(peerId, modelName, {
          messages: wireMessages,
        }, abortController.signal);

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;

          if (chunk.type === 'content') {
            fullContent += chunk.content;
            reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: chunk.content })}\n\n`);
          } else if (chunk.type === 'thinking') {
            reply.raw.write(`data: ${JSON.stringify({ type: 'thinking', content: chunk.content })}\n\n`);
          } else if (chunk.type === 'usage') {
            usageAccumulator = { input_tokens: chunk.input_tokens, output_tokens: chunk.output_tokens };
            reply.raw.write(`data: ${JSON.stringify({ type: 'usage', input_tokens: chunk.input_tokens, output_tokens: chunk.output_tokens, total_tokens: chunk.total_tokens })}\n\n`);
          }
        }

        // Store assistant response
        if (fullContent) {
          store.addMessage(sid, { role: 'ai', content: fullContent });
        }

        // Record consumed tokens
        if (usageAccumulator) {
          manager.recordConsumedTokens({ model: modelName, inputTokens: usageAccumulator.input_tokens, outputTokens: usageAccumulator.output_tokens });
        } else if (fullContent) {
          // Estimate from content length if no usage data
          manager.recordConsumedTokens({ model: modelName, inputTokens: 0, outputTokens: Math.ceil(fullContent.length / 4) });
        }

        if (!abortController.signal.aborted) {
          taskManager.resolve(task.id, { output: 'p2p remote llm stream completed' });
          reply.raw.write('data: [DONE]\n\n');
        } else {
          taskManager.cancelTask(task.id);
        }
        reply.raw.end();
      } catch (error) {
        if (abortController.signal.aborted) {
          taskManager.cancelTask(task.id);
          reply.raw.end();
          return;
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        taskManager.reject(task.id, error);
        reply.raw.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
        reply.raw.end();
      } finally {
        taskManager.unregisterAbort(task.id);
      }
    }
  );

  // GET /api/p2p/leaderboard — token leaderboard for current network
  fastify.get('/leaderboard', async (_req, reply) => {
    const manager = getManager();
    if (!manager) return reply.status(200).send([]);
    return manager.getLeaderboard();
  });

  // GET /api/p2p/stats — own detailed stats for current network
  fastify.get('/stats', async (_req, reply) => {
    const manager = getManager();
    if (!manager) return reply.status(200).send(null);
    return manager.getOwnStats();
  });

  // POST /api/p2p/video/generate — Distributed video generation via P2P
  fastify.post<{ Body: { prompt: string; model?: string; settings?: Partial<VideoSettings> } }>(
    '/video/generate',
    async (request, reply) => {
      const manager = getManager();
      if (!manager) {
        return reply.status(503).send({ error: 'P2P not enabled' });
      }

      const { prompt, model = 'wan2.2', settings: userSettings } = request.body as any;
      if (!prompt || typeof prompt !== 'string') {
        return reply.status(400).send({ error: 'prompt is required' });
      }

      const modelRef = model.toLowerCase();
      const peers = manager.getRemoteModelsByName(modelRef, 'video');
      if (peers.length === 0) {
        return reply.status(404).send({ error: `No P2P peers found sharing model "${model}"`, availableModels: manager.getRemoteModels().map(l => l.model) });
      }

      const settings: VideoSettings = {
        totalFrames: userSettings?.totalFrames ?? 9,
        width: userSettings?.width ?? 832,
        height: userSettings?.height ?? 480,
        cfgScale: userSettings?.cfgScale ?? 5,
        steps: userSettings?.steps ?? 2.5,
        flowShift: userSettings?.flowShift ?? 5,
        fps: userSettings?.fps ?? 16,
        ...(userSettings?.seed !== undefined ? { seed: userSettings.seed } : {}),
      };

      // SSE stream for progress updates
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      const abortController = new AbortController();
      reply.raw.on('close', () => { if (!abortController.signal.aborted) abortController.abort(); });

      // Distribute frames across peers
      const framesPerPeer = Math.ceil(settings.totalFrames / peers.length);
      const frameMap = new Map<number, string>(); // frameIndex → base64 data
      const errors: string[] = [];

      reply.raw.write(`data: ${JSON.stringify({ type: 'status', message: `Distributing ${settings.totalFrames} frames across ${peers.length} peer(s)` })}\n\n`);

      const peerTasks = peers.map(async (peer: RemoteModel, idx: number) => {
        const start = idx * framesPerPeer;
        const end = Math.min(start + framesPerPeer, settings.totalFrames);
        if (start >= settings.totalFrames) return;

        try {
          for (let frameIndex = start; frameIndex < end; frameIndex++) {
            if (abortController.signal.aborted) break;
            const result = await manager.invokeRemoteModelTask(
              peer.peerId, peer.name, 'video_frame',
              {
                prompt,
                width: settings.width,
                height: settings.height,
                steps: settings.steps,
                cfgScale: settings.cfgScale,
                seed: settings.seed,
                frameIndex,
                totalFrames: settings.totalFrames,
              },
              abortController.signal,
            );
            frameMap.set(frameIndex, result.data);
            reply.raw.write(`data: ${JSON.stringify({ type: 'frame', frameIndex, total: settings.totalFrames, peer: peer.peerName })}\n\n`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${peer.peerName}: ${msg}`);
        }
      });

      await Promise.all(peerTasks);

      reply.raw.write(`data: ${JSON.stringify({ type: 'status', message: `Received ${frameMap.size}/${settings.totalFrames} frames. Stitching...` })}\n\n`);

      // Write frames to disk and stitch
      const fs = await import('fs/promises');
      const pathMod = await import('path');
      const generatedDir = pathMod.default.join(fastify.orchestrator.workspaceRoot, '.generated');
      const videoId = `video_${Date.now()}`;
      const framesDir = pathMod.default.join(generatedDir, videoId);
      await fs.mkdir(framesDir, { recursive: true });

      for (let i = 0; i < settings.totalFrames; i++) {
        const data = frameMap.get(i);
        if (data) {
          const padded = String(i + 1).padStart(6, '0');
          await fs.writeFile(pathMod.default.join(framesDir, `frame_${padded}.png`), Buffer.from(data, 'base64'));
        }
      }

      // Try stitching with ffmpeg
      const outputPath = pathMod.default.join(generatedDir, `${videoId}.mp4`);
      let resultPath = framesDir;
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        const framePattern = pathMod.default.join(framesDir, 'frame_%06d.png');
        await execFileAsync('ffmpeg', [
          '-y', '-framerate', String(settings.fps), '-i', framePattern,
          '-vf', `minterpolate=fps=${settings.fps * 2}:mi_mode=blend`,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'medium',
          outputPath,
        ], { timeout: 300_000 });
        resultPath = outputPath;
      } catch {
        // Fall back to raw frames directory
      }

      const relativePath = `/generated/${pathMod.default.relative(generatedDir, resultPath)}`;
      reply.raw.write(`data: ${JSON.stringify({ type: 'complete', video: relativePath, framesGenerated: frameMap.size, totalFrames: settings.totalFrames, peersUsed: peers.length, ...(errors.length ? { warnings: errors } : {}) })}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  );
};
