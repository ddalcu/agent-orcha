# Agent Orchestrator Project

This project was initialized with Agent Orchestrator - a TypeScript framework for building and orchestrating multi-agent AI systems.

## Getting Started

### 1. Configure LLM Settings

Edit `llm.json` to configure your LLM providers:

```json
{
  "version": "1.0",
  "models": {
    "default": {
      "provider": "openai",
      "baseUrl": "http://localhost:1234/v1",  // For local LLMs (LM Studio, Ollama)
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

**Supported Providers:**
- Local: LM Studio (`http://localhost:1234/v1`), Ollama (`http://localhost:11434/v1`)
- Cloud: OpenAI, Google Gemini, Anthropic Claude

### 2. Start the Server

```bash
npx agent-orcha start
```

The server will run at `http://localhost:3000`

### 3. Test Your Agent

```bash
curl -X POST http://localhost:3000/api/agents/example/invoke \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "Hello, how are you?"}}'
```

## Project Structure

```
.
├── agents/              # Agent definitions (YAML)
├── workflows/           # Workflow definitions (YAML)
├── vectors/             # Vector store configs and data
├── functions/           # Custom function tools (JavaScript)
├── llm.json            # LLM and embedding configurations
├── mcp.json            # MCP server configurations (optional)
└── .env                # Environment variables (optional)
```

## Creating Agents

Create a new file in `agents/` directory:

```yaml
# agents/my-agent.agent.yaml

name: my-agent
description: Description of what this agent does
version: "1.0.0"

llm:
  name: default
  temperature: 0.7

prompt:
  system: |
    You are a helpful assistant that...
  inputVariables:
    - query

tools: []

output:
  format: text
```

## Creating Workflows

Create a new file in `workflows/` directory:

```yaml
# workflows/my-workflow.workflow.yaml

name: my-workflow
description: Description of the workflow
version: "1.0.0"

input:
  schema:
    topic:
      type: string
      required: true

steps:
  - id: step1
    agent: my-agent
    input:
      query: "{{input.topic}}"
    output:
      key: result

output:
  result: "{{steps.step1.output}}"
```

## Using Vector Stores

1. Add documents to `vectors/sample-data/`
2. Configure vector store in `vectors/`:

```yaml
# vectors/my-knowledge.vector.yaml

name: my-knowledge
description: My knowledge base

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

embedding: default

store:
  type: memory  # Use 'chroma' for persistent storage
```

**For persistent storage with Chroma:**
```yaml
store:
  type: chroma
  options:
    path: .chroma                    # Where to store data
    collectionName: my-knowledge     # Collection name
    url: http://localhost:8000       # Chroma server URL
```

**Note:** To use Chroma, run the server:
```bash
docker run -p 8000:8000 chromadb/chroma
```

3. Reference in agent:

```yaml
tools:
  - vector:my-knowledge
```

## Using MCP Servers

Configure MCP servers in `mcp.json`:

```json
{
  "servers": {
    "fetch": {
      "transport": "streamable-http",
      "url": "https://remote.mcpservers.org/fetch/mcp",
      "enabled": true
    }
  }
}
```

Reference in agent:

```yaml
tools:
  - mcp:fetch
```

## API Endpoints

- `GET /api/agents` - List all agents
- `POST /api/agents/:name/invoke` - Invoke an agent
- `GET /api/workflows` - List all workflows
- `POST /api/workflows/:name/run` - Run a workflow
- `POST /api/vectors/:name/search` - Search vector store

## Web UI

Open `http://localhost:3000` in your browser to access the interactive UI for testing agents and workflows.

## Using as a Library

You can also use Agent Orchestrator programmatically:

```javascript
import { Orchestrator } from 'agent-orcha';

const orchestrator = new Orchestrator({ projectRoot: '.' });
await orchestrator.initialize();

// Invoke an agent
const result = await orchestrator.agents.invoke('my-agent', {
  query: 'Hello world'
});

console.log(result.output);
```

## Documentation

Full documentation: https://github.com/ddalcu/agent-orcha

## License

MIT
