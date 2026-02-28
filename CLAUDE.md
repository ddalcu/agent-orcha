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

**Loader config** is optional. Defaults to `html` for web sources, `text` for file/directory. Not used for database sources. Supported types: `text`, `pdf`, `csv`, `json`, `markdown`, `html`. Web sources support all types via `loader.type` (e.g., `json` for APIs, `text` for raw content). JSON arrays of objects produce `_rawRow` metadata for `graph.directMapping`. Web sources also support `jsonPath` (dot-notation, e.g., `items` or `data.results`) to extract a nested array from the JSON response before parsing.

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
5. Stores with `reindex.schedule` (cron expression) automatically refresh on a schedule via `node-cron`. Cron cleanup happens in `KnowledgeStore.close()`
6. Search combines chunk KNN + entity KNN + neighborhood expansion, merged by score

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

`lib/sandbox/` provides sandboxed execution environments. Tools are referenced with `sandbox:` prefix.

**VM Execution:** `vm-executor.ts` — `sandbox_exec`, `sandbox_web_fetch`, `sandbox_web_search`
**Shell:** `sandbox-shell.ts` — `sandbox_shell` executes commands as non-root `sandbox` user
**Browser:** `sandbox-browser.ts` — CDP-based Chromium control with `sandbox_browser_navigate`, `sandbox_browser_observe`, `sandbox_browser_click`, `sandbox_browser_type`, `sandbox_browser_screenshot`, `sandbox_browser_evaluate`. Uses `cdp-client.ts` (WebSocket CDP) and `page-readiness.ts` (DOM observation). Browser tools return multimodal `ContentPart[]` (images).
**Config:** `SandboxConfig` in `types.ts` with `browserCdpUrl` field (default: `http://localhost:9222`)

### Published Agents

Agents with `publish: true` (or `publish: { enabled: true, password: "..." }`) get standalone chat pages at `/chat/<agent-name>`. Handled by `src/routes/chat.route.ts` with per-agent token auth (independent of global `AUTH_PASSWORD`). UI: `public/chat.html` + `public/src/components/StandaloneChat.js`.

### Resource Unloading

All loaders (`AgentLoader`, `WorkflowLoader`, `FunctionLoader`, `SkillLoader`, `KnowledgeStore`) have `remove()` and `nameForPath()` methods. `Orchestrator.unloadFile()` cleanly removes a resource from memory (stops triggers, closes integrations, evicts cached stores). Used by IDE file delete/rename and the `project:delete` workspace tool.

### Integration System

`lib/integrations/integration-manager.ts` manages external integrations. Attached to agents via the `integrations:` config field.

**Supported connectors:**
- **Collabnook** (`type: collabnook`) — WebSocket-based chat connector. Agents receive messages via @mention and reply in-channel.
- **Email** (`type: email`) — IMAP polling + SMTP sending via `imapflow` and `nodemailer`. Agents are triggered by inbound emails and auto-reply to senders. Agents also get an `email_send` tool for composing new emails.

**Key files:**
- `lib/integrations/types.ts` — Zod schemas (`CollabnookIntegrationSchema`, `EmailIntegrationSchema`), `IntegrationAccessor` interface
- `lib/integrations/collabnook.ts` — `CollabnookConnector`
- `lib/integrations/email.ts` — `EmailConnector`
- `lib/integrations/integration-manager.ts` — Lifecycle management for all connectors
- `lib/tools/built-in/integration-tools.ts` — Auto-injected tools (`integration_post`, `integration_context`, `email_send`)

### Trigger System

`lib/triggers/trigger-manager.ts` supports cron (node-cron) and webhook triggers. Attached to agents via the `triggers:` config field.

### Memory System

Two layers:
- `ConversationStore` (`lib/memory/conversation-store.ts`) — Session-based in-memory message storage with FIFO and TTL
- `MemoryManager` (`lib/memory/memory-manager.ts`) — Persistent agent memory saved to disk (`.memory/` directory)

### Workflow Types

Two types: `type: 'steps'` (default, sequential/parallel) and `type: 'react'` (autonomous). The `react` type was previously called `langgraph`. Executor: `ReactWorkflowExecutor` in `lib/workflows/react-workflow-executor.ts`.

### Agent Config

New fields beyond the base schema: `skills`, `memory`, `integrations`, `triggers`, `publish`.

### Web UI (Studio)

Located in `public/`. Uses vanilla JS web components (`Component` base class). No build step — served directly by Fastify static. Tabs: Agents, Knowledge, MCP, Workflows, Skills, Monitor, IDE.

### Documentation Sync

Schema documentation lives in multiple files. When changing schemas (agents, knowledge, workflows, etc.), update **all** of these:
- `README.md` — Public-facing docs with full schema reference and examples
- `docs/documentation.html` — Hosted documentation site
- `docs/hub-registry.json` — Community Hub card data (must match what exists in `templates/`)
- `templates/skills/orcha-builder/SKILL.md` — Skill injected into agents that build/modify ORCHA resources
- `CLAUDE.md` — This file (architecture context for AI assistants)
- `lib/knowledge/types.ts` (or equivalent) — The Zod schema is the source of truth

When adding, removing, or renaming templates (agents, skills, knowledge, functions, workflows), update `docs/hub-registry.json` to stay in sync.