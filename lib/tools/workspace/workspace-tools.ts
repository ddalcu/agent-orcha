import * as fs from 'fs/promises';
import * as path from 'path';
import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import { parse as parseYaml } from 'yaml';
import { resolveSafePath, buildTree } from '../../utils/file-utils.ts';
import { AgentDefinitionSchema } from '../../agents/types.ts';
import { WorkflowDefinitionSchema } from '../../workflows/types.ts';
import { KnowledgeConfigSchema } from '../../knowledge/types.ts';
import { logger } from '../../logger.ts';
import type { LogEntry } from '../../logger.ts';

export interface WorkspaceResourceSummary {
  agents: { name: string; description: string }[];
  workflows: { name: string; description: string }[];
  skills: { name: string; description: string }[];
  functions: { name: string; description: string }[];
  knowledge: { name: string; description: string }[];
}

export interface DiagnosticsReport {
  agents: {
    name: string;
    llm: { name: string; exists: boolean };
    tools: { ref: string; resolved: boolean }[];
    skills: { name: string; exists: boolean }[];
  }[];
  knowledge: {
    name: string;
    status: string;
    errorMessage: string | null;
  }[];
  mcp: {
    name: string;
    connected: boolean;
    toolCount: number;
  }[];
  logs: LogEntry[];
}

export interface WorkspaceToolDeps {
  workspaceRoot: string;
  reloadFile: (relativePath: string) => Promise<string>;
  listResources: () => WorkspaceResourceSummary;
  getDiagnostics: () => Promise<DiagnosticsReport>;
}

function createWorkspaceReadTool(deps: WorkspaceToolDeps): StructuredTool {
  return tool(
    async ({ filePath }) => {
      const fullPath = await resolveSafePath(deps.workspaceRoot, filePath);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        return JSON.stringify({ error: 'Cannot read a directory' });
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      return JSON.stringify({ path: filePath, content });
    },
    {
      name: 'workspace_read',
      description:
        'Read the contents of a file in the ORCHA workspace by relative path. ' +
        'Use this to inspect existing agents, workflows, skills, functions, or any config file.',
      schema: z.object({
        filePath: z.string().describe('Relative path from workspace root (e.g. "agents/my-agent.agent.yaml")'),
      }),
    },
  );
}

function createWorkspaceWriteTool(deps: WorkspaceToolDeps): StructuredTool {
  return tool(
    async ({ filePath, content }) => {
      const fullPath = await resolveSafePath(deps.workspaceRoot, filePath);

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
      logger.info(`[WorkspaceTool] File written: ${filePath}`);

      let reloaded = 'none';
      try {
        reloaded = await deps.reloadFile(filePath);
        if (reloaded !== 'none') {
          logger.info(`[WorkspaceTool] Hot-reloaded ${reloaded} from: ${filePath}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[WorkspaceTool] Reload failed for ${filePath}: ${message}`);
        return JSON.stringify({ success: true, path: filePath, reloaded: 'error', reloadError: message });
      }

      return JSON.stringify({ success: true, path: filePath, reloaded });
    },
    {
      name: 'workspace_write',
      description:
        'Create or overwrite a file in the ORCHA workspace. Automatically creates parent directories ' +
        'and triggers hot-reload for recognized resource types (.agent.yaml, .workflow.yaml, etc.).',
      schema: z.object({
        filePath: z.string().describe('Relative path from workspace root (e.g. "agents/weather-bot.agent.yaml")'),
        content: z.string().describe('Full file content to write'),
      }),
    },
  );
}

function createWorkspaceListTool(deps: WorkspaceToolDeps): StructuredTool {
  return tool(
    async ({ subdir }) => {
      const baseDir = subdir
        ? await resolveSafePath(deps.workspaceRoot, subdir)
        : deps.workspaceRoot;

      const tree = await buildTree(baseDir, deps.workspaceRoot, 0);
      return JSON.stringify({ root: subdir || '.', tree });
    },
    {
      name: 'workspace_list',
      description:
        'List the workspace directory tree. Optionally filter to a subdirectory ' +
        '(e.g. "agents", "workflows", "skills").',
      schema: z.object({
        subdir: z
          .string()
          .optional()
          .describe('Optional subdirectory to list (e.g. "agents"). Omit for full workspace tree.'),
      }),
    },
  );
}

function createWorkspaceListResourcesTool(deps: WorkspaceToolDeps): StructuredTool {
  return tool(
    async ({ type }) => {
      const resources = deps.listResources();

      if (type) {
        const filtered = resources[type as keyof WorkspaceResourceSummary];
        if (!filtered) {
          return JSON.stringify({ error: `Unknown resource type: ${type}. Valid types: agents, workflows, skills, functions, knowledge` });
        }
        return JSON.stringify({ [type]: filtered });
      }

      return JSON.stringify(resources);
    },
    {
      name: 'workspace_list_resources',
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

function createWorkspaceDiagnosticsTool(deps: WorkspaceToolDeps): StructuredTool {
  return tool(
    async () => {
      const report = await deps.getDiagnostics();
      return JSON.stringify(report, null, 2);
    },
    {
      name: 'workspace_diagnostics',
      description:
        'Run diagnostics on the ORCHA workspace. Validates that all agent tool references resolve, ' +
        'skill references exist, LLM configs are valid, knowledge stores are healthy, and MCP servers are connected. ' +
        'Also includes recent warning and error logs.',
      schema: z.object({}),
    },
  );
}

export function buildWorkspaceTools(deps: WorkspaceToolDeps): Map<string, StructuredTool> {
  const tools = new Map<string, StructuredTool>();

  tools.set('read', createWorkspaceReadTool(deps));
  tools.set('write', createWorkspaceWriteTool(deps));
  tools.set('list', createWorkspaceListTool(deps));
  tools.set('list_resources', createWorkspaceListResourcesTool(deps));
  tools.set('diagnostics', createWorkspaceDiagnosticsTool(deps));

  logger.info('[WorkspaceTools] Built workspace tools: ' + Array.from(tools.keys()).join(', '));
  return tools;
}
