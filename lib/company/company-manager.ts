import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Company, CreateCompanyInput, UpdateCompanyInput } from './types.ts';
import { CreateCompanySchema, UpdateCompanySchema } from './types.ts';
import { logger } from '../logger.ts';

export class CompanyManager {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): Company[] {
    const stmt = this.db.prepare('SELECT * FROM companies ORDER BY name');
    return stmt.all() as Company[];
  }

  get(id: string): Company | undefined {
    const stmt = this.db.prepare('SELECT * FROM companies WHERE id = ?');
    return stmt.get(id) as Company | undefined;
  }

  getByPrefix(prefix: string): Company | undefined {
    const stmt = this.db.prepare('SELECT * FROM companies WHERE issuePrefix = ?');
    return stmt.get(prefix) as Company | undefined;
  }

  create(data: CreateCompanyInput): Company {
    const parsed = CreateCompanySchema.parse(data);
    const now = new Date().toISOString();
    const id = randomUUID();

    // Check uniqueness
    const existing = this.db.prepare('SELECT id FROM companies WHERE name = ? OR issuePrefix = ?')
      .get(parsed.name, parsed.issuePrefix);
    if (existing) {
      throw new Error(`Company with name "${parsed.name}" or prefix "${parsed.issuePrefix}" already exists`);
    }

    const stmt = this.db.prepare(`
      INSERT INTO companies (id, name, description, status, issuePrefix, issueCounter, brandColor, createdAt, updatedAt)
      VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?)
    `);
    stmt.run(id, parsed.name, parsed.description, parsed.issuePrefix, parsed.brandColor, now, now);

    logger.info(`[CompanyManager] Created company: ${parsed.name} (${parsed.issuePrefix})`);
    return this.get(id)!;
  }

  update(id: string, data: UpdateCompanyInput): Company {
    const parsed = UpdateCompanySchema.parse(data);
    const company = this.get(id);
    if (!company) throw new Error(`Company not found: ${id}`);

    const fields: string[] = [];
    const values: SQLInputValue[] = [];

    if (parsed.name !== undefined) { fields.push('name = ?'); values.push(parsed.name); }
    if (parsed.description !== undefined) { fields.push('description = ?'); values.push(parsed.description); }
    if (parsed.brandColor !== undefined) { fields.push('brandColor = ?'); values.push(parsed.brandColor); }
    if (parsed.status !== undefined) { fields.push('status = ?'); values.push(parsed.status); }

    if (fields.length === 0) return company;

    fields.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE companies SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    logger.info(`[CompanyManager] Updated company: ${company.name}`);
    return this.get(id)!;
  }

  archive(id: string): Company {
    return this.update(id, { status: 'archived' });
  }

  delete(id: string): void {
    const company = this.get(id);
    if (!company) throw new Error(`Company not found: ${id}`);

    this.db.prepare('DELETE FROM companies WHERE id = ?').run(id);
    logger.info(`[CompanyManager] Deleted company: ${company.name} (CASCADE)`);
  }

  incrementIssueCounter(id: string): number {
    this.db.prepare('UPDATE companies SET issueCounter = issueCounter + 1 WHERE id = ?').run(id);
    const row = this.db.prepare('SELECT issueCounter FROM companies WHERE id = ?').get(id) as { issueCounter: number } | undefined;
    return row?.issueCounter ?? 0;
  }
}
