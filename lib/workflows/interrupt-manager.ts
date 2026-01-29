import type { InterruptState } from './types.js';
import { logger } from '../logger.js';

/**
 * Manages workflow interrupts for human-in-the-loop interactions.
 * Interrupts are stored in-memory and expire after 1 hour.
 */
export class InterruptManager {
  private interrupts: Map<string, InterruptState> = new Map();
  private readonly INTERRUPT_TTL = 3600000; // 1 hour in milliseconds

  /**
   * Adds a new interrupt.
   */
  addInterrupt(interrupt: InterruptState): void {
    this.interrupts.set(interrupt.threadId, interrupt);
    logger.info(`Added interrupt for thread ${interrupt.threadId}: ${interrupt.question}`);

    // Clean up expired interrupts
    this.cleanupExpired();
  }

  /**
   * Gets an interrupt by thread ID.
   */
  getInterrupt(threadId: string): InterruptState | undefined {
    const interrupt = this.interrupts.get(threadId);

    // Check if expired
    if (interrupt && Date.now() - interrupt.timestamp > this.INTERRUPT_TTL) {
      this.interrupts.delete(threadId);
      logger.info(`Interrupt expired for thread ${threadId}`);
      return undefined;
    }

    return interrupt;
  }

  /**
   * Gets all interrupts for a workflow.
   */
  getInterruptsByWorkflow(workflowName: string): InterruptState[] {
    const interrupts: InterruptState[] = [];

    for (const interrupt of this.interrupts.values()) {
      if (interrupt.workflowName === workflowName && !interrupt.resolved) {
        // Check if expired
        if (Date.now() - interrupt.timestamp <= this.INTERRUPT_TTL) {
          interrupts.push(interrupt);
        }
      }
    }

    return interrupts;
  }

  /**
   * Resolves an interrupt with the user's answer.
   */
  resolveInterrupt(threadId: string, answer: string): boolean {
    const interrupt = this.getInterrupt(threadId);

    if (!interrupt) {
      logger.warn(`No interrupt found for thread ${threadId}`);
      return false;
    }

    interrupt.resolved = true;
    interrupt.answer = answer;
    this.interrupts.set(threadId, interrupt);

    logger.info(`Resolved interrupt for thread ${threadId} with answer: ${answer}`);
    return true;
  }

  /**
   * Removes an interrupt.
   */
  removeInterrupt(threadId: string): boolean {
    const deleted = this.interrupts.delete(threadId);
    if (deleted) {
      logger.info(`Removed interrupt for thread ${threadId}`);
    }
    return deleted;
  }

  /**
   * Cleans up expired interrupts.
   */
  private cleanupExpired(): void {
    const now = Date.now();
    const expiredThreadIds: string[] = [];

    for (const [threadId, interrupt] of this.interrupts.entries()) {
      if (now - interrupt.timestamp > this.INTERRUPT_TTL) {
        expiredThreadIds.push(threadId);
      }
    }

    for (const threadId of expiredThreadIds) {
      this.interrupts.delete(threadId);
      logger.info(`Cleaned up expired interrupt for thread ${threadId}`);
    }
  }

  /**
   * Gets the total number of active interrupts.
   */
  getInterruptCount(): number {
    this.cleanupExpired();
    return this.interrupts.size;
  }

  /**
   * Clears all interrupts (useful for testing).
   */
  clear(): void {
    this.interrupts.clear();
    logger.info('Cleared all interrupts');
  }
}
