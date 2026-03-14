import type { Session, MessageMeta } from '../types/index.js';

const SESSIONS_KEY = 'orcha-sessions';
const ACTIVE_KEY = 'orcha-active-session-id';
const MAX_SESSIONS = 50;

class SessionStore {
  getAll(): Session[] {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const sessions: Session[] = raw ? JSON.parse(raw) : [];
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | null {
    return this.getAll().find(s => s.id === id) || null;
  }

  create(opts: { agentName?: string | null; agentType?: string; llmName?: string | null; workflowName?: string | null }): Session {
    const sessions = this.getAll();
    const session: Session = {
      id: 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9),
      agentName: opts.agentName || null,
      agentType: (opts.agentType as Session['agentType']) || 'agent',
      llmName: opts.llmName || null,
      workflowName: opts.workflowName || null,
      title: 'New conversation',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    sessions.unshift(session);
    if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
    this._save(sessions);
    this.setActiveId(session.id);
    return session;
  }

  addMessage(sessionId: string, role: 'user' | 'assistant', content: string, meta?: MessageMeta) {
    const sessions = this.getAll();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    const msg: { role: string; content: string; meta?: MessageMeta } = { role, content };
    if (meta) msg.meta = meta;
    session.messages.push(msg as Session['messages'][number]);
    session.updatedAt = Date.now();
    if (role === 'user' && session.title === 'New conversation') {
      session.title = content.length > 50 ? content.substring(0, 50) + '...' : content;
    }
    this._save(sessions);
  }

  delete(sessionId: string) {
    const sessions = this.getAll().filter(s => s.id !== sessionId);
    this._save(sessions);
    if (this.getActiveId() === sessionId) this.clearActiveId();
  }

  getActiveId(): string | null {
    return localStorage.getItem(ACTIVE_KEY);
  }

  setActiveId(id: string) {
    localStorage.setItem(ACTIVE_KEY, id);
  }

  clearActiveId() {
    localStorage.removeItem(ACTIVE_KEY);
  }

  private _save(sessions: Session[]) {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }
}

export const sessionStore = new SessionStore();
