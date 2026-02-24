import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectFileType, isSupportedFileType } from '../../../lib/knowledge/utils/file-type-detector.ts';

describe('detectFileType', () => {
  it('should detect PDF files', () => {
    assert.equal(detectFileType('document.pdf'), 'pdf');
    assert.equal(detectFileType('path/to/file.PDF'), 'pdf');
  });

  it('should detect CSV files', () => {
    assert.equal(detectFileType('data.csv'), 'csv');
  });

  it('should detect JSON files', () => {
    assert.equal(detectFileType('config.json'), 'json');
  });

  it('should detect markdown files', () => {
    assert.equal(detectFileType('readme.md'), 'markdown');
    assert.equal(detectFileType('docs.markdown'), 'markdown');
  });

  it('should detect text files', () => {
    assert.equal(detectFileType('notes.txt'), 'text');
    assert.equal(detectFileType('notes.text'), 'text');
  });

  it('should default to text for unknown extensions', () => {
    assert.equal(detectFileType('file.xyz'), 'text');
    assert.equal(detectFileType('file.html'), 'text');
    assert.equal(detectFileType('file'), 'text');
  });
});

describe('isSupportedFileType', () => {
  it('should return true for supported extensions', () => {
    assert.ok(isSupportedFileType('file.pdf'));
    assert.ok(isSupportedFileType('file.csv'));
    assert.ok(isSupportedFileType('file.json'));
    assert.ok(isSupportedFileType('file.md'));
    assert.ok(isSupportedFileType('file.markdown'));
    assert.ok(isSupportedFileType('file.txt'));
    assert.ok(isSupportedFileType('file.text'));
  });

  it('should return false for unsupported extensions', () => {
    assert.equal(isSupportedFileType('file.html'), false);
    assert.equal(isSupportedFileType('file.docx'), false);
    assert.equal(isSupportedFileType('file.xyz'), false);
  });
});
