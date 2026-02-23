import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
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
});
