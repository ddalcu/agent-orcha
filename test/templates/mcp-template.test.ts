import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { MCPConfigSchema } from '../../lib/mcp/types.ts';
import { substituteEnvVars } from '../../lib/utils/env-substitution.ts';

const templatePath = path.resolve(import.meta.dirname, '../../templates/mcp.json');

describe('templates/mcp.json', () => {
  const saved = { EXA_API_KEY: process.env.EXA_API_KEY };

  beforeEach(() => {
    delete process.env.EXA_API_KEY;
  });

  afterEach(() => {
    if (saved.EXA_API_KEY === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = saved.EXA_API_KEY;
  });

  it('parses against MCPConfigSchema', () => {
    const raw = fs.readFileSync(templatePath, 'utf-8');
    const parsed = JSON.parse(substituteEnvVars(raw));
    const result = MCPConfigSchema.safeParse(parsed);
    assert.ok(result.success, `Schema validation failed: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  });

  it('registers the exa server with the hosted MCP URL and tracking header', () => {
    const raw = fs.readFileSync(templatePath, 'utf-8');
    const parsed = JSON.parse(substituteEnvVars(raw));
    const cfg = MCPConfigSchema.parse(parsed);
    const exa = cfg.servers.exa;

    assert.ok(exa, 'exa server should be present in the template');
    assert.equal(exa.transport, 'streamable-http');
    assert.equal(exa.url, 'https://mcp.exa.ai/mcp');
    assert.equal(exa.headers?.['x-exa-integration'], 'agent-orcha');
    assert.ok('x-api-key' in (exa.headers ?? {}), 'x-api-key header must be declared');
  });

  it('leaves x-api-key empty when EXA_API_KEY is unset (server still parses, connection will fail gracefully)', () => {
    const raw = fs.readFileSync(templatePath, 'utf-8');
    const parsed = JSON.parse(substituteEnvVars(raw));
    const cfg = MCPConfigSchema.parse(parsed);
    assert.equal(cfg.servers.exa?.headers?.['x-api-key'], '');
  });

  it('substitutes EXA_API_KEY into x-api-key when set', () => {
    process.env.EXA_API_KEY = 'test-key-123';
    const raw = fs.readFileSync(templatePath, 'utf-8');
    const parsed = JSON.parse(substituteEnvVars(raw));
    const cfg = MCPConfigSchema.parse(parsed);
    assert.equal(cfg.servers.exa?.headers?.['x-api-key'], 'test-key-123');
  });
});
