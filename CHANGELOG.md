# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
