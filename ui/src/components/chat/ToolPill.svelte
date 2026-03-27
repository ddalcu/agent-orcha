<script lang="ts">
  interface Props {
    runId: string;
    toolName: string;
    input?: string;
    output?: string;
    done: boolean;
    isThinking?: boolean;
  }
  let { runId, toolName, input = '', output = '', done, isThinking = false }: Props = $props();

  let detailsVisible = $state(false);
  let pillEl = $state<HTMLDivElement | null>(null);
  let detailsEl = $state<HTMLDivElement | null>(null);

  function handlePillClick(e: MouseEvent) {
    if (!done) return;
    if (detailsEl?.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    detailsVisible = !detailsVisible;
  }

  function handleDocumentClick(e: MouseEvent) {
    if (pillEl && !pillEl.contains(e.target as Node)) {
      detailsVisible = false;
    }
  }

  $effect(() => {
    document.addEventListener('click', handleDocumentClick, { capture: true });
    return () => document.removeEventListener('click', handleDocumentClick, { capture: true });
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  bind:this={pillEl}
  id="tool-{runId}"
  class="tool-pill"
  class:done
  class:thinking={isThinking}
  role="button"
  tabindex="0"
  onclick={handlePillClick}
>
  {#if done}
    <span class="inline-flex items-center gap-1">
      <i class="fas fa-check text-green text-2xs"></i>
      <span>{toolName}</span>
    </span>
    <div bind:this={detailsEl} class="tool-invocation-details" class:visible={detailsVisible}>
      {#if input}
        <div class="tool-detail-section">
          <h4>Input</h4>
          <pre class="tool-detail-pre custom-scrollbar">{input}</pre>
        </div>
      {/if}
      {#if output}
        <div class="tool-detail-section">
          <h4>Output</h4>
          <pre class="tool-detail-pre custom-scrollbar">{output}</pre>
        </div>
      {/if}
    </div>
  {:else if isThinking}
    <i class="fas fa-brain animate-pulse text-2xs"></i>
    <span>{toolName}</span>
  {:else}
    <i class="fas fa-circle-notch animate-spin text-blue text-2xs"></i>
    <span>{toolName}</span>
  {/if}
</div>
