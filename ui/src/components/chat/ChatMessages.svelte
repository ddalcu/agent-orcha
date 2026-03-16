<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }
  let { children }: Props = $props();

  let containerEl = $state<HTMLDivElement | null>(null);

  export function scrollToBottom() {
    if (containerEl) {
      containerEl.scrollTop = containerEl.scrollHeight;
    }
  }

  export function getElement(): HTMLDivElement | null {
    return containerEl;
  }
</script>

<div bind:this={containerEl} class="chat-messages custom-scrollbar">
  {@render children()}
</div>
