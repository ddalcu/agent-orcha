import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { FunctionLoader } from '../../lib/functions/function-loader.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'functions');

describe('FunctionLoader', () => {
  let loader: FunctionLoader;

  before(async () => {
    loader = new FunctionLoader(fixturesDir);
    await loader.loadAll();
  });

  it('should load all functions from fixture directory', () => {
    const names = loader.names();
    assert.ok(names.includes('hello'));
  });

  it('should get a loaded function by name', () => {
    const func = loader.get('hello');
    assert.ok(func);
    assert.equal(func.name, 'hello');
    assert.ok(func.tool);
    assert.ok(func.metadata);
  });

  it('should return undefined for non-existent function', () => {
    assert.equal(loader.get('nonexistent'), undefined);
  });

  it('should list all loaded functions', () => {
    const funcs = loader.list();
    assert.ok(funcs.length >= 1);
  });

  it('should get a tool by name', () => {
    const tool = loader.getTool('hello');
    assert.ok(tool);
    assert.equal(tool.name, 'hello');
  });

  it('should return undefined getTool for non-existent', () => {
    assert.equal(loader.getTool('nonexistent'), undefined);
  });

  it('should invoke the loaded tool', async () => {
    const tool = loader.getTool('hello');
    assert.ok(tool);

    const result = await tool.invoke({ name: 'World' });
    assert.equal(result, 'Hello, World!');
  });

  it('should load a single function by path', async () => {
    const newLoader = new FunctionLoader(fixturesDir);
    const func = await newLoader.loadOne(path.join(fixturesDir, 'hello.function.js'));

    assert.equal(func.name, 'hello');
    assert.ok(func.tool);
  });

  it('should reload a function', async () => {
    // First ensure the function is loaded
    const freshLoader = new FunctionLoader(fixturesDir);
    await freshLoader.loadAll();

    const reloaded = await freshLoader.reload('hello');
    assert.equal(reloaded.name, 'hello');
  });

  it('should throw when reloading non-existent function', async () => {
    const freshLoader = new FunctionLoader(fixturesDir);
    await assert.rejects(
      freshLoader.reload('nonexistent'),
      /not found/
    );
  });

  it('should remove a function by name', () => {
    assert.ok(loader.get('hello'));
    const result = loader.remove('hello');
    assert.equal(result, true);
    assert.equal(loader.get('hello'), undefined);
  });

  it('should return false when removing non-existent function', () => {
    assert.equal(loader.remove('nonexistent'), false);
  });

  it('should track file path to name mapping', async () => {
    const newLoader = new FunctionLoader(fixturesDir);
    const filePath = path.join(fixturesDir, 'hello.function.js');
    await newLoader.loadOne(filePath);

    const name = newLoader.nameForPath(path.resolve(filePath));
    assert.equal(name, 'hello');
  });

  it('should return undefined nameForPath for unknown path', () => {
    assert.equal(loader.nameForPath('/nonexistent/path.function.js'), undefined);
  });
});
