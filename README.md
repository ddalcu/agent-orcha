![alt text](https://github.com/ddalcu/agent-orcha/raw/main/docs/assets/images/logo.png "Agent Orcha Logo")

# Agent Orcha

Agent Orcha is a declarative framework designed to build, manage, and scale multi-agent AI systems with ease. It combines the flexibility of TypeScript with the simplicity of YAML to orchestrate complex workflows, manage diverse tools via MCP, and integrate semantic search seamlessly. Built for developers and operators who demand reliability, extensibility, and clarity in their AI operations.

**[Documentation](https://ddalcu.github.io/agent-orcha)** | **[NPM Package](https://www.npmjs.com/package/agent-orcha)** | **[Docker Hub](https://hub.docker.com/r/ddalcu/agent-orcha)**

```bash
docker run -p 3000:3000 -v ./my-workspace:/data -e AUTH_PASSWORD=your-secret-password ddalcu/agent-orcha start
```

## Why Agent Orcha?

- **Declarative AI**: Define agents, workflows, and infrastructure in clear, version-controlled YAML files. No more spaghetti code.
- **Model Agnostic**: Seamlessly swap between OpenAI, Gemini, Anthropic, or local LLMs (Ollama, LM Studio) without rewriting logic.
- **Universal Tooling**: Leverage the **Model Context Protocol (MCP)** to connect agents to any external service, API, or database instantly.
- **Knowledge Stores**: Built-in SQLite-based vector store with optional **direct mapping** for knowledge graphs — semantic search and graph analysis as a first-class citizen.
- **Robust Workflow Engine**: Orchestrate complex multi-agent sequences with parallel execution, conditional logic, and state management - or use **ReAct** for autonomous prompt-driven workflows.
- **Conversation Memory**: Built-in session-based memory for multi-turn dialogues with automatic message management and TTL cleanup.
- **Structured Output**: Enforce JSON schemas on agent responses with automatic validation and type safety.
- **Agent Orcha Studio**: Built-in web dashboard with agent testing, knowledge browsing, workflow execution, and an **in-browser IDE** for editing configs.
- **Published Agents**: Share agents via standalone chat pages at `/chat/<name>` with optional per-agent password protection.
- **Developer Experience**: Fully typed interfaces, intuitive CLI tooling, and a modular architecture designed for rapid iteration from prototype to production.
- **Extensible Functions**: Drop in simple JavaScript functions to extend agent capabilities with zero boilerplate.

## Overview

Agent Orcha enables you to:

- **Define agents** using YAML configuration files with customizable LLM providers, prompts, and tools
- **Create workflows** that coordinate multiple agents in sequential, parallel, or autonomous (ReAct) execution
- **Integrate knowledge stores** for RAG (Retrieval Augmented Generation) with vector search and optional knowledge graphs
- **Connect MCP servers** to extend agent capabilities with external tools
- **Create local functions** to give your agents the ability to call your own custom code
- **Manage everything** through a web-based Studio dashboard with built-in IDE

## Architecture

<p align="center">
  <img src="docs/architecture.svg" alt="Agent Orcha Architecture" width="100%" />
</p>

### Knowledge Layer

<p align="center">
  <img src="docs/knowledge-architecture.svg" alt="Agent Orcha Knowledge Architecture" width="100%" />
</p>

### Alpha Status and Security Notice

**This project is currently in ALPHA state.** This software should **ALWAYS** be deployed behind a firewall without open access to its APIs. It is designed for **internal use only** and should never be exposed directly to the public internet.

Agent Orcha includes a simple password-based authentication gate. Set the `AUTH_PASSWORD` environment variable to require a password for all API access and the Studio UI. When unset, no authentication is required (suitable for local development).


## Usage

Agent Orcha can be used in multiple ways depending on your needs:

1. **CLI Tool (Recommended)** - Use `npx agent-orcha` to initialize and run Agent Orcha projects standalone
2. **Backend API Server** - Run Agent Orcha as a REST API backend for your existing frontends or applications
3. **Docker Image** - Use the official Docker image ([ddalcu/agent-orcha](https://hub.docker.com/r/ddalcu/agent-orcha)) for local and server deployments
4. **Library** - Import and use Agent Orcha programmatically in your TypeScript/JavaScript projects
5. **Source** - Clone and run directly from source for development or customization

**Requirements:** Node.js >= 24.0.0 (or Docker for containerized deployment)


## Quick Start

### CLI Usage

1. **Initialize a project:**
```bash
npx agent-orcha init my-project
cd my-project
```

2. **Configure LLM settings** in `llm.json`:
```json
{
  "version": "1.0",
  "models": {
    "default": {
      "provider": "openai",
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "not-needed",
      "model": "your-model-name",
      "temperature": 0.7
    }
  },
  "embeddings": {
    "default": {
      "provider": "openai",
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "not-needed",
      "model": "text-embedding-model"
    }
  }
}
```

3. **Start the server:**
```bash
npx agent-orcha start
```

4. **Test your agent:**
```bash
curl -X POST http://localhost:3000/api/agents/example/invoke \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "Hello, how are you?"}}'
```

### Docker Usage

Run Agent Orcha using the official Docker image:

1. **Initialize a project:**
```bash
docker run -v ./my-agent-orcha-project:/data ddalcu/agent-orcha init
```

2. **Start the server:**
```bash
docker run -p 3000:3000 -v ./my-agent-orcha-project:/data ddalcu/agent-orcha start
```

3. **Or use Docker Compose:**
```yaml
version: '3.8'

services:
  agent-orcha:
    image: ddalcu/agent-orcha
    ports:
      - "3000:3000"
    volumes:
      - ./my-agent-orcha-project:/data
    environment:
      - WORKSPACE=/data
      - AUTH_PASSWORD=your-secret-password  # Optional
```

Then run:
```bash
docker-compose up
```

See the [Docker Hub page](https://hub.docker.com/r/ddalcu/agent-orcha) for more details and available tags.

### Library Usage

```typescript
import { Orchestrator } from 'agent-orcha';

const orchestrator = new Orchestrator({
  workspaceRoot: './my-agents-project'
});

await orchestrator.initialize();

// Invoke an agent
const result = await orchestrator.agents.invoke('researcher', {
  topic: 'machine learning',
  context: 'brief overview'
});

console.log(result.output);

// Run a workflow
const workflowResult = await orchestrator.workflows.run('research-paper', {
  topic: 'artificial intelligence'
});

console.log(workflowResult.output);

// Search a knowledge store
const searchResults = await orchestrator.knowledge.search('docs', {
  query: 'how does authentication work',
  k: 4
});

// Run agent with conversation memory
const memoryResult = await orchestrator.runAgent(
  'chatbot',
  { message: 'Hello' },
  'session-123'  // sessionId
);

// Clean up
await orchestrator.close();
```

### Backend API Server Usage

Run Agent Orcha as a backend API server for your existing applications or frontends:

```bash
# Start the server (defaults to port 3000)
npx agent-orcha start

# Or specify a custom port
PORT=8080 npx agent-orcha start
```

Agent Orcha exposes a complete REST API that your frontend can consume:

```javascript
// Example: Invoke an agent from your frontend
const response = await fetch('http://localhost:3000/api/agents/researcher/invoke', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    input: { topic: 'AI trends' },
    sessionId: 'user-session-123'  // Optional for conversation memory
  })
});

const result = await response.json();
console.log(result.output);

// Example: Search a knowledge store
const searchResponse = await fetch('http://localhost:3000/api/knowledge/docs/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'authentication best practices',
    k: 5
  })
});

const searchResults = await searchResponse.json();

// Example: Stream agent responses (SSE)
const eventSource = new EventSource(
  'http://localhost:3000/api/agents/chatbot/stream?' +
  new URLSearchParams({
    input: JSON.stringify({ message: 'Hello!' }),
    sessionId: 'user-123'
  })
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data.chunk); // Streaming response chunk
};
```

**CORS Configuration:**
For production deployments, configure CORS in your server startup or use a reverse proxy (nginx, Caddy, etc.) to handle CORS headers.

**Authentication:**
Set the `AUTH_PASSWORD` environment variable to enable password authentication for all API routes. The Studio UI will prompt for the password on access. When unset, all routes are open (suitable for local development behind a firewall).

## CLI Commands

| Command | Description |
|---------|-------------|
| `npx agent-orcha init [dir]` | Initialize a new project with example configs |
| `npx agent-orcha start` | Start the agent orchestrator server |
| `npx agent-orcha help` | Show help information |

## Development Scripts

For development on the agent-orcha framework itself:

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with auto-reload |
| `npm run build` | Build |
| `npm start` | Run build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript type checking |

## Configuration

### LLM Configuration (llm.json)

All LLM and embedding configurations are defined in `llm.json` at the project root. Agents and knowledge stores reference these configs by name.

```json
{
  "version": "1.0",
  "models": {
    "default": {
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "not-needed",
      "model": "qwen/qwen3-4b-2507",
      "temperature": 0.7
    },
    "openai": {
      "apiKey": "sk-your-openai-key",
      "model": "gpt-4o",
      "temperature": 0.7
    }
  },
  "embeddings": {
    "default": {
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "not-needed",
      "model": "text-embedding-nomic-embed-text-v1.5",
      "eosToken": " "
    },
    "openai": {
      "apiKey": "sk-your-openai-key",
      "model": "text-embedding-3-small",
      "dimensions": 1536
    },
    "gemini": {
      "apiKey": "sk-your-gemini-key",
      "model": "text-embedding-004"
    }
  }
}
```

All providers are treated as OpenAI-compatible APIs. For local inference:
- **LM Studio**: Use `baseUrl: "http://localhost:1234/v1"`
- **Ollama**: Use `baseUrl: "http://localhost:11434/v1"`
- **OpenAI**: Omit `baseUrl` (uses default OpenAI endpoint)

#### Embedding Configuration Options

Embedding configurations support the following options:

- **model** (required): The embedding model name
- **apiKey** (required): API key for the embedding service
- **baseUrl** (optional): Custom API endpoint URL for local or alternative services
- **provider** (optional): Provider type (openai, gemini, local). Auto-detected if omitted
- **dimensions** (optional): Output embedding dimensions (e.g., 1536 for OpenAI text-embedding-3-small)
- **eosToken** (optional): Token to append to all text inputs (e.g., " " for Nomic models to avoid SEP warnings)


**Example configurations:**

```json
{
  "embeddings": {
    "nomic-local": {
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "not-needed",
      "model": "text-embedding-nomic-embed-text-v1.5",
      "eosToken": " "
    },
    "openai-small": {
      "apiKey": "sk-your-key",
      "model": "text-embedding-3-small",
      "dimensions": 1536
    },
    "openai-large": {
      "apiKey": "sk-your-key",
      "model": "text-embedding-3-large",
      "dimensions": 3072
    },
    "gemini": {
      "apiKey": "sk-your-key",
      "model": "text-embedding-004"
    }
  }
}
```

### Environment Variables (Optional)

```bash
# Server configuration
PORT=3000
HOST=0.0.0.0

# Base directory for config files (optional)
WORKSPACE=/path/to/project

# Authentication (optional — when set, all API routes and Studio require this password)
AUTH_PASSWORD=your-secret-password
```

## Agents

Agents are AI-powered units that can use tools and respond to queries. Define agents in YAML files within the `agents/` directory.

### Agent Schema

```yaml
# agents/<name>.agent.yaml

name: string                    # Unique identifier (required)
description: string             # Human-readable description (required)
version: string                 # Semantic version (default: "1.0.0")

llm: string | object            # Reference to LLM config in llm.json
  # Simple: llm: default
  # With override: llm: { name: default, temperature: 0.3 }

prompt:                         # Prompt configuration (required)
  system: string                # System message/instructions
  inputVariables: [string]      # Variables to interpolate in the prompt

tools:                          # Tools available to agent (optional)
  - mcp:<server-name>           # MCP server tools
  - knowledge:<store-name>      # Knowledge store search
  - function:<function-name>    # Custom function
  - builtin:<tool-name>         # Built-in tools

output:                         # Output formatting (optional)
  format: text | structured
  schema:                       # Required when format is "structured"
    type: object
    properties: { ... }
    required: [string]

skills:                         # Skills to attach (optional)
  - skill-name                  # Specific skills by name
  # Or: { mode: all }           # Attach all available skills

memory: boolean                 # Enable persistent memory (optional)

integrations:                   # External integrations (optional)
  - type: collabnook             # CollabNook chat integration
    url: wss://collabnook.com/ws
    channel: general
    botName: MyBot
    password: secret             # Optional (private channels)
    replyDelay: 1000             # Optional (ms delay before reply)
  - type: email                  # Email integration (IMAP + SMTP)
    imap:
      host: imap.gmail.com
      port: 993                  # Default: 993
      secure: true               # Default: true
    smtp:
      host: smtp.gmail.com
      port: 587                  # Default: 587
      secure: false              # Default: false
    auth:
      user: agent@example.com
      pass: app-password
    fromName: "Support Agent"    # Optional display name
    pollInterval: 60             # Seconds between IMAP checks (default: 60)
    folder: INBOX                # IMAP folder to monitor (default: INBOX)

triggers:                       # Cron or webhook triggers (optional)
  - type: cron
    schedule: "0 * * * *"
  - type: webhook

metadata:                       # Custom metadata (optional)
  category: string
  tags: [string]

publish: boolean | object       # Standalone chat page (optional)
  # Simple: publish: true
  # With password: publish: { enabled: true, password: "secret" }
```

### Published Agents (Standalone Chat Pages)

Agents can be shared via standalone URLs at `/chat/<agent-name>` without requiring the full Studio UI. Add the `publish` field to enable this:

```yaml
# Public — no password
publish: true

# Password-protected (independent of global AUTH_PASSWORD)
publish:
  enabled: true
  password: "secret123"
```

The standalone chat page supports markdown rendering, code highlighting, thinking blocks, tool call visualization, file attachments, and streaming stats.

### Example Agent

```yaml
# agents/researcher.agent.yaml

name: researcher
description: Researches topics using web fetch and knowledge search
version: "1.0.0"

llm:
  name: default
  temperature: 0.5  # Override default temperature

prompt:
  system: |
    You are a thorough researcher. Your task is to:
    1. Search through available knowledge bases
    2. Fetch additional information from the web
    3. Synthesize findings into a comprehensive report

    Use the available tools to gather information before responding.
  inputVariables:
    - topic
    - context

tools:
  - mcp:fetch
  - knowledge:transcripts

output:
  format: text

metadata:
  category: research
  tags: [research, web, knowledge]
```

### Conversation Memory

Agent Orcha supports session-based conversation memory, allowing agents to maintain context across multiple interactions. This is useful for building chatbots, multi-turn dialogues, and stateful applications.

**Features:**
- In-memory session storage with custom message types
- Automatic FIFO message limit (default: 50 messages per session)
- Optional TTL-based session cleanup (default: 1 hour)
- Backward compatible (sessionId is optional)

**API Usage:**

```bash
# First message
curl -X POST http://localhost:3000/api/agents/chatbot-memory/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "input": {"message": "My name is Alice"},
    "sessionId": "user-123"
  }'

# Second message (agent remembers the name)
curl -X POST http://localhost:3000/api/agents/chatbot-memory/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "input": {"message": "What is my name?"},
    "sessionId": "user-123"
  }'
```

**Library Usage:**

```typescript
// Run agent with conversation memory
const result1 = await orchestrator.runAgent(
  'chatbot-memory',
  { message: 'My name is Alice' },
  'user-123'  // sessionId
);

const result2 = await orchestrator.runAgent(
  'chatbot-memory',
  { message: 'What is my name?' },
  'user-123'  // Same sessionId maintains context
);
```

**Session Management API:**

```bash
# Get session stats
curl http://localhost:3000/api/agents/sessions/stats

# Get session info
curl http://localhost:3000/api/agents/sessions/user-123

# Clear session
curl -X DELETE http://localhost:3000/api/agents/sessions/user-123
```

**Memory Management (Programmatic):**

```typescript
// Access memory store
const memory = orchestrator.memory;

// Check if session exists
const hasSession = memory.hasSession('user-123');

// Get message count
const count = memory.getMessageCount('user-123');

// Clear a session
memory.clearSession('user-123');

// Get total sessions
const totalSessions = memory.getSessionCount();
```

### Structured Output

Agents can return validated, structured JSON output by specifying an `output.schema` configuration. This ensures responses match your desired format with automatic validation.

**Features:**
- JSON Schema-based output validation
- Type-safe structured responses
- Automatic schema enforcement via LLM
- Validation metadata in response

**Example Agent Configuration:**

```yaml
# agents/sentiment-structured.agent.yaml

name: sentiment-structured
description: Sentiment analysis with structured output
llm:
  name: default
  temperature: 0
prompt:
  system: |
    Analyze the sentiment of the provided text and return a structured response.
    Provide both the sentiment category and a confidence score.
  inputVariables:
    - text
output:
  format: structured
  schema:
    type: object
    properties:
      sentiment:
        type: string
        enum: [positive, negative, neutral]
        description: The overall sentiment
      confidence:
        type: number
        minimum: 0
        maximum: 1
        description: Confidence score
      keywords:
        type: array
        items:
          type: string
        description: Key sentiment-driving words
    required:
      - sentiment
      - confidence
```

**API Usage:**

```bash
curl -X POST http://localhost:3000/api/agents/sentiment-structured/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "input": {"text": "I love this product! It works great!"}
  }'
```

**Response:**

```json
{
  "output": {
    "sentiment": "positive",
    "confidence": 0.95,
    "keywords": ["love", "great"]
  },
  "metadata": {
    "duration": 1234,
    "structuredOutputValid": true
  }
}
```

**Library Usage:**

```typescript
const result = await orchestrator.runAgent('sentiment-structured', {
  text: 'This is amazing!'
});

// result.output is a typed object
console.log(result.output.sentiment); // "positive"
console.log(result.output.confidence); // 0.95
console.log(result.metadata.structuredOutputValid); // true
```

## Workflows

Workflows orchestrate multiple agents in a defined sequence. Define workflows in YAML files within the `workflows/` directory. Agent Orcha supports two workflow types: **step-based** and **ReAct**.

### Step-Based Workflows

Traditional sequential/parallel agent orchestration with explicit step definitions.

#### Workflow Schema

```yaml
# workflows/<name>.workflow.yaml

name: string                    # Unique identifier (required)
description: string             # Human-readable description (required)
version: string                 # Semantic version (default: "1.0.0")
type: steps                     # Optional (steps is default)

input:                          # Input schema (required)
  schema:
    <field_name>:
      type: string | number | boolean | array | object
      required: boolean         # (default: false)
      default: any              # Default value
      description: string       # Field description

steps:                          # Workflow steps (required)
  - id: string                  # Unique step identifier
    agent: string               # Agent name to execute
    input:                      # Input mapping using templates
      <key>: "{{input.field}}"           # From workflow input
      <key>: "{{steps.stepId.output}}"   # From previous step
    condition: string           # Optional conditional execution
    retry:                      # Optional retry configuration
      maxAttempts: number
      delay: number             # Milliseconds
    output:
      key: string               # Store output under this key

  # Parallel execution
  - parallel:
      - id: step1
        agent: agent1
        input: {...}
      - id: step2
        agent: agent2
        input: {...}

config:                         # Workflow configuration (optional)
  timeout: number               # Total timeout ms (default: 300000)
  onError: stop | continue | retry

output:                         # Output mapping (required)
  <key>: "{{steps.stepId.output}}"

metadata:                       # Custom metadata (optional)
  category: string
  tags: [string]
```

#### Template Syntax

Access data within workflows using double curly braces:

| Template | Description |
|----------|-------------|
| `{{input.fieldName}}` | Access workflow input field |
| `{{steps.stepId.output}}` | Access step output |
| `{{steps.stepId.output.nested.path}}` | Access nested output |
| `{{steps.stepId.metadata.duration}}` | Access step metadata |

#### Example Workflow

```yaml
# workflows/research-paper.workflow.yaml

name: research-paper
description: Research a topic and write a comprehensive paper
version: "1.0.0"

input:
  schema:
    topic:
      type: string
      required: true
      description: The topic to research
    style:
      type: string
      default: "professional"

steps:
  - id: research
    agent: researcher
    input:
      topic: "{{input.topic}}"
      context: "Gather comprehensive information"
    output:
      key: researchFindings

  - id: summarize
    agent: summarizer
    input:
      content: "{{steps.research.output}}"
      maxPoints: "10"
    condition: "{{steps.research.metadata.success}}"
    output:
      key: summary

  - id: write
    agent: writer
    input:
      research: "{{steps.research.output}}"
      outline: "{{steps.summarize.output}}"
      style: "{{input.style}}"
    output:
      key: paper

config:
  timeout: 600000
  onError: stop

output:
  paper: "{{steps.write.output}}"
  summary: "{{steps.summarize.output}}"
  researchFindings: "{{steps.research.output}}"
```

### ReAct Workflows

Autonomous, prompt-driven workflows using the ReAct pattern. The agent decides which tools and agents to call based on the system prompt, without explicit step definitions.

#### ReAct Schema

```yaml
# workflows/<name>.workflow.yaml

name: string                    # Unique identifier (required)
description: string             # Human-readable description (required)
version: string                 # Semantic version (default: "1.0.0")
type: react                     # Required for ReAct workflows

input:                          # Input schema (required)
  schema:
    <field_name>:
      type: string | number | boolean | array | object
      required: boolean
      description: string

prompt:                         # Prompt configuration (required)
  system: string                # System message with instructions
  goal: string                  # Goal template (supports {{input.*}} interpolation)

graph:                          # ReAct configuration (required)
  model: string                 # LLM config name from llm.json
  executionMode: react | single-turn  # Default: react
  tools:                        # Tool discovery
    mode: all | include | exclude | none
    sources: [mcp, knowledge, function, builtin]
    include: [string]           # For mode: include
    exclude: [string]           # For mode: exclude
  agents:                       # Agent discovery
    mode: all | include | exclude | none
    include: [string]
    exclude: [string]
  maxIterations: number         # Default: 10
  timeout: number               # Default: 300000

output:                         # Output extraction
  <key>: "{{state.messages[-1].content}}"

config:                         # Optional
  onError: stop | continue | retry
```

#### Execution Modes

| Mode | Behavior | Best For |
|------|----------|----------|
| `single-turn` | Calls tools once, then returns | Research, data gathering, straightforward tasks |
| `react` | Multiple rounds of tool calls with analysis | Complex problems, iterative refinement |

#### Example ReAct Workflow

```yaml
name: react-research
description: Autonomous research using tool discovery
version: "1.0.0"
type: react

input:
  schema:
    topic:
      type: string
      required: true

prompt:
  system: |
    You are a research assistant with access to tools and agents.
    Identify all tools you need, call them in parallel, then synthesize results.

    If the user hasn't provided required information, use the ask_user tool
    to request it before proceeding.
  goal: "Research and analyze: {{input.topic}}"

graph:
  model: default
  executionMode: single-turn
  tools:
    mode: all
    sources: [mcp, knowledge, function, builtin]
  agents:
    mode: all
  maxIterations: 10
  timeout: 300000

output:
  analysis: "{{state.messages[-1].content}}"
```

## Knowledge Stores

Knowledge stores enable semantic search and RAG capabilities. All stores use **SQLite with sqlite-vec** as the unified persistence layer — no external vector databases required. Define knowledge stores in YAML files within the `knowledge/` directory.

Optionally add a `graph.directMapping` section to build a knowledge graph from structured data (database, CSV, or JSON sources).

### Knowledge Store Schema

```yaml
# knowledge/<name>.knowledge.yaml

name: string                    # Unique identifier (required)
description: string             # Human-readable description (required)

source:                         # Data source (required)
  type: directory | file | database | web

loader:                         # Document loader (optional)
  type: text | pdf | csv | json | markdown | html
  # Defaults: html for web sources, text for file/directory
  # Not used for database sources

splitter:                       # Text chunking (required)
  type: character | recursive | token | markdown
  chunkSize: number             # Characters per chunk (default: 1000)
  chunkOverlap: number          # Overlap between chunks (default: 200)

embedding: string               # Reference to embedding config in llm.json (default: "default")

graph:                          # Optional — enables entity graph
  directMapping:                # Maps structured data to entities and relationships
    entities:
      - type: string            # Entity type name
        idColumn: string        # Column used as unique ID
        nameColumn: string      # Column used as display name (optional)
        properties: [string]    # Columns to include as entity properties
    relationships:              # Optional
      - type: string            # Relationship type name
        source: string          # Source entity type
        target: string          # Target entity type
        sourceIdColumn: string  # Column linking to source entity
        targetIdColumn: string  # Column linking to target entity

search:                         # Search configuration (optional)
  defaultK: number              # Results per search (default: 4)
  scoreThreshold: number        # Minimum similarity (0-1)

reindex:                        # Periodic re-indexing (optional)
  schedule: string              # Cron expression (e.g., "0 * * * *" for hourly)
```

#### Example: Vector-Only Store

```yaml
# knowledge/transcripts.knowledge.yaml

name: transcripts
description: Meeting transcripts for context retrieval

source:
  type: directory
  path: knowledge/sample-data
  pattern: "*.txt"

loader:
  type: text

splitter:
  type: character
  chunkSize: 1000
  chunkOverlap: 200

embedding: default

search:
  defaultK: 4
  scoreThreshold: 0.2
```

#### Example: Store with Graph (Direct Mapping)

```yaml
# knowledge/blog-posts.knowledge.yaml

name: blog-posts
description: Blog posts with authors as a knowledge graph

source:
  type: database
  connectionString: postgresql://user:pass@localhost:5432/blog
  query: |
    SELECT p.id, p.title, p.slug, p.html AS content,
           u.name AS author_name, u.email AS author_email
    FROM posts p
    LEFT JOIN users u ON p.author_id = u.id
    WHERE p.status = 'published'
  contentColumn: content
  metadataColumns: [id, title, slug, author_name, author_email]

splitter:
  type: recursive
  chunkSize: 2000
  chunkOverlap: 300

embedding: default

graph:
  directMapping:
    entities:
      - type: Post
        idColumn: id
        nameColumn: title
        properties: [title, slug, content]

      - type: Author
        idColumn: author_email
        nameColumn: author_name
        properties: [author_name, author_email]

    relationships:
      - type: WROTE
        source: Author
        target: Post
        sourceIdColumn: author_email
        targetIdColumn: id

search:
  defaultK: 10
```

#### Example: Web JSON API with Graph

```yaml
# knowledge/team.knowledge.yaml

name: team-directory
description: Team members from internal API

source:
  type: web
  url: https://api.internal.com/v1/employees
  headers:
    Authorization: "Bearer ${EMPLOYEE_API_TOKEN}"

loader:
  type: json

splitter:
  type: character
  chunkSize: 500

embedding: default

graph:
  directMapping:
    entities:
      - type: Employee
        idColumn: id
        nameColumn: name
        properties: [name, email, role]
      - type: Department
        idColumn: department
        nameColumn: department
        properties: [department]
    relationships:
      - type: BELONGS_TO
        source: Employee
        target: Department
        sourceIdColumn: id
        targetIdColumn: department
```

**How it works:**
- All data persists to SQLite at `.knowledge-data/{name}.db`
- On restart, source hashes are compared — if unchanged, data restores instantly without re-indexing
- Stores with `graph.directMapping` also store entities and relationships with vector embeddings
- Agents get additional graph tools (traverse, entity_lookup, graph_schema) when entities exist

### Data Source Types

#### Directory/File Sources
```yaml
source:
  type: directory
  path: knowledge/sample-data
  pattern: "*.txt"
  recursive: true
```

#### Database Sources
```yaml
source:
  type: database
  connectionString: postgresql://user:password@localhost:5432/docs_db
  query: SELECT content, title, category FROM documents WHERE published = true
  contentColumn: content
  metadataColumns:
    - title
    - category
  batchSize: 100
```

#### Web Sources
```yaml
# HTML (default) — parsed with Cheerio, optional CSS selector
source:
  type: web
  url: https://docs.example.com/guide/
  selector: article.documentation

# JSON API — use jsonPath to extract a nested array
source:
  type: web
  url: https://api.example.com/report?format=json
  jsonPath: data.results          # dot-notation path to the array in the response
  headers:
    Authorization: "Bearer token"
loader:
  type: json

# Raw text / markdown
source:
  type: web
  url: https://raw.githubusercontent.com/user/repo/main/README.md
loader:
  type: text
```

The `jsonPath` option extracts a nested value from the JSON response before parsing. When the extracted value is an array of objects, each object becomes a document with `_rawRow` metadata (supports `graph.directMapping`).


## Functions

Functions are custom JavaScript tools that extend agent capabilities with your own code. They're simple to create and require no dependencies.

### Function Schema

Create a file in `functions/` ending with `.function.js`:

```javascript
/**
 * Function description
 */
export default {
  name: 'function-name',           // Unique identifier (required)
  description: 'What it does',     // Clear description (required)

  parameters: {                    // Input parameters (required)
    param1: {
      type: 'number',              // string | number | boolean | array | object | enum
      description: 'Parameter description',
      required: true,              // Optional, defaults to true
      default: 0,                  // Optional default value
    },
  },

  execute: async ({ param1 }) => { // Execution function (required)
    // Your logic here
    return `Result: ${param1}`;
  },
};

// Optional metadata for documentation
export const metadata = {
  name: 'function-name',
  version: '1.0.0',
  author: 'Your Name',
  tags: ['category'],
};
```

### Example Function

```javascript
// functions/fibonacci.function.js

export default {
  name: 'fibonacci',
  description: 'Returns the nth Fibonacci number (0-based indexing)',

  parameters: {
    n: {
      type: 'number',
      description: 'The index (0-based, max 100)',
    },
  },

  execute: async ({ n }) => {
    if (n < 0 || !Number.isInteger(n)) {
      throw new Error('Index must be a non-negative integer');
    }
    if (n > 100) {
      throw new Error('Index too large (max 100)');
    }

    if (n === 0) return 'Fibonacci(0) = 0';
    if (n === 1) return 'Fibonacci(1) = 1';

    let prev = 0, curr = 1;
    for (let i = 2; i <= n; i++) {
      [prev, curr] = [curr, prev + curr];
    }

    return `Fibonacci(${n}) = ${curr}`;
  },
};
```

### Using Functions in Agents

Reference functions in your agent's tools list with the `function:` prefix:

```yaml
name: math-assistant
description: Assistant that can calculate Fibonacci numbers

llm:
  name: default
  temperature: 0.3

prompt:
  system: |
    You are a math assistant. Use the fibonacci tool to calculate
    Fibonacci numbers when asked.
  inputVariables:
    - query

tools:
  - function:fibonacci    # References fibonacci.function.js

output:
  format: text
```

### Parameter Types

- **string**: Text value
- **number**: Numeric value
- **boolean**: true/false
- **array**: Array of values
- **object**: JSON object
- **enum**: One of a fixed set (requires `values` array)

Example enum parameter:
```javascript
parameters: {
  operation: {
    type: 'enum',
    values: ['add', 'subtract', 'multiply', 'divide'],
    description: 'Math operation to perform',
  },
}
```

## MCP Servers

Model Context Protocol (MCP) servers provide external tools to agents. Configure MCP servers in `mcp.json` at the project root.

### MCP Configuration

```json
{
  "version": "1.0.0",
  "servers": {
    "<server-name>": {
      "transport": "streamable-http | stdio | sse | sse-only",
      "url": "https://server-url/mcp",
      "command": "node",
      "args": ["./mcp-server.js"],
      "env": { "KEY": "VALUE" },
      "headers": { "Authorization": "Bearer TOKEN" },
      "timeout": 30000,
      "enabled": true,
      "description": "Server description"
    }
  },
  "globalOptions": {
    "throwOnLoadError": false,
    "prefixToolNameWithServerName": true,
    "additionalToolNamePrefix": "",
    "defaultToolTimeout": 30000
  }
}
```

### Example MCP Configuration

```json
{
  "version": "1.0.0",
  "servers": {
    "fetch": {
      "transport": "streamable-http",
      "url": "https://remote.mcpservers.org/fetch/mcp",
      "description": "Web fetch capabilities",
      "timeout": 30000,
      "enabled": true
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "description": "File system access"
    }
  }
}
```

Reference MCP tools in agents:
```yaml
tools:
  - mcp:fetch    # All tools from "fetch" server
```

## Agent Orcha Studio

Agent Orcha includes a built-in web dashboard accessible at `http://localhost:3000` when the server is running. The Studio provides a visual interface for managing and testing your entire Agent Orcha instance.

### Tabs

- **Agents**: Browse all configured agents, invoke them with custom input, stream responses in real-time, and manage conversation sessions
- **Knowledge**: Browse and search knowledge stores, view entities and graph structure for stores with direct mapping
- **MCP**: Browse MCP servers, view available tools per server, and call tools directly
- **Workflows**: Browse and execute workflows (both step-based and ReAct), stream execution progress
- **Skills**: Browse and inspect available skills
- **Monitor**: View LLM call logs with context size, token estimates, and duration metrics
- **IDE**: Full in-browser file editor with file tree navigation, syntax highlighting for YAML, JSON, and JavaScript, and hot-reload on save

## API Reference

### Health Check

```
GET /health
Response: { "status": "ok", "timestamp": "..." }
```

### Authentication

When `AUTH_PASSWORD` is set, all `/api/*` routes require a valid session cookie. The `/health` endpoint is always public.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/check` | Check authentication status (never returns 401) |
| POST | `/api/auth/login` | Authenticate with password, returns session cookie |
| POST | `/api/auth/logout` | Invalidate session and clear cookie |

**Login Request:**
```json
{
  "password": "your-secret-password"
}
```

**Check Response:**
```json
{
  "authenticated": true,
  "required": true
}
```

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/:name` | Get agent details |
| POST | `/api/agents/:name/invoke` | Run agent |
| POST | `/api/agents/:name/stream` | Stream agent response (SSE) |
| GET | `/api/agents/sessions/stats` | Get session statistics |
| GET | `/api/agents/sessions/:sessionId` | Get session details |
| DELETE | `/api/agents/sessions/:sessionId` | Clear session messages |

**Invoke Request:**
```json
{
  "input": {
    "topic": "your topic",
    "context": "additional context"
  },
  "sessionId": "optional-session-id"
}
```

**Response:**
```json
{
  "output": "Agent response text",
  "metadata": {
    "tokensUsed": 150,
    "toolCalls": [],
    "duration": 1234,
    "sessionId": "optional-session-id",
    "messagesInSession": 4,
    "structuredOutputValid": true
  }
}
```

### Chat (Published Agents)

Standalone chat endpoints for published agents. Exempt from global `AUTH_PASSWORD` — each agent handles its own auth.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/chat/:agentName` | Serve standalone chat page |
| GET | `/api/chat/:agentName/config` | Get published agent config |
| POST | `/api/chat/:agentName/auth` | Authenticate with agent password |
| POST | `/api/chat/:agentName/stream` | Stream agent response (SSE) |

**Auth Request** (password-protected agents only):
```json
{ "password": "secret123" }
```

**Auth Response:**
```json
{ "token": "hex-token..." }
```

**Stream Request** (include `X-Chat-Token` header if password-protected):
```json
{
  "input": { "message": "Hello!" },
  "sessionId": "optional-session-id"
}
```

### Workflows

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workflows` | List all workflows |
| GET | `/api/workflows/:name` | Get workflow details |
| POST | `/api/workflows/:name/run` | Execute workflow |
| POST | `/api/workflows/:name/stream` | Stream workflow execution (SSE) |

**Run Request:**
```json
{
  "input": {
    "topic": "research topic",
    "style": "professional"
  }
}
```

**Response:**
```json
{
  "output": {
    "paper": "Final content",
    "summary": "Key points"
  },
  "metadata": {
    "duration": 5000,
    "stepsExecuted": 3,
    "success": true
  },
  "stepResults": {
    "research": { "output": "...", "metadata": {} },
    "summarize": { "output": "...", "metadata": {} }
  }
}
```

### Knowledge Stores

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/knowledge` | List all knowledge stores |
| GET | `/api/knowledge/:name` | Get knowledge store config |
| POST | `/api/knowledge/:name/search` | Search knowledge store |
| POST | `/api/knowledge/:name/refresh` | Reload documents |
| POST | `/api/knowledge/:name/add` | Add documents |
| GET | `/api/knowledge/:name/entities` | Get graph entities |
| GET | `/api/knowledge/:name/edges` | Get graph edges |

**Search Request:**
```json
{
  "query": "search term",
  "k": 4
}
```

### LLM

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/llm` | List all LLM configurations |
| GET | `/api/llm/:name` | Get LLM config details |
| POST | `/api/llm/:name/chat` | Chat with LLM (non-streaming) |
| POST | `/api/llm/:name/stream` | Chat with LLM (SSE streaming) |

**Chat Request:**
```json
{
  "message": "Your message"
}
```

### Functions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/functions` | List all functions |
| GET | `/api/functions/:name` | Get function details and schema |
| POST | `/api/functions/:name/call` | Call a function |

**Call Request:**
```json
{
  "arguments": {
    "a": 5,
    "b": 3,
    "operation": "add"
  }
}
```

### MCP

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mcp` | List all MCP servers |
| GET | `/api/mcp/:name` | Get MCP server config |
| GET | `/api/mcp/:name/tools` | List tools from server |
| POST | `/api/mcp/:name/call` | Call a tool on server |

**Call Tool Request:**
```json
{
  "tool": "tool-name",
  "arguments": { "url": "https://example.com" }
}
```

### Skills

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills` | List all skills |
| GET | `/api/skills/:name` | Get skill details |

### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List all tasks |
| POST | `/api/tasks` | Submit a new task |
| GET | `/api/tasks/:id` | Get task status |
| DELETE | `/api/tasks/:id` | Cancel a task |

### Files

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/files/tree` | Get project directory tree |
| GET | `/api/files/read?path=...` | Read file contents |
| PUT | `/api/files/write` | Write file contents |

**Write File Request:**
```json
{
  "path": "agents/new-agent.agent.yaml",
  "content": "name: new-agent\n..."
}
```

## Directory Structure

```
my-project/
├── agents/                     # Agent definitions (YAML)
├── workflows/                  # Workflow definitions (YAML)
├── knowledge/                  # Knowledge store configs and data
├── functions/                  # Custom function tools (JavaScript)
├── public/                     # Web UI (Studio)
│
├── llm.json                    # LLM and embedding configurations
├── mcp.json                    # MCP server configuration
└── .env                        # Environment variables
```

**Framework source structure:**

```
agent-orcha/
├── src/                        # Server/API code
│   ├── index.ts                # Entry point
│   ├── server.ts               # Fastify server setup
│   ├── cli/                    # CLI commands
│   └── routes/                 # API route handlers
│       ├── agents.route.ts
│       ├── workflows.route.ts
│       ├── knowledge.route.ts
│       ├── skills.route.ts
│       ├── tasks.route.ts
│       ├── llm.route.ts
│       ├── functions.route.ts
│       ├── mcp.route.ts
│       └── files.route.ts
│
├── lib/                        # Core library
│   ├── orchestrator.ts         # Main orchestrator class
│   ├── agents/                 # Agent system
│   │   ├── types.ts
│   │   ├── agent-loader.ts
│   │   ├── agent-executor.ts
│   │   └── structured-output-wrapper.ts
│   ├── workflows/              # Workflow system
│   │   ├── types.ts
│   │   ├── workflow-loader.ts
│   │   ├── workflow-executor.ts
│   │   └── react-workflow-executor.ts
│   ├── knowledge/              # Knowledge store system
│   │   ├── types.ts
│   │   ├── knowledge-store.ts
│   │   ├── sqlite-store.ts
│   │   └── direct-mapper.ts
│   ├── skills/                 # Skills system
│   │   └── skill-loader.ts
│   ├── tasks/                  # Task management
│   │   ├── task-manager.ts
│   │   └── task-store.ts
│   ├── sandbox/                # Sandbox execution
│   │   └── vm-executor.ts
│   ├── integrations/           # External integrations
│   │   └── integration-manager.ts
│   ├── triggers/               # Cron & webhook triggers
│   │   └── trigger-manager.ts
│   ├── memory/                 # Memory system
│   │   ├── conversation-store.ts
│   │   └── memory-manager.ts
│   ├── llm/                    # LLM factory + providers
│   │   ├── llm-factory.ts
│   │   └── providers/
│   ├── mcp/                    # MCP client
│   │   └── mcp-client.ts
│   ├── functions/              # Function loader
│   └── tools/                  # Tool registry and discovery
│       ├── tool-registry.ts
│       └── built-in/
│           └── knowledge-tools-factory.ts
│
├── public/                     # Web UI (Studio)
│   └── src/
│       ├── components/         # Web components
│       └── services/           # API client
│
├── templates/                  # Project initialization templates
└── docs/                       # Documentation website
```

## Tool Types

### Function Tools
Custom JavaScript functions you create in the `functions/` directory:
```yaml
tools:
  - function:fibonacci     # References fibonacci.function.js
  - function:calculator
```

### MCP Tools
External tools from MCP servers:
```yaml
tools:
  - mcp:fetch              # All tools from "fetch" server
```

### Knowledge Tools
Semantic search on knowledge stores:
```yaml
tools:
  - knowledge:transcripts  # Search "transcripts" store
  - knowledge:docs         # Search "docs" store
```

### Built-in Tools
Framework-provided tools:
```yaml
tools:
  - builtin:ask_user       # Human-in-the-loop (ReAct workflows)
  - builtin:memory_save    # Save to persistent memory
```

### Sandbox Tools
Sandboxed code execution, shell, and browser automation:
```yaml
tools:
  - sandbox:exec               # Execute JavaScript in sandboxed VM
  - sandbox:shell              # Execute shell commands (non-root sandbox user)
  - sandbox:web_fetch          # Fetch URLs from sandbox
  - sandbox:web_search         # Web search from sandbox
  - sandbox:browser_navigate   # Navigate browser to URL
  - sandbox:browser_observe    # Text snapshot of current page
  - sandbox:browser_click      # Click element by CSS selector
  - sandbox:browser_type       # Type text into element
  - sandbox:browser_screenshot # Take screenshot (multimodal image)
  - sandbox:browser_evaluate   # Execute JS in browser page
```

Browser tools require Chromium inside Docker (`BROWSER_SANDBOX=true`, enabled by default). A noVNC viewer is available at `http://localhost:6080`.

### Project Tools
Workspace file access:
```yaml
tools:
  - project:read           # Read project files
  - project:write          # Write project files
  - project:delete         # Delete files and unload resources
```

## License

MIT
