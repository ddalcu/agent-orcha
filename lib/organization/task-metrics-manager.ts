import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logger.ts';

export interface TaskLogRow {
  id: string;
  kind: string;
  target: string;
  status: string;
  orgId: string;
  ticketId: string;
  input: string;
  result: string;
  error: string;
  iteration: number;
  messageCount: number;
  imageCount: number;
  contextChars: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export class TaskMetricsManager {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    // Drop legacy task_metrics table if it exists
    const hasOld = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_metrics'").get();
    if (hasOld) {
      this.db.exec('DROP TABLE task_metrics');
      logger.info('[TaskMetricsManager] Dropped legacy task_metrics table');
    }
  }

  /** Create or update a task record in the DB */
  record(taskId: string, data: {
    kind?: string;
    target?: string;
    status: string;
    orgId?: string;
    ticketId?: string;
    input?: Record<string, unknown>;
    result?: unknown;
    error?: string;
    metrics?: { iteration?: number; messageCount?: number; imageCount?: number; contextChars?: number; inputTokens?: number; outputTokens?: number };
    durationMs?: number;
  }): void {
    const now = new Date().toISOString();
    const m = data.metrics || {};
    const existing = this.db.prepare('SELECT id FROM task_log WHERE id = ?').get(taskId);

    if (existing) {
      this.db.prepare(`
        UPDATE task_log SET
          status = ?, error = ?,
          result = ?,
          iteration = ?, messageCount = ?, imageCount = ?,
          contextChars = ?, inputTokens = ?, outputTokens = ?,
          durationMs = ?, updatedAt = ?,
          completedAt = CASE WHEN ? IN ('completed', 'failed', 'canceled') THEN ? ELSE completedAt END
        WHERE id = ?
      `).run(
        data.status, data.error || '',
        data.result ? JSON.stringify(data.result) : '',
        m.iteration || 0, m.messageCount || 0, m.imageCount || 0,
        m.contextChars || 0, m.inputTokens || 0, m.outputTokens || 0,
        data.durationMs || 0, now,
        data.status, now,
        taskId,
      );
    } else {
      this.db.prepare(`
        INSERT INTO task_log (id, kind, target, status, orgId, ticketId,
          input, result, error,
          iteration, messageCount, imageCount, contextChars, inputTokens, outputTokens,
          durationMs, createdAt, updatedAt, completedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
      `).run(
        taskId, data.kind || '', data.target || '', data.status,
        data.orgId || '', data.ticketId || '',
        data.input ? JSON.stringify(data.input) : '{}',
        data.result ? JSON.stringify(data.result) : '',
        data.error || '',
        m.iteration || 0, m.messageCount || 0, m.imageCount || 0,
        m.contextChars || 0, m.inputTokens || 0, m.outputTokens || 0,
        data.durationMs || 0, now, now,
      );
    }
  }

  /** Create a task record at submission time (before completion) */
  create(taskId: string, kind: string, target: string, input: Record<string, unknown>, orgId?: string): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM task_log WHERE id = ?').get(taskId);
    if (existing) return; // Already tracked

    this.db.prepare(`
      INSERT INTO task_log (id, kind, target, status, orgId, ticketId,
        input, result, error,
        iteration, messageCount, imageCount, contextChars, inputTokens, outputTokens,
        durationMs, createdAt, updatedAt, completedAt)
      VALUES (?, ?, ?, 'working', ?, '', ?, '', '', 0, 0, 0, 0, 0, 0, 0, ?, ?, '')
    `).run(taskId, kind, target, orgId || '', JSON.stringify(input), now, now);
  }

  /** Update task status in the DB */
  updateStatus(taskId: string, status: string, error?: string): void {
    const now = new Date().toISOString();
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      this.db.prepare('UPDATE task_log SET status = ?, error = ?, updatedAt = ?, completedAt = ? WHERE id = ?')
        .run(status, error || '', now, now, taskId);
    } else {
      this.db.prepare('UPDATE task_log SET status = ?, error = ?, updatedAt = ? WHERE id = ?')
        .run(status, error || '', now, taskId);
    }
  }

  getByTask(taskId: string): TaskLogRow | undefined {
    return this.db.prepare('SELECT * FROM task_log WHERE id = ?').get(taskId) as TaskLogRow | undefined;
  }

  list(filters?: { status?: string; orgId?: string; kind?: string; target?: string }, limit = 100): TaskLogRow[] {
    let sql = 'SELECT * FROM task_log WHERE 1=1';
    const params: (string | number)[] = [];

    if (filters?.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters?.orgId) { sql += ' AND orgId = ?'; params.push(filters.orgId); }
    if (filters?.kind) { sql += ' AND kind = ?'; params.push(filters.kind); }
    if (filters?.target) { sql += ' AND target = ?'; params.push(filters.target); }

    sql += ' ORDER BY createdAt DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params) as unknown as TaskLogRow[];
  }

  getOrgStats(orgId: string): {
    totalTasks: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    byAgent: { name: string; count: number; inputTokens: number; outputTokens: number }[];
  } {
    const totals = this.db.prepare(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(inputTokens), 0) as inTok, COALESCE(SUM(outputTokens), 0) as outTok
      FROM task_log WHERE orgId = ?
    `).get(orgId) as { cnt: number; inTok: number; outTok: number };

    const byAgent = this.db.prepare(`
      SELECT target as name, COUNT(*) as count,
             COALESCE(SUM(inputTokens), 0) as inputTokens,
             COALESCE(SUM(outputTokens), 0) as outputTokens
      FROM task_log WHERE orgId = ? AND target != ''
      GROUP BY target ORDER BY count DESC
    `).all(orgId) as { name: string; count: number; inputTokens: number; outputTokens: number }[];

    return {
      totalTasks: totals.cnt,
      totalInputTokens: totals.inTok,
      totalOutputTokens: totals.outTok,
      byAgent,
    };
  }
}
