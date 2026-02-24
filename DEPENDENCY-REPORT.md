# Dependency Size Report — agent-orcha

**Total `node_modules` size: 333 MB**
**Date: 2026-02-18**

This is an npx package. Every MB matters because users download it on first run.

---

## Summary of Findings

| Category | Size | % of Total |
|----------|------|------------|
| @langchain/community + transitive bloat | ~76 MB | 23% |
| LangChain core ecosystem (core, openai, anthropic, etc.) | ~57 MB | 17% |
| js-tiktoken (tokenizer data) | 21 MB | 6% |
| @aws-sdk/client-s3 + @smithy | 27 MB | 8% |
| openai SDK | 9.6 MB | 3% |
| Dev dependencies installed as prod (typescript, eslint, etc.) | ~32 MB | 10% |
| Remaining (fastify, zod, pino, etc.) | ~110 MB | 33% |

**Estimated savings with all recommendations: ~140-170 MB (40-50% reduction)**

---

## Detailed Breakdown

### 1. @langchain/community — THE BIGGEST PROBLEM

**Direct size:** 24 MB
**Transitive bloat it pulls in:** ~52 MB

| Transitive Dependency | Size | Why It's Installed |
|----------------------|------|--------------------|
| playwright + playwright-core | 12.7 MB | browserbase/stagehand (unused) |
| rxjs | 11 MB | neo4j-driver (unused) |
| @ibm-cloud/watsonx-ai + ibm-cloud-sdk-core | 11.4 MB | IBM Watson integration (unused) |
| neo4j-driver + core + bolt | 6.6 MB | Neo4j integration (unused) |
| @browserbasehq/sdk + stagehand | 4.9 MB | Browser automation (unused) |
| handlebars + helpers | 2.9 MB | Template engine from @langchain/classic |
| @langchain/classic | 13 MB | Legacy langchain compat layer |
| uglify-js | 1.3 MB | handlebars dependency |
| source-map | 824 KB | handlebars dependency |

**What you actually use from @langchain/community:**
- `document_loaders/fs/csv` — CSV file loading
- `document_loaders/fs/pdf` — PDF file loading
- `document_loaders/web/cheerio` — Web page loading
- `vectorstores/chroma` — Chroma vector store

**That's 4 features pulling in 76 MB of dependencies.**

#### Recommendation: Replace with direct implementations

| Feature | Replacement | Size Impact |
|---------|-------------|-------------|
| CSV loader | Use `node:fs` + simple CSV parser (`csv-parse` ~200KB) or write ~30 lines of code | -76 MB |
| PDF loader | `pdf-parse` (~2 MB) directly, which is what langchain uses internally | Already installed transitively |
| Cheerio web loader | `cheerio` (~1.5 MB) directly — already a transitive dep | Already installed transitively |
| Chroma vectorstore | `chromadb` package directly (already a direct dep) — write a thin wrapper | Already installed |

**Estimated savings: ~70-76 MB** by removing `@langchain/community` entirely.

You'd also need to replace imports from `@langchain/classic` (JSONLoader, TextLoader, MemoryVectorStore) which are used in a few files. These are simple enough to replace with direct implementations or import from `@langchain/core` / `langchain`.

---

### 2. @aws-sdk/client-s3 — 27 MB for one feature

**Size:** @aws-sdk/client-s3 (4.4 MB) + @smithy/* (13 MB) + @aws-crypto (1 MB) + nested clients (1.7 MB) = ~27 MB

**Used in:** Only `lib/knowledge/loaders/s3-loader.ts`

#### Recommendation: Make it a peer/optional dependency

Move `@aws-sdk/client-s3` to `peerDependencies` with `peerDependenciesMeta` marking it optional. Users who need S3 loading can install it themselves. This is a standard pattern for optional integrations.

```json
"peerDependencies": {
  "@aws-sdk/client-s3": "^3.700.0"
},
"peerDependenciesMeta": {
  "@aws-sdk/client-s3": { "optional": true }
}
```

Use a dynamic `import()` in the S3 loader with a helpful error message if not installed.

**Estimated savings: ~27 MB** for users who don't need S3.

---

### 3. js-tiktoken — 21 MB of tokenizer data

**Size:** 21 MB
**Pulled in by:** @langchain/core, @langchain/openai, @langchain/textsplitters

This is the tokenizer data for OpenAI models. It's a required transitive dependency of langchain core — not much you can do about it while staying on langchain. However, if you ever consider dropping langchain (see section 8), this goes away too.

#### Recommendation: No direct action (addressed by langchain alternatives)

---

### 4. openai SDK — 9.6 MB (+ duplicated)

**Size:** 9.6 MB (v4.104.0) + separate copy of v6.16.0 inside @langchain/openai
**Pulled in by:** Direct dep, @langchain/community, @langchain/core (via langsmith), chromadb

#### Recommendation: Remove direct dependency if not used directly

You don't appear to import `openai` directly anywhere in src/ or lib/. It's only pulled transitively. If confirmed, remove it from `dependencies`.

**Estimated savings: ~0 MB** (still pulled transitively) but cleaner dependency tree.

---

### 5. Database drivers — pg (moderate) + mysql2 (small)

**Size:** pg ~500 KB, mysql2 ~856 KB

These are reasonably sized. However, most users likely only need one (or neither).

#### Recommendation: Make optional peer dependencies

Same pattern as S3 — move to optional peerDependencies with dynamic imports.

```json
"peerDependencies": {
  "pg": "^8.0.0",
  "mysql2": "^3.0.0"
},
"peerDependenciesMeta": {
  "pg": { "optional": true },
  "mysql2": { "optional": true }
}
```

**Estimated savings: ~1.3 MB** (small but cleaner)

---

### 6. chromadb — 1.7 MB + pulls in openai

**Size:** 1.7 MB direct + requires openai SDK

**Used in:** Only `lib/knowledge/knowledge-store-factory.ts` for Chroma vector store

#### Recommendation: Make optional peer dependency

Same optional pattern. Users who want Chroma can install it. The MemoryVectorStore is a fine default.

**Estimated savings: ~1.7 MB** (+ no longer forces openai SDK)

---

### 7. pino-pretty — dev tool shipped to prod

**Size:** ~1.3 MB (+ transitive deps)

`pino-pretty` is a log formatting tool typically used only during development. It should be a devDependency or optional.

#### Recommendation: Move to devDependencies or optionalDependencies

In the logger, dynamically load pino-pretty only if available:

```ts
const transport = process.env.NODE_ENV !== 'production'
  ? { target: 'pino-pretty' }
  : undefined;
```

**Estimated savings: ~1.3 MB**

---

### 8. The LangChain Elephant in the Room

The entire LangChain ecosystem consumes approximately **130+ MB** when you add up:

| Package | Size |
|---------|------|
| @langchain/community | 24 MB |
| @langchain/openai | 15 MB |
| @langchain/classic | 13 MB |
| @langchain/core | 12 MB |
| langchain | 4 MB |
| @langchain/anthropic | 5.7 MB |
| @langchain/langgraph + sdk + checkpoint | ~7 MB |
| @langchain/google-genai | 1.9 MB |
| @langchain/textsplitters | ~500 KB |
| js-tiktoken (required by core) | 21 MB |
| langsmith (required by core) | 2.4 MB |
| Transitive bloat (playwright, neo4j, ibm, etc.) | ~52 MB |
| **Total** | **~158 MB (47% of node_modules)** |

#### Long-term Recommendation: Evaluate direct SDK usage

What LangChain gives you that you actually use:
1. **LLM abstraction** (ChatOpenAI, ChatAnthropic, ChatGoogleGenerativeAI) — 3 providers
2. **Tool/function calling abstraction** (DynamicStructuredTool)
3. **LangGraph** for workflow orchestration
4. **Document loaders** (CSV, PDF, text, web)
5. **Text splitters** (RecursiveCharacterTextSplitter)
6. **Embeddings** (OpenAIEmbeddings)
7. **Vector stores** (MemoryVectorStore)

What you could replace it with:
1. **LLM calls** — Use `openai`, `@anthropic-ai/sdk`, `@google/generative-ai` directly (~15 MB total vs ~60 MB for langchain LLM wrappers). Write a thin adapter (~100 lines).
2. **Tool calling** — Each SDK has native tool/function calling. Zod schemas (already used) can define tools.
3. **LangGraph** — This is the hardest to replace. If you use complex graph workflows, keep it. If it's simple agent loops, a custom implementation is ~200 lines.
4. **Document loaders** — Direct implementations as described in section 1.
5. **Text splitters** — `RecursiveCharacterTextSplitter` is ~50 lines of code to implement.
6. **Embeddings** — Direct API calls to OpenAI embeddings endpoint (~10 lines).
7. **Vector stores** — In-memory cosine similarity is ~30 lines.

**Potential savings: ~140 MB** but significant refactoring effort.

---

## Priority Action Plan

### Quick Wins (do now, ~100 MB savings)

| # | Action | Savings | Effort |
|---|--------|---------|--------|
| 1 | Remove `@langchain/community` — replace 4 loaders + chroma wrapper with direct code | ~70-76 MB | Medium |
| 2 | Make `@aws-sdk/client-s3` an optional peer dependency | ~27 MB | Low |
| 3 | Move `pino-pretty` to devDependencies | ~1.3 MB | Low |
| 4 | Remove `openai` from direct deps if not directly imported | ~0 MB | Low |

### Medium-term (next release, ~30 MB more)

| # | Action | Savings | Effort |
|---|--------|---------|--------|
| 5 | Make `pg`, `mysql2`, `chromadb` optional peer dependencies | ~3 MB | Low |
| 6 | Make `graphology` + `graphology-communities-louvain` optional | ~4 MB | Low |
| 7 | Audit if `@langchain/google-genai` can be optional (not all users need Google) | ~2 MB | Low |

### Long-term (future version, ~140 MB more)

| # | Action | Savings | Effort |
|---|--------|---------|--------|
| 8 | Replace LangChain with direct SDK calls + thin abstractions | ~140 MB | High |

---

## Target Size After Optimizations

| Phase | node_modules Size |
|-------|------------------|
| Current | 333 MB |
| After Quick Wins (#1-4) | ~230 MB |
| After Medium-term (#5-7) | ~220 MB |
| After Long-term (#8) | ~80-100 MB |

---

## Notes

- Dev dependencies (`typescript`, `eslint`, `c8`, `tsx`, `@types/*`) account for ~32 MB but are NOT installed when users run `npx agent-orcha` (npm skips devDependencies for published packages). These are fine.
- The `@esbuild/darwin-arm64` (9.9 MB) is a platform-specific binary pulled by `tsx` (devDependency) — also not shipped to users.
- `fastify` (3.4 MB) and `zod` (5 MB) are core dependencies and well-sized for what they do. No action needed.
- `ws` (WebSocket, ~200 KB), `dotenv` (~100 KB), `node-cron` (~100 KB), `yaml` (1.2 MB), `minimatch` (~100 KB) are all lightweight and fine.
