import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { OrgMember, OrgMemberNode, CreateOrgMemberInput, UpdateOrgMemberInput } from './types.ts';
import { CreateOrgMemberSchema, UpdateOrgMemberSchema } from './types.ts';
import type { OrgManager } from './org-manager.ts';
import { logger } from '../logger.ts';

export class OrgChartManager {
  private db: DatabaseSync;
  private orgManager: OrgManager;
  private agentNameValidator: (name: string) => boolean;

  constructor(db: DatabaseSync, orgManager: OrgManager, agentNameValidator: (name: string) => boolean) {
    this.db = db;
    this.orgManager = orgManager;
    this.agentNameValidator = agentNameValidator;
  }

  list(orgId: string): OrgMember[] {
    return this.db.prepare('SELECT * FROM org_members WHERE orgId = ? ORDER BY position, createdAt')
      .all(orgId) as OrgMember[];
  }

  get(id: string): OrgMember | undefined {
    return this.db.prepare('SELECT * FROM org_members WHERE id = ?').get(id) as OrgMember | undefined;
  }

  getCEO(orgId: string): OrgMember | undefined {
    return this.db.prepare("SELECT * FROM org_members WHERE orgId = ? AND role = 'ceo'")
      .get(orgId) as OrgMember | undefined;
  }

  getDirectReports(memberId: string): OrgMember[] {
    return this.db.prepare('SELECT * FROM org_members WHERE reportsTo = ? ORDER BY position, createdAt')
      .all(memberId) as OrgMember[];
  }

  getTree(orgId: string): OrgMemberNode[] {
    const all = this.list(orgId);
    const byId = new Map(all.map(m => [m.id, { ...m, children: [] as OrgMemberNode[] }]));

    const roots: OrgMemberNode[] = [];
    for (const node of byId.values()) {
      if (node.reportsTo && byId.has(node.reportsTo)) {
        byId.get(node.reportsTo)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  create(orgId: string, data: CreateOrgMemberInput): OrgMember {
    const parsed = CreateOrgMemberSchema.parse(data);
    const org = this.orgManager.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);

    if (!this.agentNameValidator(parsed.agentName)) {
      throw new Error(`Agent not found: ${parsed.agentName}`);
    }

    // Enforce max 1 CEO per org
    if (parsed.role === 'ceo') {
      const existingCEO = this.getCEO(orgId);
      if (existingCEO) {
        throw new Error(`Organization already has a CEO: ${existingCEO.agentName}`);
      }
    }

    // Validate reportsTo exists in the same org
    if (parsed.reportsTo) {
      const parent = this.get(parsed.reportsTo);
      if (!parent || parent.orgId !== orgId) {
        throw new Error(`Invalid reportsTo: member not found in this organization`);
      }
    }

    const now = new Date().toISOString();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO org_members (id, orgId, agentName, title, role, reportsTo, position, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, parsed.agentName, parsed.title, parsed.role, parsed.reportsTo, parsed.position, now, now);

    logger.info(`[OrgChartManager] Added member: ${parsed.agentName} (${parsed.role}) to org ${org.name}`);
    return this.get(id)!;
  }

  update(id: string, data: UpdateOrgMemberInput): OrgMember {
    const parsed = UpdateOrgMemberSchema.parse(data);
    const member = this.get(id);
    if (!member) throw new Error(`Org member not found: ${id}`);

    // Enforce max 1 CEO per org
    if (parsed.role === 'ceo' && member.role !== 'ceo') {
      const existingCEO = this.getCEO(member.orgId);
      if (existingCEO) {
        throw new Error(`Organization already has a CEO: ${existingCEO.agentName}`);
      }
    }

    // Validate reportsTo if changing
    if (parsed.reportsTo !== undefined && parsed.reportsTo !== null) {
      if (parsed.reportsTo === id) {
        throw new Error('A member cannot report to themselves');
      }
      const parent = this.get(parsed.reportsTo);
      if (!parent || parent.orgId !== member.orgId) {
        throw new Error('Invalid reportsTo: member not found in this organization');
      }
    }

    const fields: string[] = [];
    const values: SQLInputValue[] = [];

    if (parsed.title !== undefined) { fields.push('title = ?'); values.push(parsed.title); }
    if (parsed.role !== undefined) { fields.push('role = ?'); values.push(parsed.role); }
    if (parsed.reportsTo !== undefined) { fields.push('reportsTo = ?'); values.push(parsed.reportsTo); }
    if (parsed.position !== undefined) { fields.push('position = ?'); values.push(parsed.position); }

    if (fields.length === 0) return member;

    fields.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE org_members SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    logger.info(`[OrgChartManager] Updated member: ${member.agentName}`);
    return this.get(id)!;
  }

  delete(id: string): void {
    const member = this.get(id);
    if (!member) throw new Error(`Org member not found: ${id}`);

    this.db.prepare('DELETE FROM org_members WHERE id = ?').run(id);
    logger.info(`[OrgChartManager] Removed member: ${member.agentName}`);
  }
}
