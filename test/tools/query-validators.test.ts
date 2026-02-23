import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { validateReadonlyCypher, validateReadonlySql } from '../../lib/tools/built-in/query-validators.ts';

describe('validateReadonlyCypher', () => {
  it('should accept valid read queries', () => {
    assert.deepEqual(validateReadonlyCypher('MATCH (n) RETURN n'), { valid: true });
    assert.deepEqual(validateReadonlyCypher('MATCH (n:Person) WHERE n.name = "Alice" RETURN n'), { valid: true });
    assert.deepEqual(validateReadonlyCypher('MATCH (n)-[r]->(m) RETURN n, r, m ORDER BY n.name'), { valid: true });
  });

  it('should reject CREATE statements', () => {
    const result = validateReadonlyCypher('CREATE (n:Person {name: "Bob"})');
    assert.equal(result.valid, false);
    assert.ok(result.reason!.includes('CREATE'));
  });

  it('should reject DELETE statements', () => {
    const result = validateReadonlyCypher('MATCH (n) DELETE n');
    assert.equal(result.valid, false);
    assert.ok(result.reason!.includes('DELETE'));
  });

  it('should reject MERGE statements', () => {
    const result = validateReadonlyCypher('MERGE (n:Person {name: "Bob"})');
    assert.equal(result.valid, false);
  });

  it('should reject SET statements', () => {
    const result = validateReadonlyCypher('MATCH (n) SET n.name = "Bob"');
    assert.equal(result.valid, false);
  });

  it('should reject empty queries', () => {
    const result = validateReadonlyCypher('');
    assert.equal(result.valid, false);
    assert.ok(result.reason!.includes('empty'));
  });

  it('should reject whitespace-only queries', () => {
    const result = validateReadonlyCypher('   ');
    assert.equal(result.valid, false);
  });

  it('should ignore write keywords inside strings', () => {
    const result = validateReadonlyCypher('MATCH (n) WHERE n.name = "CREATE something" RETURN n');
    assert.equal(result.valid, true);
  });

  it('should ignore write keywords in comments', () => {
    const result = validateReadonlyCypher('MATCH (n) RETURN n // CREATE something');
    assert.equal(result.valid, true);
  });
});

describe('validateReadonlySql', () => {
  it('should accept valid SELECT queries', () => {
    assert.deepEqual(validateReadonlySql('SELECT * FROM users'), { valid: true });
    assert.deepEqual(validateReadonlySql('SELECT id, name FROM users WHERE id = 1'), { valid: true });
    assert.deepEqual(validateReadonlySql('SELECT COUNT(*) FROM orders GROUP BY status'), { valid: true });
  });

  it('should reject INSERT statements', () => {
    const result = validateReadonlySql('INSERT INTO users (name) VALUES ("Bob")');
    assert.equal(result.valid, false);
    assert.ok(result.reason!.includes('INSERT'));
  });

  it('should reject UPDATE statements', () => {
    const result = validateReadonlySql('UPDATE users SET name = "Bob" WHERE id = 1');
    assert.equal(result.valid, false);
  });

  it('should reject DELETE statements', () => {
    const result = validateReadonlySql('DELETE FROM users WHERE id = 1');
    assert.equal(result.valid, false);
  });

  it('should reject DROP statements', () => {
    const result = validateReadonlySql('DROP TABLE users');
    assert.equal(result.valid, false);
  });

  it('should reject ALTER statements', () => {
    const result = validateReadonlySql('ALTER TABLE users ADD COLUMN age INT');
    assert.equal(result.valid, false);
  });

  it('should reject TRUNCATE statements', () => {
    const result = validateReadonlySql('TRUNCATE TABLE users');
    assert.equal(result.valid, false);
  });

  it('should reject empty queries', () => {
    const result = validateReadonlySql('');
    assert.equal(result.valid, false);
  });

  it('should ignore write keywords inside strings', () => {
    const result = validateReadonlySql("SELECT * FROM logs WHERE action = 'DELETE user'");
    assert.equal(result.valid, true);
  });

  it('should ignore write keywords in comments', () => {
    const result = validateReadonlySql('SELECT * FROM users -- DELETE this later');
    assert.equal(result.valid, true);
  });
});
