# Svelte 5 Migration — Complete

## Status: Done (tested and verified)

## Line Count Summary

| Component | Original (vanilla JS) | Svelte 5 | Reduction |
|---|---|---|---|
| AgentsView.js | 2,722 | 1,915 (AgentsPage) | 30% |
| StandaloneChat.js | 1,256 | 456 (StandaloneChatPage) | 64% |
| LocalLlmView.js | 2,443 | 2,037 (LocalLlmPage) | 17% |
| IdeView.js | 976 | 756 (IdePage) | 23% |
| AgentComposer.js | 807 | 944 (AgentComposer) | +17% (gained tool picker) |
| KnowledgeView.js | 474 | 499 (KnowledgePage) | ~same |
| MonitorView.js | 479 | 456 (MonitorPage) | 5% |
| GraphView.js | 418 | 412 (GraphPage) | ~same |
| McpView.js | 379 | 342 (McpPage) | 10% |
| LogViewer.js | 155 | 95 (LogViewer) | 39% |
| AppRoot.js | 283 | 213 (App.svelte) | 25% |
| NavBar.js | 64 | 43 (NavBar.svelte) | 33% |
| **13 shared chat components** | *(duplicated in 2 files)* | 705 | **new shared layer** |
| Services/Utils/Stores | 729 | 610 | 16% |
| **Total** | **~13,520** | **~9,587** | **29%** |

## Verification

- [x] `cd ui && npm run build` — compiles in ~1.1s, zero errors
- [x] 2,521 unit tests pass (0 failures)
- [x] 122 Playwright e2e tests exist (require running server)
- [x] Chrome DevTools — all 7 tabs render and function correctly
- [x] Chat streaming tested: user message → thinking pills → tool pills → canvas → stats bar
- [x] Standalone chat `/chat/<agent>` loads correctly with sample questions
- [x] Knowledge detail panel: stats, badges, search, indexing progress
- [x] IDE visual composer: agent YAML editing with source/visual toggle
- [x] Monitor: task list, status badges, detail panel
- [x] Graph: vis.js network rendering with colored nodes
- [x] No `<style>` blocks in any Svelte file
- [x] Logo asset preserved via `ui/public/assets/logo.png`

## Bugs Found and Fixed

1. **`hasActiveSession` not reactive** — `$derived(!!sessionStore.getActiveId())` read from localStorage which isn't reactive. After creating a session, the textarea stayed readonly and the new session modal kept re-opening. Fixed by deriving from the reactive `activeSessionId` state variable instead.

2. **Standalone chat routing in dev** — `/chat/*` routes served `index.html` (SPA) instead of `chat.html`. Added a custom Vite plugin (`chatRoutePlugin`) that rewrites `/chat/*` requests to `/chat.html`, mirroring the Fastify production behavior.

3. **`onclick|stopPropagation` syntax** — Svelte 5 doesn't support event modifier syntax. Fixed by wrapping in `(e) => { e.stopPropagation(); handler(); }`.

## Architecture

- All CSS in one file (`app.css`) — zero `<style>` blocks in Svelte files
- Svelte 5 Runes only (`$state`, `$derived`, `$effect`)
- TypeScript throughout
- Vite builds to `public/` — zero server/Docker/SEA changes
- Hash routing via `$state` + `hashchange`
- CDN kept for FontAwesome, Inter font, Ace Editor, vis-network
- Custom Vite plugin routes `/chat/*` to `chat.html` in dev mode

## Root package.json changes
```json
"dev:ui": "cd ui && npm run dev",
"build:ui": "cd ui && npm ci && npm run build",
"build": "npm run build:ui && tsc && npm run copy-assets"
```

## Dev workflow
```
Terminal 1: npm run dev          → Fastify on :3000
Terminal 2: npm run dev:ui       → Vite on :5173, proxies /api/* to :3000
```

## Findings

- Streaming chat uses imperative DOM manipulation for performance — declarative Svelte would cause excessive re-renders during token streaming
- The biggest DRY win is the 13 shared chat components eliminating duplication between AgentsPage and StandaloneChatPage
- `emptyOutDir: true` in vite.config wipes the output dir — static assets (logo) must go in `ui/public/`
- localStorage reads are not reactive in Svelte — always derive from `$state` variables that mirror localStorage
