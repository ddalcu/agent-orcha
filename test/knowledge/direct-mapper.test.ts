import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { DirectMapper } from '../../lib/knowledge/direct-mapper.ts';

describe('DirectMapper', () => {
  const config = {
    entities: [
      {
        type: 'User',
        idColumn: 'user_id',
        nameColumn: 'username',
        properties: ['email'],
      },
      {
        type: 'Post',
        idColumn: 'post_id',
        nameColumn: 'title',
        properties: [{ body: 'content' }],
      },
    ],
    relationships: [
      {
        type: 'AUTHORED',
        source: 'User',
        target: 'Post',
        sourceIdColumn: 'user_id',
        targetIdColumn: 'post_id',
      },
    ],
  };

  it('should extract entities from documents', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'alice@test.com', post_id: 10, title: 'Hello', content: 'World' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    assert.equal(result.entities.length, 2);
    assert.equal(result.entities[0]!.type, 'User');
    assert.equal(result.entities[0]!.name, 'alice');
    assert.equal(result.entities[1]!.type, 'Post');
    assert.equal(result.entities[1]!.name, 'Hello');
  });

  it('should extract relationships between entities', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'a@t.com', post_id: 10, title: 'Post1', content: 'Body' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    assert.equal(result.relationships.length, 1);
    assert.equal(result.relationships[0]!.type, 'AUTHORED');
    assert.equal(result.relationships[0]!.sourceName, 'alice');
    assert.equal(result.relationships[0]!.targetName, 'Post1');
  });

  it('should deduplicate entities across documents', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'a@t.com', post_id: 10, title: 'P1', content: 'B1' } } },
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'a@t.com', post_id: 20, title: 'P2', content: 'B2' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    const users = result.entities.filter(e => e.type === 'User');
    const posts = result.entities.filter(e => e.type === 'Post');
    assert.equal(users.length, 1);
    assert.equal(posts.length, 2);
  });

  it('should skip rows without required ID columns', () => {
    const docs = [
      { metadata: { _rawRow: { username: 'bob' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    assert.equal(result.entities.length, 0);
  });

  it('should skip invalid documents', () => {
    const docs = [
      { metadata: null },
      { metadata: { _rawRow: null } },
    ];

    const result = DirectMapper.mapQueryResults(docs as any, config);

    assert.equal(result.entities.length, 0);
  });

  it('should generate default name when nameColumn is missing', () => {
    const noNameConfig = {
      entities: [
        { type: 'Item', idColumn: 'id', properties: [] },
      ],
    };

    const docs = [
      { metadata: { _rawRow: { id: 42 } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, noNameConfig);

    assert.equal(result.entities.length, 1);
    assert.equal(result.entities[0]!.name, 'Item-42');
  });

  it('should skip relationships when entities are missing', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'a@t.com' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    assert.equal(result.relationships.length, 0);
  });

  it('should handle config without relationships', () => {
    const noRelConfig = {
      entities: [{ type: 'Tag', idColumn: 'tag_id', nameColumn: 'name', properties: [] }],
    };

    const docs = [
      { metadata: { _rawRow: { tag_id: 1, name: 'js' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, noRelConfig);

    assert.equal(result.entities.length, 1);
    assert.equal(result.relationships.length, 0);
  });
});
