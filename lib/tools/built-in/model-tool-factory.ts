import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { readdirSync } from 'fs';
import { promisify } from 'util';
import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { ImageModelConfig, TtsModelConfig } from '../../llm/llm-config.ts';
import type { P2PManager } from '../../p2p/p2p-manager.ts';
import type { LeverageMode } from '../../agents/types.ts';
import { OmniModelCache } from '../../llm/providers/omni-model-cache.ts';
import { logger } from '../../logger.ts';

const execFileAsync = promisify(execFile);

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

/** Find ffmpeg binary — check PATH first, then common install locations. */
function findFfmpeg(): string {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    if (process.platform !== 'win32') return 'ffmpeg';
    // WinGet installs to a deeply nested path not always in PATH
    const pkgsDir = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      const dirs = readdirSync(pkgsDir).filter((d: string) => /ffmpeg/i.test(d));
      for (const dir of dirs) {
        const base = path.join(pkgsDir, dir);
        const files = readdirSync(base, { recursive: true }) as (string | Buffer)[];
        const match = files.find((f) => String(f).endsWith('ffmpeg.exe'));
        if (match) {
          const fullPath = path.join(base, String(match));
          logger.info(`[TTS] Found ffmpeg at: ${fullPath}`);
          return fullPath;
        }
      }
    } catch (err: any) {
      logger.warn(`[TTS] WinGet ffmpeg scan failed: ${err.message}`);
    }
    return 'ffmpeg';
  }
}

let _ffmpegPath: string | null = null;
function getFfmpeg(): string {
  if (!_ffmpegPath) _ffmpegPath = findFfmpeg();
  return _ffmpegPath;
}

const MAX_REFERENCE_SECONDS = 15;

/** Probe audio duration in seconds via ffprobe. Returns null if probe fails. */
async function probeDuration(audioPath: string): Promise<number | null> {
  const ffprobe = getFfmpeg().replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath,
    ]);
    const secs = parseFloat(stdout.trim());
    return Number.isFinite(secs) ? secs : null;
  } catch {
    return null;
  }
}

/**
 * Ensure reference audio is a 24kHz mono WAV ≤ MAX_REFERENCE_SECONDS.
 * Converts format and/or trims via ffmpeg only when needed.
 * Returns the original path if no processing is required.
 */
async function ensureReferenceAudio(audioPath: string): Promise<string> {
  const ext = path.extname(audioPath).toLowerCase();
  const isWav = ext === '.wav';

  // If already WAV, check if trimming is needed
  if (isWav) {
    const duration = await probeDuration(audioPath);
    if (duration === null) {
      // ffprobe unavailable — pass through as-is rather than failing
      logger.debug(`[TTS] Could not probe WAV duration (ffprobe not available), passing through as-is`);
      return audioPath;
    }
    if (duration <= MAX_REFERENCE_SECONDS) {
      return audioPath; // already WAV and short enough
    }
    logger.info(`[TTS] Reference audio is ${duration.toFixed(1)}s, trimming to ${MAX_REFERENCE_SECONDS}s`);
  }

  const wavPath = isWav ? audioPath.replace(/\.wav$/i, '_trimmed.wav') : audioPath.replace(/\.[^.]+$/, '.wav');
  const ffmpegArgs = ['-y', '-i', audioPath, '-ar', '24000', '-ac', '1', '-t', String(MAX_REFERENCE_SECONDS), wavPath];

  logger.debug(`[TTS] Processing reference audio${!isWav ? ` ${ext} → WAV` : ''} using ffmpeg`);
  try {
    await execFileAsync(getFfmpeg(), ffmpegArgs);
    logger.info(`[TTS] Reference audio ready: ${wavPath}`);
    return wavPath;
  } catch (err: any) {
    throw new Error(`Failed to process reference audio — is ffmpeg installed? ${err.message}`);
  }
}

async function generateTtsLocally(config: TtsModelConfig, args: { text: string; voice?: string; referenceAudio?: string }): Promise<string | null> {
  const resolve = (p: string) => path.isAbsolute(p) ? p : path.join(_workspaceRoot, p);
  if (!config.modelPath) return null;

  const modelPath = resolve(config.modelPath);
  const ttsModel = await OmniModelCache.getTtsModel(modelPath);

  let referenceAudioPath: string | undefined;
  if (args.referenceAudio) {
    referenceAudioPath = await ensureReferenceAudio(resolve(args.referenceAudio));
  }

  const buffer = await ttsModel.speak(args.text, {
    ...(referenceAudioPath ? { referenceAudioPath } : {}),
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

  // Convert non-WAV audio locally before sending path to remote peer
  let referenceAudio = args.referenceAudio;
  if (referenceAudio) {
    const resolve = (p: string) => path.isAbsolute(p) ? p : path.join(_workspaceRoot, p);
    referenceAudio = await ensureReferenceAudio(resolve(referenceAudio));
  }

  const peer = p2pDeps.manager.selectBestPeer(remotePeers);
  logger.info(`[ModelToolFactory] Using remote peer "${peer.peerName}" for TTS model "${name}"`);
  const result = await p2pDeps.manager.invokeRemoteModelTask(
    peer.peerId, peer.name, 'tts',
    { text: args.text, voice: args.voice, referenceAudio },
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
      } catch (localErr: any) {
        logger.warn(`[ModelToolFactory] Local TTS failed, checking P2P fallback: ${localErr?.message || localErr}`);
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
        referenceAudio: z.string().optional().describe('Path to a reference audio file for voice cloning (WAV, MP3, M4A, etc. — 5-10 seconds, 24kHz mono recommended)'),
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
