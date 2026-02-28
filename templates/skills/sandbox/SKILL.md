---
name: sandbox
description: Execute JavaScript, shell commands, fetch web content, and control a browser
sandbox: true
---

# Sandbox Tools

## sandbox_exec
Run JavaScript in isolated VM. Use `console.log()` for output, `return` for result. No `fetch`/`require` — use `sandbox_web_fetch` for HTTP.

## sandbox_shell
Run shell commands in `/tmp` with limited permissions (Docker only).

## sandbox_web_fetch
Fetch web pages (auto-converted to markdown) or APIs (`raw: true`).

## sandbox_web_search
Search DuckDuckGo. Params: `query`, `num_results`.

## Browser Tools

Observe → Act → Observe loop. Elements have short refs (e1, e2...) — use them in click/type.

| Tool | Use |
|------|-----|
| `sandbox_browser_observe` | Text snapshot with element refs. Primary verification tool. |
| `sandbox_browser_navigate` | Go to URL, wait for ready, return snapshot |
| `sandbox_browser_click` | Click by ref (`"e3"`) or text (`"Submit"`) |
| `sandbox_browser_type` | Type by ref (`"e5"`), dispatches input/change events |
| `sandbox_browser_content` | Page as markdown (optional selector) |
| `sandbox_browser_evaluate` | Run JS, reports side effects |
| `sandbox_browser_screenshot` | PNG screenshot (expensive, last resort) |

## Best Practices

1. Use `sandbox_web_fetch` for HTTP — not `fetch` in sandbox_exec
2. Use observe to verify page state — not screenshots
3. Use refs from observe output in click/type — don't guess selectors
4. Check `sideEffects` in evaluate results
