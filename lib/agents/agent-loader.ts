import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { AgentDefinitionSchema, type AgentDefinition } from './types.ts';
import { logger } from '../logger.ts';

export class AgentLoader {
  private agentsDir: string;
  private agents: Map<string, AgentDefinition> = new Map();
  private pathToName: Map<string, string> = new Map();

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
  }

  async loadAll(): Promise<Map<string, AgentDefinition>> {
    const files = await glob('**/*.agent.yaml', { cwd: this.agentsDir });

    for (const file of files) {
      const filePath = path.join(this.agentsDir, file);
      try {
        const agent = await this.loadOne(filePath);
        this.agents.set(agent.name, agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[AgentLoader] Skipping invalid agent file "${file}": ${message}`);
      }
    }

    return this.agents;
  }

  async loadOne(filePath: string): Promise<AgentDefinition> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content);
    const agent = AgentDefinitionSchema.parse(parsed);
    this.agents.set(agent.name, agent);
    this.pathToName.set(path.resolve(filePath), agent.name);
    return agent;
  }

  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  list(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  names(): string[] {
    return Array.from(this.agents.keys());
  }

  remove(name: string): boolean {
    return this.agents.delete(name);
  }

  nameForPath(absolutePath: string): string | undefined {
    return this.pathToName.get(absolutePath);
  }
}
