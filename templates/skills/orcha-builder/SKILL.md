---
name: orcha-builder
description: Documentation for creating and modifying ORCHA resources (agents, workflows, skills, functions, knowledge stores)
---

# ORCHA Resource Schemas

Use this reference when creating or modifying ORCHA resources. All resource files live in the workspace root under their respective directories.

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
  - sandbox:exec                  # Sandbox tools (exec, web_fetch, web_search)
  - workspace:read                  # Workspace tools (read, write, list, list_resources)

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
      - architect                  # Prevent recursive invocation
  executionMode: react            # react | single-turn (default: react)
  maxIterations: 10               # Max tool-call loops (default: 10)
  timeout: 300000                 # Timeout in ms (default: 300000)

output:
  result: "{{result}}"
```

---

## Knowledge Stores (`knowledge/<name>.knowledge.yaml`)

```yaml
name: my-knowledge
description: What this knowledge store contains

source:
  # Directory source
  type: directory                 # directory | file | database | web | s3
  path: ./docs                    # Relative to workspace root
  pattern: "**/*.md"              # Glob pattern for file matching (NOT "glob")
  recursive: true                 # Default: true

  # --- OR file source ---
  # type: file
  # path: ./data/report.pdf

  # --- OR database source ---
  # type: database
  # connectionString: postgresql://user:pass@host:5432/db  # postgresql://, mysql://, or sqlite://
  # query: "SELECT content FROM documents"
  # contentColumn: content        # Default: "content"
  # metadataColumns: [id, title]  # Optional
  # batchSize: 100                # Optional, default: 100

  # --- OR web source ---
  # type: web
  # url: https://example.com/docs
  # selector: ".main-content"     # Optional CSS selector
  # headers:                      # Optional custom headers
  #   Authorization: "Bearer token"

loader:                           # REQUIRED (has defaults)
  type: text                      # text | pdf | csv | json | markdown

splitter:
  type: recursive                 # character | recursive | token | markdown
  chunkSize: 1000
  chunkOverlap: 200

embedding: default                # String reference to llm.json config (NOT an object)

search:                           # Optional
  defaultK: 4
  scoreThreshold: 0.5             # Optional minimum score

graph:                            # Optional: enable graph entities via direct mapping
  directMapping:
    entities:
      - type: Person              # Entity type label
        idColumn: id              # Column for entity ID
        nameColumn: name          # Optional: column for display name
        properties:               # Columns to include as properties
          - email                 # String = same column name
          - { role: job_title }   # Object = { propertyName: columnName }
    relationships:                # Optional: define relationships
      - type: WORKS_FOR
        source: Person            # Source entity type
        target: Organization      # Target entity type
        sourceIdColumn: person_id
        targetIdColumn: org_id
        groupNode: department     # Optional: group by column
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

## MCP Server Configuration (`mcp.json`)

The `mcp.json` file in the workspace root configures external MCP servers. Agents reference them via `mcp:<server-name>` in their tools list.

```json
{
  "version": "1.0.0",
  "servers": {
    "server-name": {
      "url": "https://example.com/mcp",
      "description": "What this server provides",
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

**Server config fields:**
- `url` — Required for remote servers (auto-detects `streamable-http` transport)
- `command` + `args` — Required for local stdio servers (auto-detects `stdio` transport)
- `transport` — Explicit: `stdio`, `sse`, `streamable-http`, or `sse-only` (auto-detected if omitted)
- `headers` — Optional HTTP headers (e.g. for auth)
- `env` — Optional environment variables (for stdio servers)
- `description` — Optional human-readable description
- `timeout` — Request timeout in ms (default: 30000)
- `enabled` — Set to `false` to disable without removing (default: true)

**Adding a new MCP server:**
1. Read `mcp.json` first to preserve existing servers
2. Add the new server entry to the `servers` object
3. Write the updated `mcp.json` back
4. Create an agent that references it with `tools: [mcp:server-name]`

---

## Best Practices

- **Naming**: Use kebab-case for all resource names (e.g. `weather-bot`, `data-pipeline`)
- **Temperature**: Use 0.0-0.3 for structured/deterministic tasks, 0.5-0.7 for creative/conversational
- **Tools**: Only include tools the agent actually needs — fewer tools = better focus
- **Prompts**: Be specific and include examples in system prompts; use inputVariables for dynamic content
- **Read before write**: Always read an existing resource before modifying it to preserve fields you're not changing
- **Uniqueness**: Check `workspace_list_resources` before creating to avoid name collisions
- **Skills**: Use skills to share knowledge across multiple agents without duplicating prompt content
