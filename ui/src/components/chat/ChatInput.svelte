<script lang="ts">
  import { tick } from 'svelte';

  export interface MentionableAgent {
    name: string;
    description?: string;
    icon?: string;
  }

  interface Props {
    disabled?: boolean;
    readonly?: boolean;
    placeholder?: string;
    mentionAgents?: MentionableAgent[];
    onsubmit: (message: string) => void;
    onfileselect?: (files: File[]) => void;
    onplusclick?: (event: MouseEvent) => void;
    onclick?: () => void;
  }
  let {
    disabled = false,
    readonly = false,
    placeholder = 'Ask anything',
    mentionAgents = [],
    onsubmit,
    onfileselect,
    onplusclick,
    onclick,
  }: Props = $props();

  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  let fileInputEl = $state<HTMLInputElement | null>(null);

  // Mention popup state
  let mentionOpen = $state(false);
  let mentionQuery = $state('');
  let mentionIndex = $state(0);
  let mentionStartPos = $state(0);
  let popupEl = $state<HTMLDivElement | null>(null);

  const filteredMentions = $derived(
    mentionAgents.filter(a =>
      !mentionQuery || a.name.toLowerCase().includes(mentionQuery.toLowerCase())
    )
  );

  const FILE_ACCEPT = "image/*,audio/*,.wav,.mp3,.ogg,.flac,.pdf,.doc,.docx,.xls,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.go,.rs,.rb,.php,.sql,.sh,.log,.ini,.toml,.env";

  function handleInput() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 200) + 'px';
    detectMention();
  }

  function detectMention() {
    if (!textareaEl || mentionAgents.length === 0) {
      closeMention();
      return;
    }

    const pos = textareaEl.selectionStart;
    const text = textareaEl.value.substring(0, pos);

    // Find the last @ that isn't preceded by a word character
    const match = text.match(/(^|[^a-zA-Z0-9])@([a-zA-Z0-9_-]*)$/);
    if (!match) {
      closeMention();
      return;
    }

    const query = match[2];
    // Position of the @ character
    const atPos = pos - query.length - 1;

    mentionQuery = query;
    mentionStartPos = atPos;
    mentionIndex = 0;
    mentionOpen = true;
  }

  function closeMention() {
    mentionOpen = false;
    mentionQuery = '';
    mentionIndex = 0;
  }

  function selectMention(agent: MentionableAgent) {
    if (!textareaEl) return;

    const before = textareaEl.value.substring(0, mentionStartPos);
    const after = textareaEl.value.substring(mentionStartPos + 1 + mentionQuery.length);
    const inserted = `@${agent.name} `;

    textareaEl.value = before + inserted + after;
    const newPos = before.length + inserted.length;
    textareaEl.selectionStart = newPos;
    textareaEl.selectionEnd = newPos;

    closeMention();
    textareaEl.focus();
    handleInput();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (mentionOpen && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionIndex = (mentionIndex + 1) % filteredMentions.length;
        scrollMentionIntoView();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionIndex = (mentionIndex - 1 + filteredMentions.length) % filteredMentions.length;
        scrollMentionIntoView();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(filteredMentions[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function scrollMentionIntoView() {
    tick().then(() => {
      if (!popupEl) return;
      const active = popupEl.querySelector('.mention-item.active');
      active?.scrollIntoView({ block: 'nearest' });
    });
  }

  function submit() {
    if (!textareaEl) return;
    closeMention();
    onsubmit(textareaEl.value.trim());
    textareaEl.value = '';
    textareaEl.style.height = 'auto';
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0 && onfileselect) {
      onfileselect(Array.from(input.files));
    }
    input.value = '';
  }

  function handleMousedown(e: MouseEvent) {
    if (readonly && onclick) {
      e.preventDefault();
      onclick();
    }
  }

  function handleBlur(e: FocusEvent) {
    // Close mention popup when focus leaves the input area entirely
    // But not when clicking inside the popup itself
    const related = e.relatedTarget as HTMLElement | null;
    if (related && popupEl?.contains(related)) return;
    // Small delay so click on popup item can fire first
    setTimeout(() => {
      if (!textareaEl?.matches(':focus')) {
        closeMention();
      }
    }, 150);
  }

  export function focus() {
    textareaEl?.focus();
  }

  export function setValue(text: string) {
    if (textareaEl) {
      textareaEl.value = text;
      textareaEl.focus();
    }
  }

  export function getValue(): string {
    return textareaEl?.value.trim() ?? '';
  }

  export function clear() {
    if (textareaEl) {
      textareaEl.value = '';
      textareaEl.style.height = 'auto';
    }
    closeMention();
  }

  export function triggerFileSelect(accept?: string) {
    if (fileInputEl) {
      fileInputEl.accept = accept || FILE_ACCEPT;
      fileInputEl.click();
    }
  }
</script>

<div class="chat-input-wrap">
  <input
    type="file"
    bind:this={fileInputEl}
    multiple
    accept={FILE_ACCEPT}
    class="hidden"
    onchange={handleFileChange}
  >
  <textarea
    bind:this={textareaEl}
    rows="1"
    {placeholder}
    disabled={disabled}
    readonly={readonly}
    class:cursor-pointer={readonly}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onmousedown={handleMousedown}
    onblur={handleBlur}
  ></textarea>
  <div class="chat-input-actions left">
    <button
      type="button"
      class="attach-btn"
      title="Attach files"
      onclick={(e: MouseEvent) => onplusclick ? onplusclick(e) : fileInputEl?.click()}
    >
      <i class="fas fa-plus text-sm"></i>
    </button>
  </div>
  <div class="chat-input-actions right">
    <button
      class="send-btn"
      aria-label="Send message"
      disabled={disabled}
      onclick={submit}
    >
      <i class="fas fa-paper-plane text-sm"></i>
    </button>
  </div>

  {#if mentionOpen && filteredMentions.length > 0}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={popupEl}
      class="mention-popup"
      style="bottom: calc(100% + 4px); left: 0; right: 0;"
    >
      {#each filteredMentions as agent, i}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="mention-item"
          class:active={i === mentionIndex}
          onmousedown={(e: MouseEvent) => { e.preventDefault(); selectMention(agent); }}
          onmouseenter={() => mentionIndex = i}
          role="option"
          aria-selected={i === mentionIndex}
        >
          <span class="mention-item-icon">
            <i class={agent.icon || 'fas fa-robot'}></i>
          </span>
          <span class="mention-item-info">
            <span class="mention-item-name">@{agent.name}</span>
            {#if agent.description}
              <span class="mention-item-desc">{agent.description}</span>
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>
