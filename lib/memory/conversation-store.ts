import type { BaseMessage } from '../types/llm-types.ts';
import type { ConversationSession, ConversationStoreConfig } from './types.ts';
import { logger } from '../logger.ts';

export class ConversationStore {
  private sessions: Map<string, ConversationSession>;
  private maxMessagesPerSession: number;
  private sessionTTL?: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: ConversationStoreConfig = { maxMessagesPerSession: 50 }) {
    this.sessions = new Map();
    this.maxMessagesPerSession = config.maxMessagesPerSession;
    this.sessionTTL = config.sessionTTL;

    // Start periodic cleanup if TTL is configured
    if (this.sessionTTL) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Run every minute
    }
  }

  /**
   * Get all messages for a session
   */
  getMessages(sessionId: string): BaseMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }

    // Update last accessed time
    session.lastAccessedAt = Date.now();
    return [...session.messages]; // Return copy to prevent external modification
  }

  /**
   * Add a message to a session
   * Maintains FIFO order and enforces max message limit
   */
  addMessage(sessionId: string, message: BaseMessage): void {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        messages: [],
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
      this.sessions.set(sessionId, session);
      logger.debug(`[ConversationStore] Created new session: ${sessionId}`);
    }

    session.messages.push(message);
    session.lastAccessedAt = Date.now();

    // Enforce FIFO limit (remove oldest messages if exceeded)
    if (session.messages.length > this.maxMessagesPerSession) {
      const removed = session.messages.length - this.maxMessagesPerSession;
      session.messages.splice(0, removed);
      logger.debug(`[ConversationStore] Session ${sessionId}: Removed ${removed} old messages (FIFO)`);
    }
  }

  /**
   * Clear all messages from a session
   */
  clearSession(sessionId: string): void {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      logger.debug(`[ConversationStore] Cleared session: ${sessionId}`);
    }
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get number of messages in a session
   */
  getMessageCount(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    return session ? session.messages.length : 0;
  }

  /**
   * Get total number of sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Remove expired sessions based on TTL
   */
  cleanup(): void {
    if (!this.sessionTTL) return;

    const now = Date.now();
    let removedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const age = now - session.lastAccessedAt;
      if (age > this.sessionTTL) {
        this.sessions.delete(sessionId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.info(`[ConversationStore] Cleaned up ${removedCount} expired sessions`);
    }
  }

  /**
   * Stop cleanup interval (call when shutting down)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }
}
