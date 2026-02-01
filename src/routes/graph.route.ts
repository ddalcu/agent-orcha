import type { FastifyPluginAsync } from 'fastify';

interface QueryBody {
  query: string;
}

// Check if Neo4j is configured via environment variables
function isNeo4jConfigured(): boolean {
  return !!(process.env.NEO4J_URI && process.env.NEO4J_USERNAME && process.env.NEO4J_PASSWORD);
}

// Get Neo4j driver instance
async function getNeo4jDriver() {
  if (!isNeo4jConfigured()) {
    throw new Error('Neo4j not configured. Set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD environment variables.');
  }

  try {
    const neo4j = await import('neo4j-driver');
    const driver = neo4j.default.driver(
      process.env.NEO4J_URI!,
      neo4j.default.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!)
    );
    await driver.verifyConnectivity();
    return driver;
  } catch (error) {
    throw new Error(`Failed to connect to Neo4j: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Convert Neo4j records to neo4jd3 format
// neo4jd3 expects: { results: [{ data: [{ graph: { nodes: [], relationships: [] } }] }] }
function convertToNeo4jd3Format(records: any[]): any {
  const nodesMap = new Map<string, any>();
  const relationships: any[] = [];

  for (const record of records) {
    // Process all fields in the record
    for (const key of record.keys) {
      const value = record.get(key);

      if (!value) continue;

      // Check if it's a node (has identity and labels properties)
      const isNode = value.identity !== undefined && value.labels !== undefined;

      if (isNode) {
        // Convert Neo4j Integer to string for ID
        const nodeId = typeof value.identity === 'object' && value.identity.toInt
          ? value.identity.toInt().toString()
          : value.identity.toString();

        if (!nodesMap.has(nodeId)) {
          const props = value.properties || {};
          const labels = Array.isArray(value.labels) ? value.labels : [];

          nodesMap.set(nodeId, {
            id: nodeId,
            labels: labels,
            properties: props
          });
        }
      }

      // Check if it's a relationship (has type, start, and end properties)
      const isRelationship = value.type !== undefined && value.start !== undefined && value.end !== undefined;

      if (isRelationship) {
        // Convert Neo4j Integer to string for IDs
        const startId = typeof value.start === 'object' && value.start.toInt
          ? value.start.toInt().toString()
          : value.start.toString();
        const endId = typeof value.end === 'object' && value.end.toInt
          ? value.end.toInt().toString()
          : value.end.toString();
        const relId = value.identity
          ? (typeof value.identity === 'object' && value.identity.toInt
              ? value.identity.toInt().toString()
              : value.identity.toString())
          : `${startId}-${value.type}-${endId}`;

        const props = value.properties || {};

        relationships.push({
          id: relId,
          type: value.type,
          startNode: startId,
          endNode: endId,
          properties: props
        });
      }
    }
  }

  // Return in neo4jd3 expected format
  return {
    results: [
      {
        columns: [],
        data: [
          {
            graph: {
              nodes: Array.from(nodesMap.values()),
              relationships: relationships
            }
          }
        ]
      }
    ]
  };
}

export const graphRoutes: FastifyPluginAsync = async (fastify) => {
  // Get Neo4j configuration status
  fastify.get('/config', async () => {
    return {
      configured: isNeo4jConfigured(),
      uri: process.env.NEO4J_URI || null,
      username: process.env.NEO4J_USERNAME || null
    };
  });

  // Execute Cypher query and return results in neo4jd3 format
  fastify.post<{ Body: QueryBody }>('/query', async (request, reply) => {
    const { query } = request.body;

    if (!query) {
      return reply.status(400).send({ error: 'Query is required' });
    }

    let driver;
    try {
      driver = await getNeo4jDriver();
      const session = driver.session({ database: 'neo4j' });

      try {
        fastify.log.info(`Executing Neo4j query: ${query.substring(0, 100)}...`);
        const result = await session.run(query);
        fastify.log.info(`Query returned ${result.records.length} records`);

        const data = convertToNeo4jd3Format(result.records);
        const graph = data.results[0]?.data[0]?.graph;
        if (graph) {
          fastify.log.info(`Converted to ${graph.nodes.length} nodes, ${graph.relationships.length} relationships`);
        }

        return data;
      } catch (queryError) {
        fastify.log.error(`Query execution failed: ${queryError}`);
        throw queryError;
      } finally {
        await session.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fastify.log.error(`Graph query error: ${message}`);
      if (error instanceof Error && error.stack) {
        fastify.log.error(error.stack);
      }
      return reply.status(500).send({ error: message });
    } finally {
      if (driver) {
        await driver.close();
      }
    }
  });
};
