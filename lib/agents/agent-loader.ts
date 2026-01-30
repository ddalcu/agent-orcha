import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { AgentDefinitionSchema, type AgentDefinition } from './types.js';

export class AgentLoader {
  private agentsDir: string;
  private agents: Map<string, AgentDefinition> = new Map();

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
  }

  async loadAll(): Promise<Map<string, AgentDefinition>> {
    const files = await glob('**/*.agent.yaml', { cwd: this.agentsDir });

    for (const file of files) {
      const filePath = path.join(this.agentsDir, file);
      const agent = await this.loadOne(filePath);
      this.agents.set(agent.name, agent);
    }

    return this.agents;
  }

  async loadOne(filePath: string): Promise<AgentDefinition> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content);
    const agent = AgentDefinitionSchema.parse(parsed);
    this.agents.set(agent.name, agent);
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
}
