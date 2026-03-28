import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CompanyDB } from '../../lib/company/company-db.ts';
import { CompanyManager } from '../../lib/company/company-manager.ts';
import { TicketManager } from '../../lib/company/ticket-manager.ts';

describe('TicketManager', () => {
  let tempDir: string;
  let companyDB: CompanyDB;
  let companyManager: CompanyManager;
  let ticketManager: TicketManager;
  let companyId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-test-'));
    companyDB = new CompanyDB(tempDir);
    const db = companyDB.getDB();
    companyManager = new CompanyManager(db);
    ticketManager = new TicketManager(db, companyManager);

    // Create a test company for tickets
    const company = companyManager.create({ name: 'Test Co', issuePrefix: 'TEST' });
    companyId = company.id;
  });

  afterEach(() => {
    companyDB.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── create ──

  it('should create a ticket with default values', () => {
    const ticket = ticketManager.create(companyId, { title: 'Fix login bug' });

    assert.ok(ticket.id);
    assert.equal(ticket.companyId, companyId);
    assert.equal(ticket.title, 'Fix login bug');
    assert.equal(ticket.description, '');
    assert.equal(ticket.status, 'backlog');
    assert.equal(ticket.priority, 'medium');
    assert.equal(ticket.assigneeAgent, '');
    assert.equal(ticket.identifier, 'TEST-1');
    assert.equal(ticket.issueNumber, 1);
    assert.ok(ticket.createdAt);
    assert.ok(ticket.updatedAt);
  });

  it('should create a ticket with all fields', () => {
    const ticket = ticketManager.create(companyId, {
      title: 'Deploy v2',
      description: 'Deploy the new version',
      priority: 'critical',
      assigneeAgent: 'deploy-agent',
    });

    assert.equal(ticket.title, 'Deploy v2');
    assert.equal(ticket.description, 'Deploy the new version');
    assert.equal(ticket.priority, 'critical');
    assert.equal(ticket.assigneeAgent, 'deploy-agent');
  });

  it('should auto-increment issue numbers', () => {
    const t1 = ticketManager.create(companyId, { title: 'First' });
    const t2 = ticketManager.create(companyId, { title: 'Second' });
    const t3 = ticketManager.create(companyId, { title: 'Third' });

    assert.equal(t1.identifier, 'TEST-1');
    assert.equal(t2.identifier, 'TEST-2');
    assert.equal(t3.identifier, 'TEST-3');
  });

  it('should throw for non-existent company', () => {
    assert.throws(() => ticketManager.create('fake-id', { title: 'Nope' }), /Company not found/);
  });

  it('should reject empty title', () => {
    assert.throws(() => ticketManager.create(companyId, { title: '' }));
  });

  it('should reject invalid priority', () => {
    assert.throws(() => ticketManager.create(companyId, { title: 'X', priority: 'ultra' as any }));
  });

  it('should log creation activity', () => {
    const ticket = ticketManager.create(companyId, { title: 'With activity' });
    const activity = ticketManager.getActivity(ticket.id);

    assert.equal(activity.length, 1);
    assert.equal(activity[0].type, 'status_change');
    assert.equal(activity[0].newValue, 'backlog');
    assert.equal(activity[0].authorType, 'system');
  });

  // ── get / list ──

  it('should get a ticket by id', () => {
    const created = ticketManager.create(companyId, { title: 'Lookup' });
    const found = ticketManager.get(created.id);

    assert.ok(found);
    assert.equal(found!.id, created.id);
  });

  it('should get a ticket by identifier', () => {
    ticketManager.create(companyId, { title: 'By ident' });
    const found = ticketManager.getByIdentifier('TEST-1');

    assert.ok(found);
    assert.equal(found!.title, 'By ident');
  });

  it('should return undefined for missing id', () => {
    assert.equal(ticketManager.get('nonexistent'), undefined);
  });

  it('should return undefined for missing identifier', () => {
    assert.equal(ticketManager.getByIdentifier('NOPE-99'), undefined);
  });

  it('should list tickets for a company', () => {
    ticketManager.create(companyId, { title: 'A' });
    ticketManager.create(companyId, { title: 'B' });

    const tickets = ticketManager.list(companyId);
    assert.equal(tickets.length, 2);
  });

  it('should return empty list for company with no tickets', () => {
    const other = companyManager.create({ name: 'Empty Co', issuePrefix: 'EMPTY' });
    const tickets = ticketManager.list(other.id);
    assert.equal(tickets.length, 0);
  });

  it('should filter tickets by status', () => {
    const t = ticketManager.create(companyId, { title: 'A' });
    ticketManager.transition(t.id, 'in_progress');
    ticketManager.create(companyId, { title: 'B' });

    const inProgress = ticketManager.list(companyId, { status: 'in_progress' });
    assert.equal(inProgress.length, 1);
    assert.equal(inProgress[0].title, 'A');
  });

  it('should filter tickets by priority', () => {
    ticketManager.create(companyId, { title: 'Low', priority: 'low' });
    ticketManager.create(companyId, { title: 'High', priority: 'high' });

    const high = ticketManager.list(companyId, { priority: 'high' });
    assert.equal(high.length, 1);
    assert.equal(high[0].title, 'High');
  });

  it('should filter tickets by assigneeAgent', () => {
    ticketManager.create(companyId, { title: 'Assigned', assigneeAgent: 'bot-1' });
    ticketManager.create(companyId, { title: 'Unassigned' });

    const assigned = ticketManager.list(companyId, { assigneeAgent: 'bot-1' });
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0].title, 'Assigned');
  });

  // ── update ──

  it('should update ticket title', () => {
    const t = ticketManager.create(companyId, { title: 'Old' });
    const updated = ticketManager.update(t.id, { title: 'New' });

    assert.equal(updated.title, 'New');
  });

  it('should update ticket description', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const updated = ticketManager.update(t.id, { description: 'detailed desc' });

    assert.equal(updated.description, 'detailed desc');
  });

  it('should update ticket priority', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const updated = ticketManager.update(t.id, { priority: 'critical' });

    assert.equal(updated.priority, 'critical');
  });

  it('should update assignee and log activity', () => {
    const t = ticketManager.create(companyId, { title: 'T', assigneeAgent: 'old-bot' });
    ticketManager.update(t.id, { assigneeAgent: 'new-bot' });

    const activity = ticketManager.getActivity(t.id);
    const assignChange = activity.find(a => a.type === 'assignment_change');
    assert.ok(assignChange);
    assert.equal(assignChange!.oldValue, 'old-bot');
    assert.equal(assignChange!.newValue, 'new-bot');
  });

  it('should not log activity when assignee unchanged', () => {
    const t = ticketManager.create(companyId, { title: 'T', assigneeAgent: 'same-bot' });
    ticketManager.update(t.id, { assigneeAgent: 'same-bot' });

    const activity = ticketManager.getActivity(t.id);
    const assignChanges = activity.filter(a => a.type === 'assignment_change');
    assert.equal(assignChanges.length, 0);
  });

  it('should return unchanged ticket when no fields provided', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const updated = ticketManager.update(t.id, {});

    assert.equal(updated.title, 'T');
  });

  it('should throw when updating non-existent ticket', () => {
    assert.throws(() => ticketManager.update('fake', { title: 'X' }), /Ticket not found/);
  });

  // ── transition ──

  it('should transition ticket status', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const updated = ticketManager.transition(t.id, 'in_progress');

    assert.equal(updated.status, 'in_progress');
  });

  it('should set completedAt when transitioning to done', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const done = ticketManager.transition(t.id, 'done');

    assert.ok(done.completedAt);
    assert.notEqual(done.completedAt, '');
  });

  it('should set completedAt when transitioning to cancelled', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const cancelled = ticketManager.transition(t.id, 'cancelled');

    assert.ok(cancelled.completedAt);
  });

  it('should return unchanged ticket when transitioning to same status', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const same = ticketManager.transition(t.id, 'backlog');

    assert.equal(same.status, 'backlog');
  });

  it('should log status change activity', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    ticketManager.transition(t.id, 'todo');

    const activity = ticketManager.getActivity(t.id);
    const statusChange = activity.find(a => a.content.includes('backlog to todo'));
    assert.ok(statusChange);
    assert.equal(statusChange!.oldValue, 'backlog');
    assert.equal(statusChange!.newValue, 'todo');
  });

  it('should throw when transitioning non-existent ticket', () => {
    assert.throws(() => ticketManager.transition('fake', 'done'), /Ticket not found/);
  });

  // ── linkTask ──

  it('should link a task to a ticket', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    ticketManager.linkTask(t.id, 'task-123');

    const found = ticketManager.get(t.id)!;
    assert.equal(found.taskId, 'task-123');
  });

  // ── comments ──

  it('should add a comment', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const comment = ticketManager.addComment(t.id, 'Hello!', 'user', 'Alice');

    assert.equal(comment.type, 'comment');
    assert.equal(comment.content, 'Hello!');
    assert.equal(comment.authorType, 'user');
    assert.equal(comment.authorName, 'Alice');
  });

  it('should add a task event', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const event = ticketManager.addTaskEvent(t.id, 'Agent started');

    assert.equal(event.type, 'task_event');
    assert.equal(event.content, 'Agent started');
    assert.equal(event.authorType, 'system');
  });

  it('should add comment with metadata', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    const comment = ticketManager.addComment(t.id, 'Result', 'agent', 'Bot', { tokens: 500 });

    assert.equal(JSON.parse(comment.metadata).tokens, 500);
  });

  // ── activity ──

  it('should return activity in chronological order', () => {
    const t = ticketManager.create(companyId, { title: 'T' });
    ticketManager.addComment(t.id, 'First', 'user', 'A');
    ticketManager.addComment(t.id, 'Second', 'user', 'B');

    const activity = ticketManager.getActivity(t.id);
    // creation + 2 comments = 3
    assert.equal(activity.length, 3);
    assert.equal(activity[1].content, 'First');
    assert.equal(activity[2].content, 'Second');
  });

  it('should return empty activity for unknown ticket', () => {
    const activity = ticketManager.getActivity('nonexistent');
    assert.equal(activity.length, 0);
  });

  // ── cross-company isolation ──

  it('should isolate tickets between companies', () => {
    const other = companyManager.create({ name: 'Other Co', issuePrefix: 'OTHER' });
    ticketManager.create(companyId, { title: 'In Test Co' });
    ticketManager.create(other.id, { title: 'In Other Co' });

    assert.equal(ticketManager.list(companyId).length, 1);
    assert.equal(ticketManager.list(other.id).length, 1);
  });

  it('should use separate issue counters per company', () => {
    const other = companyManager.create({ name: 'Other Co', issuePrefix: 'OTHER' });
    const t1 = ticketManager.create(companyId, { title: 'A' });
    const t2 = ticketManager.create(other.id, { title: 'B' });

    assert.equal(t1.identifier, 'TEST-1');
    assert.equal(t2.identifier, 'OTHER-1');
  });
});
