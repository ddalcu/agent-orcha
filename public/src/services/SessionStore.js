
const SESSIONS_KEY = 'orcha-sessions';
const ACTIVE_KEY = 'orcha-active-session-id';
const MAX_SESSIONS = 50;

class SessionStore {
    getAll() {
        const raw = localStorage.getItem(SESSIONS_KEY);
        const sessions = raw ? JSON.parse(raw) : [];
        return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    get(id) {
        return this.getAll().find(s => s.id === id) || null;
    }

    create({ agentName, agentType, llmName }) {
        const sessions = this.getAll();
        const session = {
            id: 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9),
            agentName: agentName || null,
            agentType: agentType || 'agent',
            llmName: llmName || null,
            title: 'New conversation',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        sessions.unshift(session);

        // Enforce max sessions — remove oldest
        if (sessions.length > MAX_SESSIONS) {
            sessions.length = MAX_SESSIONS;
        }

        this._save(sessions);
        this.setActiveId(session.id);
        return session;
    }

    addMessage(sessionId, role, content) {
        const sessions = this.getAll();
        const session = sessions.find(s => s.id === sessionId);
        if (!session) return;

        session.messages.push({ role, content });
        session.updatedAt = Date.now();

        // Set title from first user message
        if (role === 'user' && session.title === 'New conversation') {
            session.title = content.length > 50 ? content.substring(0, 50) + '...' : content;
        }

        this._save(sessions);
    }

    delete(sessionId) {
        const sessions = this.getAll().filter(s => s.id !== sessionId);
        this._save(sessions);
        if (this.getActiveId() === sessionId) {
            this.clearActiveId();
        }
    }

    getActiveId() {
        return localStorage.getItem(ACTIVE_KEY);
    }

    setActiveId(id) {
        localStorage.setItem(ACTIVE_KEY, id);
    }

    clearActiveId() {
        localStorage.removeItem(ACTIVE_KEY);
    }

    _save(sessions) {
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    }
}

export const sessionStore = new SessionStore();
