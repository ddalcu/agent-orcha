import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from './types.js';

export class WorkflowLoader {
  private workflowsDir: string;
  private workflows: Map<string, WorkflowDefinition> = new Map();

  constructor(workflowsDir: string) {
    this.workflowsDir = workflowsDir;
  }

  async loadAll(): Promise<Map<string, WorkflowDefinition>> {
    const files = await glob('**/*.workflow.yaml', { cwd: this.workflowsDir });

    for (const file of files) {
      const filePath = path.join(this.workflowsDir, file);
      const workflow = await this.loadOne(filePath);
      this.workflows.set(workflow.name, workflow);
    }

    return this.workflows;
  }

  async loadOne(filePath: string): Promise<WorkflowDefinition> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content);
    const workflow = WorkflowDefinitionSchema.parse(parsed);
    this.workflows.set(workflow.name, workflow);
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
}
