import { spawn } from 'node:child_process';
import type { Organization, Ticket } from './types.ts';
import type { OrgChartManager } from './org-chart-manager.ts';
import type { OrgManager } from './org-manager.ts';
import type { TicketManager } from './ticket-manager.ts';
import { logger } from '../logger.ts';

interface ClaudeCodeCEODeps {
  orgChart: OrgChartManager;
  orgs: OrgManager;
  tickets: TicketManager;
  listAgents: () => { name: string; description?: string }[];
  workspaceRoot: string;
}

interface ClaudeCodeResult {
  output: string;
  sessionId: string;
  costUsd: number;
}

export class ClaudeCodeCEO {
  private orgId: string;
  private deps: ClaudeCodeCEODeps;
  private activeProcess: import('node:child_process').ChildProcess | null = null;

  constructor(orgId: string, deps: ClaudeCodeCEODeps) {
    this.orgId = orgId;
    this.deps = deps;
  }

  /** Kill the running Claude Code process if any */
  forceStop(): boolean {
    if (this.activeProcess && !this.activeProcess.killed) {
      this.activeProcess.kill('SIGTERM');
      // Give it 3s, then SIGKILL
      setTimeout(() => {
        if (this.activeProcess && !this.activeProcess.killed) {
          this.activeProcess.kill('SIGKILL');
        }
      }, 3000);
      logger.info(`[ClaudeCodeCEO] Force stopped process for org ${this.orgId}`);
      return true;
    }
    return false;
  }

  get isRunning(): boolean {
    return this.activeProcess !== null && !this.activeProcess.killed;
  }

  async handleTicket(org: Organization, ticket: Ticket): Promise<ClaudeCodeResult> {
    const prompt = this.buildTriagePrompt(org, ticket);
    return this.execute(org, prompt);
  }

  async executeHeartbeat(org: Organization, prompt: string, onEvent?: (event: { type: string; content?: string; tool?: string; input?: unknown; output?: unknown }) => void): Promise<ClaudeCodeResult> {
    return this.execute(org, prompt, onEvent);
  }

  async reviewTicket(org: Organization, ticket: Ticket, agentOutput: string): Promise<ClaudeCodeResult> {
    const prompt = this.buildReviewPrompt(org, ticket, agentOutput);
    return this.execute(org, prompt);
  }

  private async execute(org: Organization, prompt: string, onEvent?: (event: { type: string; content?: string; tool?: string; input?: unknown; output?: unknown }) => void): Promise<ClaudeCodeResult> {
    const ceoConfig = this.parseCeoConfig(org.ceoConfig);
    const apiUrl = `http://localhost:${process.env['PORT'] ?? '3333'}`;

    const model = ceoConfig.model || process.env['CLAUDE_CODE_CEO_MODEL'] || 'sonnet';
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--model', model];

    if (ceoConfig.lastSessionId) {
      args.push('--resume', ceoConfig.lastSessionId);
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ORCHA_API_URL: apiUrl,
      ORCHA_ORG_ID: this.orgId,
    };

    // Include auth token if auth is configured
    if (process.env['AUTH_PASSWORD']) {
      env['ORCHA_AUTH_TOKEN'] = process.env['AUTH_PASSWORD'];
    }

    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.deps.workspaceRoot,
      });
      this.activeProcess = proc;

      let output = '';
      let sessionId = '';
      let costUsd = 0;
      let stdoutBuffer = '';

      const processLine = (line: string) => {
        try {
          const event = JSON.parse(line);

          // stream-json format:
          //   { type: "assistant", message: { content: [{ type: "thinking"|"tool_use"|"text", ... }] } }
          //   { type: "user", tool_use_result: "..." }  — tool results
          //   { type: "result", result: "...", session_id, total_cost_usd }
          if (event.type === 'result') {
            const resultText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result || '');
            output = resultText;
            sessionId = event.session_id || '';
            costUsd = event.total_cost_usd || 0;
          } else if (event.type === 'assistant' && event.message?.content) {
            const blocks = Array.isArray(event.message.content) ? event.message.content : [];
            for (const block of blocks) {
              if (block.type === 'thinking' && block.thinking) {
                const thinkText = typeof block.thinking === 'string' ? block.thinking : '';
                if (thinkText) onEvent?.({ type: 'thinking', content: thinkText });
              } else if (block.type === 'tool_use') {
                const toolName = block.name || 'unknown';
                let inputSummary: string;
                if (block.input?.command) inputSummary = `$ ${block.input.command}`;
                else if (block.input?.file_path) inputSummary = block.input.file_path;
                else if (block.input?.query) inputSummary = block.input.query;
                else if (block.input?.pattern) inputSummary = block.input.pattern;
                else if (block.input?.prompt) inputSummary = block.input.prompt;
                else inputSummary = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {});
                onEvent?.({ type: 'tool_start', tool: toolName, input: inputSummary });
              } else if (block.type === 'text' && block.text) {
                output += block.text;
                onEvent?.({ type: 'content', content: block.text });
              }
            }
          } else if (event.type === 'user' && event.tool_use_result) {
            const resultStr = typeof event.tool_use_result === 'string' ? event.tool_use_result : JSON.stringify(event.tool_use_result);
            onEvent?.({ type: 'tool_end', tool: '', output: resultStr });
          }
        } catch {
          logger.debug(`[ClaudeCodeCEO] Non-JSON line: ${line.slice(0, 200)}`);
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        // Process complete lines only — handle chunked JSON across data events
        const lines = stdoutBuffer.split('\n');
        // Keep the last incomplete line in the buffer
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) processLine(trimmed);
        }
      });

      // Flush any remaining buffer on stream end
      proc.stdout?.on('end', () => {
        const trimmed = stdoutBuffer.trim();
        if (trimmed) processLine(trimmed);
        stdoutBuffer = '';
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          logger.warn(`[ClaudeCodeCEO] stderr: ${text.slice(0, 500)}`);
        }
      });

      // Send prompt via stdin
      proc.stdin?.write(prompt);
      proc.stdin?.end();

      proc.on('close', (code) => {
        this.activeProcess = null;

        // Persist session ID for resume
        if (sessionId) {
          try {
            this.deps.orgs.update(this.orgId, {
              ceoConfig: JSON.stringify({ ...ceoConfig, lastSessionId: sessionId }),
            });
          } catch (err) {
            logger.error(`[ClaudeCodeCEO] Failed to persist session ID: ${err}`);
          }
        }

        if (code === 0) {
          logger.info(`[ClaudeCodeCEO] Completed (session: ${sessionId}, cost: $${costUsd.toFixed(4)})`);
          resolve({ output, sessionId, costUsd });
        } else {
          const errMsg = `Claude Code exited with code ${code}`;
          logger.error(`[ClaudeCodeCEO] ${errMsg}`);
          reject(new Error(errMsg));
        }
      });

      proc.on('error', (err) => {
        logger.error(`[ClaudeCodeCEO] Process error: ${err.message}`);
        reject(new Error(`Failed to spawn Claude Code: ${err.message}. Is 'claude' CLI installed and logged in?`));
      });
    });
  }

  private buildTriagePrompt(org: Organization, ticket: Ticket): string {
    const members = this.deps.orgChart.list(this.orgId);
    const agents = this.deps.listAgents();
    const allTickets = this.deps.tickets.list(this.orgId);
    const activeTickets = allTickets.filter(t => t.identifier !== ticket.identifier && t.status !== 'done' && t.status !== 'cancelled');

    const orgChartSummary = members.map(m =>
      `- ${m.agentName} (${m.role}${m.title ? `, ${m.title}` : ''})`
    ).join('\n') || 'No members assigned yet.';

    const availableAgents = agents.map(a =>
      `- ${a.name}${a.description ? `: ${a.description}` : ''}`
    ).join('\n') || 'No agents loaded.';

    const activeTicketsSummary = activeTickets.length > 0
      ? activeTickets.map(t => `- ${t.identifier}: ${t.title} [${t.status}] ${t.priority}${t.assigneeAgent ? ` → ${t.assigneeAgent}` : ''}`).join('\n')
      : 'No other active tickets.';

    return `You are the CEO of organization "${org.name}" (${org.issuePrefix}).
You communicate with Agent Orcha via REST APIs at $ORCHA_API_URL.

## Your Org Chart
${orgChartSummary}

## Available Agents in Workspace
${availableAgents}

## Active Tickets in Organization
${activeTicketsSummary}

## Ticket to Triage
**${ticket.identifier}**: ${ticket.title}
Priority: ${ticket.priority}
${ticket.description ? `\nDescription:\n${ticket.description}` : ''}

## Instructions
Analyze this ticket and take the best action using the Agent Orcha APIs:
1. Execute work yourself if you're the best fit
2. Delegate to an org member via the ticket execute API
3. Create a new agent via the file write API if needed

Use curl or fetch to call the APIs. The org-ceo-cc skill has the full API reference.`;
  }

  private buildReviewPrompt(org: Organization, ticket: Ticket, agentOutput: string): string {
    const truncated = agentOutput.length > 3000
      ? agentOutput.slice(0, 3000) + '\n\n... (truncated)'
      : agentOutput;

    return `You are the CEO of organization "${org.name}" (${org.issuePrefix}).
You communicate with Agent Orcha via REST APIs at $ORCHA_API_URL.

## Review Request
An agent completed work on ticket **${ticket.identifier}**: ${ticket.title}

## Agent Output
${truncated}

## Instructions
Review this work. Use the Agent Orcha APIs to:
- Add a comment with your review via POST /api/organizations/tickets/${ticket.id}/comments
- If approved, transition to done via POST /api/organizations/tickets/${ticket.id}/transition
- If changes needed, add feedback and re-execute via POST /api/organizations/tickets/${ticket.id}/execute`;
  }

  private parseCeoConfig(configStr: string): Record<string, string> {
    try {
      return JSON.parse(configStr || '{}');
    } catch {
      return {};
    }
  }
}
