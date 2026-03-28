import type { FastifyPluginAsync } from 'fastify';
import { CreateCompanySchema, UpdateCompanySchema, CreateTicketSchema, UpdateTicketSchema, CreateRoutineSchema, UpdateRoutineSchema } from '../../lib/company/types.ts';

interface IdParams { id: string }
interface CompanyIdParams { companyId: string }
interface TicketIdParams { id: string }
interface RoutineIdParams { id: string }

export const companiesRoutes: FastifyPluginAsync = async (fastify) => {
  const cs = () => fastify.orchestrator.companySystem;

  // ── Companies ──

  fastify.get('/', async () => {
    return cs().companies.list();
  });

  fastify.get<{ Params: IdParams }>('/:id', async (request, reply) => {
    const company = cs().companies.get(request.params.id);
    if (!company) return reply.status(404).send({ error: 'Company not found' });
    return company;
  });

  fastify.post<{ Body: unknown }>('/', async (request, reply) => {
    try {
      const data = CreateCompanySchema.parse(request.body);
      const company = cs().companies.create(data);
      return reply.status(201).send(company);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.patch<{ Params: IdParams; Body: unknown }>('/:id', async (request, reply) => {
    try {
      const data = UpdateCompanySchema.parse(request.body);
      return cs().companies.update(request.params.id, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.delete<{ Params: IdParams }>('/:id', async (request, reply) => {
    try {
      cs().companies.delete(request.params.id);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  // ── Tickets ──

  fastify.get<{ Params: CompanyIdParams; Querystring: { status?: string; priority?: string; assignee?: string } }>(
    '/:companyId/tickets', async (request) => {
      const { status, priority, assignee } = request.query;
      return cs().tickets.list(request.params.companyId, {
        status, priority, assigneeAgent: assignee,
      });
    },
  );

  fastify.post<{ Params: CompanyIdParams; Body: unknown }>(
    '/:companyId/tickets', async (request, reply) => {
      try {
        const data = CreateTicketSchema.parse(request.body);
        const ticket = cs().tickets.create(request.params.companyId, data);
        return reply.status(201).send(ticket);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.get<{ Params: TicketIdParams }>('/tickets/:id', async (request, reply) => {
    const ticket = cs().tickets.get(request.params.id);
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });
    const activity = cs().tickets.getActivity(request.params.id);
    return { ...ticket, activity };
  });

  fastify.patch<{ Params: TicketIdParams; Body: unknown }>('/tickets/:id', async (request, reply) => {
    try {
      const data = UpdateTicketSchema.parse(request.body);
      return cs().tickets.update(request.params.id, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.post<{ Params: TicketIdParams; Body: { status: string } }>(
    '/tickets/:id/transition', async (request, reply) => {
      try {
        return cs().tickets.transition(request.params.id, request.body.status);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.post<{ Params: TicketIdParams; Body: { content: string; authorType?: string; authorName?: string } }>(
    '/tickets/:id/comments', async (request, reply) => {
      try {
        const { content, authorType, authorName } = request.body;
        const activity = cs().tickets.addComment(
          request.params.id, content, authorType || 'user', authorName || 'User',
        );
        return reply.status(201).send(activity);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.post<{ Params: TicketIdParams; Body: { agentName?: string; input?: string } }>(
    '/tickets/:id/execute', async (request, reply) => {
      try {
        const ticket = cs().tickets.get(request.params.id);
        if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });

        const agentName = request.body.agentName || ticket.assigneeAgent;
        if (!agentName) return reply.status(400).send({ error: 'No agent assigned to ticket' });

        // Get company for context
        const company = cs().companies.get(ticket.companyId);
        if (!company) return reply.status(400).send({ error: 'Company not found' });

        const companyContext = {
          company: {
            id: company.id,
            name: company.name,
            description: company.description,
            prefix: company.issuePrefix,
          },
          ticket: {
            identifier: ticket.identifier,
            title: ticket.title,
            priority: ticket.priority,
            description: ticket.description,
          },
        };

        // Build full ticket context with activity history for the agent
        const activityHistory = cs().tickets.getActivity(ticket.id);
        const historyLines = activityHistory
          .filter(a => a.type === 'comment')
          .map(a => `[${a.authorType === 'agent' ? `Agent: ${a.authorName}` : a.authorName}] ${a.content}`)
          .join('\n\n---\n\n');

        let query = `${ticket.identifier}: ${ticket.title}\n\n${ticket.description}`;
        if (historyLines) {
          query += `\n\n--- Ticket Activity ---\n\n${historyLines}`;
        }
        if (request.body.input) {
          query += `\n\n--- Latest Request ---\n\n${request.body.input}`;
        }

        const ticketId = ticket.id;

        // Submit task with company context and completion callbacks
        const task = fastify.orchestrator.tasks.getManager().submitAgent({
          agent: agentName,
          input: { query },
          sessionId: ticket.taskId ? undefined : undefined,
          companyContext,
          onComplete: (result) => {
            const output = typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output, null, 2);

            // Extract generated file attachments from the output
            const attachments: { url: string; type: string; name: string }[] = [];
            const filePattern = /\/generated\/[^\s)"'\]]+/g;
            let match: RegExpExecArray | null;
            while ((match = filePattern.exec(output)) !== null) {
              const url = match[0];
              const name = url.split('/').pop() || url;
              const ext = name.split('.').pop()?.toLowerCase() || '';
              let type = 'file';
              if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) type = 'image';
              else if (['mp3', 'wav', 'ogg', 'flac', 'opus'].includes(ext)) type = 'audio';
              else if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) type = 'video';
              attachments.push({ url, type, name });
            }

            // Truncate very long outputs for the activity feed
            const summary = output.length > 4000 ? output.slice(0, 4000) + '\n\n... (truncated)' : output;
            const metadata = attachments.length > 0 ? { attachments } : undefined;
            cs().tickets.addComment(ticketId, summary, 'agent', agentName, metadata);
            cs().tickets.addTaskEvent(ticketId, `Agent "${agentName}" completed execution`);
          },
          onError: (error) => {
            cs().tickets.addComment(ticketId, `Execution failed: ${error}`, 'agent', agentName);
            cs().tickets.addTaskEvent(ticketId, `Agent "${agentName}" execution failed`);
          },
        });

        // Link task to ticket and transition
        cs().tickets.linkTask(ticket.id, task.id);
        if (ticket.status === 'backlog' || ticket.status === 'todo') {
          cs().tickets.transition(ticket.id, 'in_progress');
        }
        cs().tickets.addTaskEvent(ticket.id, `Agent "${agentName}" started execution (task: ${task.id})`);

        return reply.status(202).send({ taskId: task.id, ticket: cs().tickets.get(ticket.id) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  // ── Routines ──

  fastify.get<{ Params: CompanyIdParams }>(
    '/:companyId/routines', async (request) => {
      return cs().routines.list(request.params.companyId);
    },
  );

  fastify.post<{ Params: CompanyIdParams; Body: unknown }>(
    '/:companyId/routines', async (request, reply) => {
      try {
        const data = CreateRoutineSchema.parse(request.body);
        const routine = cs().routines.create(request.params.companyId, data);
        return reply.status(201).send(routine);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.get<{ Params: RoutineIdParams }>('/routines/:id', async (request, reply) => {
    const routine = cs().routines.get(request.params.id);
    if (!routine) return reply.status(404).send({ error: 'Routine not found' });
    const runs = cs().routines.getRuns(request.params.id, 20);
    return { ...routine, runs };
  });

  fastify.patch<{ Params: RoutineIdParams; Body: unknown }>('/routines/:id', async (request, reply) => {
    try {
      const data = UpdateRoutineSchema.parse(request.body);
      return cs().routines.update(request.params.id, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.delete<{ Params: RoutineIdParams }>('/routines/:id', async (request, reply) => {
    try {
      cs().routines.delete(request.params.id);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.post<{ Params: RoutineIdParams }>('/routines/:id/pause', async (request, reply) => {
    try {
      return cs().routines.pause(request.params.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.post<{ Params: RoutineIdParams }>('/routines/:id/resume', async (request, reply) => {
    try {
      return cs().routines.resume(request.params.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.post<{ Params: RoutineIdParams }>('/routines/:id/trigger', async (request, reply) => {
    try {
      const run = await cs().routines.trigger(request.params.id);
      return reply.status(202).send(run);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.get<{ Params: RoutineIdParams; Querystring: { limit?: string } }>(
    '/routines/:id/runs', async (request, reply) => {
      const routine = cs().routines.get(request.params.id);
      if (!routine) return reply.status(404).send({ error: 'Routine not found' });
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
      return cs().routines.getRuns(request.params.id, limit);
    },
  );
};
