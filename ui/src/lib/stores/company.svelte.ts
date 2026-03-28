import type { Company, Ticket, Routine } from '../types/index.js';
import { companyApi } from '../services/company-api.js';

class CompanyStore {
  companies = $state<Company[]>([]);
  selectedCompany = $state<Company | null>(null);
  tickets = $state<Ticket[]>([]);
  routines = $state<Routine[]>([]);
  loading = $state(false);
  initialized = false;

  async loadCompanies(): Promise<void> {
    this.companies = await companyApi.listCompanies();
    this.initialized = true;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.initialized) await this.loadCompanies();
  }

  async selectCompanyById(id: string): Promise<void> {
    await this.ensureLoaded();
    const found = this.companies.find(c => c.id === id);
    if (found && found.id !== this.selectedCompany?.id) {
      this.selectedCompany = found;
      await Promise.all([this.loadTickets(), this.loadRoutines()]);
    }
  }

  selectCompany(company: Company | null): void {
    this.selectedCompany = company;
    if (company) {
      this.loadTickets();
      this.loadRoutines();
    } else {
      this.tickets = [];
      this.routines = [];
    }
  }

  async loadTickets(filters?: { status?: string; priority?: string; assignee?: string }): Promise<void> {
    if (!this.selectedCompany) return;
    this.tickets = await companyApi.listTickets(this.selectedCompany.id, filters);
  }

  async loadRoutines(): Promise<void> {
    if (!this.selectedCompany) return;
    this.routines = await companyApi.listRoutines(this.selectedCompany.id);
  }
}

export const companyStore = new CompanyStore();
