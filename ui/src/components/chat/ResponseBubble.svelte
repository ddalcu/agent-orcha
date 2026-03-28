<script lang="ts">
  import { renderMarkdown, highlightCode } from '../../lib/services/markdown.js';
  import ToolPill from './ToolPill.svelte';
  import ThinkingPill from './ThinkingPill.svelte';
  import ModelOutput from './ModelOutput.svelte';
  import type { Snippet } from 'svelte';

  interface ToolData {
    runId: string;
    tool: string;
    input: string;
    output?: string;
    done: boolean;
  }

  interface ThinkingData {
    content: string;
    done: boolean;
  }

  interface ModelOutputData {
    task: string;
    input?: string;
    image?: string;
    audio?: string;
    video?: string;
    error?: string;
  }

  interface Props {
    id: string;
    content?: string;
    tools?: ToolData[];
    thinkingSections?: ThinkingData[];
    modelOutputs?: ModelOutputData[];
    isLoading?: boolean;
    error?: string;
    children?: Snippet;
  }
  let {
    id,
    content = '',
    tools = [],
    thinkingSections = [],
    modelOutputs = [],
    isLoading = false,
    error = '',
    children,
  }: Props = $props();

  let contentEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (contentEl && content) {
      contentEl.innerHTML = renderMarkdown(content);
      highlightCode(contentEl);
    }
  });

  const hasToolPills = $derived(tools.length > 0 || thinkingSections.length > 0);
</script>

<div id={id} class="flex justify-start">
  <div class="response-bubble-inner group" class:loading={isLoading && !content && !error}>
    <div class="response-content" class:whitespace-pre-wrap={isLoading && !content && !error} class:flex={isLoading && !content && !error} class:items-center={isLoading && !content && !error}>
      {#if error}
        <span class="text-red">{error}</span>
      {:else if content}
        <div bind:this={contentEl} class="content-text markdown-content"></div>
      {:else if isLoading}
        <div class="loading-dots">
          <div></div>
          <div></div>
          <div></div>
        </div>
      {/if}
      {#if modelOutputs.length > 0}
        {#each modelOutputs as mo}
          <ModelOutput task={mo.task} input={mo.input} image={mo.image} audio={mo.audio} video={mo.video} error={mo.error} />
        {/each}
      {/if}
      {#if children}
        {@render children()}
      {/if}
    </div>
    {#if hasToolPills}
      <div class="tool-invocations">
        {#each thinkingSections as thinking}
          <ThinkingPill content={thinking.content} done={thinking.done} />
        {/each}
        {#each tools as tool}
          <ToolPill runId={tool.runId} toolName={tool.tool} input={tool.input} output={tool.output} done={tool.done} />
        {/each}
      </div>
    {/if}
  </div>
</div>
