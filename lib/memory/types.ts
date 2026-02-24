import { z } from 'zod';
import type { BaseMessage } from '../types/llm-types.ts';

export const ConversationStoreConfigSchema = z.object({
  maxMessagesPerSession: z.number().int().positive().default(50),
  sessionTTL: z.number().int().positive().optional(),
});

export type ConversationStoreConfig = z.infer<typeof ConversationStoreConfigSchema>;

export interface ConversationSession {
  messages: BaseMessage[];
  createdAt: number;
  lastAccessedAt: number;
}
