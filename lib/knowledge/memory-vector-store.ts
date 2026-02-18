import { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';

interface MemoryVector {
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  id?: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Lightweight in-memory vector store using cosine similarity.
 * Replaces @langchain/classic MemoryVectorStore to avoid heavy transitive deps.
 */
export class MemoryVectorStore extends VectorStore {
  memoryVectors: MemoryVector[] = [];

  _vectorstoreType(): string {
    return 'memory';
  }

  constructor(embeddings: EmbeddingsInterface) {
    super(embeddings, {});
  }

  async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
    for (let i = 0; i < vectors.length; i++) {
      this.memoryVectors.push({
        content: documents[i]!.pageContent,
        embedding: vectors[i]!,
        metadata: documents[i]!.metadata,
      });
    }
  }

  async addDocuments(documents: Document[]): Promise<void> {
    const texts = documents.map((doc) => doc.pageContent);
    const vectors = await this.embeddings.embedDocuments(texts);
    await this.addVectors(vectors, documents);
  }

  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    _filter?: this['FilterType']
  ): Promise<[Document, number][]> {
    const scored = this.memoryVectors.map((vec) => ({
      score: cosineSimilarity(query, vec.embedding),
      doc: new Document({ pageContent: vec.content, metadata: vec.metadata }),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, k).map(({ doc, score }) => [doc, score]);
  }

  static async fromDocuments(
    docs: Document[],
    embeddings: EmbeddingsInterface
  ): Promise<MemoryVectorStore> {
    const store = new MemoryVectorStore(embeddings);
    await store.addDocuments(docs);
    return store;
  }

  static async fromExistingIndex(
    embeddings: EmbeddingsInterface
  ): Promise<MemoryVectorStore> {
    return new MemoryVectorStore(embeddings);
  }
}
