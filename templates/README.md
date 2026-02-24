# Agent Orcha Project

This project was initialized with Agent Orcha - a TypeScript framework for building and orchestrating multi-agent AI systems.

## Quick Start

### 1. Configure LLM Settings

Edit `llm.json` to configure your LLM providers:

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

**Supported Providers:**
- Local: LM Studio (`http://localhost:1234/v1`), Ollama (`http://localhost:11434/v1`)
- Cloud: OpenAI, Google Gemini, Anthropic Claude

### 2. Start the Server

```bash
npx agent-orcha start
```

The server and Studio dashboard will be available at `http://localhost:3000`.

To enable password authentication, set `AUTH_PASSWORD` in your `.env` file:
```bash
AUTH_PASSWORD=your-secret-password
```

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
├── knowledge/           # Knowledge store configs and data
├── functions/           # Custom function tools (JavaScript)
├── skills/              # Skill definitions (Markdown)
├── llm.json             # LLM and embedding configurations
├── mcp.json             # MCP server configurations (optional)
├── sandbox.json         # Sandbox configuration (optional)
└── .env                 # Environment variables (optional)
```

## Configuration Files

| File | Location | Description |
|------|----------|-------------|
| `*.agent.yaml` | `agents/` | Agent definitions with LLM, prompt, tools, and output format |
| `*.workflow.yaml` | `workflows/` | Workflows - step-based (sequential/parallel) or ReAct (autonomous) |
| `*.knowledge.yaml` | `knowledge/` | Knowledge stores - SQLite-based vector search with optional direct graph mapping |
| `*.function.js` | `functions/` | Custom JavaScript tools for agents |
| `llm.json` | Root | LLM model and embedding configurations |
| `mcp.json` | Root | MCP server connections for external tools |

## Key Features

- **Agents**: YAML-defined AI units with tools, structured output, conversation memory, skills, and triggers
- **Workflows**: Step-based orchestration or ReAct autonomous workflows with tool/agent discovery
- **Knowledge Stores**: SQLite-based vector search with optional direct graph mapping
- **Skills**: Prompt augmentation via Markdown files attached to agents
- **Tasks**: Submit, track, and cancel async agent tasks
- **Sandbox**: Sandboxed code execution with `sandbox_exec`, `sandbox_web_fetch`, `sandbox_web_search`
- **Triggers**: Cron and webhook triggers for automated agent invocation
- **Functions**: Custom JavaScript tools with typed parameters
- **MCP Servers**: Connect to external tools via Model Context Protocol
- **Studio**: Web dashboard with agent testing, knowledge browsing, skills, monitoring, and in-browser IDE

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/agents` | List all agents |
| `POST /api/agents/:name/invoke` | Invoke an agent |
| `POST /api/agents/:name/stream` | Stream agent response (SSE) |
| `GET /api/workflows` | List all workflows |
| `POST /api/workflows/:name/run` | Run a workflow |
| `POST /api/workflows/:name/stream` | Stream workflow execution (SSE) |
| `POST /api/knowledge/:name/search` | Search knowledge store |
| `GET /api/functions` | List all functions |
| `POST /api/functions/:name/call` | Call a function |
| `GET /api/mcp` | List MCP servers |
| `POST /api/mcp/:name/call` | Call an MCP tool |

## Using as a Library

```javascript
import { Orchestrator } from 'agent-orcha';

const orchestrator = new Orchestrator({ workspaceRoot: '.' });
await orchestrator.initialize();

// Invoke an agent
const result = await orchestrator.agents.invoke('my-agent', {
  query: 'Hello world'
});

console.log(result.output);
```

## Documentation

- Full documentation: https://ddalcu.github.io/agent-orcha
- GitHub: https://github.com/ddalcu/agent-orcha
