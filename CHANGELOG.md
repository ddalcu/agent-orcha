# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release 0.0.3

### Added

- **Conversation Memory**: Session-based conversation memory for multi-turn dialogues
  - In-memory session storage using LangChain messages (HumanMessage, AIMessage)
  - Automatic FIFO message management (default: 50 messages per session)
  - Optional TTL-based session cleanup (default: 1 hour)
  - Backward compatible - sessionId is optional in API calls
  - Session management API endpoints for stats and cleanup
  - Memory accessor in Orchestrator for programmatic access

- **Structured Output**: Schema-enforced JSON responses from agents
  - JSON Schema-based output validation using LangChain's `withStructuredOutput()`
  - Automatic schema enforcement via LLM
  - Response validation with metadata (`structuredOutputValid` flag)
  - Support for complex schemas with nested objects and arrays
  - Backward compatible - works alongside existing text/json output formats

- **API Enhancements**:
  - Added `sessionId` parameter to agent invoke and stream endpoints
  - New session management endpoints: `/api/agents/sessions/stats`, `/api/agents/sessions/:sessionId`
  - Enhanced agent result metadata with `sessionId`, `messagesInSession`, and `structuredOutputValid`

- **Example Agents**:
  - `chatbot-memory.agent.yaml` - Demonstrates conversation memory
  - `sentiment-structured.agent.yaml` - Demonstrates structured output with sentiment analysis
  - `data-extractor.agent.yaml` - Demonstrates complex structured output for entity extraction

- **Documentation**:
  - Comprehensive README sections for conversation memory and structured output
  - API usage examples with curl commands
  - Library usage examples with TypeScript
  - Test script (`test-new-features.sh`) for validating new features

### Changed

- Updated `AgentInstance` interface to accept `AgentInvokeOptions` (with sessionId) or plain input
- Enhanced `AgentResult` metadata with new fields for session and validation tracking
- `Orchestrator.runAgent()` and `Orchestrator.streamAgent()` now accept optional sessionId parameter

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
- Production-ready server with Fastify REST API, SSE streaming, CLI, and Web UI
- Security Notice: the project is in alpha state and should only be deployed behind a firewall for internal use.