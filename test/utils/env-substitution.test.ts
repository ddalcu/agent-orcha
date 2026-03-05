import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { substituteEnvVars } from '../../lib/utils/env-substitution.ts';

describe('substituteEnvVars', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.TEST_VAR = process.env.TEST_VAR;
    saved.TEST_URL = process.env.TEST_URL;
    saved.TEST_EMPTY = process.env.TEST_EMPTY;
    process.env.TEST_VAR = 'hello';
    process.env.TEST_URL = 'https://api.example.com';
    process.env.TEST_EMPTY = '';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('replaces a single env var', () => {
    assert.equal(substituteEnvVars('key: ${TEST_VAR}'), 'key: hello');
  });

  it('replaces multiple env vars', () => {
    assert.equal(
      substituteEnvVars('${TEST_URL}/path?key=${TEST_VAR}'),
      'https://api.example.com/path?key=hello',
    );
  });

  it('leaves unset vars unchanged', () => {
    assert.equal(substituteEnvVars('key: ${DOES_NOT_EXIST_XYZ}'), 'key: ${DOES_NOT_EXIST_XYZ}');
  });

  it('uses default value when var is unset', () => {
    assert.equal(substituteEnvVars('key: ${MISSING_XYZ:-fallback}'), 'key: fallback');
  });

  it('prefers env value over default', () => {
    assert.equal(substituteEnvVars('key: ${TEST_VAR:-fallback}'), 'key: hello');
  });

  it('handles empty env var (not unset)', () => {
    assert.equal(substituteEnvVars('key: ${TEST_EMPTY}'), 'key: ');
  });

  it('handles empty default value', () => {
    assert.equal(substituteEnvVars('key: ${MISSING_XYZ:-}'), 'key: ');
  });

  it('does not touch strings without placeholders', () => {
    const input = 'name: my-agent\nllm: default';
    assert.equal(substituteEnvVars(input), input);
  });

  it('works with multiline YAML', () => {
    const yaml = 'name: my-agent\napiKey: ${TEST_VAR}\nurl: ${TEST_URL}';
    assert.equal(substituteEnvVars(yaml), 'name: my-agent\napiKey: hello\nurl: https://api.example.com');
  });

  it('works with JSON', () => {
    const json = '{"apiKey": "${TEST_VAR}", "model": "gpt-4"}';
    assert.equal(substituteEnvVars(json), '{"apiKey": "hello", "model": "gpt-4"}');
  });

  it('ignores $VAR without braces', () => {
    assert.equal(substituteEnvVars('key: $TEST_VAR'), 'key: $TEST_VAR');
  });
});
