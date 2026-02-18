import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../logger.js';

const DEFAULT_MAX_LINES = 100;

export class MemoryManager {
  private memoryDir: string;

  constructor(projectRoot: string) {
    this.memoryDir = path.join(projectRoot, '.memory');
  }

  private getFilePath(agentName: string): string {
    return path.join(this.memoryDir, `${agentName}.md`);
  }

  async load(agentName: string): Promise<string> {
    try {
      return await fs.readFile(this.getFilePath(agentName), 'utf-8');
    } catch {
      return '';
    }
  }

  async save(agentName: string, content: string, maxLines: number = DEFAULT_MAX_LINES): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    const truncated = this.truncateToMaxLines(content, maxLines);
    await fs.writeFile(this.getFilePath(agentName), truncated, 'utf-8');
    logger.info(`[MemoryManager] Saved memory for agent: ${agentName} (${truncated.split('\n').length} lines)`);
  }

  private truncateToMaxLines(content: string, maxLines: number): string {
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;
    return lines.slice(-maxLines).join('\n');
  }
}
