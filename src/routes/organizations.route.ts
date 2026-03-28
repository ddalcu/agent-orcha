import type { FastifyPluginAsync } from 'fastify';
import { CreateOrgSchema, UpdateOrgSchema, CreateTicketSchema, UpdateTicketSchema, CreateRoutineSchema, UpdateRoutineSchema, CreateOrgMemberSchema, UpdateOrgMemberSchema } from '../../lib/organization/types.ts';

interface IdParams { id: string }
interface OrgIdParams { orgId: string }
interface TicketIdParams { id: string }
interface RoutineIdParams { id: string }
interface MemberIdParams { id: string }

export const organizationsRoutes: FastifyPluginAsync = async (fastify) => {
  const os = () => fastify.orchestrator.orgSystem;

  // ── Organizations ──

  fastify.get('/', async () => {
    return os().orgs.list();
  });

  fastify.get<{ Params: IdParams }>('/:id', async (request, reply) => {
    const org = os().orgs.get(request.params.id);
    if (!org) return reply.status(404).send({ error: 'Organization not found' });
    return org;
  });

  fastify.post<{ Body: unknown }>('/', async (request, reply) => {
    try {
      const data = CreateOrgSchema.parse(request.body);
      const org = os().orgs.create(data);
      return reply.status(201).send(org);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.patch<{ Params: IdParams; Body: unknown }>('/:id', async (request, reply) => {
    try {
      const data = UpdateOrgSchema.parse(request.body);
      return os().orgs.update(request.params.id, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.delete<{ Params: IdParams }>('/:id', async (request, reply) => {
    try {
      os().orgs.delete(request.params.id);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  // ── Tickets ──

  fastify.get<{ Params: OrgIdParams; Querystring: { status?: string; priority?: string; assignee?: string } }>(
    '/:orgId/tickets', async (request) => {
      const { status, priority, assignee } = request.query;
      return os().tickets.list(request.params.orgId, {
        status, priority, assigneeAgent: assignee,
      });
    },
  );

  fastify.post<{ Params: OrgIdParams; Body: unknown }>(
    '/:orgId/tickets', async (request, reply) => {
      try {
        const data = CreateTicketSchema.parse(request.body);
        const ticket = os().tickets.create(request.params.orgId, data);
        return reply.status(201).send(ticket);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.get<{ Params: TicketIdParams }>('/tickets/:id', async (request, reply) => {
    const ticket = os().tickets.get(request.params.id);
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });
    const activity = os().tickets.getActivity(request.params.id);
    return { ...ticket, activity };
  });

  fastify.patch<{ Params: TicketIdParams; Body: unknown }>('/tickets/:id', async (request, reply) => {
    try {
      const data = UpdateTicketSchema.parse(request.body);
      return os().tickets.update(request.params.id, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.post<{ Params: TicketIdParams; Body: { status: string } }>(
    '/tickets/:id/transition', async (request, reply) => {
      try {
        return os().tickets.transition(request.params.id, request.body.status);
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
        const activity = os().tickets.addComment(
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
        const ticket = os().tickets.get(request.params.id);
        if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });

        const agentName = request.body.agentName || ticket.assigneeAgent;
        if (!agentName) return reply.status(400).send({ error: 'No agent assigned to ticket' });

        const org = os().orgs.get(ticket.orgId);
        if (!org) return reply.status(400).send({ error: 'Organization not found' });

        const members = os().orgChart.list(ticket.orgId);
        const allTickets = os().tickets.list(ticket.orgId);

        const orgContext = {
          organization: {
            id: org.id,
            name: org.name,
            description: org.description,
            prefix: org.issuePrefix,
          },
          ticket: {
            identifier: ticket.identifier,
            title: ticket.title,
            priority: ticket.priority,
            description: ticket.description,
          },
          orgChart: members.map(m => ({ agentName: m.agentName, role: m.role, title: m.title })),
          activeTickets: allTickets
            .filter(t => t.id !== ticket.id && t.status !== 'done' && t.status !== 'cancelled')
            .map(t => ({ identifier: t.identifier, title: t.title, status: t.status, priority: t.priority, assigneeAgent: t.assigneeAgent })),
        };

        // Build full ticket context with activity history for the agent
        const activityHistory = os().tickets.getActivity(ticket.id);
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

        const task = fastify.orchestrator.tasks.getManager().submitAgent({
          agent: agentName,
          input: { query },
          orgContext,
          onComplete: (result) => {
            const output = typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output, null, 2);

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

            const summary = output.length > 4000 ? output.slice(0, 4000) + '\n\n... (truncated)' : output;
            const metadata = attachments.length > 0 ? { attachments } : undefined;
            os().tickets.addComment(ticketId, summary, 'agent', agentName, metadata);
            os().tickets.addTaskEvent(ticketId, `Agent "${agentName}" completed execution`);
          },
          onError: (error) => {
            os().tickets.addComment(ticketId, `Execution failed: ${error}`, 'agent', agentName);
            os().tickets.addTaskEvent(ticketId, `Agent "${agentName}" execution failed`);
          },
        });

        os().tickets.linkTask(ticket.id, task.id);
        if (ticket.status === 'backlog' || ticket.status === 'todo') {
          os().tickets.transition(ticket.id, 'in_progress');
        }
        os().tickets.addTaskEvent(ticket.id, `Agent "${agentName}" started execution (task: ${task.id})`);

        return reply.status(202).send({ taskId: task.id, ticket: os().tickets.get(ticket.id) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  // ── Routines ──

  fastify.get<{ Params: OrgIdParams }>(
    '/:orgId/routines', async (request) => {
      return os().routines.list(request.params.orgId);
    },
  );

  fastify.post<{ Params: OrgIdParams; Body: unknown }>(
    '/:orgId/routines', async (request, reply) => {
      try {
        const data = CreateRoutineSchema.parse(request.body);
        const routine = os().routines.create(request.params.orgId, data);
        return reply.status(201).send(routine);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.get<{ Params: RoutineIdParams }>('/routines/:id', async (request, reply) => {
    const routine = os().routines.get(request.params.id);
    if (!routine) return reply.status(404).send({ error: 'Routine not found' });
    const runs = os().routines.getRuns(request.params.id, 20);
    return { ...routine, runs };
  });

  fastify.patch<{ Params: RoutineIdParams; Body: unknown }>('/routines/:id', async (request, reply) => {
    try {
      const data = UpdateRoutineSchema.parse(request.body);
      return os().routines.update(request.params.id, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.delete<{ Params: RoutineIdParams }>('/routines/:id', async (request, reply) => {
    try {
      os().routines.delete(request.params.id);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.post<{ Params: RoutineIdParams }>('/routines/:id/pause', async (request, reply) => {
    try {
      return os().routines.pause(request.params.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.post<{ Params: RoutineIdParams }>('/routines/:id/resume', async (request, reply) => {
    try {
      return os().routines.resume(request.params.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.post<{ Params: RoutineIdParams }>('/routines/:id/trigger', async (request, reply) => {
    try {
      const run = await os().routines.trigger(request.params.id);
      return reply.status(202).send(run);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.get<{ Params: RoutineIdParams; Querystring: { limit?: string } }>(
    '/routines/:id/runs', async (request, reply) => {
      const routine = os().routines.get(request.params.id);
      if (!routine) return reply.status(404).send({ error: 'Routine not found' });
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
      return os().routines.getRuns(request.params.id, limit);
    },
  );

  // ── Org Chart Members ──

  fastify.get<{ Params: OrgIdParams }>(
    '/:orgId/members', async (request) => {
      return os().orgChart.list(request.params.orgId);
    },
  );

  fastify.get<{ Params: OrgIdParams }>(
    '/:orgId/members/tree', async (request) => {
      return os().orgChart.getTree(request.params.orgId);
    },
  );

  fastify.post<{ Params: OrgIdParams; Body: unknown }>(
    '/:orgId/members', async (request, reply) => {
      try {
        const data = CreateOrgMemberSchema.parse(request.body);
        const member = os().orgChart.create(request.params.orgId, data);
        return reply.status(201).send(member);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.get<{ Params: MemberIdParams }>('/members/:id', async (request, reply) => {
    const member = os().orgChart.get(request.params.id);
    if (!member) return reply.status(404).send({ error: 'Org member not found' });
    return member;
  });

  fastify.patch<{ Params: MemberIdParams; Body: unknown }>('/members/:id', async (request, reply) => {
    try {
      const data = UpdateOrgMemberSchema.parse(request.body);
      return os().orgChart.update(request.params.id, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.delete<{ Params: MemberIdParams }>('/members/:id', async (request, reply) => {
    try {
      os().orgChart.delete(request.params.id);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  // ── CEO ──

  fastify.post<{ Params: IdParams; Body: { ceoType: string; ceoConfig?: string } }>(
    '/:id/ceo/configure', async (request, reply) => {
      try {
        const { ceoType, ceoConfig } = request.body;
        const orgId = request.params.id;

        // Remove old CEO from org chart if it was an agent
        const oldOrg = os().orgs.get(orgId);
        if (oldOrg?.ceoType === 'agent') {
          const oldCeo = os().orgChart.getCEO(orgId);
          if (oldCeo) os().orgChart.delete(oldCeo.id);
        }

        const org = os().orgs.update(orgId, {
          ceoType: ceoType as '' | 'agent' | 'claude-code',
          ceoConfig: ceoConfig || '{}',
        });

        // Auto-add agent CEO to org chart
        if (ceoType === 'agent') {
          const config = JSON.parse(ceoConfig || '{}');
          if (config.agentName) {
            // Check if already in org chart
            const members = os().orgChart.list(orgId);
            const existing = members.find(m => m.agentName === config.agentName);
            if (existing) {
              // Promote to CEO
              os().orgChart.update(existing.id, { role: 'ceo', reportsTo: null });
            } else {
              // Add as CEO
              os().orgChart.create(orgId, {
                agentName: config.agentName,
                title: 'CEO',
                role: 'ceo',
                reportsTo: null,
                position: 0,
              });
            }
          }
        }

        // Invalidate cached CEO instance
        os().ceo.invalidate(orgId);
        return org;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.get<{ Params: IdParams }>(
    '/:id/ceo/status', async (request) => {
      return os().ceo.getCEOStatus(request.params.id);
    },
  );

  fastify.post<{ Params: TicketIdParams }>(
    '/tickets/:id/submit-to-ceo', async (request, reply) => {
      try {
        const ticket = os().tickets.get(request.params.id);
        if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });

        const result = await os().ceo.handleTicket(ticket.orgId, ticket.id);
        return reply.status(202).send(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.post<{ Params: TicketIdParams; Body: { output?: string } }>(
    '/tickets/:id/ceo-review', async (request, reply) => {
      try {
        const ticket = os().tickets.get(request.params.id);
        if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });

        const output = request.body.output || '';
        const result = await os().ceo.reviewTicket(ticket.orgId, ticket.id, output);
        return reply.status(202).send(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  // ── Dashboard ──

  fastify.get<{ Params: IdParams }>('/:id/dashboard', async (request, reply) => {
    try {
      return os().dashboard.getOrgDashboard(request.params.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  // ── CEO Runs ──

  fastify.get<{ Params: IdParams; Querystring: { limit?: string } }>(
    '/:id/ceo/runs', async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 20;
      return os().ceoRuns.listRuns(request.params.id, limit);
    },
  );

  // ── Heartbeat ──

  fastify.post<{ Params: IdParams }>(
    '/:id/ceo/force-stop', async (request, reply) => {
      try {
        const result = os().heartbeat.forceStop(request.params.id);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.post<{ Params: IdParams }>(
    '/:id/ceo/heartbeat/trigger', async (request, reply) => {
      try {
        // Validate org exists and has CEO before launching
        const org = os().orgs.get(request.params.id);
        if (!org) return reply.status(404).send({ error: 'Organization not found' });
        if (!org.ceoType) return reply.status(400).send({ error: 'No CEO configured for this organization' });

        // Fire-and-forget — don't await the full heartbeat execution
        os().heartbeat.triggerHeartbeat(request.params.id, 'manual').catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          fastify.log.error(`[CEO Heartbeat] Manual trigger failed for org ${request.params.id}: ${msg}`);
        });

        return reply.status(202).send({ ok: true, message: 'CEO heartbeat triggered' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  fastify.get<{ Params: IdParams }>(
    '/:id/ceo/heartbeat/config', async (request) => {
      return os().heartbeat.getConfig(request.params.id) || { orgId: request.params.id, enabled: 0, schedule: '*/30 * * * *', timezone: 'UTC', contextSnapshot: '', updatedAt: '' };
    },
  );

  fastify.post<{ Params: IdParams; Body: { enabled: boolean; schedule: string; timezone?: string } }>(
    '/:id/ceo/heartbeat/configure', async (request, reply) => {
      try {
        const config = os().heartbeat.configureHeartbeat(request.params.id, request.body);
        return config;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );
};
