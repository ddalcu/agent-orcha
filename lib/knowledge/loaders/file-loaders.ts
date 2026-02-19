import * as fs from 'fs/promises';
import type { Document } from '../../types/llm-types.ts';

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
    const data = JSON.parse(raw);
    const texts = this.extractStrings(data);

    return texts.map((text) => ({
      pageContent: text,
      metadata: { source: this.filePath },
    }));
  }

  private extractStrings(data: unknown): string[] {
    if (typeof data === 'string') return [data];
    if (Array.isArray(data)) return data.flatMap((item) => this.extractStrings(item));
    if (typeof data === 'object' && data !== null) {
      return Object.values(data).flatMap((val) => this.extractStrings(val));
    }
    return [];
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
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    if (lines.length < 2) return [];

    const headers = this.parseCsvLine(lines[0]!);
    const documents: Document[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCsvLine(lines[i]!);
      const pairs = headers.map((h, idx) => `${h}: ${values[idx] ?? ''}`);
      documents.push(({
        pageContent: pairs.join('\n'),
        metadata: { source: this.filePath, row: i },
      }));
    }

    return documents;
  }

  private parseCsvLine(line: string): string[] {
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
