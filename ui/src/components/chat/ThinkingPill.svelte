<script lang="ts">
  import { renderMarkdown, highlightCode } from '../../lib/services/markdown.js';

  interface Props {
    content: string;
    done: boolean;
  }
  let { content, done }: Props = $props();

  let detailsVisible = $state(false);
  let pillEl = $state<HTMLDivElement | null>(null);
  let detailsEl = $state<HTMLDivElement | null>(null);
  let contentEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (done && contentEl && content) {
      contentEl.innerHTML = renderMarkdown(content);
      highlightCode(contentEl);
    }
  });

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

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  bind:this={pillEl}
  class="tool-pill thinking"
  class:done
  onclick={handlePillClick}
>
  {#if done}
    <span class="inline-flex items-center gap-1">
      <i class="fas fa-brain text-purple text-2xs"></i>
      <span>Thinking</span>
    </span>
    <div bind:this={detailsEl} class="tool-invocation-details" class:visible={detailsVisible}>
      <div class="tool-detail-section">
        <div bind:this={contentEl} class="tool-detail-pre markdown-content custom-scrollbar"></div>
      </div>
    </div>
  {:else}
    <i class="fas fa-brain animate-pulse text-2xs"></i>
    <span>Thinking...</span>
  {/if}
</div>
