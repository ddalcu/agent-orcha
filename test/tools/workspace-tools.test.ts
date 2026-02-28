import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { buildWorkspaceTools, type WorkspaceToolDeps } from '../../lib/tools/workspace/workspace-tools.ts';

describe('buildWorkspaceTools', () => {
  let tempDir: string;
  let deps: WorkspaceToolDeps;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tools-'));
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'hello');

    deps = {
      workspaceRoot: tempDir,
      reloadFile: async () => 'none',
      unloadFile: async () => 'none',
      listResources: () => ({
        agents: [{ name: 'a1', description: 'Agent 1' }],
        workflows: [],
        skills: [],
        functions: [],
        knowledge: [],
      }),
      getDiagnostics: async () => ({
        agents: [{ name: 'a1', llm: { name: 'default', exists: true }, tools: [], skills: [] }],
        knowledge: [],
        mcp: [],
        logs: [],
      }),
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should build 6 workspace tools', () => {
    const tools = buildWorkspaceTools(deps);
    assert.equal(tools.size, 6);
    assert.ok(tools.has('read'));
    assert.ok(tools.has('write'));
    assert.ok(tools.has('delete'));
    assert.ok(tools.has('list'));
    assert.ok(tools.has('list_resources'));
    assert.ok(tools.has('diagnostics'));
  });

  it('read tool should read a file', async () => {
    const tools = buildWorkspaceTools(deps);
    const readTool = tools.get('read')!;

    const result = await readTool.invoke({ filePath: 'test.txt' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.content, 'hello');
  });

  it('read tool should error for directory', async () => {
    const subDir = path.join(tempDir, 'sub');
    await fs.mkdir(subDir);

    const tools = buildWorkspaceTools(deps);
    const readTool = tools.get('read')!;

    const result = await readTool.invoke({ filePath: 'sub' });
    const parsed = JSON.parse(result as string);
    assert.ok(parsed.error.includes('directory'));
  });

  it('write tool should write a file', async () => {
    const tools = buildWorkspaceTools(deps);
    const writeTool = tools.get('write')!;

    const result = await writeTool.invoke({ filePath: 'new.txt', content: 'new content' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.success, true);

    const content = await fs.readFile(path.join(tempDir, 'new.txt'), 'utf-8');
    assert.equal(content, 'new content');
  });

  it('list tool should list workspace files', async () => {
    const tools = buildWorkspaceTools(deps);
    const listTool = tools.get('list')!;

    const result = await listTool.invoke({});
    const parsed = JSON.parse(result as string);
    assert.ok(parsed.tree);
  });

  it('list_resources tool should list resources', async () => {
    const tools = buildWorkspaceTools(deps);
    const listResourcesTool = tools.get('list_resources')!;

    const result = await listResourcesTool.invoke({});
    const parsed = JSON.parse(result as string);
    assert.ok(parsed.agents);
    assert.equal(parsed.agents.length, 1);
  });

  it('list_resources tool should filter by type', async () => {
    const tools = buildWorkspaceTools(deps);
    const listResourcesTool = tools.get('list_resources')!;

    const result = await listResourcesTool.invoke({ type: 'agents' });
    const parsed = JSON.parse(result as string);
    assert.ok(parsed.agents);
    assert.equal(Object.keys(parsed).length, 1);
  });

  it('write tool should trigger hot-reload for agent yaml', async () => {
    await fs.mkdir(path.join(tempDir, 'agents'));

    const validAgentYaml = [
      'name: test-agent',
      'description: A test agent',
      'prompt:',
      '  system: You are a test agent',
    ].join('\n');

    const reloadDeps: WorkspaceToolDeps = {
      ...deps,
      reloadFile: async (p: string) => {
        if (p.endsWith('.agent.yaml')) return 'agent';
        return 'none';
      },
    };

    const tools = buildWorkspaceTools(reloadDeps);
    const writeTool = tools.get('write')!;

    const result = await writeTool.invoke({ filePath: 'agents/test.agent.yaml', content: validAgentYaml });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.reloaded, 'agent');
  });

  it('write tool should return validation error for invalid agent yaml', async () => {
    await fs.mkdir(path.join(tempDir, 'agents'));

    const tools = buildWorkspaceTools(deps);
    const writeTool = tools.get('write')!;

    const result = await writeTool.invoke({ filePath: 'agents/bad.agent.yaml', content: 'name: test' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error.includes('Invalid agent YAML'));
  });

  it('write tool should handle reload error', async () => {
    const reloadDeps: WorkspaceToolDeps = {
      ...deps,
      reloadFile: async () => { throw new Error('Reload failed'); },
    };

    const tools = buildWorkspaceTools(reloadDeps);
    const writeTool = tools.get('write')!;

    // Use a non-validated extension so it reaches the reload code path
    const result = await writeTool.invoke({ filePath: 'config.json', content: '{"key":"value"}' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.reloaded, 'error');
    assert.ok(parsed.reloadError.includes('Reload failed'));
  });

  it('diagnostics tool should return a report', async () => {
    const tools = buildWorkspaceTools(deps);
    const diagnosticsTool = tools.get('diagnostics')!;

    const result = await diagnosticsTool.invoke({});
    const parsed = JSON.parse(result as string);
    assert.ok(Array.isArray(parsed.agents));
    assert.ok(Array.isArray(parsed.knowledge));
    assert.ok(Array.isArray(parsed.mcp));
    assert.ok(Array.isArray(parsed.logs));
    assert.equal(parsed.agents[0].name, 'a1');
    assert.equal(parsed.agents[0].llm.exists, true);
  });

  it('list tool should list subdirectory', async () => {
    const subDir = path.join(tempDir, 'agents');
    await fs.mkdir(subDir);
    await fs.writeFile(path.join(subDir, 'agent1.yaml'), 'name: a1');

    const tools = buildWorkspaceTools(deps);
    const listTool = tools.get('list')!;

    const result = await listTool.invoke({ subdir: 'agents' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.root, 'agents');
  });

  it('delete tool should delete a file and call unloadFile', async () => {
    await fs.writeFile(path.join(tempDir, 'to-delete.txt'), 'bye');

    let unloadCalled = false;
    const deleteDeps: WorkspaceToolDeps = {
      ...deps,
      unloadFile: async () => { unloadCalled = true; return 'none'; },
    };

    const tools = buildWorkspaceTools(deleteDeps);
    const deleteTool = tools.get('delete')!;

    const result = await deleteTool.invoke({ filePath: 'to-delete.txt' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.success, true);
    assert.ok(unloadCalled);

    // Verify file is actually gone
    try {
      await fs.stat(path.join(tempDir, 'to-delete.txt'));
      assert.fail('File should have been deleted');
    } catch {
      // Expected
    }
  });

  it('delete tool should return error for non-existent file', async () => {
    const tools = buildWorkspaceTools(deps);
    const deleteTool = tools.get('delete')!;

    const result = await deleteTool.invoke({ filePath: 'nonexistent.txt' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error.includes('not found'));
  });

  it('delete tool should delete a directory', async () => {
    const subDir = path.join(tempDir, 'skill-dir');
    await fs.mkdir(subDir);
    await fs.writeFile(path.join(subDir, 'SKILL.md'), '# content');

    const tools = buildWorkspaceTools(deps);
    const deleteTool = tools.get('delete')!;

    const result = await deleteTool.invoke({ filePath: 'skill-dir' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.success, true);
  });

  it('delete tool should report unload type for agent files', async () => {
    await fs.mkdir(path.join(tempDir, 'agents'));
    await fs.writeFile(path.join(tempDir, 'agents', 'test.agent.yaml'), 'name: test');

    const deleteDeps: WorkspaceToolDeps = {
      ...deps,
      unloadFile: async (p: string) => {
        if (p.endsWith('.agent.yaml')) return 'agent';
        return 'none';
      },
    };

    const tools = buildWorkspaceTools(deleteDeps);
    const deleteTool = tools.get('delete')!;

    const result = await deleteTool.invoke({ filePath: 'agents/test.agent.yaml' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.success, true);
    assert.equal(parsed.unloaded, 'agent');
  });

  it('delete tool should handle unload error gracefully', async () => {
    await fs.writeFile(path.join(tempDir, 'fail-unload.txt'), 'data');

    const deleteDeps: WorkspaceToolDeps = {
      ...deps,
      unloadFile: async () => { throw new Error('Unload boom'); },
    };

    const tools = buildWorkspaceTools(deleteDeps);
    const deleteTool = tools.get('delete')!;

    const result = await deleteTool.invoke({ filePath: 'fail-unload.txt' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.success, true);
    assert.equal(parsed.unloaded, 'error');
    assert.ok(parsed.unloadError.includes('Unload boom'));
  });
});
