<p align="center">
  <img src="docs/assets/images/logo.png" alt="Agent Orcha Logo" width="300">
</p>

# Agent Orcha

Agent Orcha is a declarative framework designed to build, manage, and scale multi-agent AI systems with ease. It combines the flexibility of TypeScript with the simplicity of YAML to orchestrate complex workflows, manage diverse tools via MCP, and integrate semantic search seamlessly. Built for developers and operators who demand reliability, extensibility, and clarity in their AI operations.

## Why Agent Orcha?

- **Declarative AI**: Define agents, workflows, and infrastructure in clear, version-controlled YAML files. No more spaghetti code.
- **Model Agnostic**: Seamlessly swap between OpenAI, Gemini, Anthropic, or local LLMs (Ollama, LM Studio) without rewriting logic.
- **Universal Tooling**: Leverage the **Model Context Protocol (MCP)** to connect agents to any external service, API, or database instantly.
- **RAG Native**: Built-in vector store integration (Chroma, Memory) makes semantic search and knowledge retrieval a first-class citizen.
- **Robust Workflow Engine**: Orchestrate complex multi-agent sequences with parallel execution, conditional logic, dynamic input interpolation, and state management.
- **Production Ready**: Includes a high-performance Fastify REST API, Server-Sent Events (SSE) for real-time streaming, and comprehensive logging.
- **Developer Experience**: Fully typed interfaces, intuitive CLI tooling, and a modular architecture designed for rapid iteration from prototype to production.
- **Extensible Functions**: Drop in simple JavaScript functions to extend agent capabilities with zero boilerplate.

## Overview

Agent Orcha enables you to:

- **Define agents** using YAML configuration files with customizable LLM providers, prompts, and tools
- **Create workflows** that coordinate multiple agents in sequential or parallel execution
- **Integrate vector stores** for RAG (Retrieval Augmented Generation) capabilities
- **Connect MCP servers** to extend agent capabilities with external tools
- **Create local Functions** give your agents the ability to call your own custom code

### Alpha Status and Security Notice

**This project is currently in ALPHA state.** No security precautions have been implemented yet. This software should **ALWAYS** be deployed behind a firewall without open access to its APIs. It is designed for **internal use only** and should never be exposed directly to the public internet.


## Usage
- **Use as is** check out and run
- **Use as a library** in your TypeScript/JavaScript projects
- **Use as a CLI** with npx for standalone agent orchestration (recommended)

**Requirements:** Node.js >= 20.0.0


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

### Library Usage

```typescript
import { Orchestrator } from 'agent-orcha';

const orchestrator = new Orchestrator({
  projectRoot: './my-agents-project'
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

// Clean up
await orchestrator.close();
```

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
| `npm run build` | Build for production |
| `npm start` | Run production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript type checking |

## Configuration

### LLM Configuration (llm.json)

All LLM and embedding configurations are defined in `llm.json` at the project root. Agents and vector stores reference these configs by name.

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
  - vector:<store-name>         # Vector store search
  - builtin:<tool-name>         # Built-in tools

output:                         # Output formatting (optional)
  format: text | json | structured

metadata:                       # Custom metadata (optional)
  category: string
  tags: [string]
```

### Example Agent

```yaml
# agents/researcher.agent.yaml

name: researcher
description: Researches topics using web fetch and vector search
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
  - vector:transcripts

output:
  format: text

metadata:
  category: research
  tags: [research, web, vectors]
```

## Workflows

Workflows orchestrate multiple agents in a defined sequence. Define workflows in YAML files within the `workflows/` directory.

### Workflow Schema

```yaml
# workflows/<name>.workflow.yaml

name: string                    # Unique identifier (required)
description: string             # Human-readable description (required)
version: string                 # Semantic version (default: "1.0.0")

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

### Template Syntax

Access data within workflows using double curly braces:

| Template | Description |
|----------|-------------|
| `{{input.fieldName}}` | Access workflow input field |
| `{{steps.stepId.output}}` | Access step output |
| `{{steps.stepId.output.nested.path}}` | Access nested output |
| `{{steps.stepId.metadata.duration}}` | Access step metadata |

### Example Workflow

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

## Vector Stores

Vector stores enable semantic search and RAG capabilities. Define vector stores in YAML files within the `vectors/` directory.

### Vector Store Schema

```yaml
# vectors/<name>.vector.yaml

name: string                    # Unique identifier (required)
description: string             # Human-readable description (required)

source:                         # Data source (required)
  type: directory | file | url
  path: string                  # Path relative to project root
  pattern: string               # Glob pattern for directories
  recursive: boolean            # Recursive search (default: true)

loader:                         # Document loader (required)
  type: text | pdf | csv | json | markdown

splitter:                       # Text chunking (required)
  type: character | recursive | token | markdown
  chunkSize: number             # Characters per chunk (default: 1000)
  chunkOverlap: number          # Overlap between chunks (default: 200)

embedding: string               # Reference to embedding config in llm.json (default: "default")

store:                          # Vector store backend (required)
  type: memory | chroma 
  options:                      # Store-specific options (optional)
    path: string                # Storage path (for chroma)
    collectionName: string      # Collection name (for chroma)
    url: string                 # Server URL (for chroma, qdrant)

search:                         # Search configuration (optional)
  defaultK: number              # Results per search (default: 4)
  scoreThreshold: number        # Minimum similarity (0-1)
```

### Example Vector Store

```yaml
# vectors/transcripts.vector.yaml

name: transcripts
description: Meeting transcripts for context retrieval

source:
  type: directory
  path: vectors/sample-data
  pattern: "*.txt"

loader:
  type: text

splitter:
  type: character
  chunkSize: 1000
  chunkOverlap: 200

embedding: default  # References embedding config in llm.json

store:
  type: memory

search:
  defaultK: 4
  scoreThreshold: 0.2
```

**Note:** Vector stores are initialized on startup, loading documents and creating embeddings immediately.

### Vector Store Types

#### Memory (Development)
In-memory vector storage. Fast but not persistent - embeddings are recreated on every startup.

```yaml
store:
  type: memory
```

**Use cases:** Development, testing, small datasets

#### Chroma (Production - Local)
Persistent local vector storage using Chroma. Embeddings are cached and reused across restarts.

```yaml
store:
  type: chroma
  options:
    path: .chroma                    # Storage directory (default: .chroma)
    collectionName: my-collection    # Collection name (default: vector store name)
    url: http://localhost:8000       # Chroma server URL (default: http://localhost:8000)
```

**Setup:**
```bash
# Option 1: Run Chroma server with Docker
docker run -p 8000:8000 chromadb/chroma

# Option 2: Install and run Chroma locally
pip install chromadb
chroma run --path .chroma --port 8000
```


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
      "transport": "streamable-http | stdio | sse",
      "url": "https://server-url/mcp",
      "command": "node",
      "args": ["./mcp-server.js"],
      "timeout": 30000,
      "enabled": true,
      "description": "Server description"
    }
  },
  "globalOptions": {
    "throwOnLoadError": false,
    "prefixToolNameWithServerName": true,
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
    }
  }
}
```

Reference MCP tools in agents:
```yaml
tools:
  - mcp:fetch    # All tools from "fetch" server
```

## API Reference

### Health Check

```
GET /health
Response: { "status": "ok", "timestamp": "..." }
```

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/:name` | Get agent details |
| POST | `/api/agents/:name/invoke` | Run agent |
| POST | `/api/agents/:name/stream` | Stream agent response (SSE) |

**Invoke Request:**
```json
{
  "input": {
    "topic": "your topic",
    "context": "additional context"
  }
}
```

**Response:**
```json
{
  "output": "Agent response text",
  "metadata": {
    "tokensUsed": 150,
    "toolCalls": [],
    "duration": 1234
  }
}
```

### Workflows

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workflows` | List all workflows |
| GET | `/api/workflows/:name` | Get workflow details |
| POST | `/api/workflows/:name/run` | Execute workflow |

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
    "research": { "output": "...", "metadata": {...} },
    "summarize": { "output": "...", "metadata": {...} }
  }
}
```

### Vector Stores

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/vectors` | List all vector stores |
| GET | `/api/vectors/:name` | Get vector store config |
| POST | `/api/vectors/:name/search` | Search vector store |
| POST | `/api/vectors/:name/refresh` | Reload documents |
| POST | `/api/vectors/:name/add` | Add documents |

**Search Request:**
```json
{
  "query": "search term",
  "k": 4
}
```

## Directory Structure

```
agent-orcha/
├── src/                        # Server/API code
│   ├── index.ts                # Entry point
│   ├── server.ts               # Fastify server setup
│   └── routes/                 # API route handlers
│       ├── agents.route.ts
│       ├── workflows.route.ts
│       └── vectors.route.ts
│
├── lib/                        # Core library
│   ├── orchestrator.ts         # Main orchestrator class
│   ├── agents/                 # Agent system
│   │   ├── types.ts
│   │   ├── agent-loader.ts
│   │   └── agent-executor.ts
│   ├── workflows/              # Workflow system
│   │   ├── types.ts
│   │   ├── workflow-loader.ts
│   │   └── workflow-executor.ts
│   ├── vectors/                # Vector store system
│   │   ├── types.ts
│   │   └── vector-store-manager.ts
│   ├── llm/                    # LLM factory
│   │   └── llm-factory.ts
│   ├── mcp/                    # MCP client
│   │   └── mcp-client.ts
│   └── tools/                  # Tool registry
│       └── tool-registry.ts
│
├── agents/                     # Agent definitions (YAML)
├── workflows/                  # Workflow definitions (YAML)
├── vectors/                    # Vector store configs and data
├── functions/                  # Custom function tools (JavaScript)
├── public/                     # Web UI
│
├── package.json
├── tsconfig.json
├── llm.json                    # LLM and embedding configurations
├── mcp.json                    # MCP server configuration
└── .env                        # Environment variables
```

**Referencing in agents:**

```yaml
# Simple reference
llm: default

# With temperature override
llm:
  name: default
  temperature: 0.3
```

## Tool Types

### Function Tools
Custom JavaScript/TypeScript functions you create in the `functions/` directory:
```yaml
tools:
  - function:fibonacci     # References fibonacci.function.js
  - function:your-custom-function
```

### MCP Tools
External tools from MCP servers:
```yaml
tools:
  - mcp:fetch              # All tools from "fetch" server
```

### Vector Tools
Semantic search on vector stores:
```yaml
tools:
  - vector:transcripts     # Search "transcripts" store
```

### Built-in Tools
Framework-provided tools:
```yaml
tools:
  - builtin:tool_name
```

## Web UI

Access the web interface at `http://localhost:3000` after starting the server. The UI provides:

- **Agents Tab**: Select and run individual agents with custom input
- **Workflows Tab**: Select workflows, view flow diagrams, and execute with inputs

The workflow flow diagram visualizes:
- Step sequence with agent names
- Tool badges (MCP servers, vector databases)
- Input/output nodes

## License

MIT
