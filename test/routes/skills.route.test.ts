import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { skillsRoutes } from '../../src/routes/skills.route.ts';

describe('skills.route', () => {
  let app: any;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET / should list skills', async () => {
    const result = await createTestApp(skillsRoutes, '/api/skills', {
      skills: {
        list: () => [
          { name: 'skill1', description: 'Skill 1' },
          { name: 'skill2', description: 'Skill 2' },
        ],
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/skills' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.length, 2);
  });

  it('GET /:name should return a skill', async () => {
    const result = await createTestApp(skillsRoutes, '/api/skills', {
      skills: {
        get: (name: string) => name === 'skill1'
          ? { name: 'skill1', description: 'Skill 1', content: '# Skill Content' }
          : undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/skills/skill1' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).name, 'skill1');
  });

  it('GET /:name should return 404 for missing', async () => {
    const result = await createTestApp(skillsRoutes, '/api/skills');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/skills/missing' });
    assert.equal(res.statusCode, 404);
  });
});
