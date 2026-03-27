# Agent Orcha — Project Guide

## Coding Rules

- **Never swallow errors silently.** No empty `.catch(() => {})`, no empty `catch {}` blocks, no `catch { /* ignore */ }`. Always log the error with `logger.error()` / `logger.warn()` or re-throw it. If a catch block truly has nothing to handle, add a comment explaining *why* the error is safe to ignore (e.g., "file may not exist, that's expected").

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

### Model Configuration

All model configs live in `models.yaml` (YAML format) with sections: `llm` (chat models), `embeddings`, `image`, `video`, `tts`. Each section has named configs pointing to a provider + model combination. The `LLMFactory` creates chat model instances; image/video/TTS tools resolve their models from the corresponding section. Agents reference models via the `model:` field which can be a string (LLM shorthand) or per-type object: `model: { llm: gpt4, image: flux, video: wan2, tts: qwen }`. The `GET /api/llm/config` endpoint returns the config with the LLM section keyed as `llm` (matching the YAML key), image/tts/video sections as-is. Image/TTS model activation routes (`POST /api/local-llm/models/:id/activate-image`, `activate-tts`) scan the model directory, load via OmniModelCache, and auto-configure `models.yaml`. Download routes accept an optional `category` query param; when `category=image|tts` and no existing config exists for that slot, `models.yaml` is auto-configured on download completion.

### Tool System

Tools are provided to agents via prefixed references:
- `mcp:<server>` — MCP server tools
- `knowledge:<store>` — Knowledge store search + graph tools
- `function:<name>` — Custom JS functions
- `builtin:<name>` — Built-in tools (e.g., `ask_user`, `canvas_write`, `generate_image`, `generate_tts`, `generate_video`)

Built-in tools: `ask_user` (interrupt for user input), `save_memory` (auto-injected with memory config), `canvas_write` (write/replace content in the canvas side pane), `canvas_append` (append to existing canvas content), `generate_image` (image generation via omni/P2P), `generate_tts` (text-to-speech via omni/P2P), `generate_video` (distributed video generation via P2P — registered only when P2P is enabled). Canvas tools are registered in `Orchestrator.registerBuiltInTools()`. Model tools (`generate_image`, `generate_tts`) are registered in `Orchestrator.registerModelTools()`. Video tool is registered in `Orchestrator.registerP2PTools()`. The frontend intercepts `tool_end` events to render content. `canvas_write` supports three formats: `markdown` (rendered rich text), `html` (live iframe), `code` (syntax-highlighted with `language` param). P2P model tools use the unified `model_task_*` protocol (`model_task_invoke`, `model_task_result`, `model_task_stream`, `model_task_stream_end`, `model_task_error`) for all task types (chat, image, video_frame, tts).

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
**Vision Browser:** `vision-browser.ts` — Pixel-coordinate browser control using CDP Input events. Tools: `sandbox_vision_screenshot`, `sandbox_vision_navigate`, `sandbox_vision_click`, `sandbox_vision_type`, `sandbox_vision_scroll`, `sandbox_vision_key`, `sandbox_vision_drag`. Every action tool auto-captures a JPEG screenshot (quality 55) and returns it as a `ContentPart[]` image, cutting the screenshot→infer→act loop to one call per action. Designed for use with vision models (e.g., Qwen3-VL via LM Studio). Uses its own CDPClient/PageReadiness instances independent of the existing DOM-based browser tools.
**Config:** `SandboxConfig` in `types.ts` with `browserCdpUrl` field (default: `http://localhost:9222`)

### P2P Network

`lib/p2p/p2p-manager.ts` manages Hyperswarm-based peer-to-peer sharing. P2P is **enabled by default** (`P2P_ENABLED !== 'false'`). Agents with `p2p: { share: true }` are shared to the network. Agents with `p2p: { leverage: true }` can discover and use remote models. Models with `share: true` in `models.yaml` (or `P2P_SHARE_LLMS=true` for all) are shared.

**Key files:**
- `lib/p2p/p2p-manager.ts` — `P2PManager` class (swarm lifecycle, catalog broadcast, rate limiting)
- `lib/p2p/p2p-protocol.ts` — Wire protocol over Hyperswarm sockets
- `lib/p2p/types.ts` — Message types, `P2PStatus`, `PeerInfo`, `P2PAgentInfo`, `P2PModelInfo`
- `src/routes/p2p.route.ts` — REST API (`/api/p2p/*`)

**Runtime configuration** (all configurable via `PATCH /api/p2p/settings` or the P2P tab UI):
- Peer name (`P2P_PEER_NAME` env var, default: hostname)
- Network key (`P2P_NETWORK_KEY` env var, default: `agent-orcha-default`) — SHA-256 hashed for topic
- Rate limit (`P2P_RATE_LIMIT` env var, default: 60 req/min, 0 = unlimited) — sliding window, applies to all incoming agent + model task requests
- Enable/disable toggle (`POST /api/p2p/toggle`) — creates/destroys `P2PManager` at runtime

**Model sharing:** `P2P_SHARE_LLMS=true` blanket-shares all active models. Otherwise per-model `share: true` in `models.yaml`. The Models tab UI has a Toggle per provider. `PATCH /api/llm/config/models/:name/share` toggles the flag and broadcasts catalog. **Model discovery is model-name based**: `p2p:model-name` matches by model string (case-insensitive, partial match), not by engine/provider. Multiple peers sharing the same model on different engines are all discoverable.

**`p2p.leverage` vs `model: p2p`:** These are different features. `model: p2p` (or `model: p2p:<name>`) explicitly routes LLM calls to a remote peer. `p2p.leverage` controls how model tools (image, TTS, video) resolve to local vs remote peers. Modes: `false` (disabled), `'local-first'` (try local, P2P fallback), `'remote-first'` (try P2P, local fallback), `'remote-only'` (P2P only, fail if unavailable). Boolean `true` maps to `'local-first'` for backward compatibility. Leverage applies to model tools only — the chat LLM always resolves locally unless `model: p2p` is explicitly set.

**Load balancing:** When multiple peers share the same model, `P2PManager.selectBestPeer()` picks the least-loaded peer using a combined score: client-side in-flight request count + peer-reported load from catalog broadcasts. Ties are broken randomly. Peers broadcast their `load` (active incoming task count) in `CatalogMessage` when tasks start and complete. In-flight counts are tracked via `incrementInFlight()`/`decrementInFlight()` in `invokeRemoteModelStream()` and `invokeRemoteModelTask()`.

**Distributed video generation:** The `generate_video` built-in tool distributes frame generation across P2P peers sharing a video/image model. Each peer generates assigned frame ranges, frames are collected and stitched locally using ffmpeg. Protocol uses the unified `model_task_*` messages with `taskType: 'video_frame'`. `P2PManager.getRemoteModelsByName()` finds all peers matching a model name for parallel distribution.

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

Key schema fields: `model` (string or `{ llm, image, video, tts }` per-type object), `p2p: { leverage, share }`, `skills`, `memory`, `integrations`, `triggers`, `publish`.

### Web UI (Studio)

Located in `public/`. Uses vanilla JS web components (`Component` base class). No build step — served directly by Fastify static. Tabs: Agents, Knowledge, MCP, Workflows, Skills, Monitor, IDE.

**Styling:** No CSS framework (no Tailwind, Bootstrap, etc.). All styles are custom CSS in `public/styles.css` using CSS custom properties (design tokens) defined in `:root`. Before using any CSS variable or utility class, verify it exists in `styles.css` — do not assume variables like `--bg-tertiary` or classes like `bg-secondary` exist. Check the `:root` block for available tokens (e.g., `--bg`, `--surface`, `--hover`, `--border`, `--text-muted`).

### Documentation Sync

Schema documentation lives in multiple files. When changing schemas (agents, knowledge, workflows, etc.), update **all** of these:
- `README.md` — Public-facing docs with full schema reference and examples
- `docs/documentation.html` — Hosted documentation site
- `docs/hub-registry.json` — Community Hub card data (must match what exists in `templates/`)
- `templates/skills/orcha-builder/SKILL.md` — Skill injected into agents that build/modify ORCHA resources
- `CLAUDE.md` — This file (architecture context for AI assistants)
- `lib/knowledge/types.ts` (or equivalent) — The Zod schema is the source of truth

When adding, removing, or renaming templates (agents, skills, knowledge, functions, workflows), update `docs/hub-registry.json` to stay in sync.

### Debugging

When analyzing chat history or debugging tool calls, fetch `http://localhost:3000/api/tasks` to inspect task events, tool invocations, and model responses.