import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { CharacterTextSplitter, RecursiveCharacterTextSplitter } from '../../lib/types/text-splitters.ts';

describe('CharacterTextSplitter', () => {
  it('should return single chunk when text fits within chunkSize', async () => {
    const splitter = new CharacterTextSplitter({ chunkSize: 100, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'Short text', metadata: { id: 1 } },
    ]);
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, 'Short text');
    assert.deepEqual(docs[0]!.metadata, { id: 1 });
  });

  it('should split text into multiple chunks on separator', async () => {
    const splitter = new CharacterTextSplitter({ chunkSize: 20, chunkOverlap: 0, separator: '\n\n' });
    const docs = await splitter.splitDocuments([
      { pageContent: 'First paragraph\n\nSecond paragraph\n\nThird paragraph', metadata: {} },
    ]);
    assert.ok(docs.length > 1);
    // Each chunk should be within size or a single split that exceeds
    for (const doc of docs) {
      assert.ok(doc.pageContent.length > 0);
    }
  });

  it('should preserve metadata for each chunk', async () => {
    const splitter = new CharacterTextSplitter({ chunkSize: 10, chunkOverlap: 0, separator: '|' });
    const docs = await splitter.splitDocuments([
      { pageContent: 'aaa|bbb|ccc', metadata: { source: 'test' } },
    ]);
    for (const doc of docs) {
      assert.deepEqual(doc.metadata, { source: 'test' });
    }
  });

  it('should handle multiple documents', async () => {
    const splitter = new CharacterTextSplitter({ chunkSize: 100, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'Doc one', metadata: { id: 1 } },
      { pageContent: 'Doc two', metadata: { id: 2 } },
    ]);
    assert.equal(docs.length, 2);
    assert.equal(docs[0]!.metadata.id, 1);
    assert.equal(docs[1]!.metadata.id, 2);
  });

  it('should handle overlap between chunks', async () => {
    // 3 splits of "aaaa", "bbbb", "cccc" with separator "|"
    // chunkSize=6 means "aaaa|bbbb" (9) is too big, so "aaaa" is pushed
    // overlap=3 means we keep tail of "aaaa" = "aaa" then add "|bbbb"
    const splitter = new CharacterTextSplitter({ chunkSize: 6, chunkOverlap: 3, separator: '|' });
    const docs = await splitter.splitDocuments([
      { pageContent: 'aaaa|bbbb|cccc', metadata: {} },
    ]);
    assert.ok(docs.length >= 2);
  });

  it('should use default separator (double newline)', async () => {
    const splitter = new CharacterTextSplitter({ chunkSize: 20, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'Hello world\n\nGoodbye world', metadata: {} },
    ]);
    assert.equal(docs.length, 2);
    assert.equal(docs[0]!.pageContent, 'Hello world');
  });

  it('should handle empty text', async () => {
    const splitter = new CharacterTextSplitter({ chunkSize: 100, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: '', metadata: {} },
    ]);
    // Empty string split by separator gives [''], mergeSplits skips empty current
    assert.equal(docs.length, 0);
  });

  it('should reset current to split when overlap+split exceeds chunkSize', async () => {
    // Force the branch: candidate too big, push current, then overlap+split > chunkSize → current = split
    const splitter = new CharacterTextSplitter({ chunkSize: 5, chunkOverlap: 2, separator: '|' });
    const docs = await splitter.splitDocuments([
      { pageContent: 'abcde|fghij|klmno', metadata: {} },
    ]);
    // Each split is exactly 5 chars = chunkSize, so merging any two exceeds chunkSize
    assert.ok(docs.length === 3);
    assert.equal(docs[0]!.pageContent, 'abcde');
    assert.equal(docs[1]!.pageContent, 'fghij');
    assert.equal(docs[2]!.pageContent, 'klmno');
  });
});

describe('RecursiveCharacterTextSplitter', () => {
  it('should return single chunk when text fits within chunkSize', async () => {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'Short text', metadata: { id: 1 } },
    ]);
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, 'Short text');
  });

  it('should split on double newline first', async () => {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 20, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'Paragraph one\n\nParagraph two', metadata: {} },
    ]);
    assert.equal(docs.length, 2);
    assert.equal(docs[0]!.pageContent, 'Paragraph one');
    assert.equal(docs[1]!.pageContent, 'Paragraph two');
  });

  it('should fall through to single newline separator', async () => {
    // No double newlines, but has single newlines
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 15, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'Line one here\nLine two here', metadata: {} },
    ]);
    assert.ok(docs.length >= 2);
  });

  it('should fall through to space separator', async () => {
    // No newlines, only spaces, each word group should fit
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 10, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'aaa bbb ccc ddd eee', metadata: {} },
    ]);
    assert.ok(docs.length >= 2);
  });

  it('should force chunk when no separator works', async () => {
    // Single long word with no separators
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 5, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'abcdefghijklmno', metadata: {} },
    ]);
    assert.ok(docs.length >= 3);
    assert.equal(docs[0]!.pageContent, 'abcde');
    assert.equal(docs[1]!.pageContent, 'fghij');
    assert.equal(docs[2]!.pageContent, 'klmno');
  });

  it('should handle force chunk with overlap', async () => {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 6, chunkOverlap: 2 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'abcdefghijkl', metadata: {} },
    ]);
    // chunkSize=6, step=4 (6-2): [0-6], [4-10], [8-12]
    assert.ok(docs.length >= 2);
    assert.equal(docs[0]!.pageContent, 'abcdef');
  });

  it('should preserve metadata across chunks', async () => {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 10, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'aaaa bbbbb ccccc', metadata: { file: 'x.txt' } },
    ]);
    for (const doc of docs) {
      assert.deepEqual(doc.metadata, { file: 'x.txt' });
    }
  });

  it('should handle multiple documents', async () => {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 0 });
    const docs = await splitter.splitDocuments([
      { pageContent: 'Doc A', metadata: { id: 'a' } },
      { pageContent: 'Doc B', metadata: { id: 'b' } },
    ]);
    assert.equal(docs.length, 2);
  });

  it('should recurse into smaller separators when a single split is too big', async () => {
    // Two paragraphs separated by \n\n, but first paragraph has lines > chunkSize
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 15, chunkOverlap: 0 });
    const text = 'This is a very long first paragraph line\n\nShort second';
    const docs = await splitter.splitDocuments([{ pageContent: text, metadata: {} }]);
    // The first paragraph is 40 chars, should be recursively split
    assert.ok(docs.length >= 3);
  });
});
