<script lang="ts">
  import { escapeHtml } from '../../lib/utils/format.js';

  interface Attachment {
    data: string;
    mediaType: string;
    name: string;
  }

  interface Props {
    attachments: Attachment[];
    onremove: (index: number) => void;
  }
  let { attachments, onremove }: Props = $props();
</script>

{#if attachments.length > 0}
  <div class="attachment-preview visible">
    {#each attachments as att, i}
      <div class="attachment-pill">
        {#if att.mediaType.startsWith('image/')}
          <img src="data:{att.mediaType};base64,{att.data}" alt={att.name}>
        {:else}
          <i class="fas fa-file text-secondary text-lg"></i>
        {/if}
        <span class="truncate attachment-name">{att.name}</span>
        <button class="attachment-remove" aria-label="Remove attachment" onclick={() => onremove(i)}>
          <i class="fas fa-xmark text-xs"></i>
        </button>
      </div>
    {/each}
  </div>
{/if}
