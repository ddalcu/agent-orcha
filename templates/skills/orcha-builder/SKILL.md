---
name: orcha-builder
description: Documentation for creating and modifying ORCHA resources (agents, workflows, skills, functions, knowledge stores)
---

# ORCHA Resource Schemas

## Agents (`agents/<name>.agent.yaml`)

```yaml
name: my-agent
description: What the agent does
llm:
  name: default
  temperature: 0.7
prompt:
  system: |
    Your system prompt here.
  inputVariables:
    - query
tools:                                # mcp:<server> | knowledge:<store> | function:<name>
  - mcp:server-name                   # builtin:<name> | sandbox:<tool> | workspace:<tool>
  - knowledge:store-name              # workspace: read, write, delete, list, list_resources, diagnostics
  - sandbox:browser_navigate          # sandbox: exec, shell, web_fetch, web_search
                                      # sandbox: browser_navigate, browser_observe, browser_screenshot,
                                      #   browser_content, browser_click, browser_type, browser_evaluate
                                      # sandbox: vision_screenshot, vision_navigate, vision_click,
                                      #   vision_type, vision_scroll, vision_key, vision_drag
                                      #   (requires EXPERIMENTAL_VISION=true)
                                      # sandbox: file_read, file_write, file_edit, file_insert, file_replace_lines
                                      # builtin: ask_user, save_memory, canvas_write, canvas_append
                                      #   (conditional: integration_post, integration_context, email_send)
skills:
  - skill-name                        # or use mode: all to attach all skills
output:
  format: text                        # text | structured
memory:
  enabled: true
  maxLines: 100
integrations:
  - type: collabnook
    url: "wss://collabnook.com/ws"          # optional — defaults to wss://collabnook.com/ws
    channel: general
    botName: Bot
  - type: email
    imap:
      host: imap.gmail.com
      port: 993
    smtp:
      host: smtp.gmail.com
      port: 587
    auth:
      user: agent@example.com
      pass: pw
    pollInterval: 60
    folder: INBOX
triggers:
  - type: cron
    schedule: "*/5 * * * *"
    input:
      query: "Task"
publish: true                         # or { enabled: true, password: "secret" }
p2p: true                             # share this agent on the P2P network
sampleQuestions:                       # optional — clickable chips shown in chat UI on initial load
  - "What can you help me with?"
  - "Summarize the latest report"
```

Published agents are accessible at `/chat/<agent-name>` with optional per-agent password.
Agents with `p2p: true` are shared on the P2P network (enabled by default). P2P settings (peer name, network key, rate limit) are configurable in the P2P tab UI or via environment variables.

## Step-Based Workflows (`workflows/<name>.workflow.yaml`)

```yaml
name: my-workflow
description: What the workflow does
type: steps
input:
  schema:
    query:
      type: string
      required: true
steps:
  - id: step-one
    agent: agent-name
    input:
      query: "{{query}}"
    output:
      key: step_one_result
      extract: output
  - id: step-two
    agent: another-agent
    input:
      query: "{{step_one_result}}"
    output:
      key: step_two_result
    condition: "{{step_one_result}}"
  - parallel:
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
config:
  timeout: 300000
  onError: stop                       # stop | continue | retry
output:
  result: "{{step_two_result}}"
chatOutputFormat: text                  # text | json
sampleQuestions:
  - "Run the pipeline"
```

## ReAct Workflows (`workflows/<name>.workflow.yaml`)

```yaml
name: my-react-workflow
description: Autonomous workflow with tool and agent discovery
type: react
input:
  schema:
    query:
      type: string
      required: true
prompt:
  system: |
    You are a helpful assistant.
  goal: "Answer the user's query"
graph:
  model: default
  tools:
    sources:
      - mcp
      - knowledge
      - function
      - builtin
    mode: all                         # all | none | include | exclude
    exclude:
      - dangerous_tool
  agents:
    mode: all
    exclude:
      - architect
  executionMode: react                # react | single-turn
  maxIterations: 10
  timeout: 300000
output:
  result: "{{result}}"
chatOutputFormat: text                  # text | json
sampleQuestions:
  - "What can you do?"
```

## Knowledge Stores (`knowledge/<name>.knowledge.yaml`)

```yaml
name: my-knowledge
description: What this store contains
source:
  type: directory                     # directory | file | database | web
  path: ./docs
  pattern: "**/*.md"
  # Web-specific: url, selector (html only), headers, jsonPath (dot-notation for nested arrays)
loader:                               # optional — defaults: html (web), text (file/directory)
  type: text                          # text | pdf | csv | json | markdown | html
splitter:
  type: recursive                     # character | recursive | token | markdown
  chunkSize: 1000
  chunkOverlap: 200
embedding: default                    # reference to llm.json config
search:
  defaultK: 4
  scoreThreshold: 0.5
reindex:                              # optional — periodic refresh
  schedule: "0 * * * *"              # cron expression
graph:                                # optional — works with database, csv, json (array of objects)
  directMapping:
    entities:
      - type: Person
        idColumn: id
        nameColumn: name
        properties:
          - email
          - role: job_title
    relationships:
      - type: WORKS_FOR
        source: Person
        target: Organization
        sourceIdColumn: person_id
        targetIdColumn: org_id
```

Web sources support all loader types. Use `loader.type: json` for APIs, `text` for raw content, `html` (default) for web pages with optional `selector`. Add `headers` for authenticated endpoints. Use `jsonPath` (e.g., `items` or `data.results`) to extract a nested array from the JSON response before parsing.

## Custom Functions (`functions/<name>.function.js`)

```javascript
export const metadata = { name: "my-function", description: "What it does" };
export const parameters = {
  type: "object",
  properties: { input: { type: "string", description: "Input" } },
  required: ["input"]
};
export default async function({ input }) {
  return { result: `Processed: ${input}` };
}
```

Function parameters support automatic type coercion — if an LLM passes a number as a string, it is auto-coerced to the declared type.

## Skills (`skills/<name>/SKILL.md`)

Markdown files with YAML frontmatter (`name`, `description`). Content is injected into the agent's system prompt. Add `sandbox: true` if the skill requires sandbox tools.

## MCP Servers (`mcp.json`)

```json
{ "servers": { "name": { "url": "https://example.com/mcp", "enabled": true } } }
```

Remote: `url`. Local: `command` + `args`. Optional: `headers`, `env`, `timeout`, `transport`, `description`. Transport is auto-detected. To add a server: read `mcp.json`, add entry, write back, then reference as `mcp:<name>` in agent tools.

## LLM Configuration (`llm.json`)

```json
{
  "default": "llama-cpp",
  "llama-cpp": {
    "engine": "llama-cpp",
    "model": "qwen3-8b",
    "temperature": 0.7,
    "reasoningBudget": 4096,
    "thinkingBudget": 4096
  },
  "ollama-model": {
    "engine": "ollama",
    "model": "llama3",
    "temperature": 0.5
  },
  "embeddings": {
    "engine": "llama-cpp",
    "model": "nomic-embed",
    "type": "embedding"
  },
  "engineUrls": {
    "llama-cpp": "http://localhost:8080",
    "mlx-serve": "http://localhost:8081",
    "ollama": "http://localhost:11434",
    "lmstudio": "http://localhost:1234"
  }
}
```

The `"default"` key is a string pointer to another config name. Engines: `llama-cpp`, `mlx-serve`, `ollama`, `lmstudio`. Use `reasoningBudget`/`thinkingBudget` for thinking models. Values support `${ENV_VAR}` substitution.

## Environment Variable Substitution

All YAML and JSON config files support `${ENV_VAR}` and `${ENV_VAR:-default}` syntax. Use this for secrets, URLs, and any values that differ between environments.

## Best Practices

- Use kebab-case for all resource names
- Temperature: 0.0-0.3 for structured tasks, 0.5-0.7 for creative
- Only include tools the agent actually needs
- Always read existing resources before modifying them
- Check `workspace_list_resources` before creating to avoid name collisions
- Use skills to share knowledge across agents without duplicating prompts
