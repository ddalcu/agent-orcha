import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/* ------------------------------------------------------------------ */
/*  Auth                                                               */
/* ------------------------------------------------------------------ */

export async function authenticate(context: BrowserContext): Promise<void> {
  const req = context.request;
  const check = await req.get('/api/auth/check');
  const body = await check.json();
  if (body.required && !body.authenticated) {
    const password = process.env.AUTH_PASSWORD || 'ao2026';
    const login = await req.post('/api/auth/login', { data: { password } });
    if (!login.ok()) throw new Error(`Auth failed: ${login.status()}`);
  }
}

/* ------------------------------------------------------------------ */
/*  API helpers                                                        */
/* ------------------------------------------------------------------ */

export async function getEngines(request: APIRequestContext) {
  const res = await request.get('/api/local-llm/engines');
  return res.json();
}

export async function getLlmConfig(request: APIRequestContext) {
  const res = await request.get('/api/llm/config');
  return res.json();
}

export async function getStatus(request: APIRequestContext) {
  const res = await request.get('/api/local-llm/status');
  return res.json();
}

export async function getModels(request: APIRequestContext) {
  const res = await request.get('/api/local-llm/models');
  return res.json();
}

/* ------------------------------------------------------------------ */
/*  SSE chat streaming                                                 */
/* ------------------------------------------------------------------ */

export async function streamChat(
  request: APIRequestContext,
  message: string,
  timeoutMs = 120_000,
): Promise<string> {
  const res = await request.post('/api/llm/default/stream', {
    data: { message, sessionId: `playwright-${Date.now()}` },
    timeout: timeoutMs,
  });

  const text = await res.text();
  let accumulated = '';

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') break;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.type === 'task_id' || parsed.type === 'usage' || parsed.type === 'thinking') continue;
      if (parsed.content) accumulated += parsed.content;
    } catch {
      // skip unparseable lines
    }
  }

  return accumulated;
}

/* ------------------------------------------------------------------ */
/*  Config backup / restore                                            */
/* ------------------------------------------------------------------ */

export interface ConfigBackup {
  models: Record<string, unknown>;
  embeddings: Record<string, unknown>;
}

export async function backupConfig(request: APIRequestContext): Promise<ConfigBackup> {
  const config = await getLlmConfig(request);
  return { models: config.models, embeddings: config.embeddings };
}

export async function restoreConfig(request: APIRequestContext, backup: ConfigBackup): Promise<void> {
  if (backup.models?.default) {
    await request.put('/api/llm/config/models/default', { data: backup.models.default });
  }
  if (backup.embeddings?.default) {
    await request.put('/api/llm/config/embeddings/default', { data: backup.embeddings.default });
  }
}

/* ------------------------------------------------------------------ */
/*  UI helpers                                                         */
/* ------------------------------------------------------------------ */

export async function selectEngine(page: Page, engine: string): Promise<void> {
  const ENGINE_LABELS: Record<string, string> = {
    'llama-cpp': 'llama.cpp',
    'mlx-serve': 'MLX',
    'ollama': 'Ollama',
    'lmstudio': 'LM Studio',
  };
  const label = ENGINE_LABELS[engine] || engine;
  const tab = page.locator('.llm-engine-tab', { hasText: label });
  await tab.click();
  await tab.waitFor({ state: 'attached' });
  // wait for the active class to appear
  await page.locator('.llm-engine-tab.active', { hasText: label }).waitFor({ timeout: 5_000 });
}

export async function navigateToLlm(page: Page): Promise<void> {
  await page.goto('/#llm', { waitUntil: 'domcontentloaded' });
  await page.locator('.llm-provider-tabs').waitFor({ state: 'attached', timeout: 10_000 });
}

export async function setSliderValue(page: Page, selector: string, value: number): Promise<void> {
  await page.locator(selector).evaluate((el: HTMLInputElement, val: number) => {
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/* ------------------------------------------------------------------ */
/*  Engine unload                                                      */
/* ------------------------------------------------------------------ */

export async function unloadEngine(request: APIRequestContext, engine: string): Promise<void> {
  const engines = await getEngines(request);
  const info = engines[engine];
  if (!info?.running?.length) return;

  for (const model of info.running) {
    await request.post('/api/local-llm/engines/unload', {
      data: { engine, model: model.name, instanceId: model.instanceId },
    });
  }

  // Wait for the engine to finish processing unloads
  await new Promise((r) => setTimeout(r, 2_000));
}

export async function stopManagedEngines(request: APIRequestContext): Promise<void> {
  try { await request.post('/api/local-llm/stop'); } catch { /* ignore */ }
  try { await request.post('/api/local-llm/stop-embedding'); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  Model classification                                               */
/* ------------------------------------------------------------------ */

export function isEmbeddingModel(name: string): boolean {
  return /embed|MiniLM|bge-|e5-|gte-|nomic/i.test(name);
}
