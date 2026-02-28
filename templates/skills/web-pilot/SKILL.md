---
name: web-pilot
description: Browser automation — observe-act loop with refs
sandbox: true
---

# Web Pilot

## Tools

| Tool | Purpose |
|------|---------|
| `sandbox_browser_observe` | Text snapshot: URL, title, headings, elements with refs |
| `sandbox_browser_navigate` | Go to URL, wait for ready, return snapshot |
| `sandbox_browser_click` | Click by ref (e.g. "e3") or visible text |
| `sandbox_browser_type` | Type into input by ref (e.g. "e5") |
| `sandbox_browser_content` | Page as markdown (optional CSS selector) |
| `sandbox_browser_evaluate` | Run JS, reports side effects |
| `sandbox_browser_screenshot` | PNG screenshot (expensive, last resort) |
| `sandbox_web_search` | Search DuckDuckGo for URLs |

## Workflow: Observe → Act → Observe

1. **Navigate** → returns snapshot with element refs
2. **Act** using refs from snapshot: `click({ ref: "e3" })` or `type({ ref: "e5", text: "hello" })`
3. **Observe** → verify action worked
4. Repeat. Screenshot only if text can't answer your question.

## Refs

Observe output lists elements like:
```
- button "Submit" [ref=e1]
- textbox [ref=e2] name=email placeholder="Enter email"
- link "Home" [ref=e3]
```
Use refs in click/type: `{ "ref": "e1" }`. Refs update on each observe — always use latest.

## Patterns

- **Click by text:** `{ "text": "Accept cookies" }` (when ref unavailable)
- **Scroll:** evaluate `window.scrollBy(0, 500)` then observe
- **Dropdown:** evaluate with value set + change event dispatch
