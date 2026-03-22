<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    task: string;
    image?: string;
    error?: string;
    input?: string;
  }

  let { task, image, error: initError, input }: Props = $props();

  let status = $state<'done' | 'error'>('done');
  let errorMsg = $state('');

  onMount(() => {
    if (initError) {
      errorMsg = initError;
      status = 'error';
    }
  });
</script>

<div class="model-output">
  {#if status === 'error'}
    <div class="model-output-error">{errorMsg}</div>
  {:else if image}
    <img src={image} alt={input ?? 'Generated image'} class="model-output-image" />
  {/if}
</div>

<style>
  .model-output {
    margin: 0.5rem 0;
  }
  .model-output-error {
    color: var(--red, #ef4444);
    font-size: 0.85rem;
    padding: 0.5rem 0;
  }
  .model-output-image {
    max-width: 100%;
    border-radius: 8px;
    margin: 0.25rem 0;
  }
</style>
