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

  it('should extract property mappings with object syntax', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'alice@test.com', post_id: 10, title: 'Hello', content: 'World' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    // Post entity should have "body" property mapped from "content" column
    const post = result.entities.find(e => e.type === 'Post');
    assert.ok(post);
    assert.equal(post.properties.body, 'World');
  });

  it('should extract string properties directly', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'alice@test.com', post_id: 10, title: 'Hello', content: 'World' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    const user = result.entities.find(e => e.type === 'User');
    assert.ok(user);
    assert.equal(user.properties.email, 'alice@test.com');
  });

  it('should include sourceChunkIds in entity properties', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'a@t.com', post_id: 10, title: 'Hello', content: 'World' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    for (const entity of result.entities) {
      assert.ok(Array.isArray(entity.properties.sourceChunkIds));
      assert.deepEqual(entity.properties.sourceChunkIds, []);
    }
  });

  it('should set entity description with type name', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'a@t.com' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    assert.equal(result.entities[0]!.description, 'User entity from database');
  });

  it('should handle groupNode in relationships', () => {
    const groupConfig = {
      entities: [
        { type: 'Employee', idColumn: 'emp_id', nameColumn: 'emp_name', properties: [] },
        { type: 'Department', idColumn: 'dept_id', nameColumn: 'dept_name', properties: [] },
      ],
      relationships: [
        {
          type: 'WORKS_IN',
          source: 'Employee',
          target: 'Department',
          sourceIdColumn: 'emp_id',
          targetIdColumn: 'dept_id',
          groupNode: 'Staff',
        },
      ],
    };

    const docs = [
      { metadata: { _rawRow: { emp_id: 1, emp_name: 'Alice', dept_id: 100, dept_name: 'Engineering' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, groupConfig);

    // Should create: Employee, Department, and GroupNode entities
    assert.equal(result.entities.length, 3);
    const groupEntity = result.entities.find(e => e.type === 'GroupNode');
    assert.ok(groupEntity);
    assert.equal(groupEntity.name, 'Staff (Engineering)');
    assert.equal(groupEntity.properties.label, 'Staff');
    assert.equal(groupEntity.properties.parentName, 'Engineering');

    // Should create 2 relationships: GroupNode CHILD_OF Department + Employee WORKS_IN GroupNode
    assert.equal(result.relationships.length, 2);
    const childOf = result.relationships.find(r => r.type === 'CHILD_OF');
    assert.ok(childOf);
    assert.equal(childOf.sourceName, 'Staff (Engineering)');
    assert.equal(childOf.targetName, 'Engineering');

    const worksIn = result.relationships.find(r => r.type === 'WORKS_IN');
    assert.ok(worksIn);
    assert.equal(worksIn.sourceName, 'Alice');
    assert.equal(worksIn.targetName, 'Staff (Engineering)');
  });

  it('should deduplicate groupNode entities across rows', () => {
    const groupConfig = {
      entities: [
        { type: 'Employee', idColumn: 'emp_id', nameColumn: 'emp_name', properties: [] },
        { type: 'Department', idColumn: 'dept_id', nameColumn: 'dept_name', properties: [] },
      ],
      relationships: [
        {
          type: 'WORKS_IN',
          source: 'Employee',
          target: 'Department',
          sourceIdColumn: 'emp_id',
          targetIdColumn: 'dept_id',
          groupNode: 'Staff',
        },
      ],
    };

    const docs = [
      { metadata: { _rawRow: { emp_id: 1, emp_name: 'Alice', dept_id: 100, dept_name: 'Engineering' } } },
      { metadata: { _rawRow: { emp_id: 2, emp_name: 'Bob', dept_id: 100, dept_name: 'Engineering' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, groupConfig);

    // Should have: 2 employees + 1 department + 1 GroupNode = 4 entities
    assert.equal(result.entities.length, 4);
    const groupNodes = result.entities.filter(e => e.type === 'GroupNode');
    assert.equal(groupNodes.length, 1);

    // 1 CHILD_OF + 2 WORKS_IN = 3 relationships
    assert.equal(result.relationships.length, 3);
  });

  it('should skip relationship when sourceId is missing', () => {
    const docs = [
      { metadata: { _rawRow: { username: 'alice', email: 'a@t.com', post_id: 10, title: 'P1', content: 'B1' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    // No user entity (no user_id), so no relationships
    assert.equal(result.relationships.length, 0);
  });

  it('should skip relationship when targetId is missing', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'a@t.com', content: 'B1' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    // No post entity (no post_id), so no relationships
    assert.equal(result.relationships.length, 0);
  });

  it('should fall back to doc.metadata when _rawRow is absent', () => {
    const metaConfig = {
      entities: [
        { type: 'Item', idColumn: 'item_id', nameColumn: 'item_name', properties: [] },
      ],
    };

    const docs = [
      { metadata: { item_id: 5, item_name: 'Widget' } },
    ];

    const result = DirectMapper.mapQueryResults(docs, metaConfig);

    assert.equal(result.entities.length, 1);
    assert.equal(result.entities[0]!.name, 'Widget');
  });

  it('should fall back to doc itself when metadata is absent', () => {
    const metaConfig = {
      entities: [
        { type: 'Item', idColumn: 'item_id', nameColumn: 'item_name', properties: [] },
      ],
    };

    const docs = [
      { item_id: 5, item_name: 'DirectItem' },
    ];

    const result = DirectMapper.mapQueryResults(docs as any, metaConfig);

    assert.equal(result.entities.length, 1);
    assert.equal(result.entities[0]!.name, 'DirectItem');
  });

  it('should skip entity when nameColumn value is null', () => {
    const nameConfig = {
      entities: [
        { type: 'Item', idColumn: 'id', nameColumn: 'name', properties: [] },
      ],
    };

    const docs = [
      { metadata: { _rawRow: { id: 1, name: null } } },
    ];

    const result = DirectMapper.mapQueryResults(docs as any, nameConfig);

    assert.equal(result.entities.length, 0);
  });

  it('should handle empty documents array', () => {
    const result = DirectMapper.mapQueryResults([], config);

    assert.equal(result.entities.length, 0);
    assert.equal(result.relationships.length, 0);
  });

  it('should set relationship weight to 1.0', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'a@t.com', post_id: 10, title: 'P1', content: 'B1' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    assert.equal(result.relationships[0]!.weight, 1.0);
  });

  it('should set correct source and target types on relationships', () => {
    const docs = [
      { metadata: { _rawRow: { user_id: 1, username: 'alice', email: 'a@t.com', post_id: 10, title: 'P1', content: 'B1' } } },
    ];

    const result = DirectMapper.mapQueryResults(docs, config);

    assert.equal(result.relationships[0]!.sourceType, 'User');
    assert.equal(result.relationships[0]!.targetType, 'Post');
  });
});
