import type { FastifyPluginAsync } from 'fastify';

interface SkillParams {
  name: string;
}

export const skillsRoutes: FastifyPluginAsync = async (fastify) => {
  // List all available skills
  fastify.get('/', async () => {
    const skills = fastify.orchestrator.skills.list();

    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));
  });

  // Get a specific skill
  fastify.get<{ Params: SkillParams }>('/:name', async (request, reply) => {
    const skill = fastify.orchestrator.skills.get(request.params.name);

    if (!skill) {
      return reply.status(404).send({ error: `Skill "${request.params.name}" not found` });
    }

    return {
      name: skill.name,
      description: skill.description,
      content: skill.content,
    };
  });
};
