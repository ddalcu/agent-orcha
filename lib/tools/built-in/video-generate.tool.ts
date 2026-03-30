import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from '../../utils/child-process.ts';
import { promisify } from 'util';
import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { P2PManager } from '../../p2p/p2p-manager.ts';
import type { VideoSettings } from '../../p2p/types.ts';
import type { LeverageMode } from '../../agents/types.ts';
import { logger } from '../../logger.ts';

const execFileAsync = promisify(execFile);

interface VideoToolDeps {
  generatedDir: string;
  p2pManager?: P2PManager;
  leverage?: LeverageMode;
}

/**
 * Distribute frame ranges across available workers as evenly as possible.
 */
function distributeFrames(totalFrames: number, workerCount: number): Array<{ start: number; end: number }> {
  const framesPerWorker = Math.ceil(totalFrames / workerCount);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < workerCount; i++) {
    const start = i * framesPerWorker;
    const end = Math.min(start + framesPerWorker, totalFrames);
    if (start < totalFrames) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

/**
 * Stitch PNG frames into an MP4 video using ffmpeg.
 * Falls back to creating an animated GIF if ffmpeg is unavailable.
 */
async function stitchFrames(framesDir: string, outputPath: string, fps: number): Promise<string> {
  const framePattern = path.join(framesDir, 'frame_%06d.png');

  try {
    // Use minterpolate to generate smooth in-between frames for better continuity.
    // The blend mode creates crossfades between frames, softening discontinuities.
    await execFileAsync('ffmpeg', [
      '-y',
      '-framerate', String(fps),
      '-i', framePattern,
      '-vf', `minterpolate=fps=${fps * 2}:mi_mode=blend`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-preset', 'medium',
      outputPath,
    ], { timeout: 300_000 });
    return outputPath;
  } catch (ffmpegErr) {
    logger.warn('[VideoTool] ffmpeg MP4 failed, trying GIF fallback:', ffmpegErr);

    const gifPath = outputPath.replace(/\.mp4$/, '.gif');
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-framerate', String(fps),
        '-i', framePattern,
        '-vf', `fps=${fps},scale=-1:-1:flags=lanczos`,
        gifPath,
      ], { timeout: 120_000 });
      return gifPath;
    } catch (gifErr) {
      logger.warn('[VideoTool] ffmpeg unavailable — returning frames directory:', gifErr);
      return framesDir;
    }
  }
}

/**
 * Generate frames locally using the image model via OmniModelCache.
 */
async function generateLocalFrames(
  generatedDir: string,
  prompt: string,
  range: { start: number; end: number },
  totalFrames: number,
  settings: VideoSettings,
  frameMap: Map<number, Buffer>,
  peerContributions: Map<string, number>,
): Promise<void> {
  const { OmniModelCache } = await import('../../llm/providers/omni-model-cache.ts');
  const { getImageConfig } = await import('../../llm/llm-config.ts');

  // Find the active image config to resolve model path
  const imageConfig = getImageConfig('omni');
  if (!imageConfig) {
    throw new Error('No image model configured — load a video/image model first');
  }
  const modelPath = imageConfig.modelPath;
  if (!modelPath) {
    throw new Error('Image model has no modelPath configured');
  }
  const resolvedPath = path.isAbsolute(modelPath)
    ? modelPath
    : path.join(generatedDir, '..', modelPath);

  for (let i = range.start; i < range.end; i++) {
    const progress = i / Math.max(totalFrames - 1, 1);
    const timeLabel = progress < 0.33 ? 'beginning' : progress < 0.66 ? 'middle' : 'end';
    const framePrompt = `${prompt}, continuous animation sequence, ${timeLabel} of scene, smooth motion, consistent style and composition, frame ${i + 1} of ${totalFrames}`;
    const frameSeed = settings.seed !== undefined ? settings.seed + i : undefined;

    const imageModel = await OmniModelCache.getImageModel(resolvedPath, {});
    const buffer = await imageModel.generate(framePrompt, {
      steps: settings.steps,
      width: settings.width,
      height: settings.height,
      ...(settings.cfgScale !== undefined ? { cfgScale: settings.cfgScale } : {}),
      ...(frameSeed !== undefined ? { seed: frameSeed } : {}),
    });
    frameMap.set(i, buffer);
    peerContributions.set('local', (peerContributions.get('local') ?? 0) + 1);
    logger.info(`[VideoTool] Frame ${i + 1}/${totalFrames} from local (${frameMap.size}/${totalFrames} total)`);
  }
}

/**
 * Generate frames on a remote peer via P2P.
 */
async function generateRemoteFrames(
  p2pManager: P2PManager,
  peer: { peerId: string; name: string; peerName: string },
  prompt: string,
  range: { start: number; end: number },
  totalFrames: number,
  settings: VideoSettings,
  frameMap: Map<number, Buffer>,
  peerContributions: Map<string, number>,
): Promise<void> {
  for (let i = range.start; i < range.end; i++) {
    const progress = i / Math.max(totalFrames - 1, 1);
    const timeLabel = progress < 0.33 ? 'beginning' : progress < 0.66 ? 'middle' : 'end';
    const framePrompt = `${prompt}, continuous animation sequence, ${timeLabel} of scene, smooth motion, consistent style and composition, frame ${i + 1} of ${totalFrames}`;
    const frameSeed = settings.seed !== undefined ? settings.seed + i : undefined;

    const result = await p2pManager.invokeRemoteModelTask(
      peer.peerId, peer.name, 'video_frame',
      {
        prompt: framePrompt, width: settings.width, height: settings.height,
        steps: settings.steps, cfgScale: settings.cfgScale,
        ...(frameSeed !== undefined ? { seed: frameSeed } : {}),
        frameIndex: i, totalFrames,
      },
    );
    frameMap.set(i, Buffer.from(result.data, 'base64'));
    peerContributions.set(peer.peerName, (peerContributions.get(peer.peerName) ?? 0) + 1);
    logger.info(`[VideoTool] Frame ${i + 1}/${totalFrames} from "${peer.peerName}" (${frameMap.size}/${totalFrames} total)`);
  }
}

/**
 * Check if a local image model is available for video frame generation.
 */
async function hasLocalModel(): Promise<boolean> {
  const { getImageConfig } = await import('../../llm/llm-config.ts');
  const config = getImageConfig('omni');
  return !!config?.modelPath;
}

/**
 * Collect frames, write to disk, and stitch into video.
 */
async function finalizeVideo(
  frameMap: Map<number, Buffer>,
  totalFrames: number,
  fps: number,
  generatedDir: string,
  peerContributions: Map<string, number>,
  errors: string[],
): Promise<string> {
  const videoId = `video_${Date.now()}`;
  const framesDir = path.join(generatedDir, videoId);
  await fs.mkdir(framesDir, { recursive: true });

  let writtenFrames = 0;
  for (let i = 0; i < totalFrames; i++) {
    const frameData = frameMap.get(i);
    if (frameData) {
      const paddedIndex = String(i + 1).padStart(6, '0');
      await fs.writeFile(path.join(framesDir, `frame_${paddedIndex}.png`), frameData);
      writtenFrames++;
    }
  }

  if (writtenFrames === 0) {
    return JSON.stringify({
      __modelTask: true,
      error: `No frames were generated. Errors: ${errors.join('; ')}`,
    });
  }

  logger.info(`[VideoTool] ${writtenFrames}/${totalFrames} frames received. Stitching video...`);
  await fs.mkdir(generatedDir, { recursive: true });
  const outputPath = path.join(generatedDir, `${videoId}.mp4`);
  const result = await stitchFrames(framesDir, outputPath, fps);
  const relativePath = `/generated/${path.relative(generatedDir, result)}`;

  const contributions: Record<string, number> = {};
  for (const [name, count] of peerContributions) {
    contributions[name] = count;
  }

  return JSON.stringify({
    __modelTask: true,
    task: 'text-to-video',
    video: relativePath,
    framesGenerated: writtenFrames,
    totalFrames,
    peersUsed: Object.keys(contributions).length,
    peerContributions: contributions,
    duration: `${(totalFrames / fps).toFixed(1)}s at ${fps}fps`,
    ...(errors.length ? { warnings: errors } : {}),
  });
}

export function createVideoGenerateTool(deps: VideoToolDeps): StructuredTool {
  return tool(
    async (args) => {
      const { prompt, model, totalFrames, width, height, cfgScale, steps, seed, fps } = args;
      const modelRef = model || 'wan2.2';
      const mode = deps.leverage || false;

      const settings: VideoSettings = {
        totalFrames, width, height, cfgScale, steps, fps,
        ...(seed !== undefined ? { seed } : {}),
      };

      const frameMap = new Map<number, Buffer>();
      const errors: string[] = [];
      const peerContributions = new Map<string, number>();

      try {
        // Discover workers based on leverage mode
        const hasLocal = await hasLocalModel();
        let remotePeers: Array<{ peerId: string; name: string; peerName: string }> = [];

        if (mode && deps.p2pManager) {
          remotePeers = deps.p2pManager.getRemoteModelsByName(modelRef, 'image');
        }

        // ── remote-only: only use P2P peers ──
        if (mode === 'remote-only') {
          if (remotePeers.length === 0) {
            return JSON.stringify({
              __modelTask: true,
              error: `No remote peers found with model "${modelRef}" (remote-only mode).`,
            });
          }
          logger.info(`[VideoTool] remote-only: ${remotePeers.length} peer(s) for ${totalFrames} frames`);
          const ranges = distributeFrames(totalFrames, remotePeers.length);
          const tasks: Promise<void>[] = [];
          for (let idx = 0; idx < remotePeers.length; idx++) {
            const range = ranges[idx];
            if (!range) continue;
            const peer = remotePeers[idx]!;
            tasks.push(generateRemoteFrames(deps.p2pManager!, peer, prompt, range, totalFrames, settings, frameMap, peerContributions)
              .catch(err => { errors.push(`${peer.peerName}: ${(err as Error).message}`); }));
          }
          await Promise.all(tasks);
          return finalizeVideo(frameMap, totalFrames, fps, deps.generatedDir, peerContributions, errors);
        }

        // ── remote-first: try P2P, fall back to local ──
        if (mode === 'remote-first' && deps.p2pManager) {
          const totalWorkers = remotePeers.length + (hasLocal ? 1 : 0);
          if (totalWorkers === 0) {
            return JSON.stringify({ __modelTask: true, error: `No workers available for model "${modelRef}".` });
          }
          logger.info(`[VideoTool] remote-first: ${totalWorkers} worker(s) (${remotePeers.length} remote${hasLocal ? ' + local' : ''}) for ${totalFrames} frames`);
          const ranges = distributeFrames(totalFrames, totalWorkers);
          const tasks: Promise<void>[] = [];
          for (let idx = 0; idx < remotePeers.length; idx++) {
            const range = ranges[idx];
            if (!range) continue;
            const peer = remotePeers[idx]!;
            tasks.push(generateRemoteFrames(deps.p2pManager, peer, prompt, range, totalFrames, settings, frameMap, peerContributions)
              .catch(err => { errors.push(`${peer.peerName}: ${(err as Error).message}`); }));
          }
          if (hasLocal) {
            const localRange = ranges[remotePeers.length];
            if (localRange) {
              tasks.push(generateLocalFrames(deps.generatedDir, prompt, localRange, totalFrames, settings, frameMap, peerContributions)
                .catch(err => { errors.push(`local: ${(err as Error).message}`); }));
            }
          }
          await Promise.all(tasks);
          return finalizeVideo(frameMap, totalFrames, fps, deps.generatedDir, peerContributions, errors);
        }

        // ── local-first (default): generate locally, use P2P as fallback for extra workers ──
        if (!hasLocal && remotePeers.length === 0) {
          return JSON.stringify({
            __modelTask: true,
            error: `No video/image model loaded locally and no remote peers available. Load a video/image model first.`,
          });
        }

        // Distribute across local + any P2P peers if leverage is enabled
        const useRemote = mode && deps.p2pManager && remotePeers.length > 0;
        const totalWorkers = (hasLocal ? 1 : 0) + (useRemote ? remotePeers.length : 0);
        logger.info(`[VideoTool] local-first: ${totalWorkers} worker(s) (${useRemote ? remotePeers.length + ' remote + ' : ''}${hasLocal ? 'local' : 'no local'}) for ${totalFrames} frames`);
        const ranges = distributeFrames(totalFrames, totalWorkers);
        const tasks: Promise<void>[] = [];

        let rangeIdx = 0;
        // Local gets first range
        if (hasLocal) {
          const localRange = ranges[rangeIdx++];
          if (localRange) {
            tasks.push(generateLocalFrames(deps.generatedDir, prompt, localRange, totalFrames, settings, frameMap, peerContributions)
              .catch(err => { errors.push(`local: ${(err as Error).message}`); }));
          }
        }
        // Remote peers get remaining ranges
        if (useRemote) {
          for (const peer of remotePeers) {
            const range = ranges[rangeIdx++];
            if (!range) break;
            tasks.push(generateRemoteFrames(deps.p2pManager!, peer, prompt, range, totalFrames, settings, frameMap, peerContributions)
              .catch(err => { errors.push(`${peer.peerName}: ${(err as Error).message}`); }));
          }
        }

        await Promise.all(tasks);
        return finalizeVideo(frameMap, totalFrames, fps, deps.generatedDir, peerContributions, errors);
      } catch (err) {
        logger.error('[VideoTool] Video generation failed:', err);
        return JSON.stringify({
          __modelTask: true,
          error: `Video generation failed: ${(err as Error).message}`,
        });
      }
    },
    {
      name: 'generate_video',
      description:
        'Generate a video by creating frames with a video/image model and stitching them together. ' +
        'When P2P leverage is enabled, frames are distributed across network peers for faster generation. ' +
        'Use the video_settings from the session context if available.',
      schema: z.object({
        prompt: z.string().describe('Text prompt describing the video to generate'),
        model: z.string().optional().describe('Model name to use for generation (default: wan2.2). Matched against P2P peers by model name when leverage is enabled.'),
        totalFrames: z.number().default(24).describe('Total number of frames to generate'),
        width: z.number().default(512).describe('Frame width in pixels'),
        height: z.number().default(512).describe('Frame height in pixels'),
        cfgScale: z.number().default(7).describe('CFG scale for generation guidance'),
        steps: z.number().default(20).describe('Number of diffusion steps per frame'),
        seed: z.number().optional().describe('Random seed for reproducibility'),
        fps: z.number().default(12).describe('Frames per second for the output video'),
      }),
    },
  );
}
