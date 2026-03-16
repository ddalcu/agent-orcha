<script lang="ts">
  import { escapeHtml } from '../../lib/utils/format.js';

  interface Attachment {
    data: string;
    mediaType: string;
    name: string;
  }

  interface Props {
    content: string;
    attachments?: Attachment[] | null;
  }
  let { content, attachments = null }: Props = $props();
</script>

<div class="flex justify-end">
  <div class="user-bubble">
    {#if attachments && attachments.length > 0}
      <div class="flex flex-wrap gap-2 mb-2">
        {#each attachments as att}
          {#if att.mediaType.startsWith('image/') && att.data}
            <img src="data:{att.mediaType};base64,{att.data}" class="attachment-thumb" alt={att.name}>
          {:else}
            <div class="attachment-pill">
              <i class="fas fa-file"></i>
              <span class="truncate attachment-name">{att.name}</span>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
    <div class="whitespace-pre-wrap">{content}</div>
  </div>
</div>
