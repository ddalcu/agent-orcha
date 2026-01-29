import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { EntityTypeConfig, RelationshipTypeConfig, ExtractedEntity, ExtractedRelationship, ExtractionResult } from './types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('EntityExtractor');

interface EntityExtractorOptions {
  llm: BaseChatModel;
  entityTypes?: EntityTypeConfig[];
  relationshipTypes?: RelationshipTypeConfig[];
}

/**
 * LLM-based entity and relationship extraction from text chunks.
 */
export class EntityExtractor {
  private llm: BaseChatModel;
  private entityTypes?: EntityTypeConfig[];
  private relationshipTypes?: RelationshipTypeConfig[];

  constructor(options: EntityExtractorOptions) {
    this.llm = options.llm;
    this.entityTypes = options.entityTypes;
    this.relationshipTypes = options.relationshipTypes;
  }

  /**
   * Extract entities and relationships from a set of text chunks.
   * Processes chunks sequentially to avoid rate limiting.
   */
  async extractFromChunks(chunks: Array<{ id: string; content: string }>): Promise<ExtractionResult> {
    const allEntities: ExtractedEntity[] = [];
    const allRelationships: ExtractedRelationship[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      logger.info(`Extracting from chunk ${i + 1}/${chunks.length} (${chunk.content.length} chars)`);

      try {
        const result = await this.extractFromSingleChunk(chunk.id, chunk.content);
        allEntities.push(...result.entities);
        allRelationships.push(...result.relationships);
      } catch (error) {
        logger.error(`Failed to extract from chunk ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    logger.info(`Raw extraction: ${allEntities.length} entities, ${allRelationships.length} relationships`);

    // Deduplicate entities by normalized name + type
    const deduplicated = this.deduplicateEntities(allEntities, allRelationships);
    logger.info(`After dedup: ${deduplicated.entities.length} entities, ${deduplicated.relationships.length} relationships`);

    return deduplicated;
  }

  private async extractFromSingleChunk(chunkId: string, content: string): Promise<ExtractionResult> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(content);

    const response = await this.llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const responseText = typeof response.content === 'string'
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map((c) => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
        : '';

    return this.parseExtractionResponse(responseText, chunkId);
  }

  private buildSystemPrompt(): string {
    const entityTypesSection = this.entityTypes && this.entityTypes.length > 0
      ? `\n\nEntity types to extract:\n${this.entityTypes.map((t) => `- ${t.name}: ${t.description}`).join('\n')}`
      : '\n\nExtract all notable entities (people, organizations, concepts, locations, events, objects, etc.).';

    const relationshipTypesSection = this.relationshipTypes && this.relationshipTypes.length > 0
      ? `\n\nRelationship types to extract:\n${this.relationshipTypes.map((t) => `- ${t.name}: ${t.description}`).join('\n')}`
      : '\n\nExtract all meaningful relationships between entities.';

    return `You are an entity and relationship extraction system. Given a text document, extract structured entities and relationships.
${entityTypesSection}
${relationshipTypesSection}

Respond ONLY with valid JSON in this exact format:
{
  "entities": [
    {
      "name": "Entity Name",
      "type": "EntityType",
      "description": "Brief description of this entity based on the text"
    }
  ],
  "relationships": [
    {
      "sourceName": "Source Entity Name",
      "sourceType": "SourceEntityType",
      "targetName": "Target Entity Name",
      "targetType": "TargetEntityType",
      "type": "RELATIONSHIP_TYPE",
      "description": "Brief description of this relationship",
      "weight": 1.0
    }
  ]
}

Rules:
- Entity names should be normalized (proper case, no extra whitespace)
- Use consistent naming for the same entity across extractions
- Relationship weight should be 0.0 to 1.0 (1.0 = very strong relationship)
- Every entity in a relationship must also appear in the entities array
- Be thorough but precise - extract real entities, not generic concepts`;
  }

  private buildUserPrompt(content: string): string {
    return `Extract entities and relationships from the following text:\n\n---\n${content}\n---`;
  }

  private parseExtractionResponse(responseText: string, chunkId: string): ExtractionResult {
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, responseText];
      const jsonStr = (jsonMatch[1] ?? responseText).trim();
      const parsed = JSON.parse(jsonStr);

      const entities: ExtractedEntity[] = (parsed.entities ?? []).map((e: any) => ({
        name: String(e.name ?? '').trim(),
        type: String(e.type ?? 'Unknown').trim(),
        description: String(e.description ?? '').trim(),
        properties: { sourceChunkId: chunkId },
      })).filter((e: ExtractedEntity) => e.name.length > 0);

      const relationships: ExtractedRelationship[] = (parsed.relationships ?? []).map((r: any) => ({
        sourceName: String(r.sourceName ?? '').trim(),
        sourceType: String(r.sourceType ?? 'Unknown').trim(),
        targetName: String(r.targetName ?? '').trim(),
        targetType: String(r.targetType ?? 'Unknown').trim(),
        type: String(r.type ?? 'RELATES_TO').trim(),
        description: String(r.description ?? '').trim(),
        weight: typeof r.weight === 'number' ? Math.max(0, Math.min(1, r.weight)) : 1.0,
      })).filter((r: ExtractedRelationship) => r.sourceName.length > 0 && r.targetName.length > 0);

      return { entities, relationships };
    } catch (error) {
      logger.warn(`Failed to parse extraction response for chunk ${chunkId}: ${error instanceof Error ? error.message : String(error)}`);
      logger.debug(`Response was: ${responseText.substring(0, 200)}...`);
      return { entities: [], relationships: [] };
    }
  }

  /**
   * Deduplicate entities by normalized key (lowercase name + type).
   * Merges descriptions and source chunk IDs.
   * Updates relationship references to use canonical entity names.
   */
  private deduplicateEntities(
    entities: ExtractedEntity[],
    relationships: ExtractedRelationship[]
  ): ExtractionResult {
    const entityMap = new Map<string, ExtractedEntity>();
    const nameNormMap = new Map<string, string>(); // normalizedKey -> canonical name

    for (const entity of entities) {
      const key = `${entity.name.toLowerCase()}::${entity.type.toLowerCase()}`;
      const existing = entityMap.get(key);

      if (existing) {
        // Merge: keep longer description, merge source chunks
        if (entity.description.length > existing.description.length) {
          existing.description = entity.description;
        }
        const existingChunks = existing.properties.sourceChunkIds as string[] ?? [];
        const newChunkId = entity.properties.sourceChunkId as string;
        if (newChunkId && !existingChunks.includes(newChunkId)) {
          existingChunks.push(newChunkId);
        }
        existing.properties.sourceChunkIds = existingChunks;
      } else {
        const chunkId = entity.properties.sourceChunkId as string;
        entityMap.set(key, {
          ...entity,
          properties: {
            sourceChunkIds: chunkId ? [chunkId] : [],
          },
        });
        nameNormMap.set(key, entity.name);
      }
    }

    // Deduplicate relationships
    const relMap = new Map<string, ExtractedRelationship>();
    for (const rel of relationships) {
      const sourceKey = `${rel.sourceName.toLowerCase()}::${rel.sourceType.toLowerCase()}`;
      const targetKey = `${rel.targetName.toLowerCase()}::${rel.targetType.toLowerCase()}`;

      // Update names to canonical versions
      const canonicalSource = nameNormMap.get(sourceKey) ?? rel.sourceName;
      const canonicalTarget = nameNormMap.get(targetKey) ?? rel.targetName;

      const relKey = `${sourceKey}->${rel.type.toLowerCase()}->${targetKey}`;
      const existing = relMap.get(relKey);

      if (existing) {
        // Merge: average weights, keep longer description
        existing.weight = (existing.weight + rel.weight) / 2;
        if (rel.description.length > existing.description.length) {
          existing.description = rel.description;
        }
      } else {
        relMap.set(relKey, {
          ...rel,
          sourceName: canonicalSource,
          targetName: canonicalTarget,
        });
      }
    }

    return {
      entities: Array.from(entityMap.values()),
      relationships: Array.from(relMap.values()),
    };
  }
}
