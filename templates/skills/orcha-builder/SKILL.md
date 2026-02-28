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
  inputVariables: [query]
tools:                            # mcp:<server> | knowledge:<store> | function:<name>
  - mcp:server-name               # builtin:<name> | sandbox:<tool> | project:<tool>
  - knowledge:store-name           # sandbox: exec, shell, web_fetch, web_search, browser_*
  - sandbox:browser_navigate       # project: read, write, delete, list, list_resources
skills: [skill-name]              # or { mode: all }
output:
  format: text                    # text | structured
memory: { enabled: true, maxLines: 100 }
integrations:
  - { type: collabnook, url: "wss://host/ws", channel: general, botName: Bot }
  - { type: email, imap: { host: imap.gmail.com, port: 993 }, smtp: { host: smtp.gmail.com, port: 587 }, auth: { user: agent@example.com, pass: pw }, pollInterval: 60, folder: INBOX }
triggers:
  - { type: cron, schedule: "*/5 * * * *", input: { query: "Task" } }
publish: true                     # or { enabled: true, password: "secret" }
sampleQuestions:                  # optional — clickable chips shown in chat UI on initial load
  - "What can you help me with?"
  - "Summarize the latest report"
```

Published agents are accessible at `/chat/<agent-name>` with optional per-agent password.

## Step-Based Workflows (`workflows/<name>.workflow.yaml`)

```yaml
name: my-workflow
description: What the workflow does
type: steps
input:
  schema:
    query: { type: string, required: true }
steps:
  - id: step-one
    agent: agent-name
    input: { query: "{{query}}" }
    output: { key: step_one_result, extract: output }
  - id: step-two
    agent: another-agent
    input: { query: "{{step_one_result}}" }
    output: { key: step_two_result }
    condition: "{{step_one_result}}"
  - parallel:
      - id: branch-a
        agent: agent-a
        input: { query: "{{query}}" }
        output: { key: result_a }
      - id: branch-b
        agent: agent-b
        input: { query: "{{query}}" }
        output: { key: result_b }
config: { timeout: 300000, onError: stop }  # stop | continue | retry
output:
  result: "{{step_two_result}}"
```

## ReAct Workflows (`workflows/<name>.workflow.yaml`)

```yaml
name: my-react-workflow
description: Autonomous workflow with tool and agent discovery
type: react
input:
  schema:
    query: { type: string, required: true }
prompt:
  system: |
    You are a helpful assistant.
  goal: "Answer the user's query"
graph:
  model: default
  tools:
    sources: [mcp, knowledge, function, builtin]
    mode: all                     # all | none | include | exclude
    exclude: [dangerous_tool]
  agents:
    mode: all
    exclude: [architect]
  executionMode: react            # react | single-turn
  maxIterations: 10
  timeout: 300000
output:
  result: "{{result}}"
```

## Knowledge Stores (`knowledge/<name>.knowledge.yaml`)

```yaml
name: my-knowledge
description: What this store contains
source:
  type: directory                 # directory | file | database | web
  path: ./docs
  pattern: "**/*.md"
  # Web-specific: url, selector (html only), headers, jsonPath (dot-notation for nested arrays)
loader:                           # optional — defaults: html (web), text (file/directory)
  type: text                      # text | pdf | csv | json | markdown | html
splitter:
  type: recursive                 # character | recursive | token | markdown
  chunkSize: 1000
  chunkOverlap: 200
embedding: default                # reference to llm.json config
search: { defaultK: 4, scoreThreshold: 0.5 }
reindex:                          # optional — periodic refresh
  schedule: "0 * * * *"          # cron expression
graph:                            # optional — works with database, csv, json (array of objects)
  directMapping:
    entities:
      - type: Person
        idColumn: id
        nameColumn: name
        properties: [email, { role: job_title }]
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

## Skills (`skills/<name>/SKILL.md`)

Markdown files with YAML frontmatter (`name`, `description`). Content is injected into the agent's system prompt. Add `sandbox: true` if the skill requires sandbox tools.

## MCP Servers (`mcp.json`)

```json
{ "servers": { "name": { "url": "https://example.com/mcp", "enabled": true } } }
```

Remote: `url`. Local: `command` + `args`. Optional: `headers`, `env`, `timeout`, `transport`, `description`. Transport is auto-detected. To add a server: read `mcp.json`, add entry, write back, then reference as `mcp:<name>` in agent tools.

## Best Practices

- Use kebab-case for all resource names
- Temperature: 0.0-0.3 for structured tasks, 0.5-0.7 for creative
- Only include tools the agent actually needs
- Always read existing resources before modifying them
- Check `workspace_list_resources` before creating to avoid name collisions
- Use skills to share knowledge across agents without duplicating prompts
