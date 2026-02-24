import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SkillLoader } from '../../lib/skills/skill-loader.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'skills');

describe('SkillLoader', () => {
  let loader: SkillLoader;

  before(async () => {
    loader = new SkillLoader(fixturesDir);
    await loader.loadAll();
  });

  it('should load all skills from fixture directory', () => {
    const names = loader.names();
    assert.ok(names.includes('test-skill'));
    assert.ok(names.includes('sandbox-skill'));
  });

  it('should get a skill by name', () => {
    const skill = loader.get('test-skill');
    assert.ok(skill);
    assert.equal(skill.name, 'test-skill');
    assert.equal(skill.description, 'A test skill for unit testing');
    assert.equal(skill.sandbox, false);
  });

  it('should detect sandbox flag', () => {
    const skill = loader.get('sandbox-skill');
    assert.ok(skill);
    assert.equal(skill.sandbox, true);
  });

  it('should return undefined for non-existent skill', () => {
    assert.equal(loader.get('nonexistent'), undefined);
  });

  it('should list all skills', () => {
    const skills = loader.list();
    assert.ok(skills.length >= 2);
  });

  it('should check skill existence', () => {
    assert.equal(loader.has('test-skill'), true);
    assert.equal(loader.has('nonexistent'), false);
  });

  it('should parse frontmatter from SKILL.md', () => {
    const skill = loader.get('test-skill');
    assert.ok(skill);
    assert.ok(skill.content.includes('Test Skill'));
    // Frontmatter should be stripped from content
    assert.ok(!skill.content.includes('---'));
  });

  it('should resolveForAgent with mode:all', () => {
    const content = loader.resolveForAgent({ mode: 'all' });
    assert.ok(content.includes('test-skill'));
    assert.ok(content.includes('sandbox-skill'));
  });

  it('should resolveForAgent with specific skills', () => {
    const content = loader.resolveForAgent(['test-skill']);
    assert.ok(content.includes('test-skill'));
    assert.ok(!content.includes('sandbox-skill'));
  });

  it('should resolveForAgentWithMeta and detect sandbox need', () => {
    const result = loader.resolveForAgentWithMeta(['sandbox-skill']);
    assert.equal(result.needsSandbox, true);

    const noSandbox = loader.resolveForAgentWithMeta(['test-skill']);
    assert.equal(noSandbox.needsSandbox, false);
  });

  it('should handle non-existent skill in resolveForAgent gracefully', () => {
    const content = loader.resolveForAgent(['nonexistent']);
    assert.equal(content, '');
  });
});
