import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.ts';

export class OrgDB {
  private db: DatabaseSync;
  private dbPath: string;
  private closed = false;

  constructor(workspaceRoot: string) {
    const dataDir = path.join(workspaceRoot, '.orcha-data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.dbPath = path.join(dataDir, 'orcha.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.migrateFromCompanies();
    this.ensureSchema();
    logger.info(`[OrgDB] Database opened at ${this.dbPath}`);
  }

  getDB(): DatabaseSync {
    return this.db;
  }

  /** Drop legacy company tables if they exist (fresh start migration) */
  private migrateFromCompanies(): void {
    const hasOldTable = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='companies'"
    ).get();

    if (hasOldTable) {
      logger.info('[OrgDB] Migrating: dropping legacy company tables');
      this.db.exec(`
        DROP TABLE IF EXISTS routine_runs;
        DROP TABLE IF EXISTS routines;
        DROP TABLE IF EXISTS ticket_activity;
        DROP TABLE IF EXISTS tickets;
        DROP TABLE IF EXISTS companies;
      `);
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        issuePrefix TEXT NOT NULL UNIQUE,
        issueCounter INTEGER NOT NULL DEFAULT 0,
        brandColor TEXT NOT NULL DEFAULT '',
        ceoType TEXT NOT NULL DEFAULT '',
        ceoConfig TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        priority TEXT NOT NULL DEFAULT 'medium',
        assigneeAgent TEXT NOT NULL DEFAULT '',
        issueNumber INTEGER NOT NULL,
        identifier TEXT NOT NULL UNIQUE,
        taskId TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_org_status ON tickets(orgId, status);
      CREATE INDEX IF NOT EXISTS idx_tickets_identifier ON tickets(identifier);

      CREATE TABLE IF NOT EXISTS ticket_activity (
        id TEXT PRIMARY KEY,
        ticketId TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        authorType TEXT NOT NULL DEFAULT '',
        authorName TEXT NOT NULL DEFAULT '',
        oldValue TEXT NOT NULL DEFAULT '',
        newValue TEXT NOT NULL DEFAULT '',
        metadata TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activity_ticket ON ticket_activity(ticketId);

      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        schedule TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        agentName TEXT NOT NULL,
        agentInput TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        lastTriggeredAt TEXT NOT NULL DEFAULT '',
        nextRunAt TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_routines_org ON routines(orgId, status);

      CREATE TABLE IF NOT EXISTS routine_runs (
        id TEXT PRIMARY KEY,
        routineId TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        taskId TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        triggeredAt TEXT NOT NULL,
        completedAt TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_routine ON routine_runs(routineId);

      CREATE TABLE IF NOT EXISTS org_members (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        agentName TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'member',
        reportsTo TEXT REFERENCES org_members(id) ON DELETE SET NULL,
        position INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_members_org ON org_members(orgId);
      CREATE INDEX IF NOT EXISTS idx_members_reports ON org_members(reportsTo);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_members_org_agent ON org_members(orgId, agentName);

      CREATE TABLE IF NOT EXISTS ceo_runs (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        taskId TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        triggerSource TEXT NOT NULL DEFAULT '',
        inputTokens INTEGER NOT NULL DEFAULT 0,
        outputTokens INTEGER NOT NULL DEFAULT 0,
        costUsd REAL NOT NULL DEFAULT 0,
        durationMs INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        decisions TEXT NOT NULL DEFAULT '[]',
        ticketsCreated TEXT NOT NULL DEFAULT '[]',
        ticketsUpdated TEXT NOT NULL DEFAULT '[]',
        sessionId TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        startedAt TEXT NOT NULL,
        completedAt TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ceo_runs_org ON ceo_runs(orgId, startedAt);

      CREATE TABLE IF NOT EXISTS heartbeat_config (
        orgId TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        schedule TEXT NOT NULL DEFAULT '*/30 * * * *',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        contextSnapshot TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_log (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT '',
        target TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        orgId TEXT NOT NULL DEFAULT '',
        ticketId TEXT NOT NULL DEFAULT '',
        input TEXT NOT NULL DEFAULT '{}',
        result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        iteration INTEGER NOT NULL DEFAULT 0,
        messageCount INTEGER NOT NULL DEFAULT 0,
        imageCount INTEGER NOT NULL DEFAULT 0,
        contextChars INTEGER NOT NULL DEFAULT 0,
        inputTokens INTEGER NOT NULL DEFAULT 0,
        outputTokens INTEGER NOT NULL DEFAULT 0,
        durationMs INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_task_log_org ON task_log(orgId);
      CREATE INDEX IF NOT EXISTS idx_task_log_status ON task_log(status);
      CREATE INDEX IF NOT EXISTS idx_task_log_created ON task_log(createdAt);
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    logger.info('[OrgDB] Database closed');
  }
}
