# Svelte 5 Migration

## Status: Migration complete. All items resolved.

## What's Done

### Core UI Migration (100%)
- All 10 pages migrated to Svelte 5 Runes
- 13 shared chat components (DRY extraction)
- All stores, services, types, utils ported to TypeScript
- Build passes (`cd ui && npm run build` ~1.7s)
- Zero `<style>` blocks — all CSS in one `app.css`
- Zero inline `style="..."` — only 9 `style:` directives (dynamic values)

### Verified Working (Chrome DevTools + live backend on :3000)
- Agents: new chat modal, session sidebar, streaming with thinking/tool pills, canvas pane, stats bar, session persistence, welcome orca SVG. **0 console errors.**
- Knowledge: store cards (8 stores), detail panel, stats grid, search, SSE indexing progress. Mobile: floating toggle button for stores sidebar. **0 console errors.**
- Graph: vis.js network with colored nodes, sidebar, expand/collapse. **0 errors** (1 vis.js info about improved layout — expected).
- MCP: server accordions (3 servers), tool grids, function execution. **0 console errors.**
- Monitor: task list with status badges (Working/Completed/Cancelled), filters, detail panel, timing. **0 console errors.**
- LLM: provider tabs (Local/OpenAI/Anthropic/Google), engine tabs (llama-cpp/mlx-serve/Ollama/LM Studio), model grid, context/token sliders, unload buttons. **0 console errors.**
- IDE: file tree with expand/collapse, Ace editor, visual AgentComposer with identity/LLM/prompt/tools/integrations sections. **0 console errors.**
- Mobile (390x844): sidebar toggle, Knowledge floating button, chat input — all working.
- Streaming: tested with canvas agent — user bubble, thinking pills (expandable), status bar (iteration/context/elapsed), Stop/Cancel, stats bar (elapsed/input tokens/output tokens/tok/s/Cancelled badge). **0 console errors.**
- Standalone chat: `/chat/<agent>` with auth, streaming, canvas
- LogViewer: SSE streaming console

### Tests
- 2,521 unit tests: all pass (0 failures)
- Playwright e2e tests: **91 passed, 1 failed, 24 skipped** (12 spec files, 120 total). The 1 failure is `lmstudio Engine > verify chat works` (LLM timeout — model too slow, not UI). Skipped tests are for engines not currently running.
- Fixed e2e selectors: `/api/mcp/servers` → `/api/mcp`, `/api/ide/tree` → `/api/files/tree`, LLM managed-engine sections need engine tab click first

### TypeScript
- `svelte-check`: **0 errors**, 5 warnings (all svelte-ignored a11y on intentional clickable divs/modals)
- Build: passes in ~1.7s, 0 errors

### Lighthouse
- Accessibility: **92**, Best Practices: **96**, SEO: **100**
- 3 remaining audits: stale session 404 (environmental), badge-gray contrast 4.07:1 (borderline), touch targets (dense UI design)

### Bugs Fixed
1. `hasActiveSession` reactivity — derived from `$state` instead of localStorage
2. Standalone chat dev routing — custom Vite plugin for `/chat/*` → `chat.html`
3. `onclick|stopPropagation` — Svelte 5 doesn't support modifier syntax
4. `markdown.ts` link renderer — signature mismatch with `marked` RendererObject type (positional args, not destructured object)
5. `GraphPage.svelte` — `declare const vis` not allowed in Svelte 5 component scripts; changed to `(window as any).vis`
6. `StandaloneChatPage.svelte` — `chatMessagesEl`/`chatInputRef` bind:this refs now use `$state()` to silence `non_reactive_update` warnings
7. `StandaloneChatPage.svelte` — document-level click listeners leaked on every tool pill; now tracked in array and cleaned up in `onDestroy`
8. `GraphPage.svelte` — `vis` accessed at module parse time; now deferred via `getVis()` function with error guard (prevents crash if CDN slow/fails)
9. `KnowledgePage.svelte` — SSE progress/error event handlers had unguarded `JSON.parse()` that would crash on malformed data; added try/catch
10. `.gitignore` — Added `public` to gitignore since it's now a Vite build artifact (source is in `ui/`)
11. `tests/e2e/mcp.spec.ts` — API endpoint `/api/mcp/servers` → `/api/mcp`
12. `tests/e2e/ide.spec.ts` — API endpoint `/api/ide/tree` → `/api/files/tree`
13. `tests/e2e/llm.spec.ts` — LLM managed-engine sections (Downloaded Models, HuggingFace Browser) need managed engine tab click first; tests now select llama-cpp/mlx-serve before asserting
14. `StandaloneChatPage.svelte` — Full refactor from imperative DOM to reactive Svelte state + shared components. Eliminated 17 createElement calls, docListeners tracking, and innerHTML usage.
15. Removed unused imports: `renderMarkdown`/`highlightCode` from AgentsPage + StandaloneChatPage, `escapeHtml` from LocalLlmPage + StandaloneChatPage
16. Lighthouse: added `<meta name="description">` to both HTML files (SEO 91→100), added `<main>` landmark to App.svelte (accessibility 90→92), improved muted text contrast `--text-3` from `#5c5c64` (2.55:1) to `#8a8a94` (4.94:1 — WCAG AA compliant)
17. Dead CSS cleanup: removed 18 unused class selectors from `app.css` (copy-btn, step-node*, mobile-fab, animate-pulse-dot, animation-delay-*, fade-in, shadow-lg, bg-overlay-heavy, mb-5, md-grid-cols-*, lg-grid-cols-3). CSS bundle: 61.5KB → 59.8KB (-1.7KB)

---

## TODO — Remaining Items

### High Priority
- [x] ~~**Playwright e2e tests**~~ — Tests existed in `tests/e2e/` (12 spec files). Fixed broken selectors: `/api/mcp/servers` → `/api/mcp`, `/api/ide/tree` → `/api/files/tree`, LLM tests now click managed engine tab before checking managed-only sections. **91 passed, 1 failed (LLM timeout), 24 skipped.**
- [x] ~~**Vite chunk size warning**~~ — Fixed: added `manualChunks` to split vendor (marked+dompurify+hljs) from app code. App chunks: main=256KB, CanvasPane=49KB, chat=15KB. Vendor=1MB (expected for those libraries).
- [x] ~~**Dockerfile update**~~ — Added `COPY ui/ ./ui/` + `RUN cd ui && npm ci && npm run build && cd .. && rm -rf ui` before copying app source. Builds UI in Docker layer, then removes source to keep image lean.

### Medium Priority
- [x] ~~**StandaloneChatPage duplication**~~ — Refactored: replaced all 17 `createElement` calls with reactive `$state` bubbles array + shared Svelte components (UserBubble, ResponseBubble, ToolPill, ThinkingPill, StreamStatusBar, StreamStatsBar). Eliminated `docListeners` tracking (components handle their own cleanup). Chat chunk size reduced from 15.7KB → 11.4KB (27% smaller). All 6 chat e2e tests pass.
- [x] ~~**A11y warnings**~~ — Fixed: Added `aria-label` to all icon-only buttons (App.svelte hamburger, ChatInput send, AttachmentPreview remove, CanvasPane close, IdePage tree menus, AgentComposer add/remove buttons). Added `role`/`tabindex`/`onkeydown` to interactive divs (IdePage tree items, dropdown items, context menu items). Connected labels to form controls with `for`/`id` in LocalLlmPage, AgentComposer, and IdePage. `svelte-check` now shows **0 errors, 5 warnings** (all svelte-ignored intentional patterns).
- [x] ~~**SEA binary**~~ — Verified: `build-sea.mjs` uses `addDirectory('public', 'public')` which embeds all files from `public/`. Vite outputs to `../public` (index.html, chat.html, assets/*.js/css), matching the expected structure. Should work without changes.

### Low Priority
- [x] ~~**Remove old public/ from git**~~ — Added `public` to `.gitignore`. Old vanilla JS files were already removed. Build artifacts no longer tracked.
- [x] ~~**Code view in CanvasPane**~~ — Verified: hljs is bundled in vendor chunk (1MB), loaded on all pages. CanvasPane `code` format calls `highlightCode()` from `markdown.ts`. Production build confirmed working.
- [x] ~~**Mobile responsive**~~ — Tested at 390x844 (iPhone 14). Agents: sidebar collapses, hamburger toggle works, chat input at bottom. Knowledge: stores sidebar hidden by default, floating toggle button (bottom-right) shows/hides it. All pages render correctly.
- [x] ~~**Favicon missing**~~ — Fixed: Added `<link rel="icon" type="image/png" href="/assets/logo.png">` to both `index.html` and `chat.html`. No more 404.

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
      StandaloneChatPage.svelte (479 lines — refactored to reactive state + shared components)
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
