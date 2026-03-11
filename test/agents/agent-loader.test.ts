import { describe, it, before, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { AgentLoader } from '../../lib/agents/agent-loader.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'agents');

describe('AgentLoader', () => {
  let loader: AgentLoader;

  before(async () => {
    loader = new AgentLoader(fixturesDir);
    await loader.loadAll();
  });

  it('should load all agents from fixture directory', () => {
    const names = loader.names();
    assert.ok(names.includes('test-agent'));
  });

  it('should get an agent by name', () => {
    const agent = loader.get('test-agent');
    assert.ok(agent);
    assert.equal(agent.name, 'test-agent');
    assert.equal(agent.description, 'A test agent for unit testing');
  });

  it('should return undefined for non-existent agent', () => {
    assert.equal(loader.get('nonexistent'), undefined);
  });

  it('should list all agents', () => {
    const agents = loader.list();
    assert.ok(agents.length >= 1);
    assert.ok(agents.some(a => a.name === 'test-agent'));
  });

  it('should check agent existence', () => {
    assert.equal(loader.has('test-agent'), true);
    assert.equal(loader.has('nonexistent'), false);
  });

  it('should load a single agent by file path', async () => {
    const newLoader = new AgentLoader(fixturesDir);
    const agent = await newLoader.loadOne(path.join(fixturesDir, 'test-agent.agent.yaml'));

    assert.equal(agent.name, 'test-agent');
    assert.equal(agent.version, '1.0.0');
    assert.ok(agent.prompt.system.includes('helpful test agent'));
  });

  it('should validate agent schema on load', async () => {
    const newLoader = new AgentLoader(fixturesDir);
    const agent = await newLoader.loadOne(path.join(fixturesDir, 'test-agent.agent.yaml'));

    assert.equal(typeof agent.name, 'string');
    assert.equal(typeof agent.description, 'string');
    assert.ok(Array.isArray(agent.tools));
    assert.ok(Array.isArray(agent.prompt.inputVariables));
  });

  it('should remove an agent by name', () => {
    assert.equal(loader.has('test-agent'), true);
    const result = loader.remove('test-agent');
    assert.equal(result, true);
    assert.equal(loader.has('test-agent'), false);
    assert.equal(loader.get('test-agent'), undefined);
  });

  it('should return false when removing non-existent agent', () => {
    assert.equal(loader.remove('nonexistent'), false);
  });

  it('should track file path to name mapping', async () => {
    const newLoader = new AgentLoader(fixturesDir);
    const filePath = path.join(fixturesDir, 'test-agent.agent.yaml');
    await newLoader.loadOne(filePath);

    const name = newLoader.nameForPath(path.resolve(filePath));
    assert.equal(name, 'test-agent');
  });

  it('should return undefined nameForPath for unknown path', () => {
    assert.equal(loader.nameForPath('/nonexistent/path.agent.yaml'), undefined);
  });

  it('should skip invalid agent files in loadAll without throwing', async () => {
    // fixturesDir has both test-agent.agent.yaml (valid) and invalid-agent.agent.yaml (invalid)
    const freshLoader = new AgentLoader(fixturesDir);
    const result = await freshLoader.loadAll();
    // Valid agent should still load
    assert.ok(freshLoader.has('test-agent'));
    // Invalid agent should be skipped
    assert.ok(!freshLoader.has('123')); // name: 123 would stringify but schema validation should fail
  });

  it('should throw on loadOne with invalid schema', async () => {
    await assert.rejects(
      () => new AgentLoader(fixturesDir).loadOne(path.join(fixturesDir, 'invalid-agent.agent.yaml')),
    );
  });

  it('should throw on loadOne with nonexistent file', async () => {
    await assert.rejects(
      () => new AgentLoader(fixturesDir).loadOne(path.join(fixturesDir, 'ghost.agent.yaml')),
      /ENOENT/,
    );
  });

  it('should handle empty agents directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loader-test-'));
    try {
      const emptyLoader = new AgentLoader(tempDir);
      await emptyLoader.loadAll();
      assert.deepEqual(emptyLoader.list(), []);
      assert.deepEqual(emptyLoader.names(), []);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should overwrite existing agent on re-load', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loader-test-'));
    try {
      const agentYaml = `name: my-agent\ndescription: Version 1\nllm: default\nprompt:\n  system: v1\n  inputVariables: []\ntools: []`;
      const filePath = path.join(tempDir, 'my-agent.agent.yaml');
      await fs.writeFile(filePath, agentYaml);

      const reloader = new AgentLoader(tempDir);
      await reloader.loadOne(filePath);
      assert.equal(reloader.get('my-agent')?.description, 'Version 1');

      // Overwrite with new description
      const agentYaml2 = agentYaml.replace('Version 1', 'Version 2');
      await fs.writeFile(filePath, agentYaml2);
      await reloader.loadOne(filePath);
      assert.equal(reloader.get('my-agent')?.description, 'Version 2');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
