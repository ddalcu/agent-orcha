<script lang="ts">
  interface Props {
    elapsed: string;
    statusText?: string;
    oncancel: () => void;
  }
  let { elapsed, statusText = 'Generating...', oncancel }: Props = $props();
</script>

<div class="stream-status-bar">
  <div class="status-dot-pulse"></div>
  <span class="stream-status-text">{statusText}</span>
  <span class="stream-elapsed text-muted">{elapsed}</span>
  <button class="stream-cancel-btn" onclick={oncancel}>Stop</button>
</div>
