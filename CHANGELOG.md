# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release 0.0.5

### Added

- **Knowledge Graph Agent Tools**: New suite of built-in tools automatically registered for agents based on knowledge store configuration
  - `knowledge_cypher` — Execute read-only Cypher queries against Neo4j-backed graph stores
  - `knowledge_sql` — Execute read-only SQL queries against database-backed knowledge stores
  - `knowledge_entity_lookup` — Look up entities by name or type in the graph
  - `knowledge_traverse` — Traverse relationships from a given entity
  - `knowledge_graph_schema` — Introspect graph schema (node labels, relationship types, property keys)
  - Tools are created via `KnowledgeToolsFactory` and include read-only query validators to prevent mutations

- **Direct SQL-to-Graph Mapping**: New `DirectMapper` for `graph-rag` stores with `extractionMode: 'direct'`
  - Maps SQL query results directly to graph entities and relationships without LLM extraction
  - Guarantees 100% data preservation — all rows contribute to the graph

- **LLM Call Observability**: New `LLMCallLogger` integrated into `AgentExecutor` and `LangGraphExecutor`
  - Logs context size breakdown (system prompt, messages, tool definitions)
  - Estimated token counts and per-tool size breakdown
  - Response metrics with call duration

- **On-Demand Indexing with SSE Progress**: Knowledge stores are no longer initialized eagerly on startup
  - `POST /api/knowledge/:name/index` — Trigger async indexing
  - `GET /api/knowledge/:name/index/stream` — SSE stream for real-time indexing progress (phases: loading, chunking, embedding, extracting, building, done/error)
  - `GET /api/knowledge/:name/status` — Get store metadata (status, counts, last indexed time, duration)

- **Vector Store Cache**: New `VectorStoreCache` that persists in-memory vector stores to disk
  - Content-hash invalidation to avoid re-embedding unchanged documents on restart

- **Knowledge Store Metadata**: New `KnowledgeMetadataManager` for persistent tracking of indexing status
  - Tracks document/chunk/entity/edge/community counts, embedding model, and error state

- **Neo4j Graph Visualization**: New `GraphView` UI component in Agent Orcha Studio
  - Interactive graph exploration via neo4jd3 with Cypher query execution
  - Node/relationship inspection, drag-to-lock, dark theme
  - New `/api/graph` route for direct Neo4j query execution

### Changed

- **Enhanced Neo4j Graph Store** — Added `getSchema()`, `findEntities()`, and `getRelationships()` methods for richer graph introspection and traversal
- **Enhanced Graph RAG Factory** — Supports direct mapping mode, improved extraction caching, and progress callback reporting throughout the indexing pipeline
- **Enhanced Knowledge List API** — `GET /api/knowledge` now returns full status metadata including indexing state, counts, extraction mode, and store type
- **Enhanced KnowledgeView UI** — Status badges, index/re-index buttons, progress bars, and richer store detail display
- **Improved .env Loading** — Both CLI (`start` command) and programmatic entry (`src/index.ts`) now explicitly load `.env` from the project root before any imports that depend on env vars
- Knowledge stores now initialize lazily on first access instead of eagerly at startup

### Dependencies

- Added `neo4jd3@^0.0.5`

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

- **`ORCHA_BASE_DIR` Environment Variable**: Configure the base directory for all config files

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
