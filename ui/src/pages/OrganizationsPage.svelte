<script lang="ts">
  import { onMount } from 'svelte';
  import { orgStore } from '../lib/stores/org.svelte.js';
  import { orgApi } from '../lib/services/org-api.js';
  import { appStore } from '../lib/stores/app.svelte.js';
  import { api } from '../lib/services/api.js';
  import type { Organization, Agent } from '../lib/types/index.js';

  let showForm = $state(false);
  let editingOrg = $state<Organization | null>(null);
  let formName = $state('');
  let formDescription = $state('');
  let formPrefix = $state('');
  let formColor = $state('#5e6ad2');
  let formCeoType = $state('');
  let formCeoAgent = $state('');
  let formError = $state('');
  let confirmDelete = $state<Organization | null>(null);
  let agents = $state<Agent[]>([]);

  onMount(async () => {
    orgStore.loadOrgs();
    agents = await api.getAgents();
  });

  function openCreate() {
    editingOrg = null;
    formName = '';
    formDescription = '';
    formPrefix = '';
    formColor = '#5e6ad2';
    formCeoType = '';
    formCeoAgent = '';
    formError = '';
    showForm = true;
  }

  function openEdit(org: Organization) {
    editingOrg = org;
    formName = org.name;
    formDescription = org.description;
    formPrefix = org.issuePrefix;
    formColor = org.brandColor || '#5e6ad2';
    formCeoType = org.ceoType || '';
    try {
      const config = JSON.parse(org.ceoConfig || '{}');
      formCeoAgent = config.agentName || '';
    } catch { formCeoAgent = ''; }
    formError = '';
    showForm = true;
  }

  async function handleSubmit() {
    formError = '';
    try {
      if (editingOrg) {
        await orgApi.updateOrg(editingOrg.id, {
          name: formName,
          description: formDescription,
          brandColor: formColor,
        });
        // Use configureCEO to sync org chart
        const ceoConfig = formCeoType === 'agent' && formCeoAgent
          ? JSON.stringify({ agentName: formCeoAgent })
          : '{}';
        await orgApi.configureCEO(editingOrg.id, formCeoType, ceoConfig);
      } else {
        const created = await orgApi.createOrg({
          name: formName,
          description: formDescription,
          issuePrefix: formPrefix.toUpperCase(),
          brandColor: formColor,
        });
        // Configure CEO if selected during creation
        if (formCeoType && created.id) {
          const ceoConfig = formCeoType === 'agent' && formCeoAgent
            ? JSON.stringify({ agentName: formCeoAgent })
            : '{}';
          await orgApi.configureCEO(created.id, formCeoType, ceoConfig);
        }
      }
      showForm = false;
      await orgStore.loadOrgs();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleDelete(org: Organization) {
    try {
      await orgApi.deleteOrg(org.id);
      if (orgStore.selectedOrg?.id === org.id) {
        orgStore.selectOrg(null);
      }
      confirmDelete = null;
      await orgStore.loadOrgs();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleArchive(org: Organization) {
    await orgApi.updateOrg(org.id, { status: 'archived' });
    await orgStore.loadOrgs();
  }

  function selectAndGo(org: Organization) {
    orgStore.selectOrg(org);
    appStore.setTab('tickets', org.id);
  }
</script>

<div class="space-y-4 h-full overflow-y-auto pb-6 view-panel">
  <div class="page-header">
    <h2 class="page-title"><i class="fas fa-sitemap"></i> Organizations</h2>
    <button class="btn btn-accent btn-sm" onclick={openCreate}>
      <i class="fas fa-plus"></i> New Organization
    </button>
  </div>

  {#if orgStore.organizations.length === 0}
    <div class="empty-state">
      <i class="fas fa-sitemap empty-icon"></i>
      <p>No organizations yet. Create one to start managing tickets and routines.</p>
    </div>
  {:else}
    <div class="org-grid">
      {#each orgStore.organizations as org}
        <div
          class="org-card"
          class:selected={orgStore.selectedOrg?.id === org.id}
          class:archived={org.status === 'archived'}
        >
          <div class="card-header">
            <div class="card-title-row">
              {#if org.brandColor}
                <span class="color-dot" style:background={org.brandColor}></span>
              {/if}
              <span class="card-name">{org.name}</span>
              <span class="card-prefix">{org.issuePrefix}</span>
            </div>
            {#if org.status === 'archived'}
              <span class="status-badge archived">Archived</span>
            {/if}
          </div>

          {#if org.description}
            <p class="card-desc">{org.description}</p>
          {/if}

          <div class="card-meta">
            <span><i class="fas fa-ticket"></i> {org.issueCounter} tickets</span>
            {#if org.ceoType}
              <span class="ceo-badge"><i class="fas fa-crown"></i> {org.ceoType === 'agent' ? 'Agent CEO' : 'Claude Code CEO'}</span>
            {/if}
          </div>

          <div class="card-actions">
            <button class="btn btn-ghost btn-xs" onclick={() => selectAndGo(org)} title="Select & view tickets">
              <i class="fas fa-arrow-right"></i> Open
            </button>
            <button class="btn btn-ghost btn-xs" onclick={() => openEdit(org)} title="Edit">
              <i class="fas fa-pen"></i> Edit
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if showForm}
  <div class="modal-overlay" onclick={() => { showForm = false; }} role="presentation">
    <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog">
      <h3>{editingOrg ? 'Edit Organization' : 'New Organization'}</h3>

      {#if formError}
        <div class="form-error">{formError}</div>
      {/if}

      <label class="form-label">
        Name
        <input class="input" type="text" bind:value={formName} placeholder="Acme Corp" />
      </label>

      {#if !editingOrg}
        <label class="form-label">
          Issue Prefix
          <input class="input" type="text" bind:value={formPrefix} placeholder="ACME" maxlength="10" />
          <span class="form-hint">Uppercase, used in ticket IDs (e.g. ACME-1)</span>
        </label>
      {/if}

      <label class="form-label">
        Description
        <textarea class="input" rows="3" bind:value={formDescription} placeholder="Optional description..."></textarea>
      </label>

      <label class="form-label">
        Brand Color
        <div class="color-row">
          <input type="color" bind:value={formColor} class="color-picker" />
          <span class="color-value">{formColor}</span>
        </div>
      </label>

      <div class="ceo-config-section">
        <h4 class="ceo-config-title"><i class="fas fa-crown"></i> CEO Configuration</h4>
        <label class="form-label">
          CEO Type
          <select class="input" bind:value={formCeoType}>
            <option value="">None</option>
            <option value="agent">Agent</option>
            <option value="claude-code">Claude Code (Subscription)</option>
          </select>
        </label>

        {#if formCeoType === 'agent'}
          <label class="form-label">
            CEO Agent
            <select class="input" bind:value={formCeoAgent}>
              <option value="">Select an agent...</option>
              {#each agents as a}
                <option value={a.name}>{a.name}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#if formCeoType === 'claude-code'}
          <div class="ceo-info">
            <i class="fas fa-info-circle"></i>
            Uses your local Claude Code CLI subscription. Ensure <code>claude</code> is installed and logged in.
          </div>
        {/if}
      </div>

      {#if editingOrg}
        <div class="form-danger-zone">
          {#if editingOrg.status === 'active'}
            <button class="btn btn-ghost btn-sm text-muted" onclick={() => { handleArchive(editingOrg!); showForm = false; }}>
              <i class="fas fa-archive"></i> Archive
            </button>
          {/if}
          <button class="btn btn-ghost btn-sm text-red" onclick={() => { confirmDelete = editingOrg; showForm = false; }}>
            <i class="fas fa-trash"></i> Delete
          </button>
        </div>
      {/if}

      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => { showForm = false; }}>Cancel</button>
        <button class="btn btn-accent" onclick={handleSubmit} disabled={!formName || (!editingOrg && !formPrefix)}>
          {editingOrg ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if confirmDelete}
  <div class="modal-overlay" onclick={() => { confirmDelete = null; }} role="presentation">
    <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog">
      <h3>Delete Organization</h3>
      <p class="text-sm">
        This will permanently delete <strong>{confirmDelete.name}</strong> and all its tickets, routines, org chart, and activity.
      </p>
      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => { confirmDelete = null; }}>Cancel</button>
        <button class="btn btn-danger" onclick={() => confirmDelete && handleDelete(confirmDelete)}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .page-title {
    font-size: 1.2rem;
    font-weight: 600;
    color: var(--text-1);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--text-2);
  }
  .empty-icon {
    font-size: 2.5rem;
    opacity: 0.3;
    margin-bottom: 1rem;
  }

  .org-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }
  .org-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    transition: border-color 0.15s;
  }
  .org-card:hover {
    border-color: var(--accent);
  }
  .org-card.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-20);
  }
  .org-card.archived {
    opacity: 0.6;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .card-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .color-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .card-name {
    font-weight: 600;
    color: var(--text-1);
  }
  .card-prefix {
    font-size: 0.72rem;
    color: var(--text-2);
    background: var(--hover);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .card-desc {
    font-size: 0.82rem;
    color: var(--text-2);
    margin-bottom: 0.5rem;
    line-height: 1.4;
  }
  .card-meta {
    font-size: 0.75rem;
    color: var(--text-3);
    margin-bottom: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .card-meta i {
    margin-right: 4px;
  }
  .ceo-badge {
    color: var(--accent);
    font-weight: 600;
  }
  .card-actions {
    display: flex;
    gap: 0.25rem;
  }

  .status-badge {
    font-size: 0.65rem;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    font-weight: 600;
  }
  .status-badge.archived {
    background: var(--hover);
    color: var(--text-3);
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
    width: 100%;
    max-width: 420px;
  }
  .modal-card h3 {
    margin-bottom: 1rem;
    font-size: 1.05rem;
    color: var(--text-1);
  }
  .form-label {
    display: block;
    font-size: 0.82rem;
    color: var(--text-2);
    margin-bottom: 0.75rem;
  }
  .form-label .input {
    display: block;
    width: 100%;
    margin-top: 0.25rem;
  }
  .form-hint {
    display: block;
    font-size: 0.7rem;
    color: var(--text-3);
    margin-top: 2px;
  }
  .form-error {
    background: rgba(217, 83, 79, 0.15);
    color: var(--red);
    padding: 0.5rem;
    border-radius: 6px;
    font-size: 0.82rem;
    margin-bottom: 0.75rem;
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .color-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .color-picker {
    width: 36px;
    height: 28px;
    border: none;
    background: none;
    cursor: pointer;
    padding: 0;
  }
  .color-value {
    font-size: 0.75rem;
    color: var(--text-3);
    font-family: monospace;
  }
  .form-danger-zone {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }
  .ceo-config-section {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }
  .ceo-config-title {
    font-size: 0.82rem;
    color: var(--accent);
    margin-bottom: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .ceo-info {
    font-size: 0.75rem;
    color: var(--text-3);
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    line-height: 1.4;
  }
  .ceo-info code {
    background: var(--hover);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.7rem;
  }
  .text-muted { color: var(--text-3); }
  .text-red { color: var(--red); }
  .btn-danger {
    background: var(--red);
    color: #fff;
    border: none;
    padding: 0.4rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.82rem;
  }
</style>
