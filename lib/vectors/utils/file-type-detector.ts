import * as path from 'path';

/**
 * Detect file type from extension
 * Returns the loader type that should be used for this file
 */
export function detectFileType(filename: string): 'pdf' | 'csv' | 'json' | 'text' | 'markdown' {
  const ext = path.extname(filename).toLowerCase();

  switch (ext) {
    case '.pdf':
      return 'pdf';
    case '.csv':
      return 'csv';
    case '.json':
      return 'json';
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.txt':
    case '.text':
    default:
      return 'text';
  }
}

/**
 * Check if a file type is supported
 */
export function isSupportedFileType(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const supportedExtensions = ['.pdf', '.csv', '.json', '.md', '.markdown', '.txt', '.text'];
  return supportedExtensions.includes(ext);
}
