import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as sqliteVec from 'sqlite-vec';
// SqliteStore — thin wrapper around node:sqlite + sqlite-vec

export interface ChunkRow {
  id: number;
  content: string;
  metadata: string;
  source: string;
}

export interface EntityRow {
  id: string;
  type: string;
  name: string;
  description: string;
  properties: string; // JSON
  source_chunk_ids: string; // JSON array
}

export interface RelationshipRow {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  description: string;
  weight: number;
  properties: string; // JSON
}

export interface ScoredChunk {
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  source: string;
}

export interface ScoredEntity {
  id: string;
  type: string;
  name: string;
  description: string;
  properties: Record<string, unknown>;
  sourceChunkIds: string[];
  score: number;
}

/**
 * Unified SQLite-backed store for chunks, entities, relationships, and their vectors.
 * Uses sqlite-vec for KNN search. SQLite IS the persistence — no caching layers.
 */
export class SqliteStore {
  private db: DatabaseSync;
  private dimensions: number;
  private dbPath: string;

  constructor(dbPath: string, dimensions: number) {
    this.dbPath = dbPath;
    this.dimensions = dimensions;

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(this.db);

    // Enable WAL mode for better concurrent read performance
    this.db.exec('PRAGMA journal_mode=WAL');

    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        properties TEXT NOT NULL DEFAULT '{}',
        source_chunk_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        weight REAL NOT NULL DEFAULT 1.0,
        properties TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Create vec0 tables only if they don't exist
    // vec0 virtual tables don't support IF NOT EXISTS, so check first
    const hasChunkVecs = this.tableExists('chunk_vectors');
    if (!hasChunkVecs) {
      this.db.exec(`
        CREATE VIRTUAL TABLE chunk_vectors USING vec0 (
          embedding float[${this.dimensions}] distance_metric=cosine
        );
      `);
    }

    const hasEntityVecs = this.tableExists('entity_vectors');
    if (!hasEntityVecs) {
      this.db.exec(`
        CREATE VIRTUAL TABLE entity_vectors USING vec0 (
          embedding float[${this.dimensions}] distance_metric=cosine
        );
      `);
    }

    // Store dimensions in metadata for validation on reopen
    this.setMeta('dimensions', String(this.dimensions));
  }

  private tableExists(name: string): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name) as { cnt: number };
    return row.cnt > 0;
  }

  // --- Chunk Operations ---

  insertChunks(chunks: Array<{ content: string; metadata: Record<string, unknown>; source: string; embedding: number[] }>): void {
    const insertChunk = this.db.prepare(
      'INSERT INTO chunks (content, metadata, source) VALUES (?, ?, ?)'
    );
    const insertVec = this.db.prepare(
      'INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)'
    );

    const txn = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');

    txn.run();
    try {
      for (const chunk of chunks) {
        const result = insertChunk.run(
          chunk.content,
          JSON.stringify(chunk.metadata),
          chunk.source
        );
        const rowid = BigInt(result.lastInsertRowid); // vec0 requires BigInt rowids
        insertVec.run(rowid, this.toVecBytes(chunk.embedding));
      }
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }
  }

  searchChunks(queryEmbedding: number[], k: number): ScoredChunk[] {
    const results = this.db.prepare(`
      SELECT c.content, c.metadata, c.source, cv.distance
      FROM chunk_vectors cv
      JOIN chunks c ON c.id = cv.rowid
      WHERE cv.embedding MATCH ? AND k = ?
      ORDER BY cv.distance
    `).all(this.toVecBytes(queryEmbedding), k) as Array<{
      content: string;
      metadata: string;
      source: string;
      distance: number;
    }>;

    return results.map(r => ({
      content: r.content,
      metadata: JSON.parse(r.metadata),
      score: 1.0 - r.distance,
      source: r.source,
    }));
  }

  getChunkCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM chunks').get() as { cnt: number };
    return row.cnt;
  }

  // --- Entity Operations ---

  insertEntities(entities: Array<{
    id: string;
    type: string;
    name: string;
    description: string;
    properties: Record<string, unknown>;
    sourceChunkIds: string[];
    embedding: number[];
  }>): void {
    const insertEntity = this.db.prepare(`
      INSERT OR REPLACE INTO entities (id, type, name, description, properties, source_chunk_ids)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertVec = this.db.prepare(
      'INSERT INTO entity_vectors (rowid, embedding) VALUES (?, ?)'
    );

    // We use the entity's position in a sequence as its rowid for the vec0 table.
    // Store the mapping in a separate lookup.
    // Actually, vec0 rowid must be integer. We need a mapping from entity text id → integer rowid.
    // Let's use an auto-incrementing approach with a mapping table.

    const txn = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');

    // Ensure entity_rowid_map exists for text-id to integer-rowid mapping
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_rowid_map (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL UNIQUE
      );
    `);

    const insertMapping = this.db.prepare(
      'INSERT OR IGNORE INTO entity_rowid_map (entity_id) VALUES (?)'
    );
    const getRowid = this.db.prepare(
      'SELECT rowid FROM entity_rowid_map WHERE entity_id = ?'
    );
    const deleteVec = this.db.prepare(
      'DELETE FROM entity_vectors WHERE rowid = ?'
    );

    txn.run();
    try {
      for (const entity of entities) {
        insertEntity.run(
          entity.id,
          entity.type,
          entity.name,
          entity.description,
          JSON.stringify(entity.properties),
          JSON.stringify(entity.sourceChunkIds)
        );

        // Map text ID to integer rowid for vec0
        insertMapping.run(entity.id);
        const row = getRowid.get(entity.id) as { rowid: number | bigint };
        const rowid = BigInt(row.rowid);
        // Delete existing vec0 row if re-indexing (vec0 doesn't support OR REPLACE)
        deleteVec.run(rowid);
        insertVec.run(rowid, this.toVecBytes(entity.embedding));
      }
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }
  }

  searchEntities(queryEmbedding: number[], k: number): ScoredEntity[] {
    const results = this.db.prepare(`
      SELECT e.id, e.type, e.name, e.description, e.properties, e.source_chunk_ids, ev.distance
      FROM entity_vectors ev
      JOIN entity_rowid_map m ON m.rowid = ev.rowid
      JOIN entities e ON e.id = m.entity_id
      WHERE ev.embedding MATCH ? AND k = ?
      ORDER BY ev.distance
    `).all(this.toVecBytes(queryEmbedding), k) as Array<{
      id: string;
      type: string;
      name: string;
      description: string;
      properties: string;
      source_chunk_ids: string;
      distance: number;
    }>;

    return results.map(r => ({
      id: r.id,
      type: r.type,
      name: r.name,
      description: r.description,
      properties: JSON.parse(r.properties),
      sourceChunkIds: JSON.parse(r.source_chunk_ids),
      score: 1.0 - r.distance,
    }));
  }

  getEntity(id: string): EntityRow | undefined {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
    return row;
  }

  getAllEntities(): EntityRow[] {
    return this.db.prepare('SELECT * FROM entities').all() as unknown as EntityRow[];
  }

  getEntityCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number };
    return row.cnt;
  }

  // --- Relationship Operations ---

  insertRelationships(relationships: Array<{
    id: string;
    type: string;
    sourceId: string;
    targetId: string;
    description: string;
    weight: number;
    properties: Record<string, unknown>;
  }>): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO relationships (id, type, source_id, target_id, description, weight, properties)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');

    txn.run();
    for (const rel of relationships) {
      insert.run(
        rel.id,
        rel.type,
        rel.sourceId,
        rel.targetId,
        rel.description,
        rel.weight,
        JSON.stringify(rel.properties)
      );
    }
    commit.run();
  }

  getAllRelationships(): RelationshipRow[] {
    return this.db.prepare('SELECT * FROM relationships').all() as unknown as RelationshipRow[];
  }

  getRelationshipCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM relationships').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Get the neighborhood around an entity via iterative SQL JOINs.
   * Replaces graphology BFS traversal.
   */
  getNeighborhood(entityId: string, depth: number): { entities: EntityRow[]; relationships: RelationshipRow[] } {
    const visitedEntities = new Set<string>([entityId]);
    const collectedRelationships: RelationshipRow[] = [];
    let frontier = [entityId];

    const getEdges = this.db.prepare(`
      SELECT * FROM relationships
      WHERE source_id = ? OR target_id = ?
    `);

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const edges = getEdges.all(nodeId, nodeId) as unknown as RelationshipRow[];
        for (const edge of edges) {
          // Avoid duplicate edges
          if (collectedRelationships.some(r => r.id === edge.id)) continue;
          collectedRelationships.push(edge);

          const neighborId = edge.source_id === nodeId ? edge.target_id : edge.source_id;
          if (!visitedEntities.has(neighborId)) {
            visitedEntities.add(neighborId);
            nextFrontier.push(neighborId);
          }
        }
      }
      frontier = nextFrontier;
    }

    // Fetch all visited entities
    const entities: EntityRow[] = [];
    const getEntityStmt = this.db.prepare('SELECT * FROM entities WHERE id = ?');
    for (const id of visitedEntities) {
      const entity = getEntityStmt.get(id) as EntityRow | undefined;
      if (entity) entities.push(entity);
    }

    return { entities, relationships: collectedRelationships };
  }

  // --- Metadata Operations ---

  setMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
    ).run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  // --- Lifecycle ---

  /**
   * Clear all data (for re-indexing).
   */
  clear(): void {
    this.db.exec('DELETE FROM chunks');
    this.db.exec('DELETE FROM entities');
    this.db.exec('DELETE FROM relationships');
    this.db.exec('DELETE FROM metadata');

    // Drop and recreate vec0 tables (can't DELETE from virtual tables)
    this.db.exec('DROP TABLE IF EXISTS chunk_vectors');
    this.db.exec('DROP TABLE IF EXISTS entity_vectors');
    this.db.exec('DROP TABLE IF EXISTS entity_rowid_map');

    this.db.exec(`
      CREATE VIRTUAL TABLE chunk_vectors USING vec0 (
        embedding float[${this.dimensions}] distance_metric=cosine
      );
      CREATE VIRTUAL TABLE entity_vectors USING vec0 (
        embedding float[${this.dimensions}] distance_metric=cosine
      );
    `);

    this.setMeta('dimensions', String(this.dimensions));
  }

  hasData(): boolean {
    return this.getChunkCount() > 0;
  }

  close(): void {
    this.db.close();
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  // --- Internal ---

  private toVecBytes(vec: number[]): Uint8Array {
    return new Uint8Array(new Float32Array(vec).buffer);
  }

  /**
   * Validate stored dimensions match expected dimensions.
   * Returns true if dimensions match or no data exists.
   */
  static validateDimensions(dbPath: string, expectedDimensions: number): boolean {
    if (!fs.existsSync(dbPath)) return true;

    try {
      const db = new DatabaseSync(dbPath, { allowExtension: true });
      sqliteVec.load(db);
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('dimensions') as { value: string } | undefined;
      db.close();

      if (!row) return true;
      return parseInt(row.value, 10) === expectedDimensions;
    } catch {
      return true; // If we can't read, let it proceed and handle errors during creation
    }
  }
}
