<script lang="ts">
  import { onMount } from 'svelte';
  import { companyStore } from '../lib/stores/company.svelte.js';
  import { companyApi } from '../lib/services/company-api.js';
  import { appStore } from '../lib/stores/app.svelte.js';
  import type { Company } from '../lib/types/index.js';

  let showForm = $state(false);
  let editingCompany = $state<Company | null>(null);
  let formName = $state('');
  let formDescription = $state('');
  let formPrefix = $state('');
  let formColor = $state('#5e6ad2');
  let formError = $state('');
  let confirmDelete = $state<Company | null>(null);

  onMount(() => {
    companyStore.loadCompanies();
  });

  function openCreate() {
    editingCompany = null;
    formName = '';
    formDescription = '';
    formPrefix = '';
    formColor = '#5e6ad2';
    formError = '';
    showForm = true;
  }

  function openEdit(company: Company) {
    editingCompany = company;
    formName = company.name;
    formDescription = company.description;
    formPrefix = company.issuePrefix;
    formColor = company.brandColor || '#5e6ad2';
    formError = '';
    showForm = true;
  }

  async function handleSubmit() {
    formError = '';
    try {
      if (editingCompany) {
        await companyApi.updateCompany(editingCompany.id, {
          name: formName,
          description: formDescription,
          brandColor: formColor,
        });
      } else {
        await companyApi.createCompany({
          name: formName,
          description: formDescription,
          issuePrefix: formPrefix.toUpperCase(),
          brandColor: formColor,
        });
      }
      showForm = false;
      await companyStore.loadCompanies();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleDelete(company: Company) {
    try {
      await companyApi.deleteCompany(company.id);
      if (companyStore.selectedCompany?.id === company.id) {
        companyStore.selectCompany(null);
      }
      confirmDelete = null;
      await companyStore.loadCompanies();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleArchive(company: Company) {
    await companyApi.updateCompany(company.id, { status: 'archived' });
    await companyStore.loadCompanies();
  }

  function selectAndGo(company: Company) {
    companyStore.selectCompany(company);
    appStore.setTab('tickets');
  }
</script>

<div class="page-container">
  <div class="page-header">
    <h2 class="page-title"><i class="fas fa-building"></i> Companies</h2>
    <button class="btn btn-accent btn-sm" onclick={openCreate}>
      <i class="fas fa-plus"></i> New Company
    </button>
  </div>

  {#if companyStore.companies.length === 0}
    <div class="empty-state">
      <i class="fas fa-building empty-icon"></i>
      <p>No companies yet. Create one to start managing tickets and routines.</p>
    </div>
  {:else}
    <div class="company-grid">
      {#each companyStore.companies as company}
        <div
          class="company-card"
          class:selected={companyStore.selectedCompany?.id === company.id}
          class:archived={company.status === 'archived'}
        >
          <div class="card-header">
            <div class="card-title-row">
              {#if company.brandColor}
                <span class="color-dot" style:background={company.brandColor}></span>
              {/if}
              <span class="card-name">{company.name}</span>
              <span class="card-prefix">{company.issuePrefix}</span>
            </div>
            {#if company.status === 'archived'}
              <span class="status-badge archived">Archived</span>
            {/if}
          </div>

          {#if company.description}
            <p class="card-desc">{company.description}</p>
          {/if}

          <div class="card-meta">
            <span><i class="fas fa-ticket"></i> {company.issueCounter} tickets</span>
          </div>

          <div class="card-actions">
            <button class="btn btn-ghost btn-xs" onclick={() => selectAndGo(company)} title="Select & view tickets">
              <i class="fas fa-arrow-right"></i> Open
            </button>
            <button class="btn btn-ghost btn-xs" onclick={() => openEdit(company)} title="Edit">
              <i class="fas fa-pen"></i>
            </button>
            {#if company.status === 'active'}
              <button class="btn btn-ghost btn-xs" onclick={() => handleArchive(company)} title="Archive">
                <i class="fas fa-archive"></i>
              </button>
            {/if}
            <button class="btn btn-ghost btn-xs text-red" onclick={() => { confirmDelete = company; }} title="Delete">
              <i class="fas fa-trash"></i>
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
      <h3>{editingCompany ? 'Edit Company' : 'New Company'}</h3>

      {#if formError}
        <div class="form-error">{formError}</div>
      {/if}

      <label class="form-label">
        Name
        <input class="input" type="text" bind:value={formName} placeholder="Acme Corp" />
      </label>

      {#if !editingCompany}
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

      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => { showForm = false; }}>Cancel</button>
        <button class="btn btn-accent" onclick={handleSubmit} disabled={!formName || (!editingCompany && !formPrefix)}>
          {editingCompany ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if confirmDelete}
  <div class="modal-overlay" onclick={() => { confirmDelete = null; }} role="presentation">
    <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog">
      <h3>Delete Company</h3>
      <p class="text-sm">
        This will permanently delete <strong>{confirmDelete.name}</strong> and all its tickets, routines, and activity.
      </p>
      <div class="form-actions">
        <button class="btn btn-ghost" onclick={() => { confirmDelete = null; }}>Cancel</button>
        <button class="btn btn-danger" onclick={() => confirmDelete && handleDelete(confirmDelete)}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-container {
    padding: 1.5rem;
    max-width: 1000px;
  }
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
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

  .company-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }
  .company-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    transition: border-color 0.15s;
  }
  .company-card:hover {
    border-color: var(--accent);
  }
  .company-card.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-20);
  }
  .company-card.archived {
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
  }
  .card-meta i {
    margin-right: 4px;
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
