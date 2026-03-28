import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CEORun } from './types.ts';
import { logger } from '../logger.ts';

export class CEORunManager {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  startRun(orgId: string, type: string, triggerSource: string, taskId = ''): CEORun {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO ceo_runs (id, orgId, taskId, type, status, triggerSource, startedAt, createdAt)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(id, orgId, taskId, type, triggerSource, now, now);

    logger.info(`[CEORunManager] Started ${type} run for org ${orgId}`);
    return this.db.prepare('SELECT * FROM ceo_runs WHERE id = ?').get(id) as CEORun;
  }

  completeRun(id: string, data: {
    summary?: string;
    decisions?: string[];
    ticketsCreated?: string[];
    ticketsUpdated?: string[];
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    sessionId?: string;
  }): CEORun {
    const now = new Date().toISOString();
    const run = this.db.prepare('SELECT * FROM ceo_runs WHERE id = ?').get(id) as CEORun | undefined;
    if (!run) throw new Error(`CEO run not found: ${id}`);

    const durationMs = run.startedAt ? new Date(now).getTime() - new Date(run.startedAt).getTime() : 0;

    this.db.prepare(`
      UPDATE ceo_runs SET
        status = 'completed',
        summary = ?,
        decisions = ?,
        ticketsCreated = ?,
        ticketsUpdated = ?,
        inputTokens = ?,
        outputTokens = ?,
        costUsd = ?,
        durationMs = ?,
        sessionId = ?,
        completedAt = ?
      WHERE id = ?
    `).run(
      data.summary || '',
      JSON.stringify(data.decisions || []),
      JSON.stringify(data.ticketsCreated || []),
      JSON.stringify(data.ticketsUpdated || []),
      data.inputTokens || 0,
      data.outputTokens || 0,
      data.costUsd || 0,
      durationMs,
      data.sessionId || '',
      now,
      id,
    );

    logger.info(`[CEORunManager] Completed run ${id} (${durationMs}ms)`);
    return this.db.prepare('SELECT * FROM ceo_runs WHERE id = ?').get(id) as CEORun;
  }

  failRun(id: string, error: string): CEORun {
    const now = new Date().toISOString();
    const run = this.db.prepare('SELECT * FROM ceo_runs WHERE id = ?').get(id) as CEORun | undefined;
    if (!run) throw new Error(`CEO run not found: ${id}`);

    const durationMs = run.startedAt ? new Date(now).getTime() - new Date(run.startedAt).getTime() : 0;

    this.db.prepare(`
      UPDATE ceo_runs SET status = 'failed', error = ?, durationMs = ?, completedAt = ? WHERE id = ?
    `).run(error, durationMs, now, id);

    logger.error(`[CEORunManager] Run ${id} failed: ${error}`);
    return this.db.prepare('SELECT * FROM ceo_runs WHERE id = ?').get(id) as CEORun;
  }

  listRuns(orgId: string, limit = 50): CEORun[] {
    return this.db.prepare('SELECT * FROM ceo_runs WHERE orgId = ? ORDER BY startedAt DESC LIMIT ?')
      .all(orgId, limit) as CEORun[];
  }

  getLatestRun(orgId: string): CEORun | undefined {
    return this.db.prepare('SELECT * FROM ceo_runs WHERE orgId = ? ORDER BY startedAt DESC LIMIT 1')
      .get(orgId) as CEORun | undefined;
  }

  getStats(orgId: string): {
    totalRuns: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgDurationMs: number;
    last24hRuns: number;
    last7dCost: number;
  } {
    const all = this.db.prepare(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(costUsd), 0) as cost,
             COALESCE(SUM(inputTokens), 0) as inTok, COALESCE(SUM(outputTokens), 0) as outTok,
             COALESCE(AVG(durationMs), 0) as avgDur
      FROM ceo_runs WHERE orgId = ?
    `).get(orgId) as { cnt: number; cost: number; inTok: number; outTok: number; avgDur: number };

    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const last24h = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM ceo_runs WHERE orgId = ? AND startedAt > ?'
    ).get(orgId, dayAgo) as { cnt: number };

    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const last7d = this.db.prepare(
      'SELECT COALESCE(SUM(costUsd), 0) as cost FROM ceo_runs WHERE orgId = ? AND startedAt > ?'
    ).get(orgId, weekAgo) as { cost: number };

    return {
      totalRuns: all.cnt,
      totalCost: all.cost,
      totalInputTokens: all.inTok,
      totalOutputTokens: all.outTok,
      avgDurationMs: Math.round(all.avgDur),
      last24hRuns: last24h.cnt,
      last7dCost: last7d.cost,
    };
  }
}
