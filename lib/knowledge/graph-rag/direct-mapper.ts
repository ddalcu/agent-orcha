import type { ExtractedEntity, ExtractedRelationship, DirectMappingConfig } from './types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('DirectMapper');

/**
 * Direct SQL-to-graph mapping for structured data sources.
 * Maps query results directly to entities and relationships without LLM extraction.
 * Guarantees 100% data preservation - all rows contribute to the graph.
 */
export class DirectMapper {
  /**
   * Map SQL query results directly to entities and relationships.
   * Zero data loss - all rows contribute to the graph.
   *
   * @param documents - LangChain documents with SQL row data in metadata._rawRow
   * @param config - Direct mapping configuration specifying how to extract entities and relationships
   * @returns Extracted entities and relationships ready for graph building
   */
  static mapQueryResults(
    documents: any[],
    config: DirectMappingConfig
  ): { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] } {
    const entities: ExtractedEntity[] = [];
    const relationships: ExtractedRelationship[] = [];
    const entityCache = new Map<string, ExtractedEntity>();

    logger.info(`Mapping ${documents.length} documents to graph with ${config.entities.length} entity types`);

    for (const doc of documents) {
      // Extract raw SQL row from document metadata
      const row = doc.metadata?._rawRow || doc.metadata || doc;

      if (!row || typeof row !== 'object') {
        logger.warn(`Skipping document without valid row data`);
        continue;
      }
      // Extract entities from each row
      for (const entityMapping of config.entities) {
        const entityId = row[entityMapping.idColumn];
        if (!entityId) continue;

        const cacheKey = `${entityMapping.type}::${entityId}`;
        if (entityCache.has(cacheKey)) continue; // Deduplicate

        // Build entity name
        const name = entityMapping.nameColumn
          ? row[entityMapping.nameColumn]
          : `${entityMapping.type}-${entityId}`;

        // Extract properties
        const properties: Record<string, any> = {};
        for (const prop of entityMapping.properties) {
          if (typeof prop === 'string') {
            properties[prop] = row[prop];
          } else {
            // Handle property mapping: { outputName: inputColumn }
            const entries = Object.entries(prop);
            if (entries.length > 0) {
              const [outputName, inputColumn] = entries[0]!;
              properties[outputName] = row[inputColumn];
            }
          }
        }

        const entity: ExtractedEntity = {
          name,
          type: entityMapping.type,
          description: `${entityMapping.type} entity from database`,
          properties: {
            ...properties,
            sourceChunkIds: [], // Direct mapping doesn't use chunks
          },
        };

        entities.push(entity);
        entityCache.set(cacheKey, entity);
      }

      // Extract relationships if configured
      if (config.relationships) {
        for (const relMapping of config.relationships) {
          const sourceId = row[relMapping.sourceIdColumn];
          const targetId = row[relMapping.targetIdColumn];

          if (!sourceId || !targetId) continue;

          // Find source and target entities
          const sourceEntity = entityCache.get(`${relMapping.source}::${sourceId}`);
          const targetEntity = entityCache.get(`${relMapping.target}::${targetId}`);

          if (!sourceEntity || !targetEntity) {
            logger.debug(`Skipping relationship ${relMapping.type}: entity not found (${relMapping.source}::${sourceId} -> ${relMapping.target}::${targetId})`);
            continue;
          }

          relationships.push({
            sourceName: sourceEntity.name,
            sourceType: sourceEntity.type,
            targetName: targetEntity.name,
            targetType: targetEntity.type,
            type: relMapping.type,
            description: `${relMapping.source} ${relMapping.type} ${relMapping.target}`,
            weight: 1.0,
          });
        }
      }
    }

    logger.info(`Direct mapping complete: ${entities.length} entities, ${relationships.length} relationships`);

    return { entities, relationships };
  }
}
