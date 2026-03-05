---
name: web-pilot
description: Browser automation — observe-act loop with refs
sandbox: true
---

# Web Pilot

## Tools

| Tool | Purpose |
|------|---------|
| `sandbox_browser_observe` | Text snapshot: URL, title, headings, textExcerpt, elements with refs |
| `sandbox_browser_navigate` | Go to URL, wait for ready, return snapshot with textExcerpt |
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

## Data Extraction Strategy

1. **Check textExcerpt first** — observe/navigate returns the first 2000 chars of visible text. For many tasks this is enough.
2. **Use content(selector)** over content() — target a specific section (e.g. `{ selector: "main" }` or `{ selector: ".repo-list" }`) to avoid huge dumps.
3. **Use evaluate() for structured extraction** — `evaluate({ expression: "..." })` with JS that returns exactly the data you need (e.g. `[...document.querySelectorAll('.repo')].map(...)`)
4. **Prefer web_fetch for read-only pages** — if you just need page content without interaction, `sandbox_web_fetch` is cheaper than navigating.
5. **Never repeat a failed approach** — if a tool call returns nothing useful, switch to a different strategy immediately.

## Patterns

- **Click by text:** `{ "text": "Accept cookies" }` (when ref unavailable)
- **Scroll:** evaluate `window.scrollBy(0, 500)` then observe
- **Dropdown:** evaluate with value set + change event dispatch
