---
name: sandbox
description: Execute commands in an isolated Docker container
sandbox: true
---

# Sandbox Execution

You have access to `sandbox_exec`, a tool that runs shell commands inside an isolated Docker container.

## Tool: sandbox_exec

**Parameters:**
- `command` (required): The shell command to execute
- `workdir` (optional): Working directory inside the container
- `timeout` (optional): Command timeout in milliseconds

**Returns:** JSON with `stdout`, `stderr`, and `exitCode`

## Environment

The sandbox container includes:
- Python 3.12 with pip
- Node.js 22 with npm
- Common CLI tools (curl, git, jq, etc.)

Files persist within the container during the session. The container is isolated from the host system.

## Usage Examples

Install a package and run a script:
```
sandbox_exec({ command: "pip install requests && python script.py" })
```

Run multiple commands:
```
sandbox_exec({ command: "cd /workspace && npm init -y && npm install lodash" })
```

## Best Practices

1. Chain commands with `&&` when they depend on each other
2. Use `/workspace` as the default working directory
3. Check `exitCode` to verify command success
4. Handle errors gracefully - read `stderr` for diagnostics
