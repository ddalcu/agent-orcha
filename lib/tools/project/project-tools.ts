import * as fs from 'fs/promises';
import * as path from 'path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredTool } from '@langchain/core/tools';
import { parse as parseYaml } from 'yaml';
import { resolveSafePath, buildTree } from '../../utils/file-utils.js';
import { AgentDefinitionSchema } from '../../agents/types.js';
import { WorkflowDefinitionSchema } from '../../workflows/types.js';
import { KnowledgeConfigSchema } from '../../knowledge/types.js';
import { logger } from '../../logger.js';

export interface ProjectResourceSummary {
  agents: { name: string; description: string }[];
  workflows: { name: string; description: string }[];
  skills: { name: string; description: string }[];
  functions: { name: string; description: string }[];
  knowledge: { name: string; description: string }[];
}

export interface ProjectToolDeps {
  projectRoot: string;
  reloadFile: (relativePath: string) => Promise<string>;
  listResources: () => ProjectResourceSummary;
}

function createProjectReadTool(deps: ProjectToolDeps): StructuredTool {
  return tool(
    async ({ filePath }) => {
      const fullPath = await resolveSafePath(deps.projectRoot, filePath);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        return JSON.stringify({ error: 'Cannot read a directory' });
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      return JSON.stringify({ path: filePath, content });
    },
    {
      name: 'project_read',
      description:
        'Read the contents of a file in the ORCHA project by relative path. ' +
        'Use this to inspect existing agents, workflows, skills, functions, or any config file.',
      schema: z.object({
        filePath: z.string().describe('Relative path from project root (e.g. "agents/my-agent.agent.yaml")'),
      }),
    },
  );
}

function createProjectWriteTool(deps: ProjectToolDeps): StructuredTool {
  return tool(
    async ({ filePath, content }) => {
      const fullPath = await resolveSafePath(deps.projectRoot, filePath);

      // Validate resource YAML before writing
      const validationMap: Record<string, { schema: z.ZodTypeAny; label: string }> = {
        '.agent.yaml': { schema: AgentDefinitionSchema, label: 'agent' },
        '.workflow.yaml': { schema: WorkflowDefinitionSchema, label: 'workflow' },
        '.knowledge.yaml': { schema: KnowledgeConfigSchema, label: 'knowledge' },
      };
      const matchedSuffix = Object.keys(validationMap).find(suffix => filePath.endsWith(suffix));
      if (matchedSuffix && validationMap[matchedSuffix]) {
        const { schema, label } = validationMap[matchedSuffix];
        const parsed = parseYaml(content);
        const result = schema.safeParse(parsed);
        if (!result.success) {
          const issues = result.error.issues.map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`).join('; ');
          return JSON.stringify({ success: false, error: `Invalid ${label} YAML: ${issues}` });
        }
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(fullPath);
      await fs.mkdir(parentDir, { recursive: true });

      await fs.writeFile(fullPath, content, 'utf-8');
      logger.info(`[ProjectTool] File written: ${filePath}`);

      let reloaded = 'none';
      try {
        reloaded = await deps.reloadFile(filePath);
        if (reloaded !== 'none') {
          logger.info(`[ProjectTool] Hot-reloaded ${reloaded} from: ${filePath}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[ProjectTool] Reload failed for ${filePath}: ${message}`);
        return JSON.stringify({ success: true, path: filePath, reloaded: 'error', reloadError: message });
      }

      return JSON.stringify({ success: true, path: filePath, reloaded });
    },
    {
      name: 'project_write',
      description:
        'Create or overwrite a file in the ORCHA project. Automatically creates parent directories ' +
        'and triggers hot-reload for recognized resource types (.agent.yaml, .workflow.yaml, etc.).',
      schema: z.object({
        filePath: z.string().describe('Relative path from project root (e.g. "agents/weather-bot.agent.yaml")'),
        content: z.string().describe('Full file content to write'),
      }),
    },
  );
}

function createProjectListTool(deps: ProjectToolDeps): StructuredTool {
  return tool(
    async ({ subdir }) => {
      const baseDir = subdir
        ? await resolveSafePath(deps.projectRoot, subdir)
        : deps.projectRoot;

      const tree = await buildTree(baseDir, deps.projectRoot, 0);
      return JSON.stringify({ root: subdir || '.', tree });
    },
    {
      name: 'project_list',
      description:
        'List the project directory tree. Optionally filter to a subdirectory ' +
        '(e.g. "agents", "workflows", "skills").',
      schema: z.object({
        subdir: z
          .string()
          .optional()
          .describe('Optional subdirectory to list (e.g. "agents"). Omit for full project tree.'),
      }),
    },
  );
}

function createProjectListResourcesTool(deps: ProjectToolDeps): StructuredTool {
  return tool(
    async ({ type }) => {
      const resources = deps.listResources();

      if (type) {
        const filtered = resources[type as keyof ProjectResourceSummary];
        if (!filtered) {
          return JSON.stringify({ error: `Unknown resource type: ${type}. Valid types: agents, workflows, skills, functions, knowledge` });
        }
        return JSON.stringify({ [type]: filtered });
      }

      return JSON.stringify(resources);
    },
    {
      name: 'project_list_resources',
      description:
        'List all loaded ORCHA resources (agents, workflows, skills, functions, knowledge stores) ' +
        'with their names and descriptions. Optionally filter by resource type.',
      schema: z.object({
        type: z
          .enum(['agents', 'workflows', 'skills', 'functions', 'knowledge'])
          .optional()
          .describe('Optional resource type filter'),
      }),
    },
  );
}

export function buildProjectTools(deps: ProjectToolDeps): Map<string, StructuredTool> {
  const tools = new Map<string, StructuredTool>();

  tools.set('read', createProjectReadTool(deps));
  tools.set('write', createProjectWriteTool(deps));
  tools.set('list', createProjectListTool(deps));
  tools.set('list_resources', createProjectListResourcesTool(deps));

  logger.info('[ProjectTools] Built project tools: ' + Array.from(tools.keys()).join(', '));
  return tools;
}
