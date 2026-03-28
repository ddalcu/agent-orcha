import type { Company, Ticket, Routine, RoutineRun } from '../types/index.js';
import { companyApi } from '../services/company-api.js';

const STORAGE_KEY = 'orcha-selected-company';

class CompanyStore {
  companies = $state<Company[]>([]);
  selectedCompany = $state<Company | null>(null);
  tickets = $state<Ticket[]>([]);
  routines = $state<Routine[]>([]);
  loading = $state(false);

  constructor() {
    // Restore selected company from localStorage on load
    const savedId = localStorage.getItem(STORAGE_KEY);
    if (savedId) {
      this.loadCompanies().then(() => {
        const found = this.companies.find(c => c.id === savedId);
        if (found) this.selectedCompany = found;
      });
    }
  }

  async loadCompanies(): Promise<void> {
    this.companies = await companyApi.listCompanies();
  }

  selectCompany(company: Company | null): void {
    this.selectedCompany = company;
    if (company) {
      localStorage.setItem(STORAGE_KEY, company.id);
      this.loadTickets();
      this.loadRoutines();
    } else {
      localStorage.removeItem(STORAGE_KEY);
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
