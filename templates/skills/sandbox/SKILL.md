---
name: sandbox
description: Execute JavaScript code and fetch web content in an isolated sandbox
sandbox: true
---

# Sandbox Execution

You have access to sandbox tools for running JavaScript code and fetching web content.

## Tool: sandbox_exec

Execute JavaScript code in an isolated VM sandbox.

**Parameters:**
- `code` (required): JavaScript code to execute (runs in async context, so `await` works)
- `timeout` (optional): Execution timeout in milliseconds

**Returns:** JSON with `stdout` (console output), `result` (return value), and `error` (if any)

**Available globals:** JSON, Math, Date, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, and standard JS built-ins.

**Not available:** `fetch`, `require`, file system access. Use `sandbox_web_fetch` for HTTP requests.

## Tool: sandbox_web_fetch

Fetch web page content or API responses.

**Parameters:**
- `url` (required): HTTP or HTTPS URL to fetch
- `raw` (optional): Return raw content without HTML-to-markdown conversion
- `runScripts` (optional): Run page JavaScript before extracting content (default: true)

**Returns:** JSON with `content`, `url`, `status`, and `truncated`

## Tool: sandbox_web_search

Search the web using DuckDuckGo.

**Parameters:**
- `query` (required): Search query
- `num_results` (optional): Max results to return (default 10)

**Returns:** JSON with `results` (formatted list) and `query`

## Usage Examples

Run JavaScript code:
```
sandbox_exec({ code: "const sum = [1,2,3].reduce((a,b) => a+b, 0); console.log(sum); return sum;" })
```

Fetch a web page:
```
sandbox_web_fetch({ url: "https://example.com" })
```

## Best Practices

1. Use `console.log()` for output and `return` for the final result
2. Use `sandbox_web_fetch` for HTTP requests instead of trying to use `fetch` in sandbox_exec
3. Check the `error` field in results to verify execution success
4. Handle errors gracefully — read `error` for diagnostics
