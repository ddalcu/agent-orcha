import { contentToText, type StructuredTool } from '../types/llm-types.ts';
import { createLogger } from '../logger.ts';

const logger = createLogger('LLMCall');

export interface LLMCallContext {
  /** Caller identifier, e.g. "Agent: my-agent" or "ReactWorkflow: my-workflow" */
  caller: string;
  systemPrompt?: string;
  messages?: Array<{ role?: string; content?: string; _getType?: () => string } | any>;
  tools?: StructuredTool[];
}

interface ContextStats {
  systemPromptChars: number;
  messageCount: number;
  messageChars: number;
  toolCount: number;
  toolDescriptionChars: number;
  totalChars: number;
  estimatedTokens: number;
}

/**
 * Compute size stats for what's being sent to the LLM.
 */
function computeStats(ctx: LLMCallContext): ContextStats {
  const systemPromptChars = ctx.systemPrompt?.length ?? 0;

  let messageCount = 0;
  let messageChars = 0;
  if (ctx.messages) {
    messageCount = ctx.messages.length;
    for (const msg of ctx.messages) {
      const content = typeof msg === 'string'
        ? msg
        : msg.content
          ? contentToText(msg.content)
          : JSON.stringify(msg);
      messageChars += content.length;
    }
  }

  let toolCount = 0;
  let toolDescriptionChars = 0;
  if (ctx.tools) {
    toolCount = ctx.tools.length;
    for (const t of ctx.tools) {
      toolDescriptionChars += (t.name?.length ?? 0) + (t.description?.length ?? 0);
      // Schema JSON also counts toward context
      if (t.schema) {
        try {
          toolDescriptionChars += JSON.stringify(t.schema).length;
        } catch {
          // skip if schema can't be serialized
        }
      }
    }
  }

  const totalChars = systemPromptChars + messageChars + toolDescriptionChars;
  // Rough estimate: ~4 chars per token for English text
  const estimatedTokens = Math.round(totalChars / 4);

  return { systemPromptChars, messageCount, messageChars, toolCount, toolDescriptionChars, totalChars, estimatedTokens };
}

/**
 * Log context stats before an LLM call.
 */
export function logLLMCallStart(ctx: LLMCallContext): { startTime: number; stats: ContextStats } {
  const stats = computeStats(ctx);

  const parts = [
    `[${ctx.caller}] LLM call starting`,
    `| tools: ${stats.toolCount} (${formatChars(stats.toolDescriptionChars)})`,
    `| messages: ${stats.messageCount} (${formatChars(stats.messageChars)})`,
    `| system prompt: ${formatChars(stats.systemPromptChars)}`,
    `| total context: ~${formatChars(stats.totalChars)} (~${stats.estimatedTokens.toLocaleString()} tokens est.)`,
  ];

  logger.info(parts.join(' '));

  // Log individual tool sizes if there are any, for debugging bloated descriptions
  if (stats.toolCount > 0 && ctx.tools) {
    const toolSizes = ctx.tools
      .map((t) => {
        let size = (t.name?.length ?? 0) + (t.description?.length ?? 0);
        try { size += JSON.stringify(t.schema).length; } catch { /* skip */ }
        return { name: t.name, chars: size };
      })
      .sort((a, b) => b.chars - a.chars);

    const toolSummary = toolSizes.map((t) => `${t.name}(${formatChars(t.chars)})`).join(', ');
    logger.info(`[${ctx.caller}] Tool sizes: ${toolSummary}`);
  }

  return { startTime: Date.now(), stats };
}

/**
 * Log result after an LLM call completes.
 */
export function logLLMCallEnd(
  caller: string,
  startTime: number,
  stats: ContextStats,
  responseInfo?: { contentLength?: number; messageCount?: number }
): void {
  const duration = Date.now() - startTime;

  const parts = [
    `[${caller}] LLM call completed in ${formatDuration(duration)}`,
    `| context sent: ~${stats.estimatedTokens.toLocaleString()} tokens est.`,
  ];

  if (responseInfo?.contentLength !== undefined) {
    const responseTokens = Math.round(responseInfo.contentLength / 4);
    parts.push(`| response: ${formatChars(responseInfo.contentLength)} (~${responseTokens.toLocaleString()} tokens est.)`);
  }

  if (responseInfo?.messageCount !== undefined) {
    parts.push(`| response messages: ${responseInfo.messageCount}`);
  }

  logger.info(parts.join(' '));
}

function formatChars(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M chars`;
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)}K chars`;
  return `${chars} chars`;
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}
