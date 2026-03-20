<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import yaml from 'js-yaml';
  import { api } from '../lib/services/api.js';
  import AgentComposer from './AgentComposer.svelte';

  const ace = (globalThis as any).ace;

  // --- Constants ---
  const FILE_ICONS: Record<string, { icon: string; color: string }> = {
    yaml: { icon: 'fa-file-code', color: 'text-orange' },
    yml: { icon: 'fa-file-code', color: 'text-orange' },
    json: { icon: 'fa-file-code', color: 'text-yellow' },
    js: { icon: 'fa-file-code', color: 'text-yellow' },
    mjs: { icon: 'fa-file-code', color: 'text-yellow' },
    ts: { icon: 'fa-file-code', color: 'text-yellow' },
    txt: { icon: 'fa-file-lines', color: 'text-secondary' },
    md: { icon: 'fa-file-lines', color: 'text-blue' },
    default: { icon: 'fa-file', color: 'text-muted' },
  };

  const ACE_MODES: Record<string, string> = {
    yaml: 'ace/mode/yaml',
    yml: 'ace/mode/yaml',
    json: 'ace/mode/json',
    js: 'ace/mode/javascript',
    mjs: 'ace/mode/javascript',
    ts: 'ace/mode/typescript',
    md: 'ace/mode/markdown',
    default: 'ace/mode/text',
  };

  const RESOURCE_TYPES: Record<string, { label: string; icon: string; color: string; folder: string; suffix: string }> = {
    agent: { label: 'Agent', icon: 'fa-robot', color: 'text-blue', folder: 'agents/', suffix: '.agent.yaml' },
    function: { label: 'Function', icon: 'fa-bolt', color: 'text-yellow', folder: 'functions/', suffix: '.function.mjs' },
    knowledge: { label: 'Knowledge', icon: 'fa-database', color: 'text-purple', folder: 'knowledge/', suffix: '.knowledge.yaml' },
    skill: { label: 'Skill', icon: 'fa-wand-magic-sparkles', color: 'text-green', folder: 'skills/', suffix: '/SKILL.md' },
    workflow: { label: 'Workflow', icon: 'fa-diagram-project', color: 'text-orange', folder: 'workflows/', suffix: '.workflow.yaml' },
  };

  // --- Helpers ---
  function getExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  }

  function isAgentFile(path: string | null | undefined): boolean {
    return !!path && path.endsWith('.agent.yaml');
  }

  function getFileIcon(filename: string): { icon: string; color: string } {
    return FILE_ICONS[getExtension(filename)] || FILE_ICONS.default;
  }

  // --- State ---
  interface FileNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    children?: FileNode[];
  }

  interface CurrentFile {
    path: string;
    content: string;
  }

  let treeData = $state<FileNode[]>([]);
  let expandedDirs = $state<Set<string>>(new Set());
  let currentFile = $state<CurrentFile | null>(null);
  let savedContent = $state(''); // snapshot of content at last open/save
  let isDirty = $state(false);
  let viewMode = $state<'source' | 'visual'>('source');
  let renamingPath = $state<string | null>(null);
  let renameValue = $state('');
  let loading = $state(false);
  let prevFilePath = $state<string | null>(null);

  // Dropdown/modal
  let dropdownOpen = $state(false);
  let createModalType = $state<string | null>(null);
  let createModalName = $state('');

  // Context menu
  let contextMenuPath = $state<string | null>(null);
  let contextMenuType = $state<'file' | 'directory'>('file');
  let contextMenuPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });

  // Save feedback
  let savedMsg = $state('');
  let savedMsgClass = $state('text-green');

  // Toast
  let toastMsg = $state('');
  let toastType = $state<'info' | 'error'>('info');

  // Ace editor
  let aceEditorEl: HTMLDivElement | undefined = $state();
  let editor: any = null;

  // Composer reference
  let composerRef: ReturnType<typeof AgentComposer> | undefined = $state();
  let composerData = $state<Record<string, any>>({});

  // Rename input ref
  let renameInputEl: HTMLInputElement | undefined = $state();

  // Breadcrumb
  let breadcrumb = $derived(currentFile ? currentFile.path.split('/').join(' / ') : 'Select a file to edit');

  // Show mode toggle
  let showModeToggle = $derived(currentFile && isAgentFile(currentFile.path));

  // --- Lifecycle ---
  function handleKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveFile();
    }
  }

  function handleDocClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    // Close dropdown
    if (dropdownOpen && !target.closest('.ide-new-resource-wrapper')) {
      dropdownOpen = false;
    }
    // Close context menu
    if (contextMenuPath !== null && !target.closest('.context-menu')) {
      contextMenuPath = null;
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('click', handleDocClick);
    loadTree();
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('click', handleDocClick);
    if (editor) {
      editor.destroy();
      editor = null;
    }
  });

  // Focus rename input
  $effect(() => {
    if (renamingPath !== null && renameInputEl) {
      requestAnimationFrame(() => {
        if (!renameInputEl) return;
        renameInputEl.focus();
        const val = renameInputEl.value;
        const dotIdx = val.lastIndexOf('.');
        renameInputEl.setSelectionRange(0, dotIdx > 0 ? dotIdx : val.length);
      });
    }
  });

  // Init/sync ace editor
  $effect(() => {
    if (aceEditorEl && currentFile && viewMode === 'source') {
      untrack(() => syncAceContent());
    }
  });

  // --- Tree ---
  async function loadTree() {
    try {
      const data = await api.getFileTree();
      treeData = data.tree || [];
    } catch (err) {
      console.error('Failed to load file tree:', err);
    }
  }

  function toggleDir(dirPath: string) {
    const next = new Set(expandedDirs);
    if (next.has(dirPath)) {
      next.delete(dirPath);
    } else {
      next.add(dirPath);
    }
    expandedDirs = next;
  }

  // --- File operations ---
  async function openFile(filePath: string) {
    if (isDirty) {
      const confirmed = confirm('You have unsaved changes. Discard and open another file?');
      if (!confirmed) return;
    }

    try {
      const data = await api.readFile(filePath);
      currentFile = { path: data.path, content: data.content };
      savedContent = data.content;
      isDirty = false;

      // Preserve visual/source choice when switching between agent files
      if (!isAgentFile(filePath)) {
        viewMode = 'source';
      } else if (!isAgentFile(prevFilePath)) {
        viewMode = 'visual';
      }
      prevFilePath = filePath;

      if (viewMode === 'visual' && isAgentFile(filePath)) {
        try {
          const parsed = yaml.load(data.content);
          if (parsed && typeof parsed === 'object') {
            composerData = parsed as Record<string, any>;
          }
        } catch { /* ignore parse error */ }
      }

      loading = true;
      await tick();
      syncAceContent();
      loading = false;
      savedMsg = '';
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  }

  function syncAceContent() {
    if (!currentFile || !aceEditorEl) return;

    if (!editor) {
      editor = ace.edit(aceEditorEl);
      editor.setTheme('ace/theme/one_dark');
      editor.setOptions({
        fontSize: '14px',
        showPrintMargin: false,
        wrap: true,
        tabSize: 2,
        useSoftTabs: true,
      });
      editor.session.on('change', () => {
        if (loading) return;
        const current = editor!.getValue();
        const dirty = current !== savedContent;
        if (dirty !== isDirty) {
          isDirty = dirty;
          if (dirty) savedMsg = '';
        }
      });
    }

    const ext = getExtension(currentFile.path);
    const mode = ACE_MODES[ext] || ACE_MODES.default;
    editor.session.setMode(mode);
    editor.setValue(currentFile.content, -1);
  }

  async function saveFile() {
    if (!currentFile || !isDirty) return;

    let content: string;
    if (viewMode === 'visual' && composerRef) {
      const data = composerRef.getData();
      content = yaml.dump(data, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
    } else {
      if (!editor) return;
      content = editor.getValue();
    }

    try {
      const result = await api.writeFile(currentFile.path, content);
      currentFile = { ...currentFile, content };
      savedContent = content;
      isDirty = false;

      const reloaded = result.reloaded && result.reloaded !== 'none';
      const failed = result.reloaded === 'error';
      if (failed) {
        savedMsg = 'Saved (reload failed)';
        savedMsgClass = 'text-amber';
      } else if (reloaded) {
        savedMsg = `Saved & reloaded ${result.reloaded}`;
        savedMsgClass = 'text-green';
      } else {
        savedMsg = 'Saved!';
        savedMsgClass = 'text-green';
      }
      setTimeout(() => { savedMsg = ''; }, 2500);
    } catch (err) {
      console.error('Failed to save file:', err);
      alert('Failed to save file.');
    }
  }

  async function deleteFile(filePath: string) {
    try {
      const result = await api.deleteFile(filePath);
      if (result.error) {
        alert(result.error);
        return;
      }

      if (currentFile && currentFile.path === filePath) {
        currentFile = null;
        isDirty = false;
        viewMode = 'source';
      }

      await loadTree();
    } catch (err) {
      console.error('Failed to delete file:', err);
      alert('Failed to delete file.');
    }
  }

  function confirmDelete(filePath: string, type: string) {
    const name = filePath.split('/').pop();
    const isDir = type === 'directory';
    const msg = isDir
      ? `Delete folder "${name}" and all its contents?`
      : `Delete "${name}"?`;
    if (!confirm(msg)) return;
    deleteFile(filePath);
  }

  function startRename(filePath: string) {
    renamingPath = filePath;
    renameValue = filePath.split('/').pop() || '';
    contextMenuPath = null;
  }

  async function commitRename() {
    if (!renamingPath) return;
    const value = renameValue.trim();
    if (!value) {
      cancelRename();
      return;
    }

    const oldPath = renamingPath;
    const oldName = oldPath.split('/').pop();
    if (value === oldName) {
      cancelRename();
      return;
    }

    const parentDir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : '';
    const newPath = parentDir ? `${parentDir}/${value}` : value;
    renamingPath = null;

    try {
      const result = await api.renameFile(oldPath, newPath);
      if (result.error) {
        alert(result.error);
        return;
      }

      if (currentFile && currentFile.path === oldPath) {
        currentFile = { ...currentFile, path: newPath };
      }

      await loadTree();
    } catch (err) {
      console.error('Failed to rename file:', err);
      alert('Failed to rename file.');
    }
  }

  function cancelRename() {
    renamingPath = null;
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }

  function handleRenameBlur() {
    setTimeout(() => {
      if (renamingPath !== null) {
        cancelRename();
      }
    }, 150);
  }

  // --- Context menu ---
  function showContextMenu(e: MouseEvent, filePath: string, type: 'file' | 'directory') {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const btnRect = btn.getBoundingClientRect();
    contextMenuPath = filePath;
    contextMenuType = type;
    contextMenuPos = { x: btnRect.right + 4, y: btnRect.top };
  }

  // --- Dropdown / new resource ---
  function toggleDropdown(e: MouseEvent) {
    e.stopPropagation();
    dropdownOpen = !dropdownOpen;
  }

  function selectResourceType(type: string) {
    dropdownOpen = false;
    createModalType = type;
    createModalName = '';
    // Focus input after modal renders
    tick().then(() => {
      const input = document.getElementById('resourceNameInput') as HTMLInputElement;
      if (input) input.focus();
    });
  }

  function closeCreateModal() {
    createModalType = null;
  }

  async function createResource() {
    if (!createModalType || !createModalName.trim()) return;
    const type = createModalType;
    const name = createModalName.trim();
    closeCreateModal();

    try {
      const template = await api.getResourceTemplate(type, name);
      if (template.error) {
        alert(template.error);
        return;
      }

      const result = await api.createFile(template.path, template.content);
      if (result.error) {
        alert(result.error);
        return;
      }

      // Expand the parent directory of the new file
      const parts = template.path.split('/');
      if (parts.length > 1) {
        parts.pop();
        const next = new Set(expandedDirs);
        next.add(parts.join('/'));
        expandedDirs = next;
      }

      await loadTree();
      await openFile(template.path);
    } catch (err) {
      console.error('Failed to create resource:', err);
      alert('Failed to create resource.');
    }
  }

  function handleCreateKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      createResource();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCreateModal();
    }
  }

  // --- Mode toggle ---
  function switchToVisual() {
    if (!currentFile) return;

    const content = editor ? editor.getValue() : currentFile.content;
    let parsed: any;
    try {
      parsed = yaml.load(content);
    } catch (err: any) {
      showToast(`Invalid YAML: ${err.message}`, 'error');
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      showToast('YAML must be an object', 'error');
      return;
    }

    viewMode = 'visual';
    composerData = parsed;
    loading = true;
    tick().then(() => {
      loading = false;
      // isDirty is now derived from content comparison — no manual save/restore needed
    });
  }

  async function switchToSource() {
    if (!currentFile) return;

    if (composerRef && viewMode === 'visual') {
      const data = composerRef.getData();
      currentFile = { ...currentFile, content: yaml.dump(data, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false }) };
    }

    loading = true;
    viewMode = 'source';
    await tick();
    syncAceContent();
    loading = false;
    // isDirty is now derived from content comparison — no manual save/restore needed
    if (editor) { editor.resize(); editor.focus(); }
  }

  function handleModeToggle(mode: 'source' | 'visual') {
    if (mode === viewMode) return;
    if (mode === 'visual') switchToVisual();
    else switchToSource();
  }

  // --- Composer change ---
  function handleComposerChange() {
    if (loading) return;
    if (!composerRef) return;
    const current = yaml.dump(composerRef.getData(), { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
    const dirty = current !== savedContent;
    if (dirty !== isDirty) {
      isDirty = dirty;
      if (dirty) savedMsg = '';
    }
  }

  // --- Toast ---
  function showToast(message: string, type: 'info' | 'error' = 'info') {
    toastMsg = message;
    toastType = type;
    setTimeout(() => { toastMsg = ''; }, 4000);
  }

  // --- Public API ---
  export function _selectResourceType(type: string) {
    selectResourceType(type);
  }

  // --- Tree click handlers ---
  function handleTreeItemClick(node: FileNode) {
    contextMenuPath = null;
    if (node.type === 'directory') {
      toggleDir(node.path);
    } else {
      openFile(node.path);
    }
  }
</script>

<div class="ide-shell">
  <!-- Toolbar -->
  <div class="ide-toolbar">
    <div class="flex items-center gap-2 text-sm text-secondary">
      <i class="fas fa-code text-green"></i>
      <span>{breadcrumb}</span>
    </div>
    <div class="flex items-center gap-3">
      <!-- Mode toggle (only for .agent.yaml files) -->
      {#if showModeToggle}
        <div class="mode-toggle">
          <button class="mode-toggle-btn {viewMode === 'source' ? 'active' : ''}"
                  onclick={() => handleModeToggle('source')}>
            <i class="fas fa-code mr-1"></i>Source
          </button>
          <button class="mode-toggle-btn {viewMode === 'visual' ? 'active' : ''}"
                  onclick={() => handleModeToggle('visual')}>
            <i class="fas fa-palette mr-1"></i>Visual
          </button>
        </div>
      {/if}
      {#if isDirty}
        <span class="text-amber text-xs flex items-center gap-1">
          <i class="fas fa-circle text-2xs"></i> Unsaved
        </span>
      {/if}
      {#if savedMsg}
        <span class="{savedMsgClass} text-xs">{savedMsg}</span>
      {/if}
      <button class="btn btn-accent btn-sm {isDirty ? '' : 'opacity-50 cursor-not-allowed'}"
              disabled={!isDirty}
              onclick={saveFile}>
        <i class="fas fa-save mr-1"></i> Save
      </button>
    </div>
  </div>

  <!-- Main content -->
  <div class="ide-main">
    <!-- File tree sidebar -->
    <div class="ide-tree">
      <div class="ide-tree-header">
        <span>Explorer</span>
        <div class="relative ide-new-resource-wrapper">
          <button class="text-muted transition-colors" title="New Resource"
                  onclick={toggleDropdown}>
            <i class="fas fa-plus text-xs"></i>
          </button>
          {#if dropdownOpen}
            <div class="resource-dropdown">
              {#each Object.entries(RESOURCE_TYPES) as [key, rt]}
                <div class="resource-dropdown-item" role="menuitem" tabindex="0"
                     onclick={() => selectResourceType(key)}
                     onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && selectResourceType(key)}>
                  <i class="fas {rt.icon} {rt.color} text-xs"></i>
                  <span>{rt.label}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      <div class="py-1">
        {#if treeData.length === 0}
          <div class="px-4 py-8 text-center text-muted text-sm">
            <i class="fas fa-spinner fa-spin mr-2"></i> Loading...
          </div>
        {:else}
          {#snippet treeNodes(nodes: FileNode[], depth: number)}
            {#each nodes as node}
              {#if node.type === 'directory'}
                {@const isExpanded = expandedDirs.has(node.path)}
                <div class="tree-item tree-depth-{Math.min(depth, 5)}" role="treeitem" tabindex="0" aria-selected={isExpanded}
                     onclick={() => handleTreeItemClick(node)}
                     onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && handleTreeItemClick(node)}>
                  <i class="fas {isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} text-xs text-muted"></i>
                  <i class="fas {isExpanded ? 'fa-folder-open' : 'fa-folder'} text-yellow text-sm"></i>
                  <span class="flex-1 min-w-0">{node.name}</span>
                  {#if depth > 0}
                    <button class="tree-menu-btn" aria-label="More options"
                            onclick={(e: MouseEvent) => { e.stopPropagation(); showContextMenu(e, node.path, 'directory'); }}>
                      <i class="fas fa-ellipsis-v text-xs"></i>
                    </button>
                  {/if}
                </div>
                {#if isExpanded && node.children}
                  {@render treeNodes(node.children, depth + 1)}
                {/if}
              {:else if renamingPath === node.path}
                {@const renameIcon = getFileIcon(node.name)}
                <div class="tree-item tree-depth-{Math.min(depth, 5)}">
                  <span class="tree-item-spacer"></span>
                  <i class="fas {renameIcon.icon} {renameIcon.color} text-sm"></i>
                  <input type="text" class="inline-tree-input"
                         bind:this={renameInputEl}
                         bind:value={renameValue}
                         onkeydown={handleRenameKeydown}
                         onblur={handleRenameBlur} />
                </div>
              {:else}
                {@const iconInfo = getFileIcon(node.name)}
                {@const isActive = currentFile?.path === node.path}
                <div class="tree-item tree-depth-{Math.min(depth, 5)} {isActive ? 'active-file' : ''}" role="treeitem" tabindex="0" aria-selected={isActive}
                     onclick={() => handleTreeItemClick(node)}
                     onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && handleTreeItemClick(node)}>
                  <span class="tree-item-spacer"></span>
                  <i class="fas {iconInfo.icon} {iconInfo.color} text-sm"></i>
                  <span class="tree-filename truncate flex-1 min-w-0">{node.name}</span>
                  <button class="tree-menu-btn" aria-label="More options"
                          onclick={(e: MouseEvent) => { e.stopPropagation(); showContextMenu(e, node.path, 'file'); }}>
                    <i class="fas fa-ellipsis-v text-xs"></i>
                  </button>
                </div>
              {/if}
            {/each}
          {/snippet}
          {@render treeNodes(treeData, 0)}
        {/if}
      </div>
    </div>

    <!-- Editor / Composer / Welcome -->
    <div class="ide-editor">
      {#if !currentFile}
        <div class="flex items-center justify-center h-full text-muted">
          <div class="text-center">
            <i class="fas fa-code text-4xl mb-4 text-muted"></i>
            <p class="text-lg">Select a file from the tree to begin editing</p>
            <p class="text-sm mt-2 text-muted">Supports YAML, JSON, JavaScript, TypeScript, and more</p>
          </div>
        </div>
      {:else if viewMode === 'visual' && isAgentFile(currentFile.path)}
        <AgentComposer bind:this={composerRef}
                       bind:data={composerData}
                       onchange={handleComposerChange} />
      {:else}
        <div class="h-full">
          <div bind:this={aceEditorEl} class="h-full w-full"></div>
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- Context menu (positioned via CSS custom properties) -->
{#if contextMenuPath !== null}
  <div class="context-menu" role="menu"
       style:left="{contextMenuPos.x}px"
       style:top="{contextMenuPos.y}px">
    {#if contextMenuType === 'file'}
      <div class="context-item" role="menuitem" tabindex="0"
           onclick={() => { if (contextMenuPath) startRename(contextMenuPath); }}
           onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' && contextMenuPath) startRename(contextMenuPath); }}>
        <i class="fas fa-pen text-xs text-muted"></i>
        <span>Rename</span>
      </div>
    {/if}
    <div class="context-item danger" role="menuitem" tabindex="0"
         onclick={() => { if (contextMenuPath) { confirmDelete(contextMenuPath, contextMenuType); contextMenuPath = null; } }}
         onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' && contextMenuPath) { confirmDelete(contextMenuPath, contextMenuType); contextMenuPath = null; } }}>
      <i class="fas fa-trash text-xs"></i>
      <span>Delete</span>
    </div>
  </div>
{/if}

<!-- Create resource modal -->
{#if createModalType !== null}
  {@const rt = RESOURCE_TYPES[createModalType]}
  <div class="auth-overlay">
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="absolute inset-0 bg-overlay" role="presentation" onclick={closeCreateModal}></div>
    <div class="relative panel shadow-xl w-full ide-create-modal">
      <div class="flex items-center gap-3 px-4 py-3 border-b">
        <i class="fas {rt.icon} {rt.color}"></i>
        <span class="text-white font-medium">New {rt.label}</span>
      </div>
      <div class="p-4">
        <label for="resourceNameInput" class="block text-sm text-secondary mb-2">Name</label>
        <div class="create-modal-input">
          <span>{rt.folder}</span>
          <input type="text" id="resourceNameInput"
                 placeholder="my-{createModalType}" autocomplete="off"
                 bind:value={createModalName}
                 onkeydown={handleCreateKeydown} />
          <span>{rt.suffix}</span>
        </div>
        <p class="text-xs text-muted mt-2">Use lowercase letters, numbers, and hyphens</p>
      </div>
      <div class="flex justify-end gap-2 px-4 py-3 border-t">
        <button class="btn btn-ghost" onclick={closeCreateModal}>Cancel</button>
        <button class="btn btn-accent btn-sm" onclick={createResource}>Create</button>
      </div>
    </div>
  </div>
{/if}

<!-- Toast -->
{#if toastMsg}
  <div class="ide-toast {toastType === 'error' ? 'error' : ''}">
    {toastMsg}
  </div>
{/if}
