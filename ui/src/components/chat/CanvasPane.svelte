<script lang="ts">
  import { renderMarkdown, highlightCode } from '../../lib/services/markdown.js';

  interface Props {
    content: string;
    title: string;
    format: 'markdown' | 'html' | 'code';
    language?: string;
    onclose: () => void;
  }
  let { content, title, format, language = '', onclose }: Props = $props();

  let activeView = $state<'preview' | 'code'>('preview');
  let previewEl = $state<HTMLDivElement | null>(null);
  let codeEl = $state<HTMLElement | null>(null);
  let publishModalOpen = $state(false);
  let publishUrl = $state('');

  $effect(() => {
    if (activeView === 'preview' && previewEl && format === 'markdown') {
      previewEl.innerHTML = renderMarkdown(content);
      highlightCode(previewEl);
    }
  });

  $effect(() => {
    if (activeView === 'code' && codeEl && content) {
      codeEl.textContent = content;
      highlightCode(codeEl.parentElement!);
    }
  });

  $effect(() => {
    if (activeView === 'preview' && codeEl && format === 'code') {
      // For code format in preview mode, render with syntax highlighting
      if (codeEl) {
        codeEl.textContent = content;
        highlightCode(codeEl.parentElement!);
      }
    }
  });

  function handlePublish() {
    publishModalOpen = true;
    publishUrl = '';
  }

  function closePublishModal() {
    publishModalOpen = false;
  }

  function copyContent() {
    navigator.clipboard.writeText(content);
  }
</script>

<div class="canvas-pane">
  <div class="canvas-header">
    <span class="canvas-title">{title}</span>
    {#if format !== 'html'}
      <div class="canvas-toggle">
        <button
          class="canvas-toggle-btn"
          class:active={activeView === 'preview'}
          onclick={() => { activeView = 'preview'; }}
        >Preview</button>
        <button
          class="canvas-toggle-btn"
          class:active={activeView === 'code'}
          onclick={() => { activeView = 'code'; }}
        >Code</button>
      </div>
    {:else}
      <div class="canvas-toggle">
        <button
          class="canvas-toggle-btn"
          class:active={activeView === 'preview'}
          onclick={() => { activeView = 'preview'; }}
        >Preview</button>
        <button
          class="canvas-toggle-btn"
          class:active={activeView === 'code'}
          onclick={() => { activeView = 'code'; }}
        >Source</button>
      </div>
    {/if}
    <button class="canvas-publish-btn" title="Publish" aria-label="Publish" onclick={handlePublish}>
      <i class="fas fa-arrow-up-from-bracket text-sm"></i>
    </button>
    <button class="canvas-close-btn" title="Close" aria-label="Close" onclick={onclose}>
      <i class="fas fa-xmark text-sm"></i>
    </button>
  </div>
  <div class="canvas-body custom-scrollbar">
    {#if activeView === 'preview'}
      {#if format === 'markdown'}
        <div bind:this={previewEl} class="canvas-preview markdown-content"></div>
      {:else if format === 'html'}
        <iframe
          class="canvas-iframe"
          sandbox="allow-scripts allow-same-origin"
          srcdoc={content}
          title={title}
        ></iframe>
      {:else}
        <pre class="canvas-code"><code bind:this={codeEl} class={language ? `language-${language}` : ''}>{content}</code></pre>
      {/if}
    {:else}
      <pre class="canvas-code"><code>{content}</code></pre>
    {/if}
  </div>
</div>

{#if publishModalOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) closePublishModal(); }}>
    <div class="modal-content modal-content-sm">
      <div class="modal-header">
        <h3 class="text-lg font-semibold text-primary">Publish Content</h3>
        <button class="modal-close-btn" aria-label="Close modal" onclick={closePublishModal}>
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <div class="p-4 flex flex-col gap-3">
        <p class="text-sm text-secondary">Copy the content to share it.</p>
        <button class="btn btn-accent w-full" onclick={copyContent}>
          <i class="far fa-copy"></i>
          Copy to Clipboard
        </button>
        {#if publishUrl}
          <div class="text-sm text-green text-center">{publishUrl}</div>
        {/if}
      </div>
    </div>
  </div>
{/if}
