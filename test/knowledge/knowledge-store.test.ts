import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { KnowledgeStore } from '../../lib/knowledge/knowledge-store.ts';

describe('KnowledgeStore', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ks-test-'));
    knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should construct with knowledgeDir and workspaceRoot', () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    assert.ok(store);
  });

  it('should load config from YAML file', async () => {
    const yaml = `
name: test-kb
description: Test knowledge store
source:
  type: file
  path: ./data/test.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    const filePath = path.join(knowledgeDir, 'test-kb.knowledge.yaml');
    await fs.writeFile(filePath, yaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    assert.equal(config.name, 'test-kb');
    assert.equal(config.source.type, 'file');
    assert.equal(config.splitter.chunkSize, 500);
  });

  it('should throw on invalid YAML schema', async () => {
    const yaml = `name: 123\n`;
    const filePath = path.join(knowledgeDir, 'bad.knowledge.yaml');
    await fs.writeFile(filePath, yaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await assert.rejects(() => store.loadOne(filePath));
  });

  it('should throw on nonexistent file', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await assert.rejects(
      () => store.loadOne(path.join(knowledgeDir, 'ghost.knowledge.yaml')),
      /ENOENT/,
    );
  });

  it('should loadAll and skip invalid files', async () => {
    const validYaml = `
name: valid-kb
description: Valid store
source:
  type: file
  path: ./test.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    const invalidYaml = `name: 123\ndescription: true`;

    await fs.writeFile(path.join(knowledgeDir, 'valid.knowledge.yaml'), validYaml);
    await fs.writeFile(path.join(knowledgeDir, 'invalid.knowledge.yaml'), invalidYaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadAll();

    assert.ok(store.getConfig('valid-kb'));
    assert.equal(store.getConfig('invalid-kb'), undefined);
  });

  it('should handle empty knowledge directory', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadAll();

    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.listConfigs(), []);
  });

  it('should return undefined for unknown store', () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    assert.equal(store.get('nonexistent'), undefined);
    assert.equal(store.getConfig('nonexistent'), undefined);
    assert.equal(store.getSqliteStore('nonexistent'), undefined);
  });

  it('should report isIndexing correctly', () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    assert.equal(store.isIndexing('test'), false);
  });

  it('should throw on initialize with unknown config', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await assert.rejects(
      () => store.initialize('nonexistent'),
      /Knowledge config not found/,
    );
  });

  it('should track path to name mapping', async () => {
    const yaml = `
name: mapped-kb
description: Mapped store
source:
  type: file
  path: ./test.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    const filePath = path.join(knowledgeDir, 'mapped.knowledge.yaml');
    await fs.writeFile(filePath, yaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(filePath);

    assert.equal(store.nameForPath(path.resolve(filePath)), 'mapped-kb');
    assert.equal(store.nameForPath('/unknown/path'), undefined);
  });

  it('should evict a store cleanly', async () => {
    const yaml = `
name: evict-kb
description: Will be evicted
source:
  type: file
  path: ./test.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    const filePath = path.join(knowledgeDir, 'evict.knowledge.yaml');
    await fs.writeFile(filePath, yaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(filePath);
    assert.ok(store.getConfig('evict-kb'));

    store.evict('evict-kb');
    assert.equal(store.getConfig('evict-kb'), undefined);
    assert.equal(store.get('evict-kb'), undefined);
  });

  it('should close without error', () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    store.close(); // should not throw
  });

  it('should resolve sqlite:// paths relative to workspaceRoot', async () => {
    const yaml = `
name: sqlite-kb
description: SQLite source
source:
  type: database
  connectionString: "sqlite://data/my.db"
  query: "SELECT content FROM docs"
  contentColumn: content
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    const filePath = path.join(knowledgeDir, 'sqlite.knowledge.yaml');
    await fs.writeFile(filePath, yaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    // Should be resolved to absolute path
    assert.ok(config.source.type === 'database');
    if (config.source.type === 'database') {
      assert.ok(path.isAbsolute(config.source.connectionString.replace('sqlite://', '')));
      assert.ok(config.source.connectionString.includes(tempDir));
    }
  });

  it('should not modify absolute sqlite:// paths', async () => {
    const yaml = `
name: abs-sqlite-kb
description: Absolute SQLite source
source:
  type: database
  connectionString: "sqlite:///absolute/path/my.db"
  query: "SELECT content FROM docs"
  contentColumn: content
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    const filePath = path.join(knowledgeDir, 'abs-sqlite.knowledge.yaml');
    await fs.writeFile(filePath, yaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    if (config.source.type === 'database') {
      assert.equal(config.source.connectionString, 'sqlite:///absolute/path/my.db');
    }
  });
});

describe('KnowledgeStore.computeFileHashes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ks-hash-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should hash a single file', async () => {
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'hello world');

    const config = {
      name: 'test',
      description: 'test',
      source: { type: 'file' as const, path: './test.txt' },
      splitter: { type: 'recursive' as const, chunkSize: 500, chunkOverlap: 50 },
      embedding: 'default',
    };

    const hashes = await KnowledgeStore.computeFileHashes(config as any, tempDir);
    assert.ok(Object.keys(hashes).length >= 2); // file hash + config hash
    assert.ok(hashes['_config']);
  });

  it('should hash directory files', async () => {
    const dataDir = path.join(tempDir, 'docs');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'a.txt'), 'aaa');
    await fs.writeFile(path.join(dataDir, 'b.txt'), 'bbb');

    const config = {
      name: 'test',
      description: 'test',
      source: { type: 'directory' as const, path: './docs', pattern: '*.txt' },
      splitter: { type: 'recursive' as const, chunkSize: 500, chunkOverlap: 50 },
      embedding: 'default',
    };

    const hashes = await KnowledgeStore.computeFileHashes(config as any, tempDir);
    assert.ok(Object.keys(hashes).length >= 3); // 2 files + config
  });

  it('should hash database query', async () => {
    const config = {
      name: 'test',
      description: 'test',
      source: { type: 'database' as const, connectionString: 'pg://localhost', query: 'SELECT *', contentColumn: 'c' },
      splitter: { type: 'recursive' as const, chunkSize: 500, chunkOverlap: 50 },
      embedding: 'default',
    };

    const hashes = await KnowledgeStore.computeFileHashes(config as any, tempDir);
    assert.ok(hashes['database:query']);
    assert.ok(hashes['_config']);
  });

  it('should hash web URL', async () => {
    const config = {
      name: 'test',
      description: 'test',
      source: { type: 'web' as const, url: 'https://example.com' },
      splitter: { type: 'recursive' as const, chunkSize: 500, chunkOverlap: 50 },
      embedding: 'default',
    };

    const hashes = await KnowledgeStore.computeFileHashes(config as any, tempDir);
    assert.ok(hashes['web:url']);
    assert.ok(hashes['_config']);
  });
});

describe('KnowledgeStore.splitDocuments', () => {
  it('should split with recursive splitter', async () => {
    const config = {
      name: 'test',
      description: 'test',
      source: { type: 'file' as const, path: './test.txt' },
      splitter: { type: 'recursive' as const, chunkSize: 20, chunkOverlap: 5 },
      embedding: 'default',
    };

    const docs = [{ pageContent: 'Hello world this is a test document with some content', metadata: {} }];
    const result = await KnowledgeStore.splitDocuments(config as any, docs);
    assert.ok(result.length > 1); // Should split into multiple chunks
  });

  it('should split with character splitter', async () => {
    const config = {
      name: 'test',
      description: 'test',
      source: { type: 'file' as const, path: './test.txt' },
      splitter: { type: 'character' as const, chunkSize: 20, chunkOverlap: 5, separator: ' ' },
      embedding: 'default',
    };

    const docs = [{ pageContent: 'Hello world this is a test document', metadata: {} }];
    const result = await KnowledgeStore.splitDocuments(config as any, docs);
    assert.ok(result.length >= 1);
  });
});
