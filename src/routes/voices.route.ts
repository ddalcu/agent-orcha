import type { FastifyPluginAsync } from 'fastify';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../lib/logger.ts';

interface VoiceParams {
  filename: string;
}

export const voicesRoutes: FastifyPluginAsync = async (fastify) => {
  const voicesDir = () => path.join(fastify.orchestrator.workspaceRoot, 'voices');

  /** List available .wav voice files */
  fastify.get('/', async () => {
    const dir = voicesDir();
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const voices = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.wav')) continue;
        const stat = await fs.stat(path.join(dir, entry.name));
        voices.push({
          filename: entry.name,
          name: entry.name.replace(/\.wav$/, ''),
          size: stat.size,
        });
      }
      voices.sort((a, b) => a.name.localeCompare(b.name));
      return voices;
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      logger.error(`Failed to list voices: ${err.message}`);
      return [];
    }
  });

  /** Get voice file as base64 for attachment */
  fastify.get<{ Params: VoiceParams }>('/:filename', async (request, reply) => {
    const filename = request.params.filename;
    if (!filename.endsWith('.wav') || filename.includes('..') || filename.includes('/')) {
      return reply.status(400).send({ error: 'Invalid filename' });
    }

    const filePath = path.join(voicesDir(), filename);
    try {
      const data = await fs.readFile(filePath);
      return {
        data: data.toString('base64'),
        mediaType: 'audio/wav',
        name: filename,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return reply.status(404).send({ error: 'Voice not found' });
      }
      logger.error(`Failed to read voice file: ${err.message}`);
      return reply.status(500).send({ error: 'Failed to read voice file' });
    }
  });
};
