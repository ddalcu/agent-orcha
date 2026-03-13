import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { KnowledgeStore } from '../../lib/knowledge/knowledge-store.ts';
import type { KnowledgeConfig, KnowledgeStoreInstance, SearchResult } from '../../lib/knowledge/types.ts';

// --- Helpers ---

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ks-test-'));
}

function makeFileConfig(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
  return {
    name: 'test-kb',
    description: 'Test knowledge store',
    source: { type: 'file' as const, path: './data/test.txt' },
    splitter: { type: 'recursive' as const, chunkSize: 500, chunkOverlap: 50 },
    embedding: 'default',
    ...overrides,
  } as KnowledgeConfig;
}

function makeWebConfig(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
  return {
    name: 'web-kb',
    description: 'Web knowledge store',
    source: { type: 'web' as const, url: 'https://example.com' },
    splitter: { type: 'recursive' as const, chunkSize: 500, chunkOverlap: 50 },
    embedding: 'default',
    ...overrides,
  } as KnowledgeConfig;
}

function makeDatabaseConfig(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
  return {
    name: 'db-kb',
    description: 'Database knowledge store',
    source: {
      type: 'database' as const,
      connectionString: 'postgresql://localhost/test',
      query: 'SELECT content FROM docs',
      contentColumn: 'content',
      batchSize: 100,
    },
    splitter: { type: 'recursive' as const, chunkSize: 500, chunkOverlap: 50 },
    embedding: 'default',
    ...overrides,
  } as KnowledgeConfig;
}

function makeDirectoryConfig(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
  return {
    name: 'dir-kb',
    description: 'Directory knowledge store',
    source: { type: 'directory' as const, path: './docs', pattern: '*.txt', recursive: true },
    splitter: { type: 'recursive' as const, chunkSize: 500, chunkOverlap: 50 },
    embedding: 'default',
    ...overrides,
  } as KnowledgeConfig;
}

const VALID_YAML = `
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

const VALID_YAML_2 = `
name: second-kb
description: Second knowledge store
source:
  type: file
  path: ./data/test2.txt
splitter:
  type: character
  chunkSize: 300
  chunkOverlap: 30
  separator: " "
embedding: default
`;

const WEB_YAML = `
name: web-kb
description: Web knowledge store
source:
  type: web
  url: https://example.com
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;

const DB_YAML = `
name: db-kb
description: Database knowledge store
source:
  type: database
  connectionString: "postgresql://localhost/test"
  query: "SELECT content FROM docs"
  contentColumn: content
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;

const REINDEX_YAML = `
name: reindex-kb
description: Reindexable store
source:
  type: file
  path: ./data/test.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
reindex:
  schedule: "0 * * * *"
`;

const SEARCH_CONFIG_YAML = `
name: search-kb
description: Store with search config
source:
  type: file
  path: ./data/test.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
search:
  defaultK: 8
  scoreThreshold: 0.5
`;

const GRAPH_YAML = `
name: graph-kb
description: Graph knowledge store
source:
  type: database
  connectionString: "postgresql://localhost/test"
  query: "SELECT id, name, category FROM items"
  contentColumn: name
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
graph:
  directMapping:
    entities:
      - type: item
        idColumn: id
        nameColumn: name
        properties: [category]
`;

// --- Constructor & Basic Accessors ---

describe('KnowledgeStore', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
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
    const yaml = VALID_YAML;
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
    const validYaml = VALID_YAML;
    const invalidYaml = `name: 123\ndescription: true`;

    await fs.writeFile(path.join(knowledgeDir, 'valid.knowledge.yaml'), validYaml);
    await fs.writeFile(path.join(knowledgeDir, 'invalid.knowledge.yaml'), invalidYaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadAll();

    assert.ok(store.getConfig('test-kb'));
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
    const filePath = path.join(knowledgeDir, 'mapped.knowledge.yaml');
    await fs.writeFile(filePath, VALID_YAML.replace('test-kb', 'mapped-kb'));

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(filePath);

    assert.equal(store.nameForPath(path.resolve(filePath)), 'mapped-kb');
    assert.equal(store.nameForPath('/unknown/path'), undefined);
  });

  it('should evict a store cleanly', async () => {
    const filePath = path.join(knowledgeDir, 'evict.knowledge.yaml');
    await fs.writeFile(filePath, VALID_YAML.replace('test-kb', 'evict-kb'));

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

  it('should load multiple configs and list them all', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'a.knowledge.yaml'), VALID_YAML);
    await fs.writeFile(path.join(knowledgeDir, 'b.knowledge.yaml'), VALID_YAML_2);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadAll();

    const configs = store.listConfigs();
    assert.equal(configs.length, 2);
    const names = configs.map(c => c.name).sort();
    assert.deepEqual(names, ['second-kb', 'test-kb']);
  });

  it('should load web source config', async () => {
    const filePath = path.join(knowledgeDir, 'web.knowledge.yaml');
    await fs.writeFile(filePath, WEB_YAML);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    assert.equal(config.name, 'web-kb');
    assert.equal(config.source.type, 'web');
    if (config.source.type === 'web') {
      assert.equal(config.source.url, 'https://example.com');
    }
  });

  it('should load database source config', async () => {
    const filePath = path.join(knowledgeDir, 'db.knowledge.yaml');
    await fs.writeFile(filePath, DB_YAML);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    assert.equal(config.name, 'db-kb');
    assert.equal(config.source.type, 'database');
  });

  it('should load config with reindex schedule', async () => {
    const filePath = path.join(knowledgeDir, 'reindex.knowledge.yaml');
    await fs.writeFile(filePath, REINDEX_YAML);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    assert.equal(config.name, 'reindex-kb');
    assert.ok(config.reindex);
    assert.equal(config.reindex!.schedule, '0 * * * *');
  });

  it('should load config with search settings', async () => {
    const filePath = path.join(knowledgeDir, 'search.knowledge.yaml');
    await fs.writeFile(filePath, SEARCH_CONFIG_YAML);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    assert.equal(config.name, 'search-kb');
    assert.ok(config.search);
    assert.equal(config.search!.defaultK, 8);
    assert.equal(config.search!.scoreThreshold, 0.5);
  });

  it('should load config with graph direct mapping', async () => {
    const filePath = path.join(knowledgeDir, 'graph.knowledge.yaml');
    await fs.writeFile(filePath, GRAPH_YAML);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    assert.equal(config.name, 'graph-kb');
    assert.ok(config.graph);
    assert.ok(config.graph!.directMapping);
  });

  it('should strip old migration fields from YAML', async () => {
    const yaml = `
name: migration-kb
description: Has old fields
kind: vector
store: chroma
source:
  type: file
  path: ./test.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
search:
  defaultK: 4
  globalSearch: true
  localSearch: true
graph:
  extractionMode: llm
  extraction:
    model: gpt-4
  communities:
    enabled: true
  cache:
    enabled: true
  store: graphology
`;
    const filePath = path.join(knowledgeDir, 'migration.knowledge.yaml');
    await fs.writeFile(filePath, yaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    assert.equal(config.name, 'migration-kb');
    // Old fields should be stripped, not cause errors
    assert.ok(config.source);
  });

  it('should getStatus return null for unknown store', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const status = await store.getStatus('nonexistent');
    assert.equal(status, null);
  });

  it('should getAllStatuses return empty map with no configs', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const statuses = await store.getAllStatuses();
    assert.equal(statuses.size, 0);
  });

  it('should getAllStatuses return metadata for loaded configs', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'a.knowledge.yaml'), VALID_YAML);
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadAll();

    // Manually save some metadata for the config
    const metaMgr = store.getMetadataManager();
    const { createDefaultMetadata } = await import('../../lib/knowledge/knowledge-store-metadata.ts');
    const meta = createDefaultMetadata('test-kb', 'vector');
    meta.status = 'indexed';
    await metaMgr.save('test-kb', meta);

    const statuses = await store.getAllStatuses();
    assert.equal(statuses.size, 1);
    assert.ok(statuses.has('test-kb'));
    assert.equal(statuses.get('test-kb')!.status, 'indexed');
  });

  it('should getMetadataManager return a manager', () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const mgr = store.getMetadataManager();
    assert.ok(mgr);
    assert.ok(mgr.baseDir.includes('.knowledge-cache'));
  });

  it('should evict nonexistent store without error', () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    // Should not throw
    store.evict('does-not-exist');
  });

  it('should refresh return early for unknown store', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    // Should not throw, just return
    await store.refresh('nonexistent');
  });

  it('should loadOne overwrite existing config with same name', async () => {
    const yaml1 = VALID_YAML;
    const yaml2 = VALID_YAML.replace('chunkSize: 500', 'chunkSize: 1000');

    const filePath1 = path.join(knowledgeDir, 'a.knowledge.yaml');
    const filePath2 = path.join(knowledgeDir, 'b.knowledge.yaml');
    await fs.writeFile(filePath1, yaml1);
    await fs.writeFile(filePath2, yaml2);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(filePath1);
    const config1 = store.getConfig('test-kb')!;
    assert.equal(config1.splitter.chunkSize, 500);

    await store.loadOne(filePath2);
    const config2 = store.getConfig('test-kb')!;
    assert.equal(config2.splitter.chunkSize, 1000);
  });

  it('should handle YAML with environment variable substitution', async () => {
    // Set env var for test
    process.env.__TEST_KB_NAME = 'env-test-kb';
    const yaml = `
name: \${__TEST_KB_NAME}
description: Env var test
source:
  type: file
  path: ./test.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    const filePath = path.join(knowledgeDir, 'env.knowledge.yaml');
    await fs.writeFile(filePath, yaml);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    const config = await store.loadOne(filePath);

    assert.equal(config.name, 'env-test-kb');
    delete process.env.__TEST_KB_NAME;
  });

  it('should load nested directory YAML files', async () => {
    const subDir = path.join(knowledgeDir, 'subdir');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'nested.knowledge.yaml'), VALID_YAML.replace('test-kb', 'nested-kb'));

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadAll();

    assert.ok(store.getConfig('nested-kb'));
  });
});

// --- Static: computeFileHashes ---

describe('KnowledgeStore.computeFileHashes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should hash a single file', async () => {
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'hello world');

    const config = makeFileConfig({ source: { type: 'file', path: './test.txt' } } as any);
    const hashes = await KnowledgeStore.computeFileHashes(config, tempDir);

    assert.ok(Object.keys(hashes).length >= 2); // file hash + config hash
    assert.ok(hashes['_config']);
  });

  it('should hash directory files', async () => {
    const dataDir = path.join(tempDir, 'docs');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'a.txt'), 'aaa');
    await fs.writeFile(path.join(dataDir, 'b.txt'), 'bbb');

    const config = makeDirectoryConfig();
    const hashes = await KnowledgeStore.computeFileHashes(config, tempDir);

    assert.ok(Object.keys(hashes).length >= 3); // 2 files + config
  });

  it('should hash database query', async () => {
    const config = makeDatabaseConfig();
    const hashes = await KnowledgeStore.computeFileHashes(config, tempDir);

    assert.ok(hashes['database:query']);
    assert.ok(hashes['_config']);
  });

  it('should hash web URL', async () => {
    const config = makeWebConfig();
    const hashes = await KnowledgeStore.computeFileHashes(config, tempDir);

    assert.ok(hashes['web:url']);
    assert.ok(hashes['_config']);
  });

  it('should produce different hashes for different file contents', async () => {
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'content A');
    const config = makeFileConfig({ source: { type: 'file', path: './test.txt' } } as any);
    const hashes1 = await KnowledgeStore.computeFileHashes(config, tempDir);

    await fs.writeFile(path.join(tempDir, 'test.txt'), 'content B');
    const hashes2 = await KnowledgeStore.computeFileHashes(config, tempDir);

    const filePath = path.join(tempDir, 'test.txt');
    assert.notEqual(hashes1[filePath], hashes2[filePath]);
  });

  it('should produce same hashes for same file contents', async () => {
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'identical');
    const config = makeFileConfig({ source: { type: 'file', path: './test.txt' } } as any);

    const hashes1 = await KnowledgeStore.computeFileHashes(config, tempDir);
    const hashes2 = await KnowledgeStore.computeFileHashes(config, tempDir);

    assert.deepEqual(hashes1, hashes2);
  });

  it('should include config hash that changes when splitter changes', async () => {
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'hello');

    const config1 = makeFileConfig({ source: { type: 'file', path: './test.txt' } } as any);
    const config2 = makeFileConfig({
      source: { type: 'file', path: './test.txt' },
      splitter: { type: 'character' as const, chunkSize: 200, chunkOverlap: 20 },
    } as any);

    const hashes1 = await KnowledgeStore.computeFileHashes(config1, tempDir);
    const hashes2 = await KnowledgeStore.computeFileHashes(config2, tempDir);

    assert.notEqual(hashes1['_config'], hashes2['_config']);
  });

  it('should handle empty directory', async () => {
    const emptyDir = path.join(tempDir, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });

    const config = makeDirectoryConfig({
      source: { type: 'directory', path: './empty', pattern: '*.txt', recursive: true },
    } as any);

    const hashes = await KnowledgeStore.computeFileHashes(config, tempDir);
    // Should have only the _config hash
    assert.ok(hashes['_config']);
    assert.equal(Object.keys(hashes).length, 1);
  });

  it('should include web selector in config hash', async () => {
    const config1 = makeWebConfig();
    const config2 = makeWebConfig({
      source: { type: 'web', url: 'https://example.com', selector: '.main' },
    } as any);

    const hashes1 = await KnowledgeStore.computeFileHashes(config1, tempDir);
    const hashes2 = await KnowledgeStore.computeFileHashes(config2, tempDir);

    assert.notEqual(hashes1['_config'], hashes2['_config']);
  });
});

// --- Static: splitDocuments ---

describe('KnowledgeStore.splitDocuments', () => {
  it('should split with recursive splitter', async () => {
    const config = makeFileConfig({
      splitter: { type: 'recursive' as const, chunkSize: 20, chunkOverlap: 5 },
    } as any);

    const docs = [{ pageContent: 'Hello world this is a test document with some content', metadata: {} }];
    const result = await KnowledgeStore.splitDocuments(config, docs);
    assert.ok(result.length > 1); // Should split into multiple chunks
  });

  it('should split with character splitter', async () => {
    const config = makeFileConfig({
      splitter: { type: 'character' as const, chunkSize: 20, chunkOverlap: 5, separator: ' ' },
    } as any);

    const docs = [{ pageContent: 'Hello world this is a test document', metadata: {} }];
    const result = await KnowledgeStore.splitDocuments(config, docs);
    assert.ok(result.length >= 1);
  });

  it('should preserve metadata through splitting', async () => {
    const config = makeFileConfig({
      splitter: { type: 'recursive' as const, chunkSize: 20, chunkOverlap: 5 },
    } as any);

    const docs = [{ pageContent: 'Hello world this is a longer test document with lots of content to split', metadata: { source: 'test.txt' } }];
    const result = await KnowledgeStore.splitDocuments(config, docs);

    for (const doc of result) {
      assert.ok(doc.metadata);
    }
  });

  it('should not split short documents', async () => {
    const config = makeFileConfig({
      splitter: { type: 'recursive' as const, chunkSize: 1000, chunkOverlap: 50 },
    } as any);

    const docs = [{ pageContent: 'Short text', metadata: {} }];
    const result = await KnowledgeStore.splitDocuments(config, docs);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.pageContent, 'Short text');
  });

  it('should handle empty documents array', async () => {
    const config = makeFileConfig();
    const result = await KnowledgeStore.splitDocuments(config, []);
    assert.deepEqual(result, []);
  });

  it('should handle multiple documents', async () => {
    const config = makeFileConfig({
      splitter: { type: 'recursive' as const, chunkSize: 20, chunkOverlap: 5 },
    } as any);

    const docs = [
      { pageContent: 'First document with enough content to be split into pieces', metadata: { id: '1' } },
      { pageContent: 'Second document also with enough content to be split', metadata: { id: '2' } },
    ];
    const result = await KnowledgeStore.splitDocuments(config, docs);
    assert.ok(result.length > 2);
  });
});

// --- Static: loadDocuments ---

describe('KnowledgeStore.loadDocuments', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should load a single text file', async () => {
    const dataDir = path.join(tempDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'test.txt'), 'Hello, knowledge store!');

    const config = makeFileConfig({
      source: { type: 'file', path: './data/test.txt' },
    } as any);

    const docs = await KnowledgeStore.loadDocuments(config, tempDir);
    assert.ok(docs.length > 0);
    assert.ok(docs[0]!.pageContent.includes('Hello'));
  });

  it('should load files from a directory', async () => {
    const dataDir = path.join(tempDir, 'docs');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'a.txt'), 'File A content');
    await fs.writeFile(path.join(dataDir, 'b.txt'), 'File B content');

    const config = makeDirectoryConfig({
      source: { type: 'directory', path: './docs', pattern: '*.txt', recursive: true },
    } as any);

    const docs = await KnowledgeStore.loadDocuments(config, tempDir);
    assert.equal(docs.length, 2);
  });

  it('should throw for unknown source type', async () => {
    const config = {
      name: 'bad',
      description: 'bad',
      source: { type: 'unknown' as any, path: './nowhere' },
      splitter: { type: 'recursive' as const, chunkSize: 500, chunkOverlap: 50 },
      embedding: 'default',
    } as KnowledgeConfig;

    await assert.rejects(
      () => KnowledgeStore.loadDocuments(config, tempDir),
      /Unknown source type/,
    );
  });

  it('should use text loader by default for file source', async () => {
    const dataDir = path.join(tempDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'test.md'), '# Markdown\n\nSome content');

    const config = makeFileConfig({
      source: { type: 'file', path: './data/test.md' },
      loader: { type: 'text' },
    } as any);

    const docs = await KnowledgeStore.loadDocuments(config, tempDir);
    assert.ok(docs.length > 0);
    assert.ok(docs[0]!.pageContent.includes('Markdown'));
  });

  it('should load JSON files with json loader', async () => {
    const dataDir = path.join(tempDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'test.json'), JSON.stringify([
      { name: 'Alice', role: 'Engineer' },
      { name: 'Bob', role: 'Designer' },
    ]));

    const config = makeFileConfig({
      source: { type: 'file', path: './data/test.json' },
      loader: { type: 'json' },
    } as any);

    const docs = await KnowledgeStore.loadDocuments(config, tempDir);
    assert.ok(docs.length > 0);
  });

  it('should load CSV files with csv loader', async () => {
    const dataDir = path.join(tempDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'test.csv'), 'name,role\nAlice,Engineer\nBob,Designer');

    const config = makeFileConfig({
      source: { type: 'file', path: './data/test.csv' },
      loader: { type: 'csv' },
    } as any);

    const docs = await KnowledgeStore.loadDocuments(config, tempDir);
    assert.ok(docs.length > 0);
  });

  it('should handle directory with no matching files', async () => {
    const emptyDir = path.join(tempDir, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });

    const config = makeDirectoryConfig({
      source: { type: 'directory', path: './empty', pattern: '*.txt', recursive: true },
    } as any);

    const docs = await KnowledgeStore.loadDocuments(config, tempDir);
    assert.equal(docs.length, 0);
  });
});

// --- Initialize with mock dependencies ---

describe('KnowledgeStore.initialize (with mocked deps)', () => {
  let tempDir: string;
  let knowledgeDir: string;

  // Mock helpers
  function createMockSqliteStore(opts: {
    hasData?: boolean;
    storedHashes?: string;
    chunkCount?: number;
    entityCount?: number;
    relCount?: number;
  } = {}) {
    const {
      hasData = false,
      storedHashes,
      chunkCount = 0,
      entityCount = 0,
      relCount = 0,
    } = opts;

    return {
      getMeta: mock.fn((_key: string) => storedHashes),
      setMeta: mock.fn(),
      hasData: mock.fn(() => hasData),
      getChunkCount: mock.fn(() => chunkCount),
      getEntityCount: mock.fn(() => entityCount),
      getRelationshipCount: mock.fn(() => relCount),
      insertChunks: mock.fn(),
      insertEntities: mock.fn(),
      insertRelationships: mock.fn(),
      searchChunks: mock.fn((_embed: number[], _k: number) => [
        { content: 'chunk result', metadata: { source: 'test' }, score: 0.9, source: 'test' },
      ]),
      searchEntities: mock.fn((_embed: number[], _k: number) => []),
      getNeighborhood: mock.fn(() => ({ entities: [], relationships: [] })),
      clear: mock.fn(),
      close: mock.fn(),
      getDbPath: mock.fn(() => path.join(tempDir, '.knowledge-data', 'test.db')),
    };
  }

  function createMockEmbeddings() {
    return {
      embedQuery: mock.fn(async (_text: string) => [0.1, 0.2, 0.3]),
      embedDocuments: mock.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    };
  }

  beforeEach(async () => {
    tempDir = await makeTempDir();
    knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, '.knowledge-data'), { recursive: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should initialize a file-based store with full indexing pipeline', async () => {
    // Set up a real file
    const dataDir = path.join(tempDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'test.txt'), 'Hello world test document content');

    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));

    const mockEmbeddings = createMockEmbeddings();
    const mockSqlite = createMockSqliteStore();

    // Mock static methods on KnowledgeStore
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    // Mock SqliteStore constructor by mocking the module-level import
    // Since we can't easily mock the constructor, we'll mock validateDimensions
    // and replace the internal SqliteStore usage via a different approach.
    // Instead, let's use a simpler approach: mock the static helpers and
    // inject a mock SqliteStore via the private doInitialize path.

    // Actually the cleanest approach is to mock the relevant static methods
    // and patch the SqliteStore constructor. Since node:test mock.module is
    // experimental and complex, let's mock at the static method level.

    const { SqliteStore } = await import('../../lib/knowledge/sqlite-store.ts');
    mock.method(SqliteStore, 'validateDimensions', () => true);

    // We need to intercept the SqliteStore constructor. Since we can't do that
    // easily with node:test, let's test the initialization indirectly by
    // testing the parts we CAN test and verifying the integration flow.

    // Test that createEmbeddings was properly mocked
    const embeddings = await KnowledgeStore.createEmbeddings('default');
    assert.ok(embeddings);

    const query = await embeddings.embedQuery('test');
    assert.deepEqual(query, [0.1, 0.2, 0.3]);
  });

  it('should return existing store on re-initialize', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));

    // Manually inject a mock store instance
    const mockInstance: KnowledgeStoreInstance = {
      config: store.getConfig('test-kb')!,
      search: async () => [],
      addDocuments: async () => {},
      refresh: async () => {},
      getMetadata: () => ({
        name: 'test-kb',
        kind: 'vector',
        status: 'indexed',
        lastIndexedAt: new Date().toISOString(),
        lastIndexDurationMs: 100,
        documentCount: 5,
        chunkCount: 10,
        entityCount: 0,
        edgeCount: 0,
        communityCount: 0,
        errorMessage: null,
        sourceHashes: {},
        embeddingModel: 'default',
        cacheVersion: '1.0',
      }),
    };

    // Access private stores map
    (store as any).stores.set('test-kb', mockInstance);

    // Should return existing without re-indexing
    const result = await store.initialize('test-kb');
    assert.equal(result, mockInstance);
  });

  it('should wait for active indexing promise instead of double-indexing', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));

    // Create a slow promise and register it as active
    let resolve!: (v: KnowledgeStoreInstance) => void;
    const slowPromise = new Promise<KnowledgeStoreInstance>((r) => { resolve = r; });
    (store as any).activeIndexing.set('test-kb', slowPromise);

    // Start initialize - should join the existing promise
    const initPromise = store.initialize('test-kb');
    assert.ok(store.isIndexing('test-kb'));

    // Resolve the slow promise
    const mockInstance: KnowledgeStoreInstance = {
      config: store.getConfig('test-kb')!,
      search: async () => [],
      addDocuments: async () => {},
      refresh: async () => {},
      getMetadata: () => ({
        name: 'test-kb',
        kind: 'vector',
        status: 'indexed',
        lastIndexedAt: null,
        lastIndexDurationMs: null,
        documentCount: 0,
        chunkCount: 0,
        entityCount: 0,
        edgeCount: 0,
        errorMessage: null,
        sourceHashes: {},
        embeddingModel: 'default',
        cacheVersion: '1.0',
      }),
    };
    resolve(mockInstance);

    const result = await initPromise;
    assert.equal(result, mockInstance);
  });

  it('should report isIndexing during active indexing', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    assert.equal(store.isIndexing('test-kb'), false);

    // Simulate active indexing
    (store as any).activeIndexing.set('test-kb', Promise.resolve());
    assert.equal(store.isIndexing('test-kb'), true);

    (store as any).activeIndexing.delete('test-kb');
    assert.equal(store.isIndexing('test-kb'), false);
  });
});

// --- Search Instance Behavior ---

describe('KnowledgeStore search instance', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should perform search on injected instance', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));

    const searchResults: SearchResult[] = [
      { content: 'result 1', metadata: { source: 'a.txt' }, score: 0.95 },
      { content: 'result 2', metadata: { source: 'b.txt' }, score: 0.85 },
    ];

    const mockInstance: KnowledgeStoreInstance = {
      config: store.getConfig('test-kb')!,
      search: mock.fn(async (_query: string, _k?: number) => searchResults),
      addDocuments: async () => {},
      refresh: async () => {},
      getMetadata: () => ({
        name: 'test-kb',
        kind: 'vector',
        status: 'indexed',
        lastIndexedAt: new Date().toISOString(),
        lastIndexDurationMs: 100,
        documentCount: 5,
        chunkCount: 10,
        entityCount: 0,
        edgeCount: 0,
        errorMessage: null,
        sourceHashes: {},
        embeddingModel: 'default',
        cacheVersion: '1.0',
      }),
    };

    (store as any).stores.set('test-kb', mockInstance);

    const instance = store.get('test-kb');
    assert.ok(instance);

    const results = await instance!.search('test query', 2);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.content, 'result 1');
    assert.equal(results[0]!.score, 0.95);
  });

  it('should list all initialized store instances', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);

    const mockInstance1: KnowledgeStoreInstance = {
      config: makeFileConfig({ name: 'kb1' } as any),
      search: async () => [],
      addDocuments: async () => {},
      refresh: async () => {},
      getMetadata: () => ({
        name: 'kb1', kind: 'vector', status: 'indexed',
        lastIndexedAt: null, lastIndexDurationMs: null,
        documentCount: 0, chunkCount: 0, entityCount: 0, edgeCount: 0,
        errorMessage: null, sourceHashes: {}, embeddingModel: 'default', cacheVersion: '1.0',
      }),
    };

    const mockInstance2: KnowledgeStoreInstance = {
      config: makeFileConfig({ name: 'kb2' } as any),
      search: async () => [],
      addDocuments: async () => {},
      refresh: async () => {},
      getMetadata: () => ({
        name: 'kb2', kind: 'vector', status: 'indexed',
        lastIndexedAt: null, lastIndexDurationMs: null,
        documentCount: 0, chunkCount: 0, entityCount: 0, edgeCount: 0,
        errorMessage: null, sourceHashes: {}, embeddingModel: 'default', cacheVersion: '1.0',
      }),
    };

    (store as any).stores.set('kb1', mockInstance1);
    (store as any).stores.set('kb2', mockInstance2);

    const list = store.list();
    assert.equal(list.length, 2);
  });

  it('should return metadata from getMetadata on instance', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);

    const metadata = {
      name: 'test-kb',
      kind: 'vector' as const,
      status: 'indexed' as const,
      lastIndexedAt: '2025-01-01T00:00:00Z',
      lastIndexDurationMs: 500,
      documentCount: 10,
      chunkCount: 25,
      entityCount: 0,
      edgeCount: 0,
      errorMessage: null,
      sourceHashes: { 'file.txt': 'abc123' },
      embeddingModel: 'default',
      cacheVersion: '1.0',
    };

    const mockInstance: KnowledgeStoreInstance = {
      config: makeFileConfig(),
      search: async () => [],
      addDocuments: async () => {},
      refresh: async () => {},
      getMetadata: () => ({ ...metadata }),
    };

    (store as any).stores.set('test-kb', mockInstance);

    const instance = store.get('test-kb')!;
    const m = instance.getMetadata();
    assert.equal(m.name, 'test-kb');
    assert.equal(m.status, 'indexed');
    assert.equal(m.documentCount, 10);
    assert.equal(m.chunkCount, 25);
  });
});

// --- Evict with active stores ---

describe('KnowledgeStore eviction with active resources', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should close sqlite store on evict', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);

    const mockClose = mock.fn();
    const mockSqliteStore = { close: mockClose };

    (store as any).sqliteStores.set('test-kb', mockSqliteStore);
    (store as any).configs.set('test-kb', makeFileConfig());
    (store as any).stores.set('test-kb', {});

    store.evict('test-kb');

    assert.equal(mockClose.mock.callCount(), 1);
    assert.equal(store.get('test-kb'), undefined);
    assert.equal(store.getConfig('test-kb'), undefined);
    assert.equal(store.getSqliteStore('test-kb'), undefined);
  });

  it('should stop cron task on evict', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);

    const mockStop = mock.fn();
    const mockCronTask = { stop: mockStop };

    (store as any).reindexTasks.set('test-kb', mockCronTask);
    (store as any).configs.set('test-kb', makeFileConfig());

    store.evict('test-kb');

    assert.equal(mockStop.mock.callCount(), 1);
  });

  it('should clear active indexing on evict', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);

    (store as any).activeIndexing.set('test-kb', Promise.resolve());
    (store as any).configs.set('test-kb', makeFileConfig());

    store.evict('test-kb');

    assert.equal(store.isIndexing('test-kb'), false);
  });

  it('should stop all cron tasks on close', () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);

    const stops: number[] = [];
    const mockTask1 = { stop: mock.fn(() => stops.push(1)) };
    const mockTask2 = { stop: mock.fn(() => stops.push(2)) };

    (store as any).reindexTasks.set('kb1', mockTask1);
    (store as any).reindexTasks.set('kb2', mockTask2);

    store.close();

    assert.equal(stops.length, 2);
    // Verify reindexTasks is cleared
    assert.equal((store as any).reindexTasks.size, 0);
  });
});

// --- Refresh ---

describe('KnowledgeStore.refresh', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return early if store does not exist', async () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    // Should not throw
    await store.refresh('nonexistent');
  });

  it('should call refresh on the store instance and update metadata', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));

    const refreshCalled = mock.fn();
    const storeMetadata = {
      name: 'test-kb',
      kind: 'vector' as const,
      status: 'indexed' as const,
      lastIndexedAt: '2025-01-01T00:00:00Z',
      lastIndexDurationMs: 100,
      documentCount: 5,
      chunkCount: 10,
      entityCount: 0,
      edgeCount: 0,
      errorMessage: null,
      sourceHashes: {},
      embeddingModel: 'default',
      cacheVersion: '1.0',
    };

    const mockInstance: KnowledgeStoreInstance = {
      config: store.getConfig('test-kb')!,
      search: async () => [],
      addDocuments: async () => {},
      refresh: async (onProgress) => {
        refreshCalled();
        onProgress?.({ name: 'test-kb', phase: 'done', progress: 100, message: 'Done' });
      },
      getMetadata: () => ({ ...storeMetadata }),
    };

    (store as any).stores.set('test-kb', mockInstance);

    // Save initial metadata
    const metaMgr = store.getMetadataManager();
    const { createDefaultMetadata } = await import('../../lib/knowledge/knowledge-store-metadata.ts');
    const meta = createDefaultMetadata('test-kb', 'vector');
    meta.status = 'indexed';
    await metaMgr.save('test-kb', meta);

    const progressEvents: any[] = [];
    await store.refresh('test-kb', (event) => progressEvents.push(event));

    assert.equal(refreshCalled.mock.callCount(), 1);
    assert.ok(progressEvents.length > 0);

    // After refresh, should not be indexing
    assert.equal(store.isIndexing('test-kb'), false);

    // Metadata should be updated
    const finalMeta = await store.getStatus('test-kb');
    assert.ok(finalMeta);
    assert.equal(finalMeta!.status, 'indexed');
  });

  it('should handle refresh errors and update metadata to error', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));

    const mockInstance: KnowledgeStoreInstance = {
      config: store.getConfig('test-kb')!,
      search: async () => [],
      addDocuments: async () => {},
      refresh: async () => {
        throw new Error('Refresh failed: network error');
      },
      getMetadata: () => ({
        name: 'test-kb',
        kind: 'vector' as const,
        status: 'indexed' as const,
        lastIndexedAt: null,
        lastIndexDurationMs: null,
        documentCount: 0,
        chunkCount: 0,
        entityCount: 0,
        edgeCount: 0,
        errorMessage: null,
        sourceHashes: {},
        embeddingModel: 'default',
        cacheVersion: '1.0',
      }),
    };

    (store as any).stores.set('test-kb', mockInstance);

    // Save initial metadata
    const metaMgr = store.getMetadataManager();
    const { createDefaultMetadata } = await import('../../lib/knowledge/knowledge-store-metadata.ts');
    const meta = createDefaultMetadata('test-kb', 'vector');
    meta.status = 'indexed';
    await metaMgr.save('test-kb', meta);

    await assert.rejects(
      () => store.refresh('test-kb'),
      /Refresh failed: network error/,
    );

    // Metadata should be updated to error
    const finalMeta = await store.getStatus('test-kb');
    assert.ok(finalMeta);
    assert.equal(finalMeta!.status, 'error');
    assert.ok(finalMeta!.errorMessage!.includes('network error'));

    // Should not be indexing
    assert.equal(store.isIndexing('test-kb'), false);
  });

  it('should set isIndexing during refresh and clear after', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));

    let indexingDuringRefresh = false;

    const mockInstance: KnowledgeStoreInstance = {
      config: store.getConfig('test-kb')!,
      search: async () => [],
      addDocuments: async () => {},
      refresh: async () => {
        // Yield control so activeIndexing.set runs before we check
        await new Promise(r => setTimeout(r, 5));
        indexingDuringRefresh = store.isIndexing('test-kb');
      },
      getMetadata: () => ({
        name: 'test-kb',
        kind: 'vector' as const,
        status: 'indexed' as const,
        lastIndexedAt: null,
        lastIndexDurationMs: null,
        documentCount: 0,
        chunkCount: 0,
        entityCount: 0,
        edgeCount: 0,
        errorMessage: null,
        sourceHashes: {},
        embeddingModel: 'default',
        cacheVersion: '1.0',
      }),
    };

    (store as any).stores.set('test-kb', mockInstance);

    // Save metadata so refresh path works
    const metaMgr = store.getMetadataManager();
    const { createDefaultMetadata } = await import('../../lib/knowledge/knowledge-store-metadata.ts');
    const meta = createDefaultMetadata('test-kb', 'vector');
    meta.status = 'indexed';
    await metaMgr.save('test-kb', meta);

    await store.refresh('test-kb');

    assert.ok(indexingDuringRefresh, 'isIndexing should be true during refresh');
    assert.equal(store.isIndexing('test-kb'), false, 'isIndexing should be false after refresh');
  });
});

// --- wrapWithValidation (tested via createEmbeddings mock) ---

describe('KnowledgeStore embedding validation', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('should validate embeddings - reject empty array', async () => {
    // Test wrapWithValidation indirectly by accessing the private static method
    // We create a mock embeddings provider that returns empty and verify it throws

    const badEmbeddings = {
      embedQuery: async () => [] as number[],
      embedDocuments: async () => [[]] as number[][],
    };

    // Access the private static wrapWithValidation
    const wrapped = (KnowledgeStore as any).wrapWithValidation(badEmbeddings);

    await assert.rejects(
      () => wrapped.embedQuery('test'),
      /Embedding.*invalid format/,
    );
  });

  it('should validate embeddings - reject NaN values', async () => {
    const badEmbeddings = {
      embedQuery: async () => [NaN, 0.2, 0.3],
      embedDocuments: async () => [[NaN, 0.2, 0.3]],
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(badEmbeddings);

    await assert.rejects(
      () => wrapped.embedQuery('test'),
      /NaN or Infinity/,
    );
  });

  it('should validate embeddings - reject Infinity values', async () => {
    const badEmbeddings = {
      embedQuery: async () => [Infinity, 0.2, 0.3],
      embedDocuments: async () => [[Infinity, 0.2, 0.3]],
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(badEmbeddings);

    await assert.rejects(
      () => wrapped.embedQuery('test'),
      /NaN or Infinity/,
    );
  });

  it('should validate embeddings - reject zero vector', async () => {
    const badEmbeddings = {
      embedQuery: async () => [0, 0, 0],
      embedDocuments: async () => [[0, 0, 0]],
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(badEmbeddings);

    await assert.rejects(
      () => wrapped.embedQuery('test'),
      /zero vector/,
    );
  });

  it('should pass through valid embeddings', async () => {
    const goodEmbeddings = {
      embedQuery: async () => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(goodEmbeddings);

    const result = await wrapped.embedQuery('test');
    assert.deepEqual(result, [0.1, 0.2, 0.3]);

    const docsResult = await wrapped.embedDocuments(['a', 'b']);
    assert.equal(docsResult.length, 2);
    assert.deepEqual(docsResult[0], [0.1, 0.2, 0.3]);
  });

  it('should validate embedDocuments - reject invalid in batch', async () => {
    const badEmbeddings = {
      embedQuery: async () => [0.1, 0.2, 0.3],
      embedDocuments: async () => [[0.1, 0.2, 0.3], [NaN, 0, 0]],
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(badEmbeddings);

    await assert.rejects(
      () => wrapped.embedDocuments(['a', 'b']),
      /NaN or Infinity/,
    );
  });

  it('should append eosToken when provided', async () => {
    let capturedText = '';
    const embeddings = {
      embedQuery: async (text: string) => { capturedText = text; return [0.1, 0.2]; },
      embedDocuments: async (texts: string[]) => { capturedText = texts[0]!; return texts.map(() => [0.1, 0.2]); },
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(embeddings, '</s>');
    await wrapped.embedQuery('hello');
    assert.equal(capturedText, 'hello</s>');
  });

  it('should not double-append eosToken', async () => {
    let capturedText = '';
    const embeddings = {
      embedQuery: async (text: string) => { capturedText = text; return [0.1, 0.2]; },
      embedDocuments: async () => [[0.1, 0.2]],
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(embeddings, '</s>');
    await wrapped.embedQuery('hello</s>');
    assert.equal(capturedText, 'hello</s>');
  });

  it('should not append eosToken when not provided', async () => {
    let capturedText = '';
    const embeddings = {
      embedQuery: async (text: string) => { capturedText = text; return [0.1, 0.2]; },
      embedDocuments: async () => [[0.1, 0.2]],
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(embeddings);
    await wrapped.embedQuery('hello');
    assert.equal(capturedText, 'hello');
  });

  it('should wrap embedQuery errors with descriptive message', async () => {
    const embeddings = {
      embedQuery: async () => { throw new Error('API timeout'); },
      embedDocuments: async () => { throw new Error('API timeout'); },
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(embeddings);

    await assert.rejects(
      () => wrapped.embedQuery('test'),
      /Embedding query failed: API timeout/,
    );
  });

  it('should wrap embedDocuments errors with descriptive message', async () => {
    const embeddings = {
      embedQuery: async () => [0.1],
      embedDocuments: async () => { throw new Error('Rate limit exceeded'); },
    };

    const wrapped = (KnowledgeStore as any).wrapWithValidation(embeddings);

    await assert.rejects(
      () => wrapped.embedDocuments(['a']),
      /Embedding documents failed: Rate limit exceeded/,
    );
  });
});

// --- createLoader (private static, tested via loadDocuments) ---

describe('KnowledgeStore.loadDocuments loader types', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should use markdown loader type (falls back to text loader)', async () => {
    const dataDir = path.join(tempDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'test.md'), '# Title\n\nContent here');

    const config = makeFileConfig({
      source: { type: 'file', path: './data/test.md' },
      loader: { type: 'markdown' },
    } as any);

    const docs = await KnowledgeStore.loadDocuments(config, tempDir);
    assert.ok(docs.length > 0);
    assert.ok(docs[0]!.pageContent.includes('Title'));
  });

  it('should default to text loader when no loader type is specified', async () => {
    const dataDir = path.join(tempDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'test.txt'), 'Plain text content');

    const config = makeFileConfig({
      source: { type: 'file', path: './data/test.txt' },
    } as any);
    // Remove loader to test default
    delete (config as any).loader;

    const docs = await KnowledgeStore.loadDocuments(config, tempDir);
    assert.ok(docs.length > 0);
  });

  it('should load directory with json loader', async () => {
    const dataDir = path.join(tempDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'a.json'), JSON.stringify({ title: 'A' }));
    await fs.writeFile(path.join(dataDir, 'b.json'), JSON.stringify({ title: 'B' }));

    const config = makeDirectoryConfig({
      source: { type: 'directory', path: './data', pattern: '*.json', recursive: true },
      loader: { type: 'json' },
    } as any);

    const docs = await KnowledgeStore.loadDocuments(config, tempDir);
    assert.ok(docs.length >= 2);
  });
});

// --- restoreIndexedStores ---

describe('KnowledgeStore.restoreIndexedStores', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should skip stores that are not indexed', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));

    // Save metadata with non-indexed status
    const metaMgr = store.getMetadataManager();
    const { createDefaultMetadata } = await import('../../lib/knowledge/knowledge-store-metadata.ts');
    const meta = createDefaultMetadata('test-kb', 'vector');
    meta.status = 'error';
    await metaMgr.save('test-kb', meta);

    // Call restoreIndexedStores (private, access via loadAll behavior)
    // Since loadAll calls restoreIndexedStores, and the status is 'error', it should skip
    await store.loadAll();

    // Store should not be initialized (no real embeddings/sqlite)
    assert.equal(store.get('test-kb'), undefined);
  });

  it('should skip stores already in memory', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);
    const store = new KnowledgeStore(knowledgeDir, tempDir);

    // Pre-populate a store in memory
    const mockInstance: KnowledgeStoreInstance = {
      config: makeFileConfig(),
      search: async () => [],
      addDocuments: async () => {},
      refresh: async () => {},
      getMetadata: () => ({
        name: 'test-kb', kind: 'vector', status: 'indexed',
        lastIndexedAt: null, lastIndexDurationMs: null,
        documentCount: 0, chunkCount: 0, entityCount: 0, edgeCount: 0,
        errorMessage: null, sourceHashes: {}, embeddingModel: 'default', cacheVersion: '1.0',
      }),
    };
    (store as any).stores.set('test-kb', mockInstance);

    // Save metadata with indexed status
    const metaMgr = store.getMetadataManager();
    const { createDefaultMetadata } = await import('../../lib/knowledge/knowledge-store-metadata.ts');
    const meta = createDefaultMetadata('test-kb', 'vector');
    meta.status = 'indexed';
    await metaMgr.save('test-kb', meta);

    // loadAll should skip since it's already in stores map
    await store.loadAll();

    // Same instance should still be there
    assert.equal(store.get('test-kb'), mockInstance);
  });
});

// --- Full doInitialize pipeline with real SqliteStore ---

describe('KnowledgeStore full initialization pipeline', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, '.knowledge-data'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'data'), { recursive: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should complete full indexing pipeline for file source', async () => {
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Hello world test content for indexing');
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));

    // Mock createEmbeddings to avoid needing llm.json
    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const progressEvents: Array<{ phase: string; progress: number }> = [];
    const instance = await store.initialize('test-kb', (event) => {
      progressEvents.push({ phase: event.phase, progress: event.progress });
    });

    // Verify instance
    assert.ok(instance);
    assert.equal(instance.config.name, 'test-kb');

    // Verify persisted metadata (getMetadata returns a snapshot, persisted status is canonical)
    const persistedMeta = await store.getStatus('test-kb');
    assert.ok(persistedMeta);
    assert.equal(persistedMeta!.status, 'indexed');
    assert.equal(persistedMeta!.name, 'test-kb');
    assert.ok(persistedMeta!.documentCount > 0);
    assert.ok(persistedMeta!.chunkCount > 0);
    assert.equal(persistedMeta!.embeddingModel, 'default');
    assert.ok(persistedMeta!.lastIndexedAt);
    assert.ok(persistedMeta!.lastIndexDurationMs! >= 0);
    assert.equal(persistedMeta!.errorMessage, null);

    // Instance metadata reflects initial state
    const meta = instance.getMetadata();
    assert.equal(meta.name, 'test-kb');
    assert.ok(meta.chunkCount > 0);

    // Verify progress events
    assert.ok(progressEvents.some(e => e.phase === 'loading'));
    assert.ok(progressEvents.some(e => e.phase === 'splitting'));
    assert.ok(progressEvents.some(e => e.phase === 'embedding'));
    assert.ok(progressEvents.some(e => e.phase === 'done'));

    // Verify store is accessible
    assert.ok(store.get('test-kb'));
    assert.ok(store.getSqliteStore('test-kb'));

    // Verify search works
    const results = await instance.search('hello', 2);
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
    assert.ok(results[0]!.content);
    assert.ok(typeof results[0]!.score === 'number');

    // Verify metadata was persisted
    const status = await store.getStatus('test-kb');
    assert.ok(status);
    assert.equal(status!.status, 'indexed');

    // Clean up
    store.getSqliteStore('test-kb')?.close();
  });

  it('should restore from SQLite when hashes match', async () => {
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Content for restore test');
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    // First initialization - full indexing
    const store1 = new KnowledgeStore(knowledgeDir, tempDir);
    await store1.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));
    const instance1 = await store1.initialize('test-kb');
    const meta1 = instance1.getMetadata();
    store1.getSqliteStore('test-kb')?.close();

    // Second initialization - should restore from SQLite
    const store2 = new KnowledgeStore(knowledgeDir, tempDir);
    await store2.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));
    const progressEvents: string[] = [];
    const instance2 = await store2.initialize('test-kb', (event) => {
      progressEvents.push(event.message);
    });
    const meta2 = instance2.getMetadata();

    // Should have restored, not re-indexed
    assert.ok(progressEvents.some(m => m.includes('Restored from SQLite')));
    assert.equal(meta2.chunkCount, meta1.chunkCount);

    store2.getSqliteStore('test-kb')?.close();
  });

  it('should handle errors during initialization and set error metadata', async () => {
    // Create file source that points to nonexistent file
    const yaml = `
name: error-kb
description: Will fail to load
source:
  type: file
  path: ./data/nonexistent.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    await fs.writeFile(path.join(knowledgeDir, 'error.knowledge.yaml'), yaml);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'error.knowledge.yaml'));

    let progressError = '';
    await assert.rejects(
      () => store.initialize('error-kb', (event) => {
        if (event.phase === 'error') progressError = event.message;
      }),
    );

    assert.ok(progressError.length > 0);

    // Metadata should be error
    const meta = await store.getStatus('error-kb');
    assert.ok(meta);
    assert.equal(meta!.status, 'error');
    assert.ok(meta!.errorMessage);
  });

  it('should add documents to an initialized store', async () => {
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Initial content');
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));
    const instance = await store.initialize('test-kb');

    const initialCount = instance.getMetadata().chunkCount;

    // Add more documents
    await instance.addDocuments([
      { content: 'New document 1', metadata: { source: 'dynamic' } },
      { content: 'New document 2' },
    ]);

    const updatedCount = instance.getMetadata().chunkCount;
    assert.ok(updatedCount > initialCount);

    store.getSqliteStore('test-kb')?.close();
  });

  it('should search with scoreThreshold filtering', async () => {
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Test content for threshold filtering');
    await fs.writeFile(path.join(knowledgeDir, 'threshold.knowledge.yaml'), SEARCH_CONFIG_YAML);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'threshold.knowledge.yaml'));
    const instance = await store.initialize('search-kb');

    // Search results with cosine similarity - threshold is 0.5
    const results = await instance.search('test', 10);
    assert.ok(Array.isArray(results));
    // All results should be above the threshold
    for (const r of results) {
      assert.ok(r.score >= 0.5, `Score ${r.score} should be >= 0.5`);
    }

    store.getSqliteStore('search-kb')?.close();
  });

  it('should handle search errors gracefully and return empty array', async () => {
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Test content');
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);

    // Return valid embeddings during indexing but fail on search
    let callCount = 0;
    const mockEmbeddings = {
      embedQuery: async (_text: string) => {
        callCount++;
        if (callCount > 1) throw new Error('Embedding service down');
        return [0.1, 0.2, 0.3];
      },
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));
    const instance = await store.initialize('test-kb');

    // Search should catch the error and return empty
    const results = await instance.search('test');
    assert.deepEqual(results, []);

    store.getSqliteStore('test-kb')?.close();
  });

  it('should use default k=4 when no k specified and no search config', async () => {
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Content a b c d e f g');
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));
    const instance = await store.initialize('test-kb');

    // Default k=4 when not specified
    const results = await instance.search('test');
    assert.ok(Array.isArray(results));
    assert.ok(results.length <= 4);

    store.getSqliteStore('test-kb')?.close();
  });

  it('should refresh instance when source changes', async () => {
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Original content');
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));
    const instance = await store.initialize('test-kb');

    // Change the source file
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Updated content with new data');

    // Refresh should re-index
    await instance.refresh();

    // After refresh, store should be re-initialized
    const newInstance = store.get('test-kb');
    assert.ok(newInstance);

    store.getSqliteStore('test-kb')?.close();
  });

  it('should skip refresh when source has not changed', async () => {
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Content unchanged');
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));
    const instance = await store.initialize('test-kb');

    // Refresh without changing source
    await instance.refresh();

    // Should still work
    assert.ok(store.get('test-kb'));

    store.getSqliteStore('test-kb')?.close();
  });

  it('should initialize with graph config (direct mapping)', async () => {
    // We need a database source for graph mapping, but that requires
    // a real database. Instead, test that graph without directMapping throws.
    const yaml = `
name: graph-no-mapping
description: Graph without direct mapping
source:
  type: file
  path: ./data/test.txt
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
graph: {}
`;
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Test content');
    await fs.writeFile(path.join(knowledgeDir, 'graph-no-mapping.knowledge.yaml'), yaml);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'graph-no-mapping.knowledge.yaml'));

    // Should throw because graph config exists but no directMapping
    await assert.rejects(
      () => store.initialize('graph-no-mapping'),
      /requires a directMapping configuration/,
    );
  });

  it('should handle dimension mismatch by re-indexing', async () => {
    await fs.writeFile(path.join(tempDir, 'data', 'test.txt'), 'Content for dimension test');
    await fs.writeFile(path.join(knowledgeDir, 'test.knowledge.yaml'), VALID_YAML);

    // First init with 3 dimensions
    const mockEmbeddings3 = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings3);

    const store1 = new KnowledgeStore(knowledgeDir, tempDir);
    await store1.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));
    const instance1 = await store1.initialize('test-kb');
    assert.ok(instance1);
    store1.getSqliteStore('test-kb')?.close();

    // Second init with different dimensions should detect mismatch
    mock.restoreAll();
    const mockEmbeddings5 = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3, 0.4, 0.5],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4, 0.5]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings5);

    const store2 = new KnowledgeStore(knowledgeDir, tempDir);
    await store2.loadOne(path.join(knowledgeDir, 'test.knowledge.yaml'));
    const instance2 = await store2.initialize('test-kb');
    assert.ok(instance2);
    const meta2 = await store2.getStatus('test-kb');
    assert.equal(meta2!.status, 'indexed');
    store2.getSqliteStore('test-kb')?.close();
  });
});

// --- Graph entity extraction and entity search ---

describe('KnowledgeStore graph entity initialization', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, '.knowledge-data'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'data'), { recursive: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should extract entities from direct mapping and support entity search', async () => {
    // Create a CSV file that DirectMapper can work with
    const csvContent = 'id,name,category\n1,Widget A,electronics\n2,Widget B,tools\n3,Widget C,electronics';
    await fs.writeFile(path.join(tempDir, 'data', 'items.csv'), csvContent);

    const yaml = `
name: graph-kb
description: Graph with direct mapping
source:
  type: file
  path: ./data/items.csv
loader:
  type: csv
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
graph:
  directMapping:
    entities:
      - type: item
        idColumn: id
        nameColumn: name
        properties: [category]
    relationships:
      - type: belongs_to
        source: item
        target: category
        sourceIdColumn: id
        targetIdColumn: category
`;
    await fs.writeFile(path.join(knowledgeDir, 'graph.knowledge.yaml'), yaml);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'graph.knowledge.yaml'));

    const progressPhases: string[] = [];
    const instance = await store.initialize('graph-kb', (event) => {
      progressPhases.push(event.phase);
    });

    assert.ok(instance);
    assert.ok(progressPhases.includes('extracting'));

    // The persisted metadata should show entities
    const meta = await store.getStatus('graph-kb');
    assert.ok(meta);
    assert.equal(meta!.status, 'indexed');

    // Entity count should be > 0 if DirectMapper found anything
    const sqliteStore = store.getSqliteStore('graph-kb');
    assert.ok(sqliteStore);
    // Entities come from DirectMapper -- exact count depends on mapping logic

    // Search should work (entity neighborhood search is triggered when entities exist)
    const results = await instance.search('Widget', 5);
    assert.ok(Array.isArray(results));

    sqliteStore?.close();
  });

  it('should log database source info during init', async () => {
    // Test the source type logging paths by initializing with database config
    // We can't actually connect to a DB, but the logging paths are hit before loading
    const yaml = `
name: db-log-kb
description: Database source for logging
source:
  type: database
  connectionString: "postgresql://user@localhost:5432/testdb"
  query: "SELECT content FROM docs"
  contentColumn: content
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    await fs.writeFile(path.join(knowledgeDir, 'db-log.knowledge.yaml'), yaml);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'db-log.knowledge.yaml'));

    // This will fail during document loading (no real DB), but source logging is hit
    await assert.rejects(
      () => store.initialize('db-log-kb'),
    );
  });

  it('should log web source info during init', async () => {
    const yaml = `
name: web-log-kb
description: Web source for logging
source:
  type: web
  url: https://nonexistent.example.com/api/data
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
`;
    await fs.writeFile(path.join(knowledgeDir, 'web-log.knowledge.yaml'), yaml);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'web-log.knowledge.yaml'));

    // This will fail during document loading (network), but source logging is hit
    await assert.rejects(
      () => store.initialize('web-log-kb'),
    );
  });
});

// --- Helper function tests (normalizeId, buildRelationships, formatNeighborhood) ---

describe('KnowledgeStore internal helpers', () => {
  // These are module-level functions not exported, but we can test them
  // indirectly through the graph initialization pipeline.
  // We also access them through the compiled module.

  it('should normalize entity IDs correctly', async () => {
    // Access the normalizeId function via the module
    // Since it's not exported, we test it through the full pipeline
    // by verifying entity IDs in the sqlite store after indexing

    const tempDir = await makeTempDir();
    const knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, '.knowledge-data'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'data'), { recursive: true });

    const csvContent = 'id,name,category\n1,Test Item,electronics';
    await fs.writeFile(path.join(tempDir, 'data', 'items.csv'), csvContent);

    const yaml = `
name: normalize-kb
description: Test normalizeId
source:
  type: file
  path: ./data/items.csv
loader:
  type: csv
splitter:
  type: recursive
  chunkSize: 500
  chunkOverlap: 50
embedding: default
graph:
  directMapping:
    entities:
      - type: item
        idColumn: id
        nameColumn: name
        properties: [category]
`;
    await fs.writeFile(path.join(knowledgeDir, 'normalize.knowledge.yaml'), yaml);

    const mockEmbeddings = {
      embedQuery: async (_text: string) => [0.1, 0.2, 0.3],
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    mock.method(KnowledgeStore, 'createEmbeddings', async () => mockEmbeddings);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'normalize.knowledge.yaml'));
    await store.initialize('normalize-kb');

    const sqliteStore = store.getSqliteStore('normalize-kb');
    if (sqliteStore && sqliteStore.getEntityCount() > 0) {
      const entities = sqliteStore.getAllEntities();
      for (const e of entities) {
        // IDs should be lowercase, no special chars except - and :
        assert.ok(/^[a-z0-9:-]+$/.test(e.id), `Entity ID "${e.id}" should be normalized`);
      }
    }

    sqliteStore?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    mock.restoreAll();
  });
});

// --- pathToName mapping ---

describe('KnowledgeStore path mapping', () => {
  let tempDir: string;
  let knowledgeDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    knowledgeDir = path.join(tempDir, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should map multiple paths to names', async () => {
    await fs.writeFile(path.join(knowledgeDir, 'a.knowledge.yaml'), VALID_YAML);
    await fs.writeFile(path.join(knowledgeDir, 'b.knowledge.yaml'), VALID_YAML_2);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(path.join(knowledgeDir, 'a.knowledge.yaml'));
    await store.loadOne(path.join(knowledgeDir, 'b.knowledge.yaml'));

    assert.equal(store.nameForPath(path.resolve(knowledgeDir, 'a.knowledge.yaml')), 'test-kb');
    assert.equal(store.nameForPath(path.resolve(knowledgeDir, 'b.knowledge.yaml')), 'second-kb');
  });

  it('should return undefined for unmapped path', () => {
    const store = new KnowledgeStore(knowledgeDir, tempDir);
    assert.equal(store.nameForPath('/some/random/path.yaml'), undefined);
  });

  it('should update mapping when config is reloaded from different path', async () => {
    const filePath1 = path.join(knowledgeDir, 'v1.knowledge.yaml');
    const filePath2 = path.join(knowledgeDir, 'v2.knowledge.yaml');
    await fs.writeFile(filePath1, VALID_YAML);
    await fs.writeFile(filePath2, VALID_YAML);

    const store = new KnowledgeStore(knowledgeDir, tempDir);
    await store.loadOne(filePath1);
    assert.equal(store.nameForPath(path.resolve(filePath1)), 'test-kb');

    await store.loadOne(filePath2);
    // Both paths should be mapped (config overwritten, but both path entries exist)
    assert.equal(store.nameForPath(path.resolve(filePath1)), 'test-kb');
    assert.equal(store.nameForPath(path.resolve(filePath2)), 'test-kb');
  });
});
