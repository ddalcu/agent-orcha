import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TextLoader, JSONLoader, CSVLoader, PDFLoader } from '../../lib/knowledge/loaders/file-loaders.ts';

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orcha-loader-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('TextLoader', () => {
  it('should load a text file as a single document', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'Hello World\nLine two');
    const loader = new TextLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, 'Hello World\nLine two');
    assert.equal(docs[0]!.metadata.source, filePath);
  });

  it('should handle empty files', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    await fs.writeFile(filePath, '');
    const loader = new TextLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, '');
  });
});

describe('JSONLoader', () => {
  it('should load a simple string value', async () => {
    const filePath = path.join(tmpDir, 'string.json');
    await fs.writeFile(filePath, JSON.stringify('hello'));
    const loader = new JSONLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, 'hello');
  });

  it('should extract strings from an object', async () => {
    const filePath = path.join(tmpDir, 'obj.json');
    await fs.writeFile(filePath, JSON.stringify({ name: 'Alice', age: 30, city: 'NY' }));
    const loader = new JSONLoader(filePath);
    const docs = await loader.load();
    // Should extract "Alice" and "NY" (strings only, not numbers)
    assert.equal(docs.length, 2);
    assert.equal(docs[0]!.pageContent, 'Alice');
    assert.equal(docs[1]!.pageContent, 'NY');
  });

  it('should extract strings from an array of objects', async () => {
    const filePath = path.join(tmpDir, 'array.json');
    await fs.writeFile(filePath, JSON.stringify([
      { title: 'Post 1', views: 100 },
      { title: 'Post 2', views: 200 },
    ]));
    const loader = new JSONLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 2);
    assert.equal(docs[0]!.pageContent, 'title: Post 1\nviews: 100');
    assert.equal(docs[1]!.pageContent, 'title: Post 2\nviews: 200');
  });

  it('should handle nested objects', async () => {
    const filePath = path.join(tmpDir, 'nested.json');
    await fs.writeFile(filePath, JSON.stringify({ a: { b: 'deep' } }));
    const loader = new JSONLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, 'deep');
  });

  it('should skip non-string values', async () => {
    const filePath = path.join(tmpDir, 'mixed.json');
    await fs.writeFile(filePath, JSON.stringify({ a: 1, b: true, c: null, d: 'text' }));
    const loader = new JSONLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, 'text');
  });
});

describe('CSVLoader', () => {
  it('should load CSV with headers', async () => {
    const filePath = path.join(tmpDir, 'data.csv');
    await fs.writeFile(filePath, 'name,age,city\nAlice,30,NY\nBob,25,LA');
    const loader = new CSVLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 2);
    assert.ok(docs[0]!.pageContent.includes('name: Alice'));
    assert.ok(docs[0]!.pageContent.includes('age: 30'));
    assert.ok(docs[0]!.pageContent.includes('city: NY'));
    assert.equal(docs[0]!.metadata.row, 1);
    assert.equal(docs[1]!.metadata.row, 2);
  });

  it('should return empty for header-only CSV', async () => {
    const filePath = path.join(tmpDir, 'header-only.csv');
    await fs.writeFile(filePath, 'name,age');
    const loader = new CSVLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 0);
  });

  it('should handle quoted fields with commas', async () => {
    const filePath = path.join(tmpDir, 'quoted.csv');
    await fs.writeFile(filePath, 'name,address\nAlice,"123 Main St, Apt 4"');
    const loader = new CSVLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 1);
    assert.ok(docs[0]!.pageContent.includes('address: 123 Main St, Apt 4'));
  });

  it('should handle escaped quotes in CSV', async () => {
    const filePath = path.join(tmpDir, 'escaped.csv');
    await fs.writeFile(filePath, 'name,quote\nAlice,"She said ""hello"""');
    const loader = new CSVLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 1);
    assert.ok(docs[0]!.pageContent.includes('She said "hello"'));
  });

  it('should skip empty lines', async () => {
    const filePath = path.join(tmpDir, 'blanks.csv');
    await fs.writeFile(filePath, 'name\n\nAlice\n\nBob\n');
    const loader = new CSVLoader(filePath);
    const docs = await loader.load();
    assert.equal(docs.length, 2);
  });

  it('should include _rawRow in metadata', async () => {
    const filePath = path.join(tmpDir, 'rawrow.csv');
    await fs.writeFile(filePath, 'a,b\n1,2');
    const loader = new CSVLoader(filePath);
    const docs = await loader.load();
    assert.deepEqual(docs[0]!.metadata._rawRow, { a: '1', b: '2' });
  });
});

describe('PDFLoader', () => {
  it('should throw when pdf-parse is not available', async () => {
    const filePath = path.join(tmpDir, 'test.pdf');
    await fs.writeFile(filePath, 'not a real pdf');
    const loader = new PDFLoader(filePath);
    await assert.rejects(loader.load(), (err: Error) => {
      // It will either fail with "pdf-parse is required" or with a pdf parsing error
      return err instanceof Error;
    });
  });
});
