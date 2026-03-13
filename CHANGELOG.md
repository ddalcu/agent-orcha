# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release 0.0.8

### Added

- **Engine Registry** — Pluggable engine abstraction supporting four inference backends: llama-cpp, mlx-serve, Ollama, and LM Studio. Each engine has standardized lifecycle management, model loading/unloading, and status reporting. Switch between engines from the Studio UI or API.

- **MLX-Serve Engine** — Apple Silicon native inference via Metal. Models in MLX format run alongside GGUF models. Auto-downloads mlx-serve binaries, with update checking and HuggingFace MLX model browsing.

- **LLM Config Pointer System** — `llm.json` now supports string pointers (e.g., `"default": "openai"`) for fast provider switching. New `engine` field identifies which inference backend to use. Auto-migrates old format on first load.

- **LLM Configuration API** — Full CRUD for `llm.json` via REST with redacted API keys and env var detection. Manage models and embeddings entirely from the browser.

- **Thinking/Reasoning for Local Models** — `reasoningBudget` field enables chain-of-thought for supported models (QwQ, DeepSeek-R1). Thinking content streams as SSE events with toggle and budget controls in the UI.

- **PDF Knowledge Store Support** — PDF loader for knowledge stores. New `patient-records` template with deidentified healthcare PDFs.

- **Workflow Enhancements** — `chatOutputFormat` (`json` | `text`) controls output rendering. `sampleQuestions` field for suggested prompts. Resume endpoint with SSE streaming for interrupted ReAct workflows. Parallel tool execution in workflows.

- **Studio Overhaul** — New Local LLM tab with engine management, model grids, and VRAM monitoring. Workflows integrated into AgentsView. Unified CSS with custom properties (Tailwind removed). Logo added to NavBar.

- **New Templates** — `actor` agent (comedy impersonation chatbot), `team-chat` workflow (multi-agent ReAct coordinator)

- **E2E Test Suite** — Playwright-based tests covering all four engines, model activation, streaming, and configuration.

### Changed

- **Tool Error Handling** — Descriptive validation errors replace raw Zod exceptions, helping LLMs self-correct. Malformed JSON arguments return the raw text for the model to fix.
- **Local LLM Defaults** — Context sizing capped at 32K using 50% of available RAM. Default `maxTokens: 4096` for local models. Single-slot mode (`--parallel 1`) for predictable memory.
- **Embedding Improvements** — Batch size increased to 128, with adaptive halving on VRAM errors. Dynamic port allocation via engine registry.
- **Function Parameter Coercion** — Automatic type coercion for function parameters, so LLMs passing numbers as strings work correctly.
- **Ollama Context Passthrough** — Configured context size now correctly forwarded to Ollama via `num_ctx`.
- **IDE** — Visual/source mode switching no longer triggers false dirty state.
- **Template `llm.json`** — Pre-configured entries for all engines and providers with `default` as a pointer.

### Removed

- Monolithic `llama-provider.ts` replaced by engine registry and individual engine classes.

### Dependencies

- **Added:** `pdf-parse`, `@playwright/test`

## Release 0.0.7

### Added

- **Vision Browser (Experimental)** — Pixel-coordinate browser control using CDP Input events, designed for vision LLMs (e.g., Qwen3-VL via LM Studio). Enabled via `EXPERIMENTAL_VISION=true` env var. Tools: `sandbox_vision_screenshot`, `sandbox_vision_navigate`, `sandbox_vision_click`, `sandbox_vision_type`, `sandbox_vision_scroll`, `sandbox_vision_key`, `sandbox_vision_drag`. Every action tool auto-captures a JPEG screenshot (quality 55) and returns it as `ContentPart[]`, cutting the screenshot-infer-act loop to one call per action. New skill template: `templates/skills/vision-browser/`. New template agent: `vision`.

- **Image Stripping** — `stripOldImages()` in `llm-types.ts` strips base64 image data from all but the most recent image-bearing message, preventing context overflow in vision browser loops.

- **ReAct Loop Rewrite** — Unified `runLoop()` generator replaces duplicated logic between `invoke()` and `streamEvents()`. Adds context size logging (KB + estimated tokens), image counting, no-tool-call nudging (3 retries before accepting as final answer), reasoning/thinking content preserved in message history, and cumulative token tracking.

- **Agent `maxIterations` Config** — New optional `maxIterations` field on agent definitions. Overrides the default 200 iteration limit per agent.

- **Task Telemetry** — Tasks now track `metrics` (iteration count, message count, image count, context size, token usage) and `events` (tool starts/ends, thinking blocks, content chunks). Updated via SSE streaming from the agent route. `TaskManager.updateMetrics()` and `TaskManager.addEvent()` methods added.

- **Monitor Activity Feed** — MonitorView in Studio now shows real-time react-loop metrics (iteration, messages, images, context size, tokens) and a scrollable activity feed with tool calls, thinking blocks, and content events streamed via SSE.

- **Session Messages API** — `GET /api/agents/sessions/:sessionId/messages` endpoint returns a compact summary of conversation messages (role, text char count, image count/bytes, tool call names) for debugging.

- **Page Text Excerpt** — `PageReadiness.observe()` now returns `textExcerpt` (first 2000 chars of visible `innerText`). Browser tools advertise it in descriptions — often sufficient without fetching full page content.

- **Environment Variable Substitution** — All config files (agent YAML, knowledge YAML, workflow YAML, skill frontmatter, `llm.json`, `mcp.json`, `sandbox.json`) now support `${ENV_VAR}` and `${ENV_VAR:-default}` placeholders, resolved from `process.env` at load time. New utility: `lib/utils/env-substitution.ts`.

- **Thinking/Reasoning Support** — All three LLM providers now extract and forward thinking/reasoning content. Anthropic supports `thinkingBudget` config for extended thinking. OpenAI provider includes a streaming `ThinkTagParser` for models (e.g., Qwen3.5) that embed `<think>` tags in content. Gemini provider detects `thought` parts. New `thinkingBudget` field in `llm.json` model config.

- **Agent Composer (Visual Editor)** — New `AgentComposer` web component (`public/src/components/AgentComposer.js`) provides a visual form editor for agent YAML files. Edits identity, LLM, prompt, tools (with picker), skills, memory, output, publish, integrations, triggers, sample questions, and metadata. Integrated into the IDE via a source/visual mode toggle for `.agent.yaml` files.

- **Rate Limiting** — In-memory sliding-window rate limiter (`src/middleware/rate-limit.ts`). Applied to `/api/auth/login` (5 attempts/60s) and `/api/chat/:agentName/auth` (5 attempts/60s) to prevent brute-force attacks.

- **SSRF Protection** — `sandbox_web_fetch` now blocks requests to private/internal IPs (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1) and internal hostnames (localhost, host.docker.internal).

- **SQL Injection Hardening** — `validateReadonlySql()` now requires queries to start with `SELECT`, blocking stacked queries (e.g., `; DROP TABLE`).

- **Sandbox File Tools** — Read, write, edit, insert, and replace_lines tools scoped to `/tmp` with symlink-escape protection.

- **Network Security Agent Template** — Offensive recon and vulnerability scanning agent template.

- **Web Engineer Agent Template** — Building and publishing web apps via htmlhost.

### Changed

- **ReAct loop is now streaming-first** — `invoke()` consumes the shared `runLoop()` generator silently; `streamEvents()` yields from it. Both paths share identical logic.

- **Parallel tool execution** — ReAct loop now executes all tool calls from a single LLM response concurrently via `Promise.all()`, with per-iteration LLM and tool timing logged.

- **Smarter nudging for small LLMs** — Empty AI messages (no content and no tool calls) are no longer pushed to history, preventing confusion in small models. Nudge messages are context-aware: after tool results, the model is asked to respond based on the data; otherwise, a generic continue prompt is used.

- **System message role** — Agent executor now sends the system prompt as `role: 'system'` instead of wrapping it in a `humanMessage()`.

- **OpenAI provider: resilient tool arg parsing** — `parseToolArgs()` gracefully handles malformed JSON from local models (single quotes, trailing commas). Falls back to empty object instead of crashing the stream.

- **OpenAI provider: reasoning model support** — Models matching `o1`/`o3`/`o4` patterns use `max_completion_tokens` instead of `max_tokens` and skip temperature (as required by the API).

- **OpenAI provider: local model tool flush** — Tool calls are now flushed at end of stream even without a usage chunk, fixing dropped tool calls with LM Studio and similar servers.

- **Anthropic provider: streaming token tracking** — Input tokens are now captured from the `message_start` event, giving accurate total token counts in streaming mode.

- **Tool schema cleanup** — All three providers now strip `$schema` from zod-generated JSON schemas before sending to the API, and cache converted tool definitions to avoid repeated serialization.

- **HTML-to-Markdown improvements** — Images and interactive elements (buttons, inputs, forms) stripped by default; new `includeImages` and `includeInteractiveElements` options. `<script>`/`<style>` tags stripped before DOM parsing to avoid jsdom VM crashes. `HEAD`, `META`, `LINK` added to skip list. Icon font text lines cleaned from output.

- **`sandbox_web_fetch` simplified** — Removed `runScripts` parameter and jsdom script execution (unreliable, security risk). HTML-to-markdown conversion uses raw HTML directly.

- **`sandbox_browser_content` capped at 15K chars** — Hard cap prevents 50K+ char dumps from blowing up agent context.

- **LLM call logger** — Now reports context in KB, tracks image count, uses compact single-line format for start/end logs. Tool size map computed once and reused for the per-tool summary.

- **React workflow executor** — Uses `stripOldImages()` before LLM calls to prevent image accumulation across workflow iterations.

- **Docker entrypoint** — Chromium output suppressed by default; `BROWSER_VERBOSE=true` restores it. CDP remote debugging now binds to `127.0.0.1` instead of `0.0.0.0`.

- **Docker image slimmed** — Removed `arp-scan`, `masscan`, `libcap2-bin` packages and `NET_RAW` capability grants from Dockerfile and docker-compose.

- **CORS locked down** — Default CORS policy changed from `origin: true` (reflect all origins) to `origin: false` (same-origin only). Cross-origin access requires explicitly setting `CORS_ORIGIN`.

- **Auth session expiry** — Sessions now store an expiration timestamp and are cleaned up hourly, replacing the previous never-expiring `Set`.

- **Agent API: publish field sanitized** — `GET /api/agents/:name` now returns `publish: { enabled, hasPassword }` instead of exposing the raw password.

- **AgentsView: auto-refresh on workspace changes** — Agent list reloads automatically when workspace_write or workspace_delete tool calls modify agent resources.

- **Tool popover positioning** — Tool call detail popovers in AgentsView and StandaloneChat now use fixed positioning with viewport-aware placement, preventing clipping at screen edges.

- **Task list endpoint** — Strips `events` array from list responses to keep payloads small; full events available via individual task GET.

- **Web-pilot agent/skill** — Updated with textExcerpt guidance, evaluate() strategy, "don't repeat failed calls" rule.

- **Auto-inject sandbox tools from skills removed** — `resolveForAgentWithMeta()` replaced with simpler `resolveForAgent()`. Agents must explicitly declare sandbox tools.

- **Anthropic default maxTokens** — Increased from 4096 to 8192.

- **Template agents cleaned up** — Removed `metadata` field from all template and example agents. Architect agent now includes sandbox and ask_user tools.

- **Template llm.json** — Uses `${OPENAI_API_KEY}` env var placeholder instead of hardcoded "not-needed".

### Removed

- **`metadata` field from agent schema** — The `metadata: z.record(z.unknown()).optional()` field has been removed from `AgentDefinitionSchema`. Existing metadata in YAML files is ignored.

## Release 0.0.6

### Breaking Changes

- **Message content type widened** — `BaseMessage.content` changed from `string` to `string | ContentPart[]` to support multimodal messages. Downstream code that assumed `string` must use the new `contentToText()` helper.
- **Tool return type widened** — `StructuredTool.invoke()` now returns `string | ContentPart[]` instead of just `string`, enabling tools to return images.

### Added

- **Published Agents** — Agents can be shared via standalone chat pages at `/chat/<agent-name>` with optional per-agent password protection (`publish: true` or `publish: { enabled: true, password: "..." }`). Independent of global `AUTH_PASSWORD`.
  - New route: `src/routes/chat.route.ts` with config, auth, and stream endpoints
  - New standalone chat UI: `public/chat.html` + `public/src/components/StandaloneChat.js`
  - Supports markdown rendering, code highlighting, thinking blocks, tool call visualization, file attachments, and streaming stats

- **Browser Sandbox** — Full Chromium browser sandbox with CDP control, Xvfb, VNC, and noVNC for visual web interaction
  - `lib/sandbox/cdp-client.ts` — Chrome DevTools Protocol WebSocket client
  - `lib/sandbox/page-readiness.ts` — Page readiness detection with DOM observation
  - `lib/sandbox/sandbox-browser.ts` — Browser tools: `sandbox_browser_navigate`, `sandbox_browser_observe`, `sandbox_browser_click`, `sandbox_browser_type`, `sandbox_browser_screenshot`, `sandbox_browser_evaluate`
  - `sandbox_browser_screenshot` returns base64 images as `ContentPart[]`, enabling multimodal tool responses
  - `src/routes/vnc.route.ts` — VNC status endpoint and WebSocket proxy for in-browser VNC viewer
  - Docker image now includes Chromium, Xvfb, x11vnc, noVNC, websockify. Controlled via `BROWSER_SANDBOX=true` env var
  - New ports exposed: 6080 (noVNC), 9222 (CDP)

- **Shell Sandbox Tool** — `sandbox:shell` tool (`lib/sandbox/sandbox-shell.ts`) for executing shell commands inside the Docker container as a non-root `sandbox` user

- **Email Integration** — Full IMAP polling + SMTP email connector (`lib/integrations/email.ts`)
  - Agents are triggered by inbound emails and auto-reply to senders
  - Agents receive an `email_send` tool for composing new emails
  - Configurable poll interval, folder, from name/address

- **Integration Tools** — Auto-injected tools for agents with integrations (`lib/tools/built-in/integration-tools.ts`)
  - `integration_post` — Post messages to connected channels
  - `integration_context` — Get recent channel context
  - `email_send` — Send emails (for agents with email integrations)

- **Multimodal Message Support** — New `ContentPart` type (`text` | `image`) and `MessageContent` union type in `lib/types/llm-types.ts`
  - All three LLM providers (OpenAI, Anthropic, Gemini) now handle image content parts in user and tool messages
  - OpenAI provider buffers tool-result images and injects them as user messages (OpenAI API constraint)
  - Agents support `attachments` in input (array of `{ data, mediaType }`) for image uploads

- **File Attachments in Studio** — AgentsView and LLM chat now support dragging/pasting images that are sent as base64 attachments

- **Workspace Delete Tool** — `project:delete` tool for removing files/directories and unloading associated resources from memory

- **Resource Unloading** — `Orchestrator.unloadFile()` method for cleanly removing agents, workflows, knowledge stores, functions, and skills from memory
  - All loaders gain `remove()` and `nameForPath()` methods
  - `MemoryManager.delete()` for removing persistent memory files
  - IDE file delete and rename now properly unload old resources

- **Knowledge Store Scheduled Reindexing** — `reindex.schedule` field (cron expression) for automatic periodic re-indexing via node-cron
  - `KnowledgeStore.evict()` for clean teardown of individual stores
  - `KnowledgeStore.close()` for stopping all reindex crons on shutdown

- **Knowledge Store `jsonPath`** — Web sources support `jsonPath` (dot-notation) to extract a nested array from JSON responses before parsing

- **Knowledge Loader `html` Type** — Explicit `html` loader type added; web sources now default to `html` loader (previously implicit)

- **Reusable Content Parsers** — `parseJsonContent()` and `parseCsvContent()` extracted from file loaders for shared use with `WebLoader`

- **LLM Chat Session Memory** — `/api/llm/:name/chat` and `/api/llm/:name/stream` endpoints now support `sessionId` and `attachments` parameters

- **LLM Factory Cache Clear** — `LLMFactory.clearCache()` called when `llm.json` is reloaded, ensuring config changes take effect immediately

- **Session Store** — `public/src/services/SessionStore.js` for persisting active agent/LLM sessions in the Studio UI across tab switches

- **Docker Compose Watch** — `docker-compose.yaml` now supports `docker compose watch` with file sync for `lib/`, `src/`, and `public/` directories

- **Docker Development Mode** — `NODE_ENV=development` enables `--watch-path` for auto-restart on code changes inside the container

- **New Template Agents** — business-analyst, corporate, music-librarian, transport-security, web-pilot

- **New Template Knowledge Stores** — customer-ops, music-store (with SQLite database), sales-pipeline, security-incidents, supply-chain, transport-ot

- **New Template Skills** — pii-guard, web-pilot

- **Demo Script** — `templates/Demo.md` with sample prompts showcasing all agent and knowledge capabilities

### Changed

- Agent executor auto-injects integration tools when agent has integrations configured
- Agent executor skips duplicate sandbox tool injection when tools already declared
- Studio AgentsView redesigned with sidebar navigation, session persistence, mobile support, and welcome screen with animated orca
- Studio GraphView refactored for improved rendering
- Studio AppRoot updated for new layout
- Orchestrator passes `IntegrationAccessor` to `AgentExecutor`
- Orchestrator registers `sandbox:shell` and `sandbox:browser_*` tools alongside existing sandbox tools
- Orchestrator properly calls `knowledgeStoreManager.close()` on shutdown
- `IntegrationAccessor` interface moved from `orchestrator.ts` to `lib/integrations/types.ts` and expanded with `sendEmail`, `hasEmailIntegration`, `hasChannelIntegration`
- `TriggerManager.removeAgentTriggers()` added for clean trigger teardown on agent unload
- IDE file rename now unloads old resource before reloading from new path
- IDE file delete now unloads associated resource from memory
- `contentToText()` helper used throughout for safe content extraction from multimodal messages
- `WebLoader` now accepts `loaderType` parameter and supports `json`, `csv`, `text`, `html` parsing modes
- File loaders refactored to export reusable `parseJsonContent()` and `parseCsvContent()` functions
- Docker image now includes system tools (curl, wget, nmap, jq, python3, git, etc.) for sandbox use
- Docker entrypoint defaults to `start` command, supports `NODE_ENV=development` watch mode
- `dev` script now defaults `WORKSPACE` to `./templates`

### Dependencies

- **Added:** `imapflow`, `nodemailer`, `@types/nodemailer`

## Release 0.0.5

### Breaking Changes

- **LangChain removed** — All `@langchain/*` dependencies replaced with custom implementations and direct LLM provider SDKs
- **Node.js 24+ required** — Leverages built-in TypeScript support; Docker image updated to `node:24-slim`
- **Unified SQLite + sqlite-vec knowledge stores** — Chroma, Pinecone, Qdrant, Neo4j, and S3 backends removed; all stores now use a single SQLite persistence layer
- **Workflow type renamed** — `type: langgraph` → `type: react` in workflow YAML configs; executor renamed to `ReactWorkflowExecutor`
- **Config field renamed** — `projectRoot` → `workspaceRoot` in `Orchestrator` constructor
- **Environment variable renamed** — `ORCHA_BASE_DIR` → `WORKSPACE`
- **Knowledge config fields stripped by migration** — The following fields are automatically removed on load: `kind`, `store` (top-level), `graph.extractionMode`, `graph.extraction`, `graph.communities`, `graph.cache`, `graph.store`, `search.localSearch`, `search.globalSearch`

### Added

- **Skills System** — Prompt augmentation via Markdown files (`skills/*/SKILL.md`) with YAML frontmatter; attach to agents via `skills:` config; loaded by `lib/skills/skill-loader.ts`
- **Task Management** — Submit, track, and cancel async tasks via `TaskManager` and `TaskStore` (`lib/tasks/`)
- **Sandbox Execution** — `VmExecutor` (`lib/sandbox/vm-executor.ts`) with three built-in tools: `sandbox_exec`, `sandbox_web_fetch`, `sandbox_web_search`
- **Integrations System** — `IntegrationManager` (`lib/integrations/`) with Collabnook connector
- **Trigger System** — Cron (node-cron) and webhook triggers via `TriggerManager` (`lib/triggers/`)
- **Memory Manager** — Persistent agent memory to disk (`.memory/` directory) alongside session-based `ConversationStore`
- **ReAct Loop** — New `react-loop.ts` implementing the ReAct reasoning pattern, replacing LangGraph dependency
- **LLM Observability** — `LLMCallLogger` integrated into `AgentExecutor` and `ReactWorkflowExecutor` for context size breakdown, token estimates, and call duration metrics
- **Knowledge Graph Tools** — `KnowledgeToolsFactory` creates `entity_lookup`, `traverse`, `graph_schema`, `sql`, and `search` tools for stores with entities
- **Direct SQL-to-Graph Mapping** — `DirectMapper` maps SQL query results directly to graph entities and relationships without LLM extraction (100% data preservation)
- **Custom LLM Providers** — OpenAI, Anthropic, and Gemini provider implementations in `lib/llm/providers/`
- **Workspace Tools** — Project-scoped file tools (`project:` source)
- **Password Authentication** — Optional `AUTH_PASSWORD` environment variable gates all `/api/*` routes and Studio UI with cookie-based sessions; disabled when unset
- **New UI Views** — `MonitorView` for LLM call monitoring, `SkillsView` for skill browsing
- **CI/CD** — GitHub Actions workflows for testing and publishing
- **Test Suite** — 100+ test files across all subsystems
- **New Template Agents** — architect, chatbot, sandbox, knowledge-broker
- **New Template Knowledge Stores** — org-chart, pet-store, web-docs

### Changed

- Conversation store uses custom message types (no longer LangChain `HumanMessage`/`AIMessage`)
- Tool registry expanded with `sandbox:` and `project:` tool sources
- Workflow executors refactored — step-based executor unchanged, autonomous executor rewritten as `ReactWorkflowExecutor`
- Knowledge list API returns full status metadata including indexing state and counts
- `.env` loading improved — both CLI and programmatic entry load `.env` before any imports

### Removed

- All `@langchain/*` dependencies
- Vector store backends: Chroma (`chromadb`), Pinecone, Qdrant, in-memory `VectorStoreCache`
- S3 document loader (`@aws-sdk/*`)
- Neo4j graph store (`neo4j-driver`)
- LLM-based entity extraction (`EntityExtractor`)
- Community detection (Louvain algorithm, community summaries)
- GraphRAG local/global search modes
- `neo4jd3` visualization library
- `LangGraphExecutor` class

### Dependencies

- **Added:** `@anthropic-ai/sdk`, `@google/generative-ai`, `openai@^6`, `sqlite-vec`, `better-sqlite3`, `jsdom`, `node-cron`, `ws`, `cheerio`, `fastify-plugin`
- **Removed:** all `@langchain/*`, `chromadb`, `neo4j-driver`, `neo4jd3`, `@aws-sdk/*`, `graphology`, `graphology-communities-louvain`

## Release 0.0.3

### Breaking Changes

- **Vectors renamed to Knowledge**: The entire vector store system has been renamed
  - `vectors/` directory → `knowledge/`
  - `.vector.yaml` config files → `.knowledge.yaml`
  - `/api/vectors/*` API routes → `/api/knowledge/*`
  - `vector:<name>` tool references → `knowledge:<name>`
  - `VectorStoreManager` class → `KnowledgeStoreManager`
  - Knowledge configs now support a `kind` field: `vector` (default) or `graph-rag`

### Added

- **GraphRAG Knowledge Stores**: Entity extraction and knowledge graph capabilities
  - `kind: graph-rag` knowledge configuration with entity/relationship type schemas
  - LLM-powered entity and relationship extraction from documents
  - Community detection using Louvain algorithm with configurable resolution
  - Local search (entity neighborhood traversal) and global search (community-level analysis)
  - Graph store backends: `memory` and `neo4j`
  - Graph caching for faster reloads (`.graph-cache` directory)
  - New API endpoints: `GET /api/knowledge/:name/entities`, `GET /api/knowledge/:name/communities`, `GET /api/knowledge/:name/edges`

- **LangGraph Workflows**: Autonomous, prompt-driven workflow execution
  - `type: langgraph` workflow configuration with ReAct and single-turn execution modes
  - Automatic tool discovery (`mode: all | include | exclude | none`) across MCP, knowledge, function, and builtin sources
  - Automatic agent discovery (use other agents as tools)
  - Human-in-the-loop via `builtin:ask_user` tool with `NodeInterrupt`
  - Configurable `maxIterations` and `timeout` for execution limits
  - Streaming support via SSE (`POST /api/workflows/:name/stream`)

- **Agent Orcha Studio**: Web-based dashboard for managing and testing your instance
  - **Agents Tab**: Browse agents, invoke with custom input, stream responses, manage conversation sessions
  - **Knowledge Tab**: Browse and search knowledge stores, view GraphRAG entities/communities
  - **MCP Tab**: Browse MCP servers, view available tools, call tools directly
  - **Workflows Tab**: Browse and execute workflows (step-based and LangGraph), stream progress
  - **IDE Tab**: In-browser file editor with file tree, syntax highlighting (YAML, JSON, JS), hot-reload on save
  - Built with web components, served at `http://localhost:3000` when server is running

- **New Data Source Types** for knowledge stores:
  - `database`: Load documents from PostgreSQL or MySQL via SQL queries
  - `s3`: Load documents from AWS S3 or S3-compatible storage (MinIO, Wasabi)
  - `web`: Load documents by scraping web pages with optional CSS selectors

- **Conversation Memory**: Session-based memory for multi-turn dialogues
  - In-memory session storage using LangChain messages (HumanMessage, AIMessage)
  - Automatic FIFO message management (default: 50 messages per session)
  - Optional TTL-based session cleanup
  - `sessionId` parameter in agent invoke/stream API calls
  - Session management endpoints: `GET /api/agents/sessions/stats`, `GET /api/agents/sessions/:sessionId`, `DELETE /api/agents/sessions/:sessionId`

- **Structured Output**: Schema-enforced JSON responses from agents
  - `output.format: structured` with JSON Schema in `output.schema`
  - Automatic schema enforcement via LangChain's `withStructuredOutput()`
  - Response validation with `structuredOutputValid` metadata flag
  - Support for complex schemas with nested objects, arrays, and enums

- **Custom Functions API**: REST endpoints for managing and calling custom functions
  - `GET /api/functions` - List all functions
  - `GET /api/functions/:name` - Get function details and schema
  - `POST /api/functions/:name/call` - Call a function with arguments

- **MCP Management API**: REST endpoints for managing MCP servers
  - `GET /api/mcp` - List all MCP servers
  - `GET /api/mcp/:name` - Get server configuration
  - `GET /api/mcp/:name/tools` - List tools from a server
  - `POST /api/mcp/:name/call` - Call a tool on a server

- **Files API**: In-browser file management for the IDE
  - `GET /api/files/tree` - Get project directory tree
  - `GET /api/files/read?path=...` - Read file contents
  - `PUT /api/files/write` - Write file contents (with hot-reload)
  - Path traversal prevention and symlink detection for security

- **Agent-as-Tool**: Use agents as tools within LangGraph workflows via agent discovery

- **`builtin:ask_user` Tool**: Built-in tool for human-in-the-loop interactions in LangGraph workflows

- **Hot-Reload**: `reloadFile()` utility for live config updates when files are saved via the IDE

- **`WORKSPACE` Environment Variable**: Configure the base directory for all config files

- **New Vector Store Backend**: Added `chroma` type alongside existing `memory`

- **New Example Templates**:
  - `chatbot-memory.agent.yaml` - Agent with conversation memory
  - `sentiment-structured.agent.yaml` - Structured output with sentiment analysis
  - `data-extractor.agent.yaml` - Complex structured output for entity extraction
  - `call-center-analyst.agent.yaml` - GraphRAG-powered call center analysis
  - `langgraph-example.workflow.yaml` - Single-turn LangGraph workflow
  - `langgraph-multi-turn.workflow.yaml` - Multi-turn ReAct LangGraph workflow
  - `graph-rag-example.knowledge.yaml` - GraphRAG knowledge store
  - `postgres-docs.knowledge.yaml` - Database source knowledge store
  - `mysql-docs.knowledge.yaml` - MySQL source knowledge store
  - `s3-minio.knowledge.yaml` - MinIO S3 source knowledge store
  - `s3-pdfs.knowledge.yaml` - AWS S3 with PDF documents
  - `web-docs.knowledge.yaml` - Web scraping source knowledge store
  - `knowledge.agent.yaml` - Agent with knowledge store search

### Changed

- Agent executor uses `createAgent` instead of `createReactAgent` for agent creation
- Streaming uses `streamEvents` v2 for improved event handling
- Web UI completely rewritten using web components (replaces previous implementation)
- `AgentInstance` interface accepts `AgentInvokeOptions` (with `sessionId`) or plain input
- `AgentResult` metadata enhanced with `sessionId`, `messagesInSession`, and `structuredOutputValid` fields
- `Orchestrator.runAgent()` and `Orchestrator.streamAgent()` accept optional `sessionId` parameter

## Release 0.0.2

### Added
- GitHub Pages and GitHub Actions

## Release 0.0.1

### Added

- Declarative multi-agent framework using YAML for agents, workflows, vectors, and infrastructure
- Model-agnostic LLM support (OpenAI, Gemini, Anthropic, Ollama, LM Studio)
- Powerful workflow engine with sequential & parallel execution, conditions, retries, and state management
- RAG-first design with built-in vector stores (Memory, Chroma) and semantic search
- Universal tooling via MCP to connect agents to external APIs, services, and databases
- Extensible function tools using simple JavaScript with zero boilerplate
- Security Notice: the project is in alpha state and should only be deployed behind a firewall for internal use.
