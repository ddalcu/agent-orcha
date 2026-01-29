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

# LangGraph Workflow Guide

LangGraph workflows use autonomous agents that can discover and call tools/agents based on your prompt, without explicit step definitions.

## Execution Modes

### Single-Turn Mode (Recommended for most cases)

**When to use:** Most research, data gathering, and analysis tasks where you want fast, efficient execution without loops.

**How it works:**
1. Agent receives your goal
2. Agent decides which tools/agents to call (can call multiple in parallel)
3. Tools execute and return results
4. Agent synthesizes results into final answer
5. Workflow completes

**Benefits:**
- ✅ Fast execution (no loops)
- ✅ Predictable behavior
- ✅ Lower token usage
- ✅ Prevents infinite loops
- ✅ Works well for straightforward tasks

**Configuration:**
```yaml
graph:
  executionMode: single-turn
  maxIterations: 10  # Safety limit (usually doesn't reach this)
```

**Example use cases:**
- Research a topic using knowledge base
- Gather data from multiple sources
- Run calculations and summarize
- Call specialized agents for specific tasks

---

### ReAct Mode (Multi-Turn)

**When to use:** Complex problems requiring iterative refinement, where the agent needs to analyze intermediate results and make additional calls.

**How it works:**
1. Agent receives your goal
2. Agent calls tools to gather initial information
3. Agent analyzes results
4. **Agent can call more tools based on what it learned**
5. Steps 3-4 repeat until agent decides it has enough information
6. Agent provides final answer

**Benefits:**
- ✅ Handles complex, multi-step problems
- ✅ Can adapt based on intermediate results
- ✅ More thorough analysis
- ✅ Can recover from incomplete information

**Drawbacks:**
- ⚠️ Can loop unnecessarily
- ⚠️ Higher token usage
- ⚠️ Slower execution
- ⚠️ Less predictable

**Configuration:**
```yaml
graph:
  executionMode: react
  maxIterations: 10  # Important: limit iterations to prevent runaway loops
```

**Example use cases:**
- Multi-step problem solving
- Research requiring progressive refinement
- Tasks where you don't know all required steps upfront
- Complex analysis needing intermediate decisions

---

## Comparison Table

| Feature | Single-Turn | ReAct |
|---------|------------|-------|
| Speed | Fast ⚡ | Slower 🐢 |
| Token Usage | Low 💰 | Higher 💸 |
| Tool Calls | Once | Multiple rounds |
| Looping Risk | None ✅ | Possible ⚠️ |
| Complexity | Simple tasks | Complex problems |
| Predictability | High | Variable |

---

## Example Workflows

### Single-Turn Example
```yaml
name: research-assistant
type: langgraph

prompt:
  system: |
    You are a research assistant. Call the tools you need to gather
    information, then provide a comprehensive answer.
  goal: "Research: {{input.topic}}"

graph:
  executionMode: single-turn  # ← Prevents looping
  maxIterations: 10
  tools:
    mode: all
    sources: [mcp, vector, function, builtin]
  agents:
    mode: all
```

### Multi-Turn Example
```yaml
name: complex-analysis
type: langgraph

prompt:
  system: |
    You are an analyst that can iteratively refine your understanding.
    Start with initial research, analyze results, then gather more
    information as needed.
  goal: "Analyze: {{input.topic}}"

graph:
  executionMode: react  # ← Allows multiple rounds
  maxIterations: 10  # ← Limit iterations
  tools:
    mode: all
  agents:
    mode: all
```

---

## Tips for Preventing Loops

### 1. Use Single-Turn Mode
The simplest solution - use `executionMode: single-turn` for most workflows.

### 2. Lower maxIterations
```yaml
graph:
  maxIterations: 5  # Reduced from default of 10
```

### 3. Better System Prompts
Be directive about tool usage:
```yaml
prompt:
  system: |
    IMPORTANT: Identify all needed tools upfront and call them together.
    After receiving results, provide your final answer immediately.
```

### 4. Filter Tools
Only expose tools that are needed:
```yaml
graph:
  tools:
    mode: include
    include: ["vector_search_knowledge", "agent_math"]
```

---

## Tool Discovery

Both modes support automatic tool discovery:

```yaml
graph:
  # Discover all available tools
  tools:
    mode: all  # or: include, exclude, none
    sources: [mcp, vector, function, builtin]
    # Optional filtering:
    # include: ["specific_tool"]
    # exclude: ["dangerous_tool"]

  # Discover all available agents (wrapped as tools)
  agents:
    mode: all  # or: include, exclude, none
    # Optional filtering:
    # include: [math, time]
    # exclude: [admin]
```

---

## Human-in-the-Loop

Both modes support the `ask_user` tool for requesting user input:

```yaml
prompt:
  system: |
    If the user hasn't provided required information, use the ask_user tool
    to request it before proceeding.
```

The workflow will pause and wait for user response when `ask_user` is called.

---

## When to Use What

| Your Task | Recommended Mode |
|-----------|-----------------|
| Simple research | Single-Turn ✅ |
| Gather + summarize | Single-Turn ✅ |
| Call specific agents | Single-Turn ✅ |
| Multi-step problem solving | ReAct 🔄 |
| Iterative refinement | ReAct 🔄 |
| Unknown complexity | Start with Single-Turn ✅ |

**Default recommendation:** Start with `single-turn` mode. Only switch to `react` if your problem truly requires iterative refinement.


## Documentation

Full documentation: https://github.com/ddalcu/agent-orcha

