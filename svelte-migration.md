# Svelte 5 Migration

## Status: Core migration complete. Polish items remain.

## What's Done

### Core UI Migration (100%)
- All 10 pages migrated to Svelte 5 Runes
- 13 shared chat components (DRY extraction)
- All stores, services, types, utils ported to TypeScript
- Build passes (`cd ui && npm run build` ~1.2s)
- Zero `<style>` blocks — all CSS in one `app.css`
- Zero inline `style="..."` — only 9 `style:` directives (dynamic values)

### Verified Working (Chrome DevTools + live backend)
- Agents: new chat modal, session sidebar, streaming with thinking/tool pills, canvas pane, stats bar, session persistence, welcome orca SVG
- Knowledge: store cards, detail panel, stats grid, search, SSE indexing progress
- Graph: vis.js network with colored nodes, sidebar, expand/collapse
- MCP: server accordions, tool grids, function execution
- Monitor: task list, filters, detail panel, activity feed
- LLM: provider tabs, engine tabs, model grid, sliders, downloads
- IDE: file tree, Ace editor, visual composer for agent YAML
- Standalone chat: `/chat/<agent>` with auth, streaming, canvas
- LogViewer: SSE streaming console

### Tests
- 2,521 unit tests: all pass (0 failures)
- E2e tests updated for new Svelte DOM selectors: 109 passed, 5 skipped, 4 failed (server-side API issues, not UI)

### Bugs Fixed
1. `hasActiveSession` reactivity — derived from `$state` instead of localStorage
2. Standalone chat dev routing — custom Vite plugin for `/chat/*` → `chat.html`
3. `onclick|stopPropagation` — Svelte 5 doesn't support modifier syntax

---

## TODO — Remaining Items

### High Priority
- [ ] **Review 4 failing e2e tests** — failures are server-side API issues (`/api/ide/tree` error, `/api/mcp/servers` error, mlx-serve slider timing). Run `npx playwright test --reporter=line` with backend running on :3000.
- [x] ~~**Vite chunk size warning**~~ — Fixed: added `manualChunks` to split vendor (marked+dompurify+hljs) from app code. App chunks: main=256KB, CanvasPane=49KB, chat=15KB. Vendor=1MB (expected for those libraries).
- [x] ~~**Dockerfile update**~~ — Added `COPY ui/ ./ui/` + `RUN cd ui && npm ci && npm run build && cd .. && rm -rf ui` before copying app source. Builds UI in Docker layer, then removes source to keep image lean.

### Medium Priority
- [ ] **StandaloneChatPage duplication** — Has 18 `createElement` calls duplicating imperative streaming logic from AgentsPage. Could extract a shared `StreamRenderer` utility class, but both pages handle auth/streams differently. Evaluate trade-off.
- [ ] **A11y warnings** — Icon-only buttons need `aria-label` attributes (NavBar hamburger, session delete, etc.). Low effort but many instances.
- [ ] **SEA binary** — Verify `build-sea.mjs` still works with Vite-built `public/`. The script embeds `public/` contents — should work since output structure is the same (HTML + assets/).

### Low Priority
- [ ] **Remove old public/ source files from git** — The original vanilla JS files (`public/src/`, `public/styles.css`) are deleted by Vite build but still in git history. Once migration is confirmed stable, clean up `.gitignore` to exclude `public/` (it's now a build artifact).
- [ ] **Code view in CanvasPane** — verify hljs highlighting works for all languages in production build
- [ ] **Mobile responsive** — test sidebar toggle, canvas layout on mobile viewport

---

## Architecture Reference

```
ui/                                    # Svelte source
  package.json                         # svelte@5, vite, marked, dompurify, highlight.js, js-yaml
  vite.config.ts                       # Two entries, proxy, chatRoutePlugin
  src/
    main.ts                            # SPA bootstrap
    chat-entry.ts                      # Standalone chat bootstrap
    app.css                            # Global styles (2,943 lines — single source of truth)
    App.svelte                         # Shell: sidebar, tab routing, auth overlay
    lib/
      types/index.ts                   # Shared TS interfaces
      utils/format.ts                  # formatElapsedTime, estimateTokens, escapeHtml, etc.
      services/api.ts                  # Typed API service
      services/markdown.ts             # marked + DOMPurify + hljs
      stores/
        app.svelte.ts                  # Global $state (tabs, agents, LLMs, etc.)
        session.svelte.ts              # localStorage session CRUD
        stream.svelte.ts               # SSE stream state management
    components/
      nav/NavBar.svelte
      chat/                            # 13 shared components (705 lines total)
        ChatInput, ChatMessages, UserBubble, ResponseBubble,
        ToolPill, ThinkingPill, StreamStatusBar, StreamStatsBar,
        AttachmentPreview, SampleQuestions, CanvasPane,
        WelcomeState, LoadingDots
    pages/
      AgentsPage.svelte (1,915 lines)
      StandaloneChatPage.svelte (456 lines)
      KnowledgePage.svelte (499 lines)
      GraphPage.svelte (412 lines)
      McpPage.svelte (342 lines)
      MonitorPage.svelte (456 lines)
      LocalLlmPage.svelte (2,037 lines)
      IdePage.svelte (756 lines)
      AgentComposer.svelte (944 lines)
      LogViewer.svelte (95 lines)
```

**Total: ~9,587 lines** (down from ~13,520 vanilla JS = 29% reduction)

## Dev Workflow
```
Terminal 1: npm run dev          → Fastify on :3000
Terminal 2: npm run dev:ui       → Vite on :5173, proxies /api/* to :3000
```
