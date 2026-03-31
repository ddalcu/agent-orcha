<script lang="ts">
  import { orgStore } from '../lib/stores/org.svelte.js';
  import { orgApi } from '../lib/services/org-api.js';
  import { appStore } from '../lib/stores/app.svelte.js';
  import { api } from '../lib/services/api.js';
  import type { OrgMember, OrgMemberNode, Agent } from '../lib/types/index.js';

  const ROLES = ['ceo', 'manager', 'member'] as const;
  const ROLE_COLORS: Record<string, string> = {
    ceo: 'var(--accent)', manager: 'var(--cyan)', member: 'var(--text-2)',
  };
  const ROLE_ICONS: Record<string, string> = {
    ceo: 'fa-crown', manager: 'fa-user-tie', member: 'fa-user',
  };

  let agents = $state<Agent[]>([]);

  // Form state
  let showForm = $state(false);
  let editingMember = $state<OrgMember | null>(null);
  let formAgent = $state('');
  let formTitle = $state('');
  let formRole = $state<string>('member');
  let formReportsTo = $state<string | null>(null);
  let formError = $state('');
  let confirmDelete = $state<OrgMember | null>(null);

  let lastLoadedOrgId: string | undefined;

  $effect(() => {
    const orgId = appStore.routeOrgId;
    if (orgId && orgId !== lastLoadedOrgId) {
      lastLoadedOrgId = orgId;
      (async () => {
        await orgStore.selectOrgById(orgId);
        if (orgStore.selectedOrg) {
          await orgStore.loadMembers();
        }
        agents = await api.getAgents();
      })();
    }
  });

  function openCreate() {
    editingMember = null;
    formAgent = '';
    formTitle = '';
    formRole = 'member';
    formReportsTo = null;
    formError = '';
    showForm = true;
  }

  function openEdit(member: OrgMember) {
    editingMember = member;
    formAgent = member.agentName;
    formTitle = member.title;
    formRole = member.role;
    formReportsTo = member.reportsTo;
    formError = '';
    showForm = true;
  }

  async function handleSubmit() {
    if (!orgStore.selectedOrg) return;
    formError = '';
    try {
      if (editingMember) {
        await orgApi.updateMember(editingMember.id, {
          title: formTitle,
          role: formRole,
          reportsTo: formReportsTo,
        });
      } else {
        await orgApi.createMember(orgStore.selectedOrg.id, {
          agentName: formAgent,
          title: formTitle,
          role: formRole,
          reportsTo: formReportsTo,
        });
      }
      showForm = false;
      await orgStore.loadMembers();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleDelete(member: OrgMember) {
    try {
      await orgApi.deleteMember(member.id);
      confirmDelete = null;
      await orgStore.loadMembers();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    }
  }

  let isClaudeCodeCEO = $derived(orgStore.selectedOrg?.ceoType === 'claude-code');

  // Filter out agents already in the org chart (for the create dropdown)
  let availableAgents = $derived(
    agents.filter(a => !orgStore.members.some(m => m.agentName === a.name))
  );

  // Get potential parents for reportsTo dropdown (exclude self if editing)
  function getParentOptions(): OrgMember[] {
    if (editingMember) {
      return orgStore.members.filter(m => m.id !== editingMember!.id);
    }
    return orgStore.members;
  }
</script>

<div class="space-y-4 h-full overflow-y-auto pb-6 view-panel">
  {#if !orgStore.selectedOrg}
    <div class="empty-state">
      <i class="fas fa-sitemap empty-icon"></i>
      <p>Select an organization first to view the org chart.</p>
      <button class="btn btn-accent btn-sm" onclick={() => appStore.setTab('organizations')}>
        Go to Organizations
      </button>
    </div>
  {:else}
    <div class="page-header">
      <h2 class="page-title">
        <i class="fas fa-sitemap"></i> Org Chart
        <span class="title-org">({orgStore.selectedOrg.name})</span>
      </h2>
      <button class="btn btn-accent btn-sm" onclick={openCreate}>
        <i class="fas fa-plus"></i> Add Member
      </button>
    </div>

    {#if orgStore.memberTree.length === 0 && !isClaudeCodeCEO}
      <div class="empty-state">
        <i class="fas fa-users empty-icon"></i>
        <p>No members in this organization yet. Add agents to build your org chart.</p>
      </div>
    {:else}
      <div class="tree-container">
        {#if isClaudeCodeCEO}
          <div class="tree-item tree-root">
            <div class="member-card cc-ceo-card">
              <div class="member-icon cc-ceo-icon">
                <i class="fas fa-crown"></i>
              </div>
              <div class="member-info">
                <div class="member-name">Claude Code</div>
                <div class="member-title">CEO (Subscription)</div>
              </div>
              <span class="role-badge cc-ceo-badge">CEO</span>
            </div>
            {#if orgStore.memberTree.length > 0}
              <div class="tree-children">
                {#each orgStore.memberTree as node}
                  {@render treeNode(node, 1)}
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          {#each orgStore.memberTree as node}
            {@render treeNode(node, 0)}
          {/each}
        {/if}
      </div>
    {/if}
  {/if}
</div>

{#snippet treeNode(node: OrgMemberNode, depth: number)}
  <div class="tree-item" class:tree-root={depth === 0}>
    <button class="member-card" onclick={() => openEdit(node)}>
      <div class="member-icon" style:color={ROLE_COLORS[node.role]}>
        <i class="fas {ROLE_ICONS[node.role] || 'fa-user'}"></i>
      </div>
      <div class="member-info">
        <div class="member-name">{node.agentName}</div>
        {#if node.title}
          <div class="member-title">{node.title}</div>
        {/if}
      </div>
      <span class="role-badge" style:color={ROLE_COLORS[node.role]}>{node.role}</span>
    </button>

    {#if node.children.length > 0}
      <div class="tree-children">
        {#each node.children as child}
          {@render treeNode(child, depth + 1)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<!-- Add/Edit Member Modal -->
{#if showForm}
  <div class="modal-overlay" onclick={() => { showForm = false; }} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog" tabindex="-1">
      <h3>{editingMember ? 'Edit Member' : 'Add Member'}</h3>

      {#if formError}
        <div class="form-error">{formError}</div>
      {/if}

      {#if !editingMember}
        <label class="form-label">
          Agent
          <select class="input" bind:value={formAgent}>
            <option value="">Select an agent...</option>
            {#each availableAgents as a}
              <option value={a.name}>{a.name}</option>
            {/each}
          </select>
        </label>
      {:else}
        <div class="form-static">
          <span class="form-static-label">Agent</span>
          <span class="form-static-value">{editingMember.agentName}</span>
        </div>
      {/if}

      <label class="form-label">
        Title
        <input class="input" type="text" bind:value={formTitle} placeholder="e.g. Lead Engineer" />
      </label>

      <label class="form-label">
        Role
        <select class="input" bind:value={formRole}>
          {#each ROLES as r}
            <option value={r}>{r.toUpperCase()}</option>
          {/each}
        </select>
      </label>

      <label class="form-label">
        Reports To
        <select class="input" bind:value={formReportsTo}>
          <option value={null}>None (top level)</option>
          {#each getParentOptions() as m}
            <option value={m.id}>{m.agentName} ({m.role})</option>
          {/each}
        </select>
      </label>

      {#if editingMember}
        <div class="form-danger-zone">
          <button class="btn btn-ghost btn-sm text-red" onclick={() => { confirmDelete = editingMember; showForm = false; }}>
            <i class="fas fa-trash"></i> Remove from Org
          </button>
        </div>
      {/if}

      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => { showForm = false; }}>Cancel</button>
        <button class="btn btn-accent" onclick={handleSubmit} disabled={!editingMember && !formAgent}>
          {editingMember ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if confirmDelete}
  <div class="modal-overlay" onclick={() => { confirmDelete = null; }} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog" tabindex="-1">
      <h3>Remove Member</h3>
      <p class="text-sm">
        Remove <strong>{confirmDelete.agentName}</strong> from the org chart? Direct reports will be moved to top level.
      </p>
      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => { confirmDelete = null; }}>Cancel</button>
        <button class="btn btn-danger" onclick={() => confirmDelete && handleDelete(confirmDelete)}>Remove</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-header { display: flex; align-items: center; justify-content: space-between; }
  .page-title { font-size: 1.2rem; font-weight: 600; color: var(--text-1); display: flex; align-items: center; gap: 0.5rem; }
  .title-org { color: var(--text-3); font-size: 0.85rem; font-weight: 400; }
  .empty-state { text-align: center; padding: 3rem 1rem; color: var(--text-2); }
  .empty-icon { font-size: 2.5rem; opacity: 0.3; margin-bottom: 1rem; }

  /* Tree layout */
  .tree-container { padding: 0.5rem 0; }
  .tree-item { position: relative; }
  .tree-children {
    padding-left: 2rem;
    border-left: 1px solid var(--border);
    margin-left: 1.25rem;
  }

  .member-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 0.5rem;
    cursor: pointer;
    transition: border-color 0.15s;
    width: 100%;
    text-align: left;
    font: inherit;
    color: inherit;
  }
  .member-card:hover { border-color: var(--accent); }

  .member-icon {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--hover);
    flex-shrink: 0;
    font-size: 0.85rem;
  }

  .member-info { flex: 1; min-width: 0; }
  .member-name { font-weight: 600; font-size: 0.88rem; color: var(--text-1); }
  .member-title { font-size: 0.75rem; color: var(--text-3); }

  .role-badge {
    font-size: 0.65rem;
    text-transform: uppercase;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .cc-ceo-card {
    border-color: var(--accent);
    cursor: default;
  }
  .cc-ceo-icon { color: var(--accent); }
  .cc-ceo-badge { color: var(--accent); }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.5rem; width: 100%; max-width: 420px; }
  .modal-card h3 { margin-bottom: 1rem; font-size: 1.05rem; color: var(--text-1); }
  .form-label { display: block; font-size: 0.82rem; color: var(--text-2); margin-bottom: 0.75rem; }
  .form-label .input { display: block; width: 100%; margin-top: 0.25rem; }
  .form-error { background: rgba(217,83,79,0.15); color: var(--red); padding: 0.5rem; border-radius: 6px; font-size: 0.82rem; margin-bottom: 0.75rem; }
  .form-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
  .form-danger-zone { display: flex; gap: 0.5rem; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
  .form-static { margin-bottom: 0.75rem; }
  .form-static-label { display: block; font-size: 0.72rem; color: var(--text-3); margin-bottom: 0.15rem; }
  .form-static-value { font-size: 0.88rem; color: var(--text-1); font-weight: 600; }
  .text-red { color: var(--red); }
  .btn-danger { background: var(--red); color: #fff; border: none; padding: 0.4rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.82rem; }
</style>
