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

### Skills System

Skills are prompt augmentation files (`skills/*/SKILL.md`) with YAML frontmatter. Loaded by `lib/skills/skill-loader.ts`. Attached to agents via the `skills:` config field. Content is injected into the agent's system prompt at runtime.

### Task Management

`lib/tasks/task-manager.ts` and `task-store.ts` provide submit/track/cancel for async tasks. Exposed via `/api/tasks` routes.

### Sandbox System

`lib/sandbox/vm-executor.ts` provides sandboxed code execution. Three built-in tools: `sandbox_exec`, `sandbox_web_fetch`, `sandbox_web_search`. Referenced as `sandbox:` tool sources.

### Integration System

`lib/integrations/integration-manager.ts` manages external integrations. Currently includes Collabnook connector. Attached to agents via the `integrations:` config field.

### Trigger System

`lib/triggers/trigger-manager.ts` supports cron (node-cron) and webhook triggers. Attached to agents via the `triggers:` config field.

### Memory System

Two layers:
- `ConversationStore` (`lib/memory/conversation-store.ts`) — Session-based in-memory message storage with FIFO and TTL
- `MemoryManager` (`lib/memory/memory-manager.ts`) — Persistent agent memory saved to disk (`.memory/` directory)

### Workflow Types

Two types: `type: 'steps'` (default, sequential/parallel) and `type: 'react'` (autonomous). The `react` type was previously called `langgraph`. Executor: `ReactWorkflowExecutor` in `lib/workflows/react-workflow-executor.ts`.

### Agent Config

New fields beyond the base schema: `skills`, `memory`, `integrations`, `triggers`.

### Web UI (Studio)

Located in `public/`. Uses vanilla JS web components (`Component` base class). No build step — served directly by Fastify static. Tabs: Agents, Knowledge, MCP, Workflows, Skills, Monitor, IDE.