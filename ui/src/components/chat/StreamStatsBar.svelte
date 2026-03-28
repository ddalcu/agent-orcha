<script lang="ts">
  interface Props {
    elapsed: string;
    inputTokens: string;
    outputTokens: string;
    tps: string;
    cancelled: boolean;
    visible: boolean;
    remotePeer?: string;
  }
  let {
    elapsed,
    inputTokens,
    outputTokens,
    tps,
    cancelled,
    visible,
    remotePeer,
  }: Props = $props();
</script>

<div class="stream-stats-bar" class:visible>
  {#if remotePeer}
    <span class="flex items-center gap-1">
      <i class="fas fa-network-wired text-2xs"></i>
      <span>{remotePeer}</span>
    </span>
    <span class="divider">|</span>
  {/if}
  <span class="flex items-center gap-1">
    <i class="far fa-clock"></i>
    <span>{elapsed}</span>
  </span>
  <span class="divider">|</span>
  <span class="flex items-center gap-1">
    <i class="fas fa-arrow-up text-2xs"></i>
    <span>{inputTokens}</span>
  </span>
  <span class="divider">|</span>
  <span class="flex items-center gap-1">
    <i class="fas fa-arrow-down text-2xs"></i>
    <span>{outputTokens}</span>
  </span>
  <span class="divider">|</span>
  <span class="flex items-center gap-1">
    <i class="fas fa-bolt text-2xs"></i>
    <span>{tps}</span>
  </span>
  {#if cancelled}
    <span class="badge badge-amber">Cancelled</span>
  {/if}
</div>
