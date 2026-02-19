import type { Document } from './llm-types.ts';

interface SplitterConfig {
  chunkSize: number;
  chunkOverlap: number;
  separator?: string;
}

export class CharacterTextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;
  private separator: string;

  constructor(config: SplitterConfig) {
    this.chunkSize = config.chunkSize;
    this.chunkOverlap = config.chunkOverlap;
    this.separator = config.separator ?? '\n\n';
  }

  async splitDocuments(documents: Document[]): Promise<Document[]> {
    const result: Document[] = [];
    for (const doc of documents) {
      const chunks = this.splitText(doc.pageContent);
      for (const chunk of chunks) {
        result.push({ pageContent: chunk, metadata: { ...doc.metadata } });
      }
    }
    return result;
  }

  private splitText(text: string): string[] {
    const splits = text.split(this.separator);
    return this.mergeSplits(splits, this.separator);
  }

  private mergeSplits(splits: string[], separator: string): string[] {
    const chunks: string[] = [];
    let current = '';

    for (const split of splits) {
      const candidate = current ? `${current}${separator}${split}` : split;

      if (candidate.length > this.chunkSize && current) {
        chunks.push(current);
        // Overlap: keep the tail of current
        const overlapStart = Math.max(0, current.length - this.chunkOverlap);
        current = current.slice(overlapStart) + separator + split;
        if (current.length > this.chunkSize) {
          current = split;
        }
      } else {
        current = candidate;
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }
}

export class RecursiveCharacterTextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;
  private separators: string[];

  constructor(config: SplitterConfig) {
    this.chunkSize = config.chunkSize;
    this.chunkOverlap = config.chunkOverlap;
    this.separators = ['\n\n', '\n', ' ', ''];
  }

  async splitDocuments(documents: Document[]): Promise<Document[]> {
    const result: Document[] = [];
    for (const doc of documents) {
      const chunks = this.splitText(doc.pageContent);
      for (const chunk of chunks) {
        result.push({ pageContent: chunk, metadata: { ...doc.metadata } });
      }
    }
    return result;
  }

  private splitText(text: string): string[] {
    return this.recursiveSplit(text, this.separators);
  }

  private recursiveSplit(text: string, separators: string[]): string[] {
    if (text.length <= this.chunkSize) return [text];
    if (separators.length === 0) return this.forceChunk(text);

    const sep = separators[0]!;
    const remaining = separators.slice(1);
    const splits = sep ? text.split(sep) : [text];

    const chunks: string[] = [];
    let current = '';

    for (const split of splits) {
      const candidate = current ? `${current}${sep}${split}` : split;

      if (candidate.length > this.chunkSize) {
        if (current) {
          chunks.push(current);
        }
        // If single split is still too big, recurse with smaller separators
        if (split.length > this.chunkSize) {
          chunks.push(...this.recursiveSplit(split, remaining));
          current = '';
        } else {
          current = split;
        }
      } else {
        current = candidate;
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  private forceChunk(text: string): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += this.chunkSize - this.chunkOverlap) {
      chunks.push(text.slice(i, i + this.chunkSize));
      if (i + this.chunkSize >= text.length) break;
    }
    return chunks;
  }
}
