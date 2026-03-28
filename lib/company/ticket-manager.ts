import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Ticket, CreateTicketInput, UpdateTicketInput, TicketActivity, TicketFilters } from './types.ts';
import { CreateTicketSchema, UpdateTicketSchema } from './types.ts';
import type { CompanyManager } from './company-manager.ts';
import { logger } from '../logger.ts';

export class TicketManager {
  private db: DatabaseSync;
  private companyManager: CompanyManager;

  constructor(db: DatabaseSync, companyManager: CompanyManager) {
    this.db = db;
    this.companyManager = companyManager;
  }

  list(companyId: string, filters?: TicketFilters): Ticket[] {
    let sql = 'SELECT * FROM tickets WHERE companyId = ?';
    const params: SQLInputValue[] = [companyId];

    if (filters?.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.priority) {
      sql += ' AND priority = ?';
      params.push(filters.priority);
    }
    if (filters?.assigneeAgent) {
      sql += ' AND assigneeAgent = ?';
      params.push(filters.assigneeAgent);
    }

    sql += ' ORDER BY createdAt DESC';
    return this.db.prepare(sql).all(...params) as Ticket[];
  }

  get(id: string): Ticket | undefined {
    return this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Ticket | undefined;
  }

  getByIdentifier(identifier: string): Ticket | undefined {
    return this.db.prepare('SELECT * FROM tickets WHERE identifier = ?').get(identifier) as Ticket | undefined;
  }

  create(companyId: string, data: CreateTicketInput): Ticket {
    const parsed = CreateTicketSchema.parse(data);
    const company = this.companyManager.get(companyId);
    if (!company) throw new Error(`Company not found: ${companyId}`);

    const issueNumber = this.companyManager.incrementIssueCounter(companyId);
    const identifier = `${company.issuePrefix}-${issueNumber}`;
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO tickets (id, companyId, title, description, status, priority, assigneeAgent, issueNumber, identifier, taskId, createdAt, updatedAt, completedAt)
      VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?, ?, '', ?, ?, '')
    `).run(id, companyId, parsed.title, parsed.description, parsed.priority, parsed.assigneeAgent, issueNumber, identifier, now, now);

    // Log creation activity
    this.addActivity(id, 'status_change', `Ticket created`, 'system', 'System', '', 'backlog');

    logger.info(`[TicketManager] Created ticket: ${identifier} — ${parsed.title}`);
    return this.get(id)!;
  }

  update(id: string, data: UpdateTicketInput): Ticket {
    const parsed = UpdateTicketSchema.parse(data);
    const ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket not found: ${id}`);

    const fields: string[] = [];
    const values: SQLInputValue[] = [];

    if (parsed.title !== undefined) { fields.push('title = ?'); values.push(parsed.title); }
    if (parsed.description !== undefined) { fields.push('description = ?'); values.push(parsed.description); }
    if (parsed.priority !== undefined) {
      fields.push('priority = ?');
      values.push(parsed.priority);
    }
    if (parsed.assigneeAgent !== undefined && parsed.assigneeAgent !== ticket.assigneeAgent) {
      fields.push('assigneeAgent = ?');
      values.push(parsed.assigneeAgent);
      this.addActivity(id, 'assignment_change', `Assignee changed`, 'system', 'System', ticket.assigneeAgent, parsed.assigneeAgent);
    }

    if (fields.length === 0) return ticket;

    fields.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.get(id)!;
  }

  transition(id: string, newStatus: string): Ticket {
    const ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket not found: ${id}`);
    if (ticket.status === newStatus) return ticket;

    const now = new Date().toISOString();
    const fields: string[] = ['status = ?', 'updatedAt = ?'];
    const values: SQLInputValue[] = [newStatus, now];

    if (newStatus === 'done' || newStatus === 'cancelled') {
      fields.push('completedAt = ?');
      values.push(now);
    }

    values.push(id);
    this.db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    this.addActivity(id, 'status_change', `Status changed from ${ticket.status} to ${newStatus}`, 'system', 'System', ticket.status, newStatus);

    logger.info(`[TicketManager] Ticket ${ticket.identifier}: ${ticket.status} → ${newStatus}`);
    return this.get(id)!;
  }

  linkTask(id: string, taskId: string): void {
    this.db.prepare('UPDATE tickets SET taskId = ?, updatedAt = ? WHERE id = ?')
      .run(taskId, new Date().toISOString(), id);
  }

  addComment(ticketId: string, content: string, authorType: string, authorName: string, metadata?: Record<string, unknown>): TicketActivity {
    return this.addActivity(ticketId, 'comment', content, authorType, authorName, '', '', metadata);
  }

  addTaskEvent(ticketId: string, eventDescription: string, metadata?: Record<string, unknown>): TicketActivity {
    return this.addActivity(ticketId, 'task_event', eventDescription, 'system', 'System', '', '', metadata);
  }

  getActivity(ticketId: string): TicketActivity[] {
    return this.db.prepare('SELECT * FROM ticket_activity WHERE ticketId = ? ORDER BY createdAt ASC')
      .all(ticketId) as TicketActivity[];
  }

  private addActivity(
    ticketId: string,
    type: string,
    content: string,
    authorType: string,
    authorName: string,
    oldValue = '',
    newValue = '',
    metadata?: Record<string, unknown>,
  ): TicketActivity {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO ticket_activity (id, ticketId, type, content, authorType, authorName, oldValue, newValue, metadata, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ticketId, type, content, authorType, authorName, oldValue, newValue, JSON.stringify(metadata ?? {}), now);

    return this.db.prepare('SELECT * FROM ticket_activity WHERE id = ?').get(id) as TicketActivity;
  }
}
