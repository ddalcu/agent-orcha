<script lang="ts">
  interface Props {
    disabled?: boolean;
    readonly?: boolean;
    placeholder?: string;
    onsubmit: (message: string) => void;
    onfileselect?: (files: File[]) => void;
    onplusclick?: (event: MouseEvent) => void;
    onclick?: () => void;
  }
  let {
    disabled = false,
    readonly = false,
    placeholder = 'Ask anything',
    onsubmit,
    onfileselect,
    onplusclick,
    onclick,
  }: Props = $props();

  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  let fileInputEl = $state<HTMLInputElement | null>(null);

  const FILE_ACCEPT = "image/*,audio/*,.wav,.mp3,.ogg,.flac,.pdf,.doc,.docx,.xls,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.go,.rs,.rb,.php,.sql,.sh,.log,.ini,.toml,.env";

  function handleInput() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 200) + 'px';
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    if (!textareaEl) return;
    const message = textareaEl.value.trim();
    if (!message && !disabled) {
      // allow submit even with empty message if attachments exist (parent handles)
    }
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
</div>
