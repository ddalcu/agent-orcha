<script lang="ts">
  interface Props {
    active: boolean;
    disabled?: boolean;
    onchange: (active: boolean) => void;
  }
  let { active, disabled = false, onchange }: Props = $props();
</script>

<button
  class="toggle {active ? 'on' : ''}"
  {disabled}
  title={active ? 'Active' : 'Inactive'}
  onclick={() => onchange(!active)}
>
  <span class="toggle-thumb"></span>
</button>

<style>
  .toggle {
    position: relative;
    width: 34px;
    height: 18px;
    border-radius: 9px;
    border: none;
    background: var(--border);
    cursor: pointer;
    padding: 0;
    transition: background 0.15s;
    flex-shrink: 0;
  }
  .toggle:hover { background: var(--text-3); }
  .toggle.on { background: var(--green); }
  .toggle.on:hover { background: var(--green); opacity: 0.85; }
  .toggle:disabled { opacity: 0.4; cursor: default; }
  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s;
  }
  .toggle.on .toggle-thumb { transform: translateX(16px); }
</style>
