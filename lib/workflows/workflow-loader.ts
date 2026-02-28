import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from './types.ts';
import { logger } from '../logger.ts';

export class WorkflowLoader {
  private workflowsDir: string;
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private pathToName: Map<string, string> = new Map();

  constructor(workflowsDir: string) {
    this.workflowsDir = workflowsDir;
  }

  async loadAll(): Promise<Map<string, WorkflowDefinition>> {
    const files = await glob('**/*.workflow.yaml', { cwd: this.workflowsDir });

    for (const file of files) {
      const filePath = path.join(this.workflowsDir, file);
      try {
        const workflow = await this.loadOne(filePath);
        this.workflows.set(workflow.name, workflow);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[WorkflowLoader] Skipping invalid workflow file "${file}": ${message}`);
      }
    }

    return this.workflows;
  }

  async loadOne(filePath: string): Promise<WorkflowDefinition> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content);
    const workflow = WorkflowDefinitionSchema.parse(parsed);
    this.workflows.set(workflow.name, workflow);
    this.pathToName.set(path.resolve(filePath), workflow.name);
    return workflow;
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name);
  }

  list(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }

  has(name: string): boolean {
    return this.workflows.has(name);
  }

  names(): string[] {
    return Array.from(this.workflows.keys());
  }

  remove(name: string): boolean {
    return this.workflows.delete(name);
  }

  nameForPath(absolutePath: string): string | undefined {
    return this.pathToName.get(absolutePath);
  }
}
