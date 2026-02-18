---
name: orcha-builder
description: Documentation for creating and modifying ORCHA resources (agents, workflows, skills, functions, knowledge stores)
---

# ORCHA Resource Schemas

Use this reference when creating or modifying ORCHA resources. All resource files live in the project root under their respective directories.

---

## Agents (`agents/<name>.agent.yaml`)

```yaml
name: my-agent                    # Unique identifier (kebab-case)
description: What the agent does  # Human-readable description
version: "1.0.0"                  # Optional, defaults to 1.0.0

llm:
  name: default                   # LLM config name from llm.json
  temperature: 0.7                # 0.0 = deterministic, 1.0 = creative

prompt:
  system: |
    You are a helpful assistant.
    Your instructions go here.
  inputVariables:
    - query                       # Variables injected at runtime

tools:                            # Optional tool references
  - mcp:server-name               # All tools from an MCP server
  - knowledge:store-name          # Knowledge search tools
  - function:my-function          # Custom function tool
  - builtin:tool-name             # Built-in tool
  - sandbox:exec                  # Sandbox tools (exec, read, write, edit, web_fetch, web_search, browser)
  - project:read                  # Project tools (read, write, list, list_resources)

skills:                           # Optional skills
  - skill-name                    # Skill name from skills directory
  # OR
  mode: all                       # Include all available skills

output:                           # Optional output config
  format: text                    # text | json | structured
  schema:                         # Required if format is structured
    type: object
    properties:
      result:
        type: string

memory:                           # Optional conversation memory
  enabled: true
  maxLines: 100                   # Max conversation history lines

metadata:                         # Optional metadata
  category: general
  tags:
    - example

integrations:                     # Optional integrations
  - type: collabnook
    url: wss://collabnook.com/ws
    channel: general
    botName: MyBot

triggers:                         # Optional triggers
  - type: cron
    schedule: "*/5 * * * *"       # Cron expression
    input:
      query: "Periodic task"
```

---

## Step-Based Workflows (`workflows/<name>.workflow.yaml`)

```yaml
name: my-workflow
description: What the workflow does
version: "1.0.0"
type: steps                       # "steps" for step-based workflows

input:
  schema:                         # Typed input fields
    query:
      type: string                # string | number | boolean | array | object
      required: true
      description: "The user query"

steps:
  - id: step-one                  # Unique step identifier (NOT "name")
    agent: agent-name             # Agent to invoke
    input:
      query: "{{query}}"          # Variable interpolation
    output:                       # Output is an object (NOT a string)
      key: step_one_result        # Variable name to store result
      extract: output             # Optional: extract a specific field

  - id: step-two
    agent: another-agent
    input:
      query: "{{step_one_result}}"
    output:
      key: step_two_result
    condition: "{{step_one_result}}"  # Optional: skip if falsy

  - parallel:                     # Parallel execution (no "name" key here)
      - id: branch-a
        agent: agent-a
        input:
          query: "{{query}}"
        output:
          key: result_a
      - id: branch-b
        agent: agent-b
        input:
          query: "{{query}}"
        output:
          key: result_b

config:                           # Optional workflow config
  timeout: 300000                 # Default 300000ms
  onError: stop                   # stop | continue | retry

output:
  result: "{{step_two_result}}"
```

---

## LangGraph Workflows (`workflows/<name>.workflow.yaml`)

```yaml
name: my-graph-workflow
description: Graph-based workflow with tool and agent discovery
version: "1.0.0"
type: langgraph

input:
  schema:                         # Typed input fields (same as step-based)
    query:
      type: string
      required: true
      description: "The user query"

prompt:                           # REQUIRED for langgraph workflows
  system: |
    You are a helpful assistant that uses available tools and agents.
  goal: "Answer the user's query using available tools"

graph:
  model: default                  # LLM config name, defaults to "default"
  tools:
    sources:                      # Tool sources to discover
      - mcp
      - knowledge
      - function
      - builtin
    mode: all                     # all | none | include | exclude
    exclude:                      # Optional exclusion list
      - dangerous_tool
  agents:
    mode: all                     # all | none | include | exclude
    exclude:
      - builder                   # Prevent recursive invocation
  executionMode: react            # react | single-turn (default: react)
  maxIterations: 10               # Max tool-call loops (default: 10)
  timeout: 300000                 # Timeout in ms (default: 300000)

output:
  result: "{{result}}"
```

---

## Knowledge Stores (`knowledge/<name>.knowledge.yaml`)

### Vector Knowledge Store

```yaml
name: my-knowledge
description: What this knowledge store contains
kind: vector                      # "vector" (default) or "graph-rag"

source:
  # Directory source
  type: directory                 # directory | file | database | web | s3
  path: ./docs                    # Relative to project root
  pattern: "**/*.md"              # Glob pattern for file matching (NOT "glob")
  recursive: true                 # Default: true

  # --- OR file source ---
  # type: file
  # path: ./data/report.pdf

  # --- OR database source ---
  # type: database
  # connectionString: postgresql://user:pass@host:5432/db
  # query: "SELECT content FROM documents"
  # contentColumn: content
  # metadataColumns: [id, title]

  # --- OR web source ---
  # type: web
  # url: https://example.com/docs
  # selector: ".main-content"     # Optional CSS selector

  # --- OR s3 source ---
  # type: s3
  # bucket: my-bucket
  # prefix: docs/
  # region: us-east-1

loader:                           # REQUIRED (has defaults)
  type: text                      # text | pdf | csv | json | markdown

splitter:
  type: recursive                 # character | recursive | token | markdown
  chunkSize: 1000
  chunkOverlap: 200

embedding: default                # String reference to llm.json config (NOT an object)

store:
  type: memory                    # memory | chroma | pinecone | qdrant

search:                           # Optional
  defaultK: 4
  scoreThreshold: 0.5             # Optional minimum score
```

### Graph RAG Knowledge Store

```yaml
name: my-graph-knowledge
description: Graph-based knowledge with entity extraction
kind: graph-rag

source:
  type: directory
  path: ./docs
  pattern: "**/*.md"

loader:
  type: text

splitter:
  type: recursive
  chunkSize: 2000
  chunkOverlap: 400

embedding: default                # String reference to llm.json config

graph:
  extractionMode: llm             # llm | direct (default: llm)
  extraction:                     # Optional (has defaults)
    llm: default                  # LLM config for entity extraction
    entityTypes:                  # Optional: constrain entity types
      - name: Person
        description: A human individual
      - name: Organization
    relationshipTypes:             # Optional: constrain relationship types
      - name: WORKS_FOR
  communities:                    # Optional (has defaults)
    algorithm: louvain
    resolution: 1.0
    minSize: 2
    summaryLlm: default
  store:
    type: memory                  # memory only for now
  cache:
    enabled: true
    directory: .graph-cache/my-kb

search:                           # Optional (has defaults)
  defaultK: 10
  localSearch:
    maxDepth: 2
  globalSearch:
    topCommunities: 5
    llm: default
```

---

## Custom Functions (`functions/<name>.function.js`)

```javascript
export const metadata = {
  name: "my-function",
  description: "What this function does",
  version: "1.0.0",
  tags: ["utility"]
};

export const parameters = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description: "The input parameter"
    }
  },
  required: ["input"]
};

export default async function({ input }) {
  // Your logic here
  return { result: `Processed: ${input}` };
}
```

---

## Skills (`skills/<name>/SKILL.md`)

```markdown
---
name: my-skill
description: What this skill teaches the agent
---

# Skill Title

Instructions, context, and knowledge that get injected into the agent's prompt.
Use markdown formatting for structure.
```

Skills with `sandbox: true` in frontmatter indicate they require sandbox tools.

---

## Best Practices

- **Naming**: Use kebab-case for all resource names (e.g. `weather-bot`, `data-pipeline`)
- **Temperature**: Use 0.0-0.3 for structured/deterministic tasks, 0.5-0.7 for creative/conversational
- **Tools**: Only include tools the agent actually needs — fewer tools = better focus
- **Prompts**: Be specific and include examples in system prompts; use inputVariables for dynamic content
- **Read before write**: Always read an existing resource before modifying it to preserve fields you're not changing
- **Uniqueness**: Check `project_list_resources` before creating to avoid name collisions
- **Skills**: Use skills to share knowledge across multiple agents without duplicating prompt content
