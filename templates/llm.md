# Agent Orcha - YAML Configuration Reference

> This document is the comprehensive reference for AI assistants helping users configure Agent Orcha projects. It covers all YAML/JSON configuration files, their schemas, and usage patterns.

## Quick Reference

| File | Location | Purpose |
|------|----------|---------|
| `llm.json` | Project root | LLM and embedding model configurations |
| `mcp.json` | Project root | MCP server configurations |
| `*.agent.yaml` | `agents/` | Agent definitions |
| `*.workflow.yaml` | `workflows/` | Workflow definitions (step-based or LangGraph) |
| `*.knowledge.yaml` | `knowledge/` | Knowledge store definitions (vector or graph-rag) |
| `*.function.js` | `functions/` | Custom function tools |
| `.env` | Project root | Environment variables |

---

## LLM Configuration (`llm.json`)

Central configuration for all LLM models and embedding models. Agents, workflows, and knowledge stores reference these by name.

### Full Schema

```json
{
  "version": "1.0",
  "models": {
    "<name>": {
      "provider": "openai | gemini | anthropic | local",
      "baseUrl": "string (optional - custom API endpoint)",
      "apiKey": "string (required)",
      "model": "string (required - model identifier)",
      "temperature": 0.7,
      "maxTokens": 4096
    }
  },
  "embeddings": {
    "<name>": {
      "provider": "openai | gemini | anthropic | local",
      "baseUrl": "string (optional)",
      "apiKey": "string (required)",
      "model": "string (required)",
      "dimensions": 1536,
      "eosToken": "string (optional - e.g. ' ' for Nomic models)"
    }
  }
}
```

### Notes

- All providers are treated as OpenAI-compatible APIs
- The `"default"` model name is used when agents don't specify an LLM
- **Local LLMs**: Use `baseUrl: "http://localhost:1234/v1"` (LM Studio) or `baseUrl: "http://localhost:11434/v1"` (Ollama)
- **Cloud providers**: Omit `baseUrl` to use the provider's default endpoint
- `eosToken` is needed for some embedding models (e.g., Nomic) to avoid SEP token warnings

### Example

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
    }
  }
}
```

---

## Agent Configuration (`*.agent.yaml`)

Agents are AI-powered units located in the `agents/` directory.

### Full Schema

```yaml
name: string                      # Unique identifier (required)
description: string               # Human-readable description (required)
version: string                   # Semantic version (default: "1.0.0")

llm: string | object              # LLM reference (required)
  # Simple: "default"
  # With override:
  #   name: default
  #   temperature: 0.3

prompt:                            # Prompt configuration (required)
  system: string                   # System message/instructions
  inputVariables:                  # Expected input field names
    - string

tools:                             # Tools available to agent (optional)
  - mcp:<server-name>              # MCP server tools
  - knowledge:<store-name>         # Knowledge store search
  - function:<function-name>       # Custom function
  - builtin:<tool-name>            # Built-in tools (e.g., ask_user)

output:                            # Output configuration (optional)
  format: text | json | structured # Default: text
  schema:                          # Required when format is "structured"
    type: object
    properties:
      <field>:
        type: string | number | boolean | array | object
        description: string
        enum: [values]             # For constrained string fields
        items:                     # For array fields
          type: string
        minimum: number            # For number fields
        maximum: number
    required:
      - field1
      - field2

metadata:                          # Custom metadata (optional)
  category: string
  tags: [string]
  features: [string]
```

### Output Formats

**Text** (default) - Returns plain text:
```yaml
output:
  format: text
```

**JSON** - Returns JSON string:
```yaml
output:
  format: json
```

**Structured** - Returns validated JSON matching a schema:
```yaml
output:
  format: structured
  schema:
    type: object
    properties:
      sentiment:
        type: string
        enum: [positive, negative, neutral]
      confidence:
        type: number
        minimum: 0
        maximum: 1
    required:
      - sentiment
      - confidence
```

### Conversation Memory

Agents automatically support conversation memory when a `sessionId` is provided in API calls. No agent-level configuration is required.

```bash
# API call with sessionId
curl -X POST http://localhost:3000/api/agents/chatbot/invoke \
  -H "Content-Type: application/json" \
  -d '{"input": {"message": "Hello"}, "sessionId": "user-123"}'
```

Memory settings (global, configured in orchestrator):
- `maxMessagesPerSession`: 50 (default)
- `sessionTTL`: optional, in milliseconds

### Example Agents

**Basic agent:**
```yaml
name: example
description: A helpful AI assistant
version: "1.0.0"

llm:
  name: default
  temperature: 0.7

prompt:
  system: |
    You are a helpful AI assistant.
  inputVariables:
    - query

tools: []

output:
  format: text
```

**Agent with knowledge search:**
```yaml
name: researcher
description: Researches topics using knowledge stores
version: "1.0.0"

llm:
  name: default
  temperature: 0.5

prompt:
  system: |
    You are a researcher. Search the knowledge base and provide answers.
  inputVariables:
    - topic

tools:
  - mcp:fetch
  - knowledge:my-knowledge

output:
  format: text
```

**Agent with structured output:**
```yaml
name: sentiment-structured
description: Sentiment analysis with structured output
version: "1.0.0"

llm:
  name: default
  temperature: 0

prompt:
  system: |
    Analyze the sentiment of the provided text.
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
      confidence:
        type: number
        minimum: 0
        maximum: 1
      keywords:
        type: array
        items:
          type: string
    required:
      - sentiment
      - confidence
```

---

## Workflow Configuration (`*.workflow.yaml`)

Workflows orchestrate multiple agents. Located in the `workflows/` directory. Two types: `steps` (default) and `langgraph`.

### Step-Based Workflows (`type: steps`)

Sequential/parallel agent orchestration with explicit step definitions.

#### Full Schema

```yaml
name: string                      # Unique identifier (required)
description: string               # Human-readable description (required)
version: string                   # Semantic version (default: "1.0.0")
type: steps                       # Explicit type (optional, "steps" is default)

input:                             # Input schema (required)
  schema:
    <field_name>:
      type: string | number | boolean | array | object
      required: boolean            # Default: false
      default: any                 # Default value
      description: string

steps:                             # Workflow steps (required)
  - id: string                    # Unique step identifier
    agent: string                  # Agent name to execute
    input:                         # Input mapping using templates
      <key>: "{{input.field}}"             # From workflow input
      <key>: "{{steps.stepId.output}}"     # From previous step output
      <key>: "{{steps.stepId.metadata.duration}}"  # From step metadata
    condition: string              # Optional conditional expression
    retry:                         # Optional retry configuration
      maxAttempts: number          # Default: 3
      delay: number                # Milliseconds between retries (default: 1000)
    output:
      key: string                  # Store output under this key

  # Parallel execution block
  - parallel:
      - id: step-a
        agent: agent-a
        input: { ... }
        output: { key: result_a }
      - id: step-b
        agent: agent-b
        input: { ... }
        output: { key: result_b }

config:                            # Workflow configuration (optional)
  timeout: number                  # Total timeout in ms (default: 300000)
  onError: stop | continue | retry # Error handling (default: stop)

output:                            # Output mapping (required)
  <key>: "{{steps.stepId.output}}"

metadata:                          # Custom metadata (optional)
  category: string
  tags: [string]
```

#### Template Syntax

| Template | Description |
|----------|-------------|
| `{{input.fieldName}}` | Access workflow input field |
| `{{steps.stepId.output}}` | Access step output |
| `{{steps.stepId.output.nested.path}}` | Access nested output |
| `{{steps.stepId.metadata.duration}}` | Access step metadata |

#### Example

```yaml
name: research-paper
description: Research a topic and write a paper
version: "1.0.0"

input:
  schema:
    topic:
      type: string
      required: true
    style:
      type: string
      default: "professional"

steps:
  - id: research
    agent: researcher
    input:
      topic: "{{input.topic}}"
    output:
      key: findings

  - id: write
    agent: writer
    input:
      research: "{{steps.research.output}}"
      style: "{{input.style}}"
    output:
      key: paper

config:
  timeout: 600000
  onError: stop

output:
  paper: "{{steps.write.output}}"
  findings: "{{steps.research.output}}"
```

---

### LangGraph Workflows (`type: langgraph`)

Autonomous, prompt-driven workflows using LangGraph. The agent decides which tools and agents to call based on the prompt.

#### Full Schema

```yaml
name: string                      # Unique identifier (required)
description: string               # Human-readable description (required)
version: string                   # Semantic version (default: "1.0.0")
type: langgraph                   # Required for LangGraph workflows

input:                             # Input schema (required)
  schema:
    <field_name>:
      type: string | number | boolean | array | object
      required: boolean
      description: string

prompt:                            # Prompt configuration (required)
  system: string                   # System message with instructions
  goal: string                     # Goal template (supports {{input.*}} interpolation)

graph:                             # LangGraph configuration (required)
  model: string                    # LLM config name from llm.json

  executionMode: react | single-turn  # Default: react
  # react: Full ReAct loop, multiple rounds of tool calls
  # single-turn: Calls tools once and returns

  tools:                           # Tool discovery config
    mode: all | include | exclude | none  # Default: all
    sources:                       # Tool source types (default: all)
      - mcp
      - knowledge
      - function
      - builtin
    include: [string]              # Tool names to include (for mode: include)
    exclude: [string]              # Tool names to exclude (for mode: exclude)

  agents:                          # Agent discovery config
    mode: all | include | exclude | none  # Default: all
    include: [string]              # Agent names to include
    exclude: [string]              # Agent names to exclude

  maxIterations: number            # Max tool-calling iterations (default: 10)
  timeout: number                  # Timeout in ms (default: 300000)

output:                            # Output extraction (required)
  <key>: "{{state.messages[-1].content}}"  # Last message content

config:                            # Workflow configuration (optional)
  onError: stop | continue | retry

metadata:                          # Custom metadata (optional)
  category: string
  tags: [string]
```

#### Execution Modes

**Single-Turn** (`executionMode: single-turn`):
- Agent calls tools once, then returns
- Fast, predictable, lower token usage
- Best for: research, data gathering, straightforward tasks

**ReAct** (`executionMode: react`):
- Agent can call tools in multiple rounds
- Can analyze intermediate results and refine
- Best for: complex multi-step problems, iterative analysis
- Use `maxIterations` to prevent runaway loops

#### Tool and Agent Discovery

Tools from all configured sources (MCP, knowledge, functions, builtins) are automatically discovered and made available to the LangGraph agent. Agents are wrapped as callable tools.

```yaml
# Discover all tools and agents
graph:
  tools:
    mode: all
  agents:
    mode: all

# Only specific tools
graph:
  tools:
    mode: include
    include: ["vector_search_knowledge", "mcp_fetch"]
  agents:
    mode: include
    include: [math, researcher]

# All tools except specific ones
graph:
  tools:
    mode: exclude
    exclude: ["function_dangerous"]
  agents:
    mode: none  # No agent discovery
```

#### Human-in-the-Loop

LangGraph workflows support the `builtin:ask_user` tool. When called, the workflow pauses (via `NodeInterrupt`) and waits for user input.

```yaml
prompt:
  system: |
    If you need clarification from the user, use the ask_user tool.
  goal: "Research: {{input.topic}}"

graph:
  tools:
    mode: all
    sources: [mcp, knowledge, function, builtin]  # builtin includes ask_user
```

#### Examples

**Single-turn research workflow:**
```yaml
name: langgraph-research
description: Autonomous research using tool discovery
version: "1.0.0"
type: langgraph

input:
  schema:
    topic:
      type: string
      required: true

prompt:
  system: |
    You are a research assistant with access to tools and agents.
    Identify all tools you need, call them in parallel, then synthesize results.
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

**Multi-turn ReAct workflow:**
```yaml
name: langgraph-multi-turn
description: Iterative analysis with ReAct pattern
version: "1.0.0"
type: langgraph

input:
  schema:
    topic:
      type: string
      required: true

prompt:
  system: |
    You are an analyst that iteratively refines understanding.
    1. Gather initial information
    2. Analyze and identify gaps
    3. Call more tools to fill gaps
    4. Provide final synthesized answer
  goal: "Provide a thorough analysis of: {{input.topic}}"

graph:
  model: default
  executionMode: react
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

---

## Knowledge Configuration (`*.knowledge.yaml`)

Knowledge stores provide semantic search and RAG capabilities. Located in the `knowledge/` directory. Two kinds: `vector` (default) and `graph-rag`.

### Vector Knowledge (`kind: vector`)

Traditional vector store with embeddings for semantic search.

#### Full Schema

```yaml
name: string                      # Unique identifier (required)
description: string               # Human-readable description (required)
kind: vector                      # Optional (vector is default)

source:                            # Data source (required)
  # Directory source
  type: directory
  path: string                    # Path relative to project root
  pattern: string                 # Glob pattern (e.g., "*.txt")
  recursive: boolean              # Default: true

  # File source
  type: file
  path: string                    # Single file path

  # Database source
  type: database
  connectionString: string        # postgresql:// or mysql://
  query: string                   # SQL query
  contentColumn: string           # Column with content (default: "content")
  metadataColumns: [string]       # Columns for metadata
  batchSize: number               # Rows per batch (default: 100)

  # Web source
  type: web
  url: string                     # URL to scrape
  selector: string                # CSS selector (optional)
  headers:                        # Custom headers (optional)
    Authorization: "Bearer TOKEN"

  # S3 source
  type: s3
  bucket: string                  # S3 bucket name
  prefix: string                  # Folder filter (optional)
  endpoint: string                # Custom S3 endpoint (optional, for MinIO/Wasabi)
  region: string                  # Default: us-east-1
  accessKeyId: string             # Optional (uses env vars if omitted)
  secretAccessKey: string         # Optional (uses env vars if omitted)
  pattern: string                 # File glob pattern (optional)
  forcePathStyle: boolean         # Default: false (set true for MinIO)

loader:                            # Document loader (required)
  type: text | pdf | csv | json | markdown
  options: {}                      # Loader-specific options

splitter:                          # Text chunking (required)
  type: character | recursive | token | markdown
  chunkSize: number               # Characters per chunk (default: 1000)
  chunkOverlap: number            # Overlap between chunks (default: 200)
  separator: string               # Custom separator (optional)

embedding: string                  # Embedding config name from llm.json (default: "default")

store:                             # Vector store backend (required)
  type: memory | chroma | pinecone | qdrant
  options:                         # Store-specific options
    path: string                   # Storage path (for chroma)
    collectionName: string         # Collection name
    url: string                    # Server URL (for chroma, qdrant)

search:                            # Search configuration (optional)
  defaultK: number                # Results per search (default: 4)
  scoreThreshold: number          # Minimum similarity 0-1

metadata:                          # Custom metadata (optional)
  category: string
```

#### Examples

**Basic directory source:**
```yaml
name: docs
description: Documentation knowledge base

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

store:
  type: memory

search:
  defaultK: 4
```

**Database source (PostgreSQL):**
```yaml
name: postgres-docs
description: Documentation from PostgreSQL

source:
  type: database
  connectionString: postgresql://user:password@localhost:5432/docs_db
  query: SELECT content, title, category FROM documents WHERE published = true
  contentColumn: content
  metadataColumns:
    - title
    - category
  batchSize: 100

loader:
  type: text

splitter:
  type: recursive
  chunkSize: 1000
  chunkOverlap: 200

embedding: default
store:
  type: memory
```

**S3 source (MinIO):**
```yaml
name: s3-docs
description: Documents from MinIO S3 storage

source:
  type: s3
  endpoint: http://localhost:9000
  bucket: knowledge-base
  prefix: documentation/
  region: us-east-1
  accessKeyId: minioadmin
  secretAccessKey: minioadmin
  pattern: "*.{pdf,txt,md}"
  forcePathStyle: true

loader:
  type: text

splitter:
  type: recursive
  chunkSize: 1000
  chunkOverlap: 200

embedding: default
store:
  type: memory
```

**Web scraping source:**
```yaml
name: web-docs
description: Documentation scraped from website

source:
  type: web
  url: https://docs.example.com/guide/
  selector: article.documentation

loader:
  type: text

splitter:
  type: markdown
  chunkSize: 1500
  chunkOverlap: 100

embedding: default
store:
  type: memory
```

---

### GraphRAG Knowledge (`kind: graph-rag`)

Entity extraction and knowledge graph with community detection for advanced analysis.

#### Full Schema

```yaml
name: string                      # Unique identifier (required)
kind: graph-rag                   # Required for GraphRAG
description: string               # Human-readable description (required)

source:                            # Same source types as vector (required)
  type: directory | file | database | web | s3
  # ... same fields as vector sources

loader:                            # Document loader (required)
  type: text | pdf | csv | json | markdown

splitter:                          # Text chunking (required)
  type: character | recursive | token | markdown
  chunkSize: number
  chunkOverlap: number

embedding: string                  # Embedding config name from llm.json

graph:                             # Graph configuration (required)
  extraction:                      # Entity extraction config
    llm: string                    # LLM name from llm.json (default: "default")
    entityTypes:                   # Optional - omit for automatic extraction
      - name: string
        description: string
    relationshipTypes:             # Optional - omit for automatic extraction
      - name: string
        description: string

  communities:                     # Community detection config
    algorithm: louvain             # Only supported algorithm
    resolution: number             # Louvain resolution (default: 1.0)
    minSize: number                # Min community size (default: 2)
    summaryLlm: string             # LLM for community summaries (default: "default")

  store:                           # Graph store backend
    type: memory                   # Default: memory
    options: {}                    # Store-specific options

  cache:                           # Graph cache config
    enabled: boolean               # Default: true
    directory: string              # Default: ".graph-cache"

search:                            # Search configuration (optional)
  defaultK: number                # Results per search (default: 10)
  localSearch:                     # Entity neighborhood search
    maxDepth: number               # Graph traversal depth (default: 2)
  globalSearch:                    # Community-level search
    topCommunities: number         # Communities to consider (default: 5)
    llm: string                    # LLM for synthesis (default: "default")

metadata:                          # Custom metadata (optional)
  category: string
```

#### How GraphRAG Works

1. **Extraction**: Documents are split and an LLM extracts entities and relationships
2. **Graph Building**: Entities become nodes, relationships become edges
3. **Community Detection**: Louvain algorithm groups related entities into communities
4. **Community Summaries**: An LLM generates summaries for each community
5. **Search**:
   - **Local search**: Finds specific entities and traverses their neighborhood
   - **Global search**: Analyzes community-level summaries for thematic queries

#### Example

```yaml
name: call-center-analysis
kind: graph-rag
description: GraphRAG for analyzing call center transcripts

source:
  type: directory
  path: knowledge/transcripts
  pattern: "*.txt"
  recursive: true

loader:
  type: text

splitter:
  type: recursive
  chunkSize: 2000
  chunkOverlap: 200

embedding: default

graph:
  extraction:
    llm: default
    entityTypes:
      - name: Agent
        description: "Call center representative"
      - name: Customer
        description: "Person calling"
      - name: Vehicle
        description: "Car discussed"
      - name: Outcome
        description: "Result of the call"
    relationshipTypes:
      - name: HANDLED_BY
        description: "Call was handled by an agent"
      - name: INTERESTED_IN
        description: "Customer interest in vehicle"
      - name: RESULTED_IN
        description: "Call resulted in outcome"

  communities:
    algorithm: louvain
    resolution: 1.0
    minSize: 2
    summaryLlm: default

  store:
    type: memory

  cache:
    enabled: true
    directory: .graph-cache

search:
  defaultK: 10
  localSearch:
    maxDepth: 2
  globalSearch:
    topCommunities: 5
    llm: default
```

---

## Function Configuration (`*.function.js`)

Custom JavaScript tools located in the `functions/` directory. Each file exports a default object with the function definition.

### Schema

```javascript
export default {
  name: 'function-name',           // Unique identifier (required)
  description: 'What it does',     // Description for the LLM (required)

  parameters: {                    // Input parameters (required)
    paramName: {
      type: 'string',             // string | number | boolean | array | object | enum
      description: 'Description', // Description for the LLM
      required: true,              // Default: true
      default: 'value',           // Default value (optional)
      values: ['a', 'b'],         // For enum type only
    },
  },

  execute: async ({ paramName }) => {
    // Your logic here (required)
    return 'Result string';
  },
};

// Optional metadata
export const metadata = {
  name: 'function-name',
  description: 'Description',
  version: '1.0.0',
  author: 'Author',
  tags: ['category'],
};
```

### Parameter Types

| Type | Description | Extra Fields |
|------|-------------|-------------|
| `string` | Text value | - |
| `number` | Numeric value | - |
| `boolean` | true/false | - |
| `array` | Array of values | - |
| `object` | JSON object | - |
| `enum` | Fixed set of values | `values: ['a', 'b']` |

### Example

```javascript
// functions/calculator.function.js

export default {
  name: 'calculator',
  description: 'Performs basic arithmetic operations',

  parameters: {
    a: { type: 'number', description: 'First number' },
    b: { type: 'number', description: 'Second number' },
    operation: {
      type: 'enum',
      values: ['add', 'subtract', 'multiply', 'divide'],
      description: 'Operation to perform',
    },
  },

  execute: async ({ a, b, operation }) => {
    switch (operation) {
      case 'add': return `${a} + ${b} = ${a + b}`;
      case 'subtract': return `${a} - ${b} = ${a - b}`;
      case 'multiply': return `${a} * ${b} = ${a * b}`;
      case 'divide': return `${a} / ${b} = ${a / b}`;
    }
  },
};
```

### Using in Agents

```yaml
tools:
  - function:calculator    # References calculator.function.js
  - function:fibonacci     # References fibonacci.function.js
```

---

## MCP Configuration (`mcp.json`)

Model Context Protocol server configuration at the project root.

### Full Schema

```json
{
  "version": "1.0.0",
  "servers": {
    "<server-name>": {
      "transport": "stdio | streamable-http | sse | sse-only",
      "url": "string (for remote transports)",
      "headers": { "key": "value" },
      "command": "string (for stdio transport)",
      "args": ["string"],
      "env": { "KEY": "VALUE" },
      "description": "string",
      "timeout": 30000,
      "enabled": true
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

### Transport Types

| Transport | Use Case | Required Fields |
|-----------|----------|----------------|
| `stdio` | Local CLI tools | `command`, `args` |
| `streamable-http` | Remote HTTP servers | `url` |
| `sse` | Server-Sent Events | `url` |
| `sse-only` | SSE without HTTP fallback | `url` |

### Example

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
  },
  "globalOptions": {
    "throwOnLoadError": false,
    "prefixToolNameWithServerName": true
  }
}
```

### Using in Agents

```yaml
tools:
  - mcp:fetch              # All tools from "fetch" server
  - mcp:filesystem         # All tools from "filesystem" server
```

---

## Tool Reference

All tool types and their prefixes for use in agent `tools` lists and LangGraph discovery:

| Prefix | Source | Example |
|--------|--------|---------|
| `mcp:<server>` | MCP server tools | `mcp:fetch` |
| `knowledge:<store>` | Knowledge store search | `knowledge:docs` |
| `function:<name>` | Custom JavaScript functions | `function:calculator` |
| `builtin:<name>` | Framework built-in tools | `builtin:ask_user` |

### Built-in Tools

| Tool | Description |
|------|-------------|
| `builtin:ask_user` | Pause execution and request user input (LangGraph only) |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `ORCHA_BASE_DIR` | Current directory | Base directory for all config files |
| `CORS_ORIGIN` | `true` | CORS origin policy |
| `NODE_ENV` | - | Node.js environment |

For S3 knowledge sources (when not specified in YAML):
| Variable | Description |
|----------|-------------|
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_REGION` | AWS region |
| `S3_ENDPOINT` | Custom S3 endpoint |

---

## Tips

### Choosing an Execution Mode for LangGraph

| Your Task | Recommended Mode |
|-----------|-----------------|
| Simple research/data gathering | `single-turn` |
| Gather and summarize | `single-turn` |
| Call specific agents | `single-turn` |
| Multi-step problem solving | `react` |
| Iterative refinement | `react` |
| Unknown complexity | Start with `single-turn` |

### When to Use GraphRAG vs Vector

| Use Case | Recommendation |
|----------|---------------|
| Simple document search | Vector |
| FAQ/knowledge base lookup | Vector |
| Entity relationship analysis | GraphRAG |
| Thematic/pattern analysis | GraphRAG |
| Small dataset (<100 docs) | Vector |
| Complex interconnected data | GraphRAG |

### Common Patterns

**Agent with memory + tools:**
```yaml
name: smart-chatbot
llm: { name: default, temperature: 0.7 }
prompt:
  system: |
    You are a helpful assistant with access to tools.
    Use conversation context to provide relevant responses.
  inputVariables:
    - message
tools:
  - mcp:fetch
  - knowledge:docs
  - function:calculator
output:
  format: text
```

**Workflow with parallel steps:**
```yaml
steps:
  - parallel:
      - id: research
        agent: researcher
        input: { topic: "{{input.topic}}" }
        output: { key: research }
      - id: data
        agent: data-analyst
        input: { query: "{{input.topic}}" }
        output: { key: data }
  - id: synthesize
    agent: writer
    input:
      research: "{{steps.research.output}}"
      data: "{{steps.data.output}}"
    output: { key: final }
```

**LangGraph with filtered tools:**
```yaml
type: langgraph
graph:
  model: default
  executionMode: single-turn
  tools:
    mode: include
    include: ["vector_search_docs", "mcp_fetch"]
  agents:
    mode: none
  maxIterations: 5
```
