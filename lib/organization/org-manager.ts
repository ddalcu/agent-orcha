import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Organization, CreateOrgInput, UpdateOrgInput } from './types.ts';
import { CreateOrgSchema, UpdateOrgSchema } from './types.ts';
import { logger } from '../logger.ts';

export class OrgManager {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): Organization[] {
    const stmt = this.db.prepare('SELECT * FROM organizations ORDER BY name');
    return stmt.all() as Organization[];
  }

  get(id: string): Organization | undefined {
    const stmt = this.db.prepare('SELECT * FROM organizations WHERE id = ?');
    return stmt.get(id) as Organization | undefined;
  }

  getByPrefix(prefix: string): Organization | undefined {
    const stmt = this.db.prepare('SELECT * FROM organizations WHERE issuePrefix = ?');
    return stmt.get(prefix) as Organization | undefined;
  }

  create(data: CreateOrgInput): Organization {
    const parsed = CreateOrgSchema.parse(data);
    const now = new Date().toISOString();
    const id = randomUUID();

    const existing = this.db.prepare('SELECT id FROM organizations WHERE name = ? OR issuePrefix = ?')
      .get(parsed.name, parsed.issuePrefix);
    if (existing) {
      throw new Error(`Organization with name "${parsed.name}" or prefix "${parsed.issuePrefix}" already exists`);
    }

    const stmt = this.db.prepare(`
      INSERT INTO organizations (id, name, description, status, issuePrefix, issueCounter, brandColor, ceoType, ceoConfig, createdAt, updatedAt)
      VALUES (?, ?, ?, 'active', ?, 0, ?, '', '{}', ?, ?)
    `);
    stmt.run(id, parsed.name, parsed.description, parsed.issuePrefix, parsed.brandColor, now, now);

    logger.info(`[OrgManager] Created organization: ${parsed.name} (${parsed.issuePrefix})`);
    return this.get(id)!;
  }

  update(id: string, data: UpdateOrgInput): Organization {
    const parsed = UpdateOrgSchema.parse(data);
    const org = this.get(id);
    if (!org) throw new Error(`Organization not found: ${id}`);

    const fields: string[] = [];
    const values: SQLInputValue[] = [];

    if (parsed.name !== undefined) { fields.push('name = ?'); values.push(parsed.name); }
    if (parsed.description !== undefined) { fields.push('description = ?'); values.push(parsed.description); }
    if (parsed.brandColor !== undefined) { fields.push('brandColor = ?'); values.push(parsed.brandColor); }
    if (parsed.status !== undefined) { fields.push('status = ?'); values.push(parsed.status); }
    if (parsed.ceoType !== undefined) { fields.push('ceoType = ?'); values.push(parsed.ceoType); }
    if (parsed.ceoConfig !== undefined) { fields.push('ceoConfig = ?'); values.push(parsed.ceoConfig); }

    if (fields.length === 0) return org;

    fields.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE organizations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    logger.info(`[OrgManager] Updated organization: ${org.name}`);
    return this.get(id)!;
  }

  archive(id: string): Organization {
    return this.update(id, { status: 'archived' });
  }

  delete(id: string): void {
    const org = this.get(id);
    if (!org) throw new Error(`Organization not found: ${id}`);

    this.db.prepare('DELETE FROM organizations WHERE id = ?').run(id);
    logger.info(`[OrgManager] Deleted organization: ${org.name} (CASCADE)`);
  }

  incrementIssueCounter(id: string): number {
    this.db.prepare('UPDATE organizations SET issueCounter = issueCounter + 1 WHERE id = ?').run(id);
    const row = this.db.prepare('SELECT issueCounter FROM organizations WHERE id = ?').get(id) as { issueCounter: number } | undefined;
    return row?.issueCounter ?? 0;
  }
}
