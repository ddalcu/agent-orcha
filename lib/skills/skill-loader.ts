import * as path from 'path';
import * as fs from 'fs/promises';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { logger } from '../logger.ts';
import type { Skill, AgentSkillsConfig } from './types.ts';

export class SkillLoader {
  private skillsDir: string;
  private skills: Map<string, Skill> = new Map();

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  async loadAll(): Promise<void> {
    try {
      const files = await glob('*/SKILL.md', { cwd: this.skillsDir });

      for (const file of files) {
        const filePath = path.join(this.skillsDir, file);
        await this.loadOne(filePath);
      }

      logger.info(`[SkillLoader] Loaded ${this.skills.size} skill(s)`);
    } catch (error) {
      logger.warn('[SkillLoader] Skills directory not found or error loading skills:', error);
    }
  }

  async loadOne(filePath: string): Promise<Skill> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);

      const dirName = path.basename(path.dirname(filePath));
      const name = typeof frontmatter.name === 'string' ? frontmatter.name : dirName;
      const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';

      const skill: Skill = {
        name,
        description,
        content: body.trim(),
        filePath,
        sandbox: frontmatter.sandbox === true,
      };

      this.skills.set(name, skill);
      logger.info(`[SkillLoader] Loaded skill: ${name}`);

      return skill;
    } catch (error) {
      logger.error(`[SkillLoader] Failed to load skill from ${filePath}:`, error);
      throw error;
    }
  }

  private parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) {
      return { frontmatter: {}, body: raw };
    }

    try {
      const frontmatter = parseYaml(match[1]!) as Record<string, unknown>;
      return { frontmatter: frontmatter ?? {}, body: match[2]! };
    } catch {
      logger.warn('[SkillLoader] Failed to parse YAML frontmatter, treating entire file as content');
      return { frontmatter: {}, body: raw };
    }
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  names(): string[] {
    return Array.from(this.skills.keys());
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  resolveForAgent(config: AgentSkillsConfig): string {
    return this.resolveForAgentWithMeta(config).content;
  }

  resolveForAgentWithMeta(config: AgentSkillsConfig): { content: string; needsSandbox: boolean } {
    let skillNames: string[];

    if ('mode' in config && config.mode === 'all') {
      skillNames = this.names();
    } else {
      skillNames = config as string[];
    }

    const resolved: string[] = [];
    let needsSandbox = false;

    for (const name of skillNames) {
      const skill = this.skills.get(name);
      if (skill) {
        resolved.push(`<skill name="${skill.name}">\n${skill.content}\n</skill>`);
        if (skill.sandbox) {
          needsSandbox = true;
        }
      } else {
        logger.warn(`[SkillLoader] Skill not found: ${name}`);
      }
    }

    return {
      content: resolved.join('\n\n'),
      needsSandbox,
    };
  }
}
