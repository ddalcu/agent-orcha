# Agent Orcha — Project Guide

## Architecture Overview

Agent Orcha is a declarative multi-agent AI framework. Agents, workflows, knowledge stores, and functions are defined in YAML and loaded at startup by the `Orchestrator` class.

### Key Directories

- `lib/` — Core library (orchestrator, agents, workflows, knowledge, tools, LLM, MCP)
- `src/` — Server (Fastify routes, CLI)
- `public/` — Web UI (Studio) — vanilla JS web components
- `examples/` — Example YAML configs
- `templates/` — Project init templates
- `test/` — Test suites

### Knowledge Store Architecture

All knowledge stores use a **unified SQLite + sqlite-vec** persistence layer. There are no external vector database dependencies (no Chroma, Pinecone, etc.).

**Key files:**
- `lib/knowledge/types.ts` — Zod schemas and TypeScript types
- `lib/knowledge/knowledge-store.ts` — Main `KnowledgeStore` class (orchestrator)
- `lib/knowledge/sqlite-store.ts` — SQLite persistence (chunks, entities, relationships, vectors)
- `lib/knowledge/direct-mapper.ts` — Maps SQL rows to graph entities/relationships

**How it works:**
1. `.knowledge.yaml` files define source, loader, splitter, embedding, and optional `graph.directMapping`
2. Documents are loaded, split into chunks, embedded, and stored in SQLite
3. If `graph.directMapping` is present, entities and relationships are extracted from structured data (no LLM extraction)
4. On restart, source hashes are compared — unchanged stores restore instantly from SQLite
5. Search combines chunk KNN + entity KNN + neighborhood expansion, merged by score

**Graph extraction is direct mapping only** — there is no LLM-based entity extraction. The `EntityExtractor` class was removed. Graph entities come from `DirectMapper.mapQueryResults()` which maps SQL columns to entity types deterministically.

**Old fields stripped by migration** in `KnowledgeConfigSchema.preprocess`:
- `kind`, `store` (top-level)
- `graph.extractionMode`, `graph.extraction`, `graph.communities`, `graph.cache`, `graph.store`
- `search.localSearch`, `search.globalSearch`

### LLM Configuration

All LLM and embedding configs live in `llm.json`. The `LLMFactory` creates model instances by config name. Embedding providers: OpenAI-compatible, Gemini. Configured via `lib/llm/`.

### Tool System

Tools are provided to agents via prefixed references:
- `mcp:<server>` — MCP server tools
- `knowledge:<store>` — Knowledge store search + graph tools
- `function:<name>` — Custom JS functions
- `builtin:<name>` — Built-in tools (e.g., `ask_user`)

Knowledge tools are created by `lib/tools/built-in/knowledge-tools-factory.ts`. Stores with entities get extra graph tools (traverse, entity_lookup, graph_schema).

### Web UI (Studio)

Located in `public/`. Uses vanilla JS web components (`Component` base class). No build step — served directly by Fastify static.