import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WorkflowLoader } from '../../lib/workflows/workflow-loader.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'workflows');

describe('WorkflowLoader', () => {
  let loader: WorkflowLoader;

  before(async () => {
    loader = new WorkflowLoader(fixturesDir);
    await loader.loadAll();
  });

  it('should load all workflows from fixture directory', () => {
    const names = loader.names();
    assert.ok(names.includes('test-workflow'));
  });

  it('should get a workflow by name', () => {
    const workflow = loader.get('test-workflow');
    assert.ok(workflow);
    assert.equal(workflow.name, 'test-workflow');
    assert.equal(workflow.type, 'steps');
  });

  it('should return undefined for non-existent workflow', () => {
    assert.equal(loader.get('nonexistent'), undefined);
  });

  it('should list all workflows', () => {
    const workflows = loader.list();
    assert.ok(workflows.length >= 1);
  });

  it('should check workflow existence', () => {
    assert.equal(loader.has('test-workflow'), true);
    assert.equal(loader.has('nonexistent'), false);
  });

  it('should load a single workflow by file path', async () => {
    const newLoader = new WorkflowLoader(fixturesDir);
    const wf = await newLoader.loadOne(path.join(fixturesDir, 'test-workflow.workflow.yaml'));

    assert.equal(wf.name, 'test-workflow');
    assert.equal(wf.type, 'steps');
    assert.ok('steps' in wf);
  });

  it('should parse workflow output mapping', () => {
    const workflow = loader.get('test-workflow');
    assert.ok(workflow);
    assert.equal(workflow.output.result, '{{steps.step1.output}}');
  });

  it('should remove a workflow by name', () => {
    assert.equal(loader.has('test-workflow'), true);
    const result = loader.remove('test-workflow');
    assert.equal(result, true);
    assert.equal(loader.has('test-workflow'), false);
    assert.equal(loader.get('test-workflow'), undefined);
  });

  it('should return false when removing non-existent workflow', () => {
    assert.equal(loader.remove('nonexistent'), false);
  });

  it('should track file path to name mapping', async () => {
    const newLoader = new WorkflowLoader(fixturesDir);
    const filePath = path.join(fixturesDir, 'test-workflow.workflow.yaml');
    await newLoader.loadOne(filePath);

    const name = newLoader.nameForPath(path.resolve(filePath));
    assert.equal(name, 'test-workflow');
  });

  it('should return undefined nameForPath for unknown path', () => {
    assert.equal(loader.nameForPath('/nonexistent/path.workflow.yaml'), undefined);
  });
});
