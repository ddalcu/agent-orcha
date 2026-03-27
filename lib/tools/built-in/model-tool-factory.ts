import * as fs from 'fs/promises';
import * as path from 'path';
import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { ImageModelConfig, TtsModelConfig } from '../../llm/llm-config.ts';
import type { P2PManager } from '../../p2p/p2p-manager.ts';
import type { LeverageMode } from '../../agents/types.ts';
import { OmniModelCache } from '../../llm/providers/omni-model-cache.ts';
import { logger } from '../../logger.ts';

interface P2PDeps {
  manager: P2PManager;
  leverage: LeverageMode;
}

let _generatedDir = '';
let _workspaceRoot = '';

export function setGeneratedDir(dir: string): void {
  _generatedDir = dir;
}

export function setWorkspaceRoot(dir: string): void {
  _workspaceRoot = dir;
}

async function generateImageLocally(_name: string, config: ImageModelConfig, args: { input: string }): Promise<string | null> {
  const resolve = (p?: string) => p ? (path.isAbsolute(p) ? p : path.join(_workspaceRoot, p)) : undefined;
  const modelPath = resolve(config.modelPath);
  if (!modelPath) return null;

  const imageModel = await OmniModelCache.getImageModel(modelPath, {
    ...(config.clipL ? { clipLPath: resolve(config.clipL) } : {}),
    ...(config.t5xxl ? { t5xxlPath: resolve(config.t5xxl) } : {}),
    ...(config.llm ? { llmPath: resolve(config.llm) } : {}),
    ...(config.vae ? { vaePath: resolve(config.vae) } : {}),
  });

  const buffer = await imageModel.generate(args.input, {
    steps: config.steps,
    width: config.width,
    height: config.height,
  });

  await fs.mkdir(_generatedDir, { recursive: true });
  const fileName = `image_${Date.now()}.png`;
  const filePath = path.join(_generatedDir, fileName);
  await fs.writeFile(filePath, buffer);

  return JSON.stringify({ __modelTask: true, task: 'text-to-image', image: `/generated/${fileName}` });
}

async function generateImageRemotely(name: string, config: ImageModelConfig, args: { input: string }, p2pDeps: P2PDeps): Promise<string | null> {
  const remotePeers = p2pDeps.manager.getRemoteModelsByName(name);
  if (remotePeers.length === 0) return null;

  const peer = p2pDeps.manager.selectBestPeer(remotePeers);
  logger.info(`[ModelToolFactory] Using remote peer "${peer.peerName}" for image model "${name}"`);
  const result = await p2pDeps.manager.invokeRemoteModelTask(
    peer.peerId, peer.name, 'image',
    { prompt: args.input, steps: config.steps, width: config.width, height: config.height },
  );

  await fs.mkdir(_generatedDir, { recursive: true });
  const fileName = `image_${Date.now()}.png`;
  const filePath = path.join(_generatedDir, fileName);
  await fs.writeFile(filePath, Buffer.from(result.data, 'base64'));

  return JSON.stringify({ __modelTask: true, task: 'text-to-image', image: `/generated/${fileName}`, remote: peer.peerName });
}

function createImageTool(name: string, config: ImageModelConfig, p2pDeps?: P2PDeps): StructuredTool {
  return tool(
    async (args) => {
      const mode = p2pDeps?.leverage || false;

      if (mode === 'remote-only') {
        if (!p2pDeps) return JSON.stringify({ __modelTask: true, error: 'P2P not available (remote-only)' });
        try {
          const result = await generateImageRemotely(name, config, args, p2pDeps);
          if (result) return result;
        } catch (err) {
          logger.error(`[ModelToolFactory] Remote image generation failed:`, err);
          return JSON.stringify({ __modelTask: true, error: `Remote image generation failed: ${(err as Error).message}` });
        }
        return JSON.stringify({ __modelTask: true, error: 'No remote peers available for image generation (remote-only)' });
      }

      if (mode === 'remote-first' && p2pDeps) {
        try {
          const result = await generateImageRemotely(name, config, args, p2pDeps);
          if (result) return result;
        } catch (remoteErr) {
          logger.warn(`[ModelToolFactory] Remote image generation failed, trying local:`, remoteErr);
        }
        // Fall through to local
        try {
          const result = await generateImageLocally(name, config, args);
          if (result) return result;
        } catch (localErr) {
          logger.error(`[ModelToolFactory] Local image generation also failed:`, localErr);
          return JSON.stringify({ __modelTask: true, error: `Image generation failed (remote and local): ${(localErr as Error).message}` });
        }
        return JSON.stringify({ __modelTask: true, error: 'No modelPath configured and remote generation failed' });
      }

      // local-first (default when leverage is set) or no leverage
      try {
        const result = await generateImageLocally(name, config, args);
        if (result) return result;
      } catch (localErr) {
        logger.warn(`[ModelToolFactory] Local image generation failed, checking P2P fallback:`, localErr);
      }

      if (p2pDeps && mode) {
        try {
          const result = await generateImageRemotely(name, config, args, p2pDeps);
          if (result) return result;
        } catch (remoteErr) {
          logger.error(`[ModelToolFactory] Remote image generation also failed:`, remoteErr);
          return JSON.stringify({ __modelTask: true, error: `Image generation failed (local and remote): ${(remoteErr as Error).message}` });
        }
      }

      return JSON.stringify({ __modelTask: true, error: config.modelPath
        ? 'Local generation failed and no remote peers available'
        : 'No modelPath configured and no remote peers available' });
    },
    {
      name: 'generate_image',
      description: `Generate an image using ${name}. ${config.description}`.trim(),
      schema: z.object({
        input: z.string().describe('Text prompt describing the image to generate'),
      }),
    },
  );
}

async function generateTtsLocally(config: TtsModelConfig, args: { text: string; voice?: string; referenceAudio?: string }): Promise<string | null> {
  const resolve = (p: string) => path.isAbsolute(p) ? p : path.join(_workspaceRoot, p);
  if (!config.modelPath) return null;

  const modelPath = resolve(config.modelPath);
  const ttsModel = await OmniModelCache.getTtsModel(modelPath);

  const buffer = await ttsModel.speak(args.text, {
    ...(args.referenceAudio ? { referenceAudioPath: resolve(args.referenceAudio) } : {}),
  });

  await fs.mkdir(_generatedDir, { recursive: true });
  const fileName = `audio_${Date.now()}.wav`;
  const filePath = path.join(_generatedDir, fileName);
  await fs.writeFile(filePath, buffer);

  return JSON.stringify({ __modelTask: true, task: 'text-to-speech', audio: `/generated/${fileName}` });
}

async function generateTtsRemotely(name: string, args: { text: string; voice?: string; referenceAudio?: string }, p2pDeps: P2PDeps): Promise<string | null> {
  const remotePeers = p2pDeps.manager.getRemoteModelsByName(name);
  if (remotePeers.length === 0) return null;

  const peer = p2pDeps.manager.selectBestPeer(remotePeers);
  logger.info(`[ModelToolFactory] Using remote peer "${peer.peerName}" for TTS model "${name}"`);
  const result = await p2pDeps.manager.invokeRemoteModelTask(
    peer.peerId, peer.name, 'tts',
    { text: args.text, voice: args.voice, referenceAudio: args.referenceAudio },
  );

  await fs.mkdir(_generatedDir, { recursive: true });
  const fileName = `audio_${Date.now()}.wav`;
  const filePath = path.join(_generatedDir, fileName);
  await fs.writeFile(filePath, Buffer.from(result.data, 'base64'));

  return JSON.stringify({ __modelTask: true, task: 'text-to-speech', audio: `/generated/${fileName}`, remote: peer.peerName });
}

function createTtsTool(name: string, config: TtsModelConfig, p2pDeps?: P2PDeps): StructuredTool {
  return tool(
    async (args) => {
      const mode = p2pDeps?.leverage || false;

      if (mode === 'remote-only') {
        if (!p2pDeps) return JSON.stringify({ __modelTask: true, error: 'P2P not available (remote-only)' });
        try {
          const result = await generateTtsRemotely(name, args, p2pDeps);
          if (result) return result;
        } catch (err) {
          logger.error(`[ModelToolFactory] Remote TTS failed:`, err);
          return JSON.stringify({ __modelTask: true, error: `Remote TTS failed: ${(err as Error).message}` });
        }
        return JSON.stringify({ __modelTask: true, error: 'No remote peers available for TTS (remote-only)' });
      }

      if (mode === 'remote-first' && p2pDeps) {
        try {
          const result = await generateTtsRemotely(name, args, p2pDeps);
          if (result) return result;
        } catch (remoteErr) {
          logger.warn(`[ModelToolFactory] Remote TTS failed, trying local:`, remoteErr);
        }
        try {
          const result = await generateTtsLocally(config, args);
          if (result) return result;
        } catch (localErr) {
          logger.error(`[ModelToolFactory] Local TTS also failed:`, localErr);
          return JSON.stringify({ __modelTask: true, error: `TTS failed (remote and local): ${(localErr as Error).message}` });
        }
        return JSON.stringify({ __modelTask: true, error: 'No modelPath configured and remote TTS failed' });
      }

      // local-first (default when leverage is set) or no leverage
      try {
        const result = await generateTtsLocally(config, args);
        if (result) return result;
      } catch (localErr) {
        logger.warn(`[ModelToolFactory] Local TTS failed, checking P2P fallback:`, localErr);
      }

      if (p2pDeps && mode) {
        try {
          const result = await generateTtsRemotely(name, args, p2pDeps);
          if (result) return result;
        } catch (remoteErr) {
          logger.error(`[ModelToolFactory] Remote TTS also failed:`, remoteErr);
          return JSON.stringify({ __modelTask: true, error: `TTS failed (local and remote): ${(remoteErr as Error).message}` });
        }
      }

      return JSON.stringify({ __modelTask: true, error: config.modelPath
        ? 'Local TTS failed and no remote peers available'
        : 'No modelPath configured and no remote peers available' });
    },
    {
      name: 'generate_tts',
      description: `Generate speech using ${name}. ${config.description}`.trim(),
      schema: z.object({
        text: z.string().describe('Text to convert to speech'),
        voice: z.string().optional().describe('Voice name to use'),
        referenceAudio: z.string().optional().describe('Path to a reference audio WAV file for voice cloning (5-10 seconds, 24kHz mono recommended)'),
      }),
    },
  );
}

export function buildModelTools(
  imageConfigs: Array<{ name: string; config: ImageModelConfig }>,
  ttsConfigs: Array<{ name: string; config: TtsModelConfig }>,
  p2pDeps?: P2PDeps,
): { image?: StructuredTool; tts?: StructuredTool } {
  const result: { image?: StructuredTool; tts?: StructuredTool } = {};
  if (imageConfigs.length > 0) {
    result.image = createImageTool(imageConfigs[0]!.name, imageConfigs[0]!.config, p2pDeps);
  }
  if (ttsConfigs.length > 0) {
    result.tts = createTtsTool(ttsConfigs[0]!.name, ttsConfigs[0]!.config, p2pDeps);
  }
  return result;
}
