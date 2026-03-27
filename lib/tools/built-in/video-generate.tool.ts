import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { P2PManager } from '../../p2p/p2p-manager.ts';
import type { VideoSettings } from '../../p2p/types.ts';
import { logger } from '../../logger.ts';

const execFileAsync = promisify(execFile);

interface VideoToolDeps {
  p2pManager: P2PManager;
  generatedDir: string;
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
  localModelName: string,
  generatedDir: string,
  prompt: string,
  range: { start: number; end: number },
  totalFrames: number,
  settings: VideoSettings,
  frameMap: Map<number, Buffer>,
  peerContributions: Map<string, number>,
): Promise<void> {
  const { OmniModelCache } = await import('../../llm/providers/omni-model-cache.ts');
  const { getModelConfig } = await import('../../llm/llm-config.ts');

  const config = getModelConfig(localModelName);
  const modelPath = config.model;
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

export function createVideoGenerateTool(deps: VideoToolDeps): StructuredTool {
  return tool(
    async (args) => {
      const { prompt, model, totalFrames, width, height, cfgScale, steps, seed, fps } = args;
      const modelRef = model || 'wan2.2';

      try {
        // Find all peers sharing this model (remote + check local)
        const remotePeers = deps.p2pManager.getRemoteModelsByName(modelRef);
        const localModels = deps.p2pManager.getLocalSharedModels();
        const refLower = modelRef.toLowerCase();
        const localMatch = localModels.find(l =>
          l.name.toLowerCase() === refLower ||
          l.model.toLowerCase() === refLower ||
          l.model.toLowerCase().includes(refLower)
        );

        const hasLocal = !!localMatch;
        const totalWorkers = remotePeers.length + (hasLocal ? 1 : 0);

        if (totalWorkers === 0) {
          return JSON.stringify({
            __modelTask: true,
            error: `No peers (local or remote) found with model "${modelRef}". Make sure the model is loaded and shared via P2P.`,
          });
        }

        logger.info(`[VideoTool] Generating ${totalFrames} frames across ${totalWorkers} worker(s) (${remotePeers.length} remote${hasLocal ? ' + local' : ''}) using model "${modelRef}"`);

        const settings: VideoSettings = {
          totalFrames, width, height, cfgScale, steps, fps,
          ...(seed !== undefined ? { seed } : {}),
        };

        // Create temp directory for frames
        const videoId = `video_${Date.now()}`;
        const framesDir = path.join(deps.generatedDir, videoId);
        await fs.mkdir(framesDir, { recursive: true });

        // Distribute frames across all workers
        const ranges = distributeFrames(totalFrames, totalWorkers);
        const frameMap = new Map<number, Buffer>();
        const errors: string[] = [];
        const peerContributions = new Map<string, number>();
        const workerTasks: Promise<void>[] = [];

        // Remote peers
        for (let idx = 0; idx < remotePeers.length; idx++) {
          const range = ranges[idx];
          if (!range) continue;
          const peer = remotePeers[idx]!;
          logger.info(`[VideoTool] Remote "${peer.peerName}" generating frames ${range.start}-${range.end - 1}`);
          peerContributions.set(peer.peerName, 0);

          workerTasks.push((async () => {
            try {
              for (let i = range.start; i < range.end; i++) {
                const progress = i / Math.max(totalFrames - 1, 1);
                const timeLabel = progress < 0.33 ? 'beginning' : progress < 0.66 ? 'middle' : 'end';
                const framePrompt = `${prompt}, continuous animation sequence, ${timeLabel} of scene, smooth motion, consistent style and composition, frame ${i + 1} of ${totalFrames}`;
                const frameSeed = seed !== undefined ? seed + i : undefined;

                const result = await deps.p2pManager.invokeRemoteModelTask(
                  peer.peerId, peer.name, 'video_frame',
                  {
                    prompt: framePrompt, width, height, steps, cfgScale,
                    ...(frameSeed !== undefined ? { seed: frameSeed } : {}),
                    frameIndex: i, totalFrames,
                  },
                );
                frameMap.set(i, Buffer.from(result.data, 'base64'));
                peerContributions.set(peer.peerName, (peerContributions.get(peer.peerName) ?? 0) + 1);
                logger.info(`[VideoTool] Frame ${i + 1}/${totalFrames} from "${peer.peerName}" (${frameMap.size}/${totalFrames} total)`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error(`[VideoTool] Remote "${peer.peerName}" error:`, msg);
              errors.push(`${peer.peerName}: ${msg}`);
            }
          })());
        }

        // Local machine (if model is available)
        if (hasLocal && localMatch) {
          const localRange = ranges[remotePeers.length];
          if (localRange) {
            logger.info(`[VideoTool] Local generating frames ${localRange.start}-${localRange.end - 1}`);
            peerContributions.set('local', 0);

            workerTasks.push((async () => {
              try {
                await generateLocalFrames(
                  localMatch.name, deps.generatedDir, prompt,
                  localRange, totalFrames, settings, frameMap, peerContributions,
                );
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error('[VideoTool] Local generation error:', msg);
                errors.push(`local: ${msg}`);
              }
            })());
          }
        }

        await Promise.all(workerTasks);

        // Write frames to disk in order
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

        // Stitch frames into video
        await fs.mkdir(deps.generatedDir, { recursive: true });
        const outputPath = path.join(deps.generatedDir, `${videoId}.mp4`);
        const result = await stitchFrames(framesDir, outputPath, fps);
        const relativePath = `/generated/${path.relative(deps.generatedDir, result)}`;

        // Build peer contribution summary
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
          peersUsed: totalWorkers,
          peerContributions: contributions,
          duration: `${(totalFrames / fps).toFixed(1)}s at ${fps}fps`,
          ...(errors.length ? { warnings: errors } : {}),
        });
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
        'Generate a video by distributing frame generation across P2P peers sharing a video/image model. ' +
        'Frames are generated in parallel across the network, then stitched together locally. ' +
        'Use the video_settings from the session context if available.',
      schema: z.object({
        prompt: z.string().describe('Text prompt describing the video to generate'),
        model: z.string().optional().describe('Model name to use for generation (default: wan2.2). Matched against P2P peers by model name.'),
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
