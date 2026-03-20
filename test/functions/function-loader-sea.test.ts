import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { _setSeaMock, _resetSeaCache } from '../../lib/sea/bootstrap.ts';

const { FunctionLoader, loadESMDirect } = await import(
  '../../lib/functions/function-loader.ts'
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'functions');

describe('FunctionLoader — SEA fallback integration', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-sea-test-'));
  });

  after(() => {
    _resetSeaCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load a simple function via FunctionLoader in SEA mode', async () => {
    _setSeaMock({ isSea: () => true });

    const fnPath = path.join(tmpDir, 'greet.function.mjs');
    fs.writeFileSync(fnPath, `
export default {
  name: 'greet',
  description: 'Greet someone',
  parameters: {
    who: { type: 'string', description: 'Who to greet' },
  },
  execute: async ({ who }) => {
    return 'Hi, ' + who + '!';
  },
};

export const metadata = {
  name: 'greet',
  description: 'Greet someone',
  version: '1.0.0',
};
`);

    const loader = new FunctionLoader(tmpDir);
    const loaded = await loader.loadOne(fnPath);

    assert.equal(loaded.name, 'greet');
    assert.equal(loaded.metadata.version, '1.0.0');

    const result = await loaded.tool.invoke({ who: 'World' });
    assert.equal(result, 'Hi, World!');

    _resetSeaCache();
  });

  it('should load the hello fixture function normally (import path)', async () => {
    _resetSeaCache();

    const loader = new FunctionLoader(fixturesDir);
    const loaded = await loader.loadOne(path.join(fixturesDir, 'hello.function.mjs'));

    assert.equal(loaded.name, 'hello');

    const result = await loaded.tool.invoke({ name: 'Test' });
    assert.equal(result, 'Hello, Test!');
  });

  it('should load a function with metadata export', async () => {
    const fnPath = path.join(tmpDir, 'tagged.function.mjs');
    fs.writeFileSync(fnPath, `
export default {
  name: 'tagged',
  description: 'A tagged function',
  execute: async () => 'ok',
};

export const metadata = {
  name: 'tagged',
  description: 'A tagged function',
  version: '2.0.0',
  author: 'Test',
  tags: ['test', 'demo'],
};
`);

    const loader = new FunctionLoader(tmpDir);
    const loaded = await loader.loadOne(fnPath);

    assert.equal(loaded.metadata.version, '2.0.0');
    assert.equal(loaded.metadata.author, 'Test');
    assert.deepEqual(loaded.metadata.tags, ['test', 'demo']);
  });

  it('should report clear errors for invalid function files', async () => {
    const fnPath = path.join(tmpDir, 'bad.function.mjs');
    fs.writeFileSync(fnPath, `export const notADefault = 42;`);

    const loader = new FunctionLoader(tmpDir);

    await assert.rejects(
      loader.loadOne(fnPath),
      /Function file must export either/
    );
  });
});

describe('loadESMDirect — direct eval fallback', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-direct-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load a module with default and named exports', () => {
    const fnPath = path.join(tmpDir, 'simple.mjs');
    fs.writeFileSync(fnPath, `
export default {
  name: 'direct-test',
  description: 'Loaded directly',
  execute: async () => 'direct-result',
};
export const metadata = { name: 'direct-test', description: 'Loaded directly' };
`);

    const mod = loadESMDirect(fnPath);

    assert.ok(mod.default, 'Should have a default export');
    assert.equal(mod.default.name, 'direct-test');
    assert.equal(typeof mod.default.execute, 'function');
    assert.ok(mod.metadata, 'Should have a metadata export');
    assert.equal(mod.metadata.name, 'direct-test');
  });

  it('should handle async execution', async () => {
    const fnPath = path.join(tmpDir, 'async-fn.mjs');
    fs.writeFileSync(fnPath, `
export default {
  name: 'async-fn',
  description: 'Async function',
  parameters: {
    a: { type: 'number', description: 'First number' },
    b: { type: 'number', description: 'Second number' },
  },
  execute: async ({ a, b }) => {
    return String(a + b);
  },
};
`);

    const mod = loadESMDirect(fnPath);
    const result = await mod.default.execute({ a: 3, b: 7 });
    assert.equal(result, '10');
  });

  it('should provide access to standard globals', async () => {
    const fnPath = path.join(tmpDir, 'globals.mjs');
    fs.writeFileSync(fnPath, `
export default {
  name: 'globals-test',
  description: 'Test globals availability',
  execute: async () => {
    const buf = Buffer.from('hello');
    const url = new URL('https://example.com');
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    return [
      buf.toString('hex'),
      url.hostname,
      dec.decode(enc.encode('ok')),
    ].join(',');
  },
};
`);

    const mod = loadESMDirect(fnPath);
    const result = await mod.default.execute();
    assert.equal(result, '68656c6c6f,example.com,ok');
  });

  it('should load the text-formatter template correctly', () => {
    const templatePath = path.resolve(__dirname, '../../templates/functions/text-formatter.function.mjs');
    const mod = loadESMDirect(templatePath);

    assert.equal(mod.default.name, 'text-formatter');
    assert.equal(mod.metadata.name, 'text-formatter');
    assert.equal(mod.metadata.version, '1.0.0');
  });

  it('should execute the text-formatter template', async () => {
    const templatePath = path.resolve(__dirname, '../../templates/functions/text-formatter.function.mjs');
    const mod = loadESMDirect(templatePath);

    const result = await mod.default.execute({ text: 'hello world', format: 'uppercase' });
    assert.equal(result, 'HELLO WORLD');
  });

  it('should throw for syntax errors', () => {
    const fnPath = path.join(tmpDir, 'syntax-err.mjs');
    fs.writeFileSync(fnPath, `export default { name: 'oops' `);

    assert.throws(() => loadESMDirect(fnPath));
  });
});
