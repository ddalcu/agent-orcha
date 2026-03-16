<script lang="ts">
  interface Props {
    questions: string[];
    onselect: (question: string) => void;
  }
  let { questions, onselect }: Props = $props();
</script>

{#if questions.length > 0}
  <div class="sample-questions-wrap">
    {#each questions as q}
      <button class="sample-question-chip" onclick={() => onselect(q)}>{q}</button>
    {/each}
  </div>
{/if}
