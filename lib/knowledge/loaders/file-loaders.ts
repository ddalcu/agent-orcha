import * as fs from 'fs/promises';
import type { Document } from '../../types/llm-types.ts';

// --- Reusable content parsers (used by both file loaders and WebLoader) ---

function isArrayOfObjects(data: unknown): data is Record<string, unknown>[] {
  return Array.isArray(data)
    && data.length > 0
    && data.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
}

function extractStrings(data: unknown): string[] {
  if (typeof data === 'string') return [data];
  if (Array.isArray(data)) return data.flatMap((item) => extractStrings(item));
  if (typeof data === 'object' && data !== null) {
    return Object.values(data).flatMap((val) => extractStrings(val));
  }
  return [];
}

/**
 * Parses JSON content into documents.
 * - Array of objects: each object becomes a document with "key: value" pairs
 *   and _rawRow metadata (supports graph.directMapping)
 * - Other JSON: recursively extracts all string values
 */
export function parseJsonContent(content: string, source: string): Document[] {
  const data = JSON.parse(content);

  if (isArrayOfObjects(data)) {
    return data.map((row, i) => {
      const pairs = Object.entries(row).map(([k, v]) => `${k}: ${v ?? ''}`);
      const rawRow: Record<string, unknown> = { ...row };
      return {
        pageContent: pairs.join('\n'),
        metadata: { source, row: i, _rawRow: rawRow },
      };
    });
  }

  const texts = extractStrings(data);
  return texts.map((text) => ({
    pageContent: text,
    metadata: { source },
  }));
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

export function parseCsvContent(content: string, source: string): Document[] {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]!);
  const documents: Document[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]!);
    const pairs = headers.map((h, idx) => `${h}: ${values[idx] ?? ''}`);
    const rawRow: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      rawRow[headers[j]!] = values[j] ?? '';
    }
    documents.push({
      pageContent: pairs.join('\n'),
      metadata: { source, row: i, _rawRow: rawRow },
    });
  }

  return documents;
}

// --- File loaders ---

/**
 * Simple text file loader. Reads the entire file as a single document.
 */
export class TextLoader {
  private filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<Document[]> {
    const content = await fs.readFile(this.filePath, 'utf-8');
    return [({ pageContent: content, metadata: { source: this.filePath } })];
  }
}

/**
 * JSON file loader. Extracts string values from JSON into documents.
 * Handles arrays of objects by extracting all string values from each item.
 */
export class JSONLoader {
  private filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<Document[]> {
    const raw = await fs.readFile(this.filePath, 'utf-8');
    return parseJsonContent(raw, this.filePath);
  }
}

/**
 * CSV file loader. Parses CSV and creates one document per row.
 * Each document's content is the row formatted as "column: value" pairs.
 */
export class CSVLoader {
  private filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<Document[]> {
    const content = await fs.readFile(this.filePath, 'utf-8');
    return parseCsvContent(content, this.filePath);
  }
}

/**
 * PDF file loader. Uses pdf-parse for extraction.
 * pdf-parse must be installed separately: npm install pdf-parse
 */
export class PDFLoader {
  private filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<Document[]> {
    let pdfParse: any;
    try {
      // @ts-ignore - pdf-parse is an optional runtime dependency
      pdfParse = (await import('pdf-parse')).default;
    } catch {
      throw new Error(
        'pdf-parse is required for PDF loading. Install it with: npm install pdf-parse'
      );
    }

    const buffer = await fs.readFile(this.filePath);
    const data = await pdfParse(buffer);

    return [({
      pageContent: data.text,
      metadata: {
        source: this.filePath,
        pdf_pages: data.numpages,
        pdf_info: data.info,
      },
    })];
  }
}
