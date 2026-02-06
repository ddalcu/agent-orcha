
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

export class SkillsView extends Component {
    constructor() {
        super();
        this.selectedSkill = null;
    }

    async connectedCallback() {
        super.connectedCallback();
        this.loadSkills();
    }

    async loadSkills() {
        const container = this.querySelector('#skillsListContainer');
        container.innerHTML = '<div class="text-gray-500 text-center py-8">Loading...</div>';

        try {
            const skills = await api.getSkills();
            this.renderSkillsList(skills);
        } catch (e) {
            container.innerHTML = `<div class="text-red-400 text-center">Error: ${e.message}</div>`;
        }
    }

    renderSkillsList(skills) {
        const container = this.querySelector('#skillsListContainer');

        if (!skills.length) {
            container.innerHTML = `
                <div class="text-gray-500 text-center py-12">
                    <i class="fas fa-wand-magic-sparkles text-4xl mb-4 block text-gray-600"></i>
                    <p class="text-lg mb-2">No skills found</p>
                    <p class="text-sm">Create a <code class="bg-dark-surface px-2 py-1 rounded">skills/my-skill/SKILL.md</code> file to get started.</p>
                </div>`;
            return;
        }

        container.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                ${skills.map(skill => `
                    <div class="skill-card bg-dark-surface border border-dark-border hover:border-teal-500 rounded-lg p-4 cursor-pointer transition-colors"
                         data-skill-name="${skill.name}">
                        <div class="flex items-center gap-2 mb-2">
                            <i class="fas fa-wand-magic-sparkles text-teal-400 text-sm"></i>
                            <span class="font-medium text-teal-400">${skill.name}</span>
                        </div>
                        <div class="text-xs text-gray-500 line-clamp-3">${skill.description || 'No description'}</div>
                    </div>
                `).join('')}
            </div>`;

        container.querySelectorAll('.skill-card').forEach(card => {
            card.addEventListener('click', () => {
                this.selectSkill(card.dataset.skillName);
            });
        });
    }

    async selectSkill(name) {
        const detailArea = this.querySelector('#skillDetailArea');
        detailArea.classList.remove('hidden');

        this.querySelector('#skillDetailName').textContent = name;
        this.querySelector('#skillDetailContent').textContent = 'Loading...';

        // Highlight selected card
        this.querySelectorAll('.skill-card').forEach(el => {
            el.classList.remove('border-teal-500', 'bg-teal-500/10');
            el.classList.add('border-dark-border');
        });
        const activeCard = this.querySelector(`[data-skill-name="${name}"]`);
        if (activeCard) {
            activeCard.classList.remove('border-dark-border');
            activeCard.classList.add('border-teal-500', 'bg-teal-500/10');
        }

        try {
            const skill = await api.getSkill(name);
            this.selectedSkill = skill;
            this.querySelector('#skillDetailDesc').textContent = skill.description || 'No description';
            this.querySelector('#skillDetailContent').textContent = skill.content;
        } catch (e) {
            this.querySelector('#skillDetailContent').textContent = 'Error loading skill: ' + e.message;
            this.querySelector('#skillDetailContent').classList.add('text-red-400');
        }
    }

    postRender() {
        this.querySelector('#closeDetailBtn').addEventListener('click', () => {
            this.querySelector('#skillDetailArea').classList.add('hidden');
            this.querySelectorAll('.skill-card').forEach(el => {
                el.classList.remove('border-teal-500', 'bg-teal-500/10');
                el.classList.add('border-dark-border');
            });
            this.selectedSkill = null;
        });
    }

    template() {
        return `
            <div class="space-y-6 h-full overflow-y-auto pb-8 custom-scrollbar">
                <div class="flex items-center justify-between border-b border-dark-border pb-4">
                    <div>
                        <h2 class="text-lg font-semibold text-gray-200">Skills</h2>
                        <p class="text-xs text-gray-500 mt-1">Prompt augmentation units that expand agent capabilities</p>
                    </div>
                </div>

                <div id="skillsListContainer"></div>

                <div id="skillDetailArea" class="hidden border-t border-dark-border pt-6">
                    <div class="bg-dark-surface/50 border border-dark-border rounded-lg p-4 mb-4">
                        <div class="flex items-center justify-between">
                            <div>
                                <div class="font-medium text-teal-400" id="skillDetailName"></div>
                                <div class="text-xs text-gray-500 mt-1" id="skillDetailDesc"></div>
                            </div>
                            <button id="closeDetailBtn" class="text-gray-500 hover:text-gray-300 transition-colors">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                    </div>

                    <div>
                        <label class="block text-sm font-medium text-gray-300 mb-2">Skill Content</label>
                        <pre id="skillDetailContent" class="bg-dark-surface border border-dark-border rounded-lg p-4 min-h-[200px] font-mono text-sm text-gray-300 whitespace-pre-wrap overflow-x-auto"></pre>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('skills-view', SkillsView);
