import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.ts';

export class CompanyDB {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(workspaceRoot: string) {
    const dataDir = path.join(workspaceRoot, '.orcha-data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.dbPath = path.join(dataDir, 'orcha.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.ensureSchema();
    logger.info(`[CompanyDB] Database opened at ${this.dbPath}`);
  }

  getDB(): DatabaseSync {
    return this.db;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        issuePrefix TEXT NOT NULL UNIQUE,
        issueCounter INTEGER NOT NULL DEFAULT 0,
        brandColor TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
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

      CREATE INDEX IF NOT EXISTS idx_tickets_company_status ON tickets(companyId, status);
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
        companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
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

      CREATE INDEX IF NOT EXISTS idx_routines_company ON routines(companyId, status);

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
    `);
  }

  close(): void {
    this.db.close();
    logger.info('[CompanyDB] Database closed');
  }
}
