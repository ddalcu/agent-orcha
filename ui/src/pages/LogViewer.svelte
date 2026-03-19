<script lang="ts">
  import { api } from '../lib/services/api.js';
  import { onDestroy } from 'svelte';

  const LEVEL_CLASSES: Record<string, string> = {
    trace: 'log-trace', debug: 'log-debug', info: 'log-info',
    warn: 'log-warn', error: 'log-error', fatal: 'log-fatal',
  };
  const MAX_VISIBLE_LINES = 2000;

  let isOpen = $state(false);
  let autoScroll = $state(true);
  let lineCount = $state(0);
  let eventSource: EventSource | null = null;
  let bodyEl: HTMLElement;

  function toggle() {
    isOpen = !isOpen;
    if (isOpen) connect();
    else disconnect();
  }

  function connect() {
    if (eventSource) return;
    eventSource = api.streamLogs();
    eventSource.onmessage = (e) => {
      try {
        appendLine(JSON.parse(e.data));
      } catch { /* ignore */ }
    };
  }

  function disconnect() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  function appendLine(entry: { timestamp?: string; level?: string; component?: string; message: string }) {
    if (!bodyEl) return;
    const line = document.createElement('div');
    line.className = `log-line ${LEVEL_CLASSES[entry.level || ''] || ''}`;
    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false }) : '';
    const lvl = (entry.level || '').toUpperCase().padEnd(5);
    const comp = entry.component ? `[${entry.component}] ` : '';
    line.textContent = `${time} ${lvl} ${comp}${entry.message}`;
    bodyEl.appendChild(line);
    lineCount++;
    if (lineCount > MAX_VISIBLE_LINES) {
      const excess = lineCount - MAX_VISIBLE_LINES;
      for (let i = 0; i < excess; i++) bodyEl.firstChild?.remove();
      lineCount = MAX_VISIBLE_LINES;
    }
    if (autoScroll) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function clear() {
    if (bodyEl) bodyEl.innerHTML = '';
    lineCount = 0;
  }

  function toggleAutoScroll() {
    autoScroll = !autoScroll;
    if (autoScroll && bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function handleScroll() {
    if (!bodyEl) return;
    const atBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40;
    if (autoScroll !== atBottom) autoScroll = atBottom;
  }

  onDestroy(() => disconnect());
</script>

<div class="log-panel" class:log-panel-closed={!isOpen} class:log-panel-open={isOpen}>
  <div class="log-header" onclick={toggle} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && toggle()}>
    <div class="log-header-left">
      <i class="fas fa-chevron-up log-chevron" class:log-chevron-open={isOpen}></i>
      <i class="fas fa-terminal log-terminal-icon"></i>
      <span class="log-title">Console</span>
    </div>
    <div class="log-header-right">
      <button class="log-btn" class:log-autoscroll-active={autoScroll} title="Auto-scroll"
        onclick={(e: MouseEvent) => { e.stopPropagation(); toggleAutoScroll(); }}>
        <i class="fas fa-angles-down"></i>
      </button>
      <button class="log-btn" title="Clear" onclick={(e: MouseEvent) => { e.stopPropagation(); clear(); }}>
        <i class="fas fa-ban"></i>
      </button>
    </div>
  </div>
  <div class="log-body" bind:this={bodyEl} onscroll={handleScroll}></div>
</div>
