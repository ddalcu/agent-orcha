import { z } from 'zod';

export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  sandbox: boolean;
}

export const AgentSkillsConfigSchema = z.union([
  z.object({ mode: z.literal('all') }),
  z.array(z.string()),
]);

export type AgentSkillsConfig = z.infer<typeof AgentSkillsConfigSchema>;
