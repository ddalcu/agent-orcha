
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';
import './AgentComposer.js';

const FILE_ICONS = {
    yaml: { icon: 'fa-file-code', color: 'text-orange' },
    yml: { icon: 'fa-file-code', color: 'text-orange' },
    json: { icon: 'fa-file-code', color: 'text-yellow' },
    js: { icon: 'fa-file-code', color: 'text-yellow' },
    ts: { icon: 'fa-file-code', color: 'text-yellow' },
    txt: { icon: 'fa-file-lines', color: 'text-secondary' },
    md: { icon: 'fa-file-lines', color: 'text-blue' },
    default: { icon: 'fa-file', color: 'text-muted' },
};

const ACE_MODES = {
    yaml: 'ace/mode/yaml',
    yml: 'ace/mode/yaml',
    json: 'ace/mode/json',
    js: 'ace/mode/javascript',
    ts: 'ace/mode/typescript',
    md: 'ace/mode/markdown',
    default: 'ace/mode/text',
};

const RESOURCE_TYPES = {
    agent: {
        label: 'Agent',
        icon: 'fa-robot',
        color: 'text-blue',
        folder: 'agents/',
        suffix: '.agent.yaml',
    },
    function: {
        label: 'Function',
        icon: 'fa-bolt',
        color: 'text-yellow',
        folder: 'functions/',
        suffix: '.function.js',
    },
    knowledge: {
        label: 'Knowledge',
        icon: 'fa-database',
        color: 'text-purple',
        folder: 'knowledge/',
        suffix: '.knowledge.yaml',
    },
    skill: {
        label: 'Skill',
        icon: 'fa-wand-magic-sparkles',
        color: 'text-green',
        folder: 'skills/',
        suffix: '/SKILL.md',
    },
    workflow: {
        label: 'Workflow',
        icon: 'fa-diagram-project',
        color: 'text-orange',
        folder: 'workflows/',
        suffix: '.workflow.yaml',
    },
};

function getExtension(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function isAgentFile(path) {
    return path && path.endsWith('.agent.yaml');
}

export class IdeView extends Component {
    constructor() {
        super();
        this.editor = null;
        this.currentFile = null;
        this.isDirty = false;
        this.treeData = [];
        this.expandedDirs = new Set();
        this._renamingPath = null;
        this._viewMode = 'source'; // 'source' | 'visual'
        this._handleKeyDown = this._handleKeyDown.bind(this);
        this._handleDocClick = this._handleDocClick.bind(this);
    }

    disconnectedCallback() {
        document.removeEventListener('keydown', this._handleKeyDown);
        document.removeEventListener('click', this._handleDocClick);
        if (this.editor) {
            this.editor.destroy();
            this.editor = null;
        }
        this._viewMode = 'source';
    }

    async postRender() {
        document.addEventListener('keydown', this._handleKeyDown);
        document.addEventListener('click', this._handleDocClick);

        const saveBtn = this.querySelector('#saveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this._saveFile());
        }

        const newFileBtn = this.querySelector('#newFileBtn');
        if (newFileBtn) {
            newFileBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleDropdown();
            });
        }

        this._attachModeToggle();
        await this._loadTree();
    }

    _handleDocClick(e) {
        const dropdown = this.querySelector('#newResourceDropdown');
        if (dropdown && !dropdown.contains(e.target) && !e.target.closest('#newFileBtn')) {
            dropdown.remove();
        }
        const contextMenu = document.querySelector('#contextMenu');
        if (contextMenu && !contextMenu.contains(e.target)) {
            contextMenu.remove();
        }
    }

    _handleKeyDown(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            this._saveFile();
        }
    }

    async _loadTree() {
        try {
            const data = await api.getFileTree();
            this.treeData = data.tree || [];
            this._renderTree();
        } catch (err) {
            console.error('Failed to load file tree:', err);
        }
    }

    _renderTree() {
        const container = this.querySelector('#fileTree');
        if (!container) return;

        container.innerHTML = this._buildTreeHTML(this.treeData, 0);

        this._attachTreeListeners();
        this._focusInlineInput();
    }

    _buildRenameInputHTML(node, depth) {
        const ext = getExtension(node.name);
        const iconInfo = FILE_ICONS[ext] || FILE_ICONS.default;
        return `
            <div class="tree-item tree-depth-${Math.min(depth, 5)}">
                <span class="w-3"></span>
                <i class="fas ${iconInfo.icon} ${iconInfo.color} text-sm"></i>
                <input type="text" class="inline-tree-input"
                       data-action="rename" data-path="${node.path}" value="${node.name}" />
            </div>
        `;
    }

    _buildTreeHTML(nodes, depth) {
        return nodes.map(node => {
            if (node.type === 'directory') {
                const isExpanded = this.expandedDirs.has(node.path);
                const chevron = isExpanded ? 'fa-chevron-down' : 'fa-chevron-right';

                const childrenHTML = isExpanded
                    ? this._buildTreeHTML(node.children || [], depth + 1)
                    : '';

                // Only show menu button for subfolders (depth > 0)
                const menuBtn = depth > 0 ? `
                    <button class="tree-menu-btn"
                            data-menu-path="${node.path}" data-menu-type="directory">
                        <i class="fas fa-ellipsis-v text-xs"></i>
                    </button>
                ` : '';

                return `
                    <div class="tree-item tree-depth-${Math.min(depth, 5)}"
                         data-path="${node.path}" data-type="directory">
                        <i class="fas ${chevron} text-xs text-muted"></i>
                        <i class="fas fa-folder${isExpanded ? '-open' : ''} text-yellow text-sm"></i>
                        <span class="flex-1 min-w-0">${node.name}</span>
                        ${menuBtn}
                    </div>
                    ${childrenHTML}
                `;
            }

            // If this file is being renamed, show an inline input instead
            if (this._renamingPath === node.path) {
                return this._buildRenameInputHTML(node, depth);
            }

            const ext = getExtension(node.name);
            const iconInfo = FILE_ICONS[ext] || FILE_ICONS.default;
            const isActive = this.currentFile && this.currentFile.path === node.path;

            return `
                <div class="tree-item tree-depth-${Math.min(depth, 5)} ${isActive ? 'active-file' : ''}"
                     data-path="${node.path}" data-type="file">
                    <span class="w-3"></span>
                    <i class="fas ${iconInfo.icon} ${iconInfo.color} text-sm"></i>
                    <span class="tree-filename truncate flex-1 min-w-0">${node.name}</span>
                    <button class="tree-menu-btn"
                            data-menu-path="${node.path}" data-menu-type="file">
                        <i class="fas fa-ellipsis-v text-xs"></i>
                    </button>
                </div>
            `;
        }).join('');
    }

    _focusInlineInput() {
        const input = this.querySelector('.inline-tree-input');
        if (!input) return;

        requestAnimationFrame(() => {
            input.focus();
            // Select the name portion (before extension) for rename inputs
            if (input.dataset.action === 'rename') {
                const val = input.value;
                const dotIdx = val.lastIndexOf('.');
                input.setSelectionRange(0, dotIdx > 0 ? dotIdx : val.length);
            }
        });

        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                this._commitInlineInput(input);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this._cancelInlineInput();
            }
        });

        input.addEventListener('blur', () => {
            // Small delay to allow click-away to cancel rather than commit
            setTimeout(() => {
                if (this._renamingPath !== null) {
                    this._cancelInlineInput();
                }
            }, 150);
        });
    }

    _cancelInlineInput() {
        this._renamingPath = null;
        this._renderTree();
    }

    async _commitInlineInput(input) {
        const value = input.value.trim();
        if (!value) {
            this._cancelInlineInput();
            return;
        }

        if (input.dataset.action === 'rename') {
            const oldPath = input.dataset.path;
            const oldName = oldPath.split('/').pop();
            if (value === oldName) {
                this._cancelInlineInput();
                return;
            }
            const parentDir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : '';
            const newPath = parentDir ? `${parentDir}/${value}` : value;
            this._renamingPath = null;
            await this._renameFile(oldPath, newPath);
        }
    }

    _attachTreeListeners() {
        this.querySelectorAll('.tree-item').forEach(item => {
            if (!item.dataset.path) return;

            item.addEventListener('click', (e) => {
                // Ignore clicks on the menu button
                if (e.target.closest('.tree-menu-btn')) return;

                // Close any open context menu
                this._closeContextMenu();

                const filePath = item.dataset.path;
                const type = item.dataset.type;

                if (type === 'directory') {
                    this._toggleDir(filePath);
                } else {
                    this._openFile(filePath);
                }
            });
        });

        // Menu button clicks
        this.querySelectorAll('.tree-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const filePath = btn.dataset.menuPath;
                const type = btn.dataset.menuType;
                this._showContextMenu(e, filePath, type);
            });
        });
    }

    _closeContextMenu() {
        const menu = document.querySelector('#contextMenu');
        if (menu) menu.remove();
    }

    _showContextMenu(e, filePath, type) {
        // Remove existing context menu
        this._closeContextMenu();

        const btn = e.currentTarget;
        const btnRect = btn.getBoundingClientRect();

        const menu = document.createElement('div');
        menu.id = 'contextMenu';
        menu.className = 'context-menu';

        const isFile = type === 'file';

        menu.innerHTML = `
            ${isFile ? `
                <div class="context-item" data-action="rename">
                    <i class="fas fa-pen text-xs text-muted"></i>
                    <span>Rename</span>
                </div>
            ` : ''}
            <div class="context-item danger" data-action="delete">
                <i class="fas fa-trash text-xs"></i>
                <span>Delete</span>
            </div>
        `;

        document.body.appendChild(menu);

        // Position after render to get correct dimensions
        requestAnimationFrame(() => {
            const menuRect = menu.getBoundingClientRect();
            let left = btnRect.right + 4;
            let top = btnRect.top;

            // Adjust if menu goes off-screen
            if (left + menuRect.width > window.innerWidth) {
                left = btnRect.left - menuRect.width - 4;
            }
            if (top + menuRect.height > window.innerHeight) {
                top = window.innerHeight - menuRect.height - 8;
            }

            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        });

        menu.querySelectorAll('.context-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                menu.remove();
                if (action === 'rename') {
                    this._startRename(filePath);
                } else if (action === 'delete') {
                    this._confirmDelete(filePath, type);
                }
            });
        });
    }

    _confirmDelete(filePath, type) {
        const name = filePath.split('/').pop();
        const isDir = type === 'directory';
        const msg = isDir
            ? `Delete folder "${name}" and all its contents?`
            : `Delete "${name}"?`;

        if (!confirm(msg)) return;
        this._deleteFile(filePath);
    }

    async _deleteFile(filePath) {
        try {
            const result = await api.deleteFile(filePath);
            if (result.error) {
                alert(result.error);
                return;
            }

            // If the deleted file was open, clear the editor
            if (this.currentFile && this.currentFile.path === filePath) {
                this.currentFile = null;
                this.isDirty = false;
                this._viewMode = 'source';
                this._renderEditor();
                this._updateModeToggle();
            }

            await this._loadTree();
        } catch (err) {
            console.error('Failed to delete file:', err);
            alert('Failed to delete file.');
        }
    }

    _toggleDir(dirPath) {
        if (this.expandedDirs.has(dirPath)) {
            this.expandedDirs.delete(dirPath);
        } else {
            this.expandedDirs.add(dirPath);
        }
        this._renderTree();
    }

    _toggleDropdown() {
        const existing = this.querySelector('#newResourceDropdown');
        if (existing) {
            existing.remove();
            return;
        }

        const btn = this.querySelector('#newFileBtn');
        if (!btn) return;

        const items = Object.entries(RESOURCE_TYPES).map(([key, rt]) => `
            <div class="resource-dropdown-item"
                 data-resource="${key}">
                <i class="fas ${rt.icon} ${rt.color} text-xs"></i>
                <span>${rt.label}</span>
            </div>
        `).join('');

        const dropdown = document.createElement('div');
        dropdown.id = 'newResourceDropdown';
        dropdown.className = 'resource-dropdown';
        dropdown.innerHTML = items;

        btn.parentElement.classList.add('relative');
        btn.parentElement.appendChild(dropdown);

        dropdown.querySelectorAll('.resource-dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const type = item.dataset.resource;
                dropdown.remove();
                this._selectResourceType(type);
            });
        });
    }

    _selectResourceType(type) {
        this._showCreateModal(type);
    }

    _showCreateModal(type) {
        // Remove existing modal if any
        const existing = this.querySelector('#createResourceModal');
        if (existing) existing.remove();

        const rt = RESOURCE_TYPES[type];
        const modal = document.createElement('div');
        modal.id = 'createResourceModal';
        modal.className = 'auth-overlay';
        modal.innerHTML = `
            <div class="absolute inset-0 bg-overlay" data-action="cancel"></div>
            <div class="relative panel shadow-xl w-full mx-4 max-w-md">
                <div class="flex items-center gap-3 px-4 py-3 border-b">
                    <i class="fas ${rt.icon} ${rt.color}"></i>
                    <span class="text-white font-medium">New ${rt.label}</span>
                </div>
                <div class="p-4">
                    <label class="block text-sm text-secondary mb-2">Name</label>
                    <div class="create-modal-input">
                        <span>${rt.folder}</span>
                        <input type="text" id="resourceNameInput"
                               placeholder="my-${type}" autocomplete="off" />
                        <span>${rt.suffix}</span>
                    </div>
                    <p class="text-xs text-muted mt-2">Use lowercase letters, numbers, and hyphens</p>
                </div>
                <div class="flex justify-end gap-2 px-4 py-3 border-t">
                    <button class="btn btn-ghost" data-action="cancel">Cancel</button>
                    <button class="btn btn-accent btn-sm" data-action="create">Create</button>
                </div>
            </div>
        `;

        this.appendChild(modal);

        const input = modal.querySelector('#resourceNameInput');
        const createBtn = modal.querySelector('[data-action="create"]');
        const cancelBtns = modal.querySelectorAll('[data-action="cancel"]');

        input.focus();

        const close = () => modal.remove();

        const create = async () => {
            const name = input.value.trim();
            if (!name) return;
            close();
            await this._createResourceFromTemplate(type, name);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                create();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
            }
        });

        createBtn.addEventListener('click', create);
        cancelBtns.forEach(btn => btn.addEventListener('click', close));
    }

    _startRename(filePath) {
        this._renamingPath = filePath;
        this._renderTree();
    }

    async _createResourceFromTemplate(type, name) {
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
                this.expandedDirs.add(parts.join('/'));
            }

            await this._loadTree();
            await this._openFile(template.path);
        } catch (err) {
            console.error('Failed to create resource:', err);
            alert('Failed to create resource.');
        }
    }

    async _createFile(filePath, content = '') {
        try {
            const result = await api.createFile(filePath, content);
            if (result.error) {
                alert(result.error);
                return;
            }
            await this._loadTree();
            await this._openFile(filePath);
        } catch (err) {
            console.error('Failed to create file:', err);
            alert('Failed to create file.');
        }
    }

    async _renameFile(oldPath, newPath) {
        try {
            const result = await api.renameFile(oldPath, newPath);
            if (result.error) {
                alert(result.error);
                this._renderTree();
                return;
            }

            // If the renamed file was currently open, update the reference
            if (this.currentFile && this.currentFile.path === oldPath) {
                this.currentFile.path = newPath;
            }

            await this._loadTree();
        } catch (err) {
            console.error('Failed to rename file:', err);
            alert('Failed to rename file.');
            this._renderTree();
        }
    }

    async _openFile(filePath) {
        if (this.isDirty) {
            const confirmed = confirm('You have unsaved changes. Discard and open another file?');
            if (!confirmed) return;
        }

        try {
            const data = await api.readFile(filePath);
            this.currentFile = { path: data.path, content: data.content };
            this.isDirty = false;
            this._viewMode = isAgentFile(filePath) ? 'visual' : 'source';
            this._renderEditor();
            this._renderTree();
            this._updateModeToggle();
        } catch (err) {
            console.error('Failed to read file:', err);
        }
    }

    _renderEditor() {
        const editorContainer = this.querySelector('#editorContainer');
        const composerContainer = this.querySelector('#composerContainer');
        const welcomePanel = this.querySelector('#welcomePanel');
        const breadcrumb = this.querySelector('#breadcrumb');

        if (!this.currentFile) {
            if (welcomePanel) welcomePanel.classList.remove('hidden');
            if (editorContainer) editorContainer.classList.add('hidden');
            if (composerContainer) composerContainer.classList.add('hidden');
            return;
        }

        if (welcomePanel) welcomePanel.classList.add('hidden');

        // Update breadcrumb
        if (breadcrumb) {
            const parts = this.currentFile.path.split('/');
            breadcrumb.textContent = parts.join(' / ');
        }

        // Update dirty state
        this._updateDirtyState();

        if (this._viewMode === 'visual') {
            if (editorContainer) editorContainer.classList.add('hidden');
            if (composerContainer) composerContainer.classList.remove('hidden');
            return;
        }

        // Source mode
        if (composerContainer) composerContainer.classList.add('hidden');
        if (editorContainer) editorContainer.classList.remove('hidden');

        // Initialize or update Ace
        const aceEl = this.querySelector('#aceEditor');
        if (!aceEl) return;

        if (!this.editor) {
            this.editor = ace.edit(aceEl);
            this.editor.setTheme('ace/theme/one_dark');
            this.editor.setOptions({
                fontSize: '14px',
                showPrintMargin: false,
                wrap: true,
                tabSize: 2,
                useSoftTabs: true,
            });

            this.editor.session.on('change', () => {
                if (!this.isDirty) {
                    this.isDirty = true;
                    this._updateDirtyState();
                }
            });
        }

        // Set mode based on file extension
        const ext = getExtension(this.currentFile.path);
        const mode = ACE_MODES[ext] || ACE_MODES.default;
        this.editor.session.setMode(mode);

        // Set content without triggering change event
        this.editor.setValue(this.currentFile.content, -1);
        this.isDirty = false;
        this._updateDirtyState();
        this.editor.focus();
    }

    _updateDirtyState() {
        const dirtyIndicator = this.querySelector('#dirtyIndicator');
        const saveBtn = this.querySelector('#saveBtn');
        const savedMsg = this.querySelector('#savedMsg');

        if (dirtyIndicator) {
            dirtyIndicator.classList.toggle('hidden', !this.isDirty);
        }
        if (saveBtn) {
            saveBtn.disabled = !this.isDirty;
            saveBtn.classList.toggle('opacity-50', !this.isDirty);
            saveBtn.classList.toggle('cursor-not-allowed', !this.isDirty);
        }
        if (savedMsg) {
            savedMsg.classList.add('hidden');
        }
    }

    async _saveFile() {
        if (!this.currentFile || !this.isDirty) return;

        let content;
        if (this._viewMode === 'visual') {
            const composer = this.querySelector('agent-composer');
            if (!composer) return;
            const data = composer.getData();
            content = jsyaml.dump(data, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
        } else {
            if (!this.editor) return;
            content = this.editor.getValue();
        }

        try {
            const result = await api.writeFile(this.currentFile.path, content);
            this.currentFile.content = content;
            this.isDirty = false;
            this._updateDirtyState();

            // Show saved confirmation with reload info
            const savedMsg = this.querySelector('#savedMsg');
            if (savedMsg) {
                const reloaded = result.reloaded && result.reloaded !== 'none';
                const failed = result.reloaded === 'error';
                if (failed) {
                    savedMsg.textContent = 'Saved (reload failed)';
                    savedMsg.classList.remove('hidden', 'text-green');
                    savedMsg.classList.add('text-amber');
                } else if (reloaded) {
                    savedMsg.textContent = `Saved & reloaded ${result.reloaded}`;
                    savedMsg.classList.remove('hidden', 'text-amber');
                    savedMsg.classList.add('text-green');
                } else {
                    savedMsg.textContent = 'Saved!';
                    savedMsg.classList.remove('hidden', 'text-amber');
                    savedMsg.classList.add('text-green');
                }
                setTimeout(() => savedMsg.classList.add('hidden'), 2500);
            }
        } catch (err) {
            console.error('Failed to save file:', err);
            alert('Failed to save file.');
        }
    }

    // ── Mode Toggle ──

    _attachModeToggle() {
        this.querySelectorAll('.mode-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (mode === this._viewMode) return;
                if (mode === 'visual') this._switchToVisual();
                else this._switchToSource();
            });
        });
    }

    _updateModeToggle() {
        const toggle = this.querySelector('#modeToggle');
        if (!toggle) return;

        const show = this.currentFile && isAgentFile(this.currentFile.path);
        toggle.classList.toggle('hidden', !show);

        toggle.querySelectorAll('.mode-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === this._viewMode);
        });
    }

    _switchToVisual() {
        if (!this.currentFile) return;

        // Get current Ace content and parse
        const content = this.editor ? this.editor.getValue() : this.currentFile.content;
        let parsed;
        try {
            parsed = jsyaml.load(content);
        } catch (err) {
            this._showToast(`Invalid YAML: ${err.message}`, 'error');
            return;
        }

        if (!parsed || typeof parsed !== 'object') {
            this._showToast('YAML must be an object', 'error');
            return;
        }

        this._viewMode = 'visual';
        this._updateModeToggle();

        // Hide Ace, show composer
        const editorContainer = this.querySelector('#editorContainer');
        const composerContainer = this.querySelector('#composerContainer');
        if (editorContainer) editorContainer.classList.add('hidden');
        if (composerContainer) composerContainer.classList.remove('hidden');

        // Create or get the composer element
        let composer = composerContainer.querySelector('agent-composer');
        if (!composer) {
            composer = document.createElement('agent-composer');
            composer.classList.add('block', 'h-full');
            composerContainer.appendChild(composer);
        }

        composer.data = parsed;

        // Listen for changes
        composer.addEventListener('composer:change', () => {
            if (!this.isDirty) {
                this.isDirty = true;
                this._updateDirtyState();
            }
        });
    }

    _switchToSource() {
        if (!this.currentFile) return;

        const composer = this.querySelector('agent-composer');
        if (composer && this._viewMode === 'visual') {
            const data = composer.getData();
            const yaml = jsyaml.dump(data, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });

            // Update Ace content
            if (this.editor) {
                this.editor.setValue(yaml, -1);
            }
            this.currentFile.content = yaml;
        }

        this._viewMode = 'source';
        this._updateModeToggle();

        const editorContainer = this.querySelector('#editorContainer');
        const composerContainer = this.querySelector('#composerContainer');
        if (composerContainer) composerContainer.classList.add('hidden');
        if (editorContainer) editorContainer.classList.remove('hidden');

        if (this.editor) {
            this.editor.resize();
            this.editor.focus();
        }
    }

    _showToast(message, type = 'info') {
        const existing = document.querySelector('#ideToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'ideToast';
        toast.className = `ide-toast ${type === 'error' ? 'error' : ''}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    template() {
        return `
            <div class="ide-shell">
                <!-- Toolbar -->
                <div class="ide-toolbar">
                    <div class="flex items-center gap-2 text-sm text-secondary">
                        <i class="fas fa-code text-green"></i>
                        <span id="breadcrumb">Select a file to edit</span>
                    </div>
                    <div class="flex items-center gap-3">
                        <!-- Mode toggle (only for .agent.yaml files) -->
                        <div id="modeToggle" class="hidden mode-toggle">
                            <button class="mode-toggle-btn active" data-mode="source">
                                <i class="fas fa-code mr-1"></i>Source
                            </button>
                            <button class="mode-toggle-btn" data-mode="visual">
                                <i class="fas fa-palette mr-1"></i>Visual
                            </button>
                        </div>
                        <span id="dirtyIndicator" class="hidden text-amber text-xs flex items-center gap-1">
                            <i class="fas fa-circle text-2xs"></i> Unsaved
                        </span>
                        <span id="savedMsg" class="hidden text-green text-xs">Saved!</span>
                        <button id="saveBtn" class="btn btn-accent btn-sm opacity-50 cursor-not-allowed" disabled>
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
                            <button id="newFileBtn" class="text-muted transition-colors" title="New Resource">
                                <i class="fas fa-plus text-xs"></i>
                            </button>
                        </div>
                        <div id="fileTree" class="py-1">
                            <div class="px-4 py-8 text-center text-muted text-sm">
                                <i class="fas fa-spinner fa-spin mr-2"></i> Loading...
                            </div>
                        </div>
                    </div>

                    <!-- Editor / Composer / Welcome -->
                    <div class="ide-editor">
                        <div id="welcomePanel" class="flex items-center justify-center h-full text-muted">
                            <div class="text-center">
                                <i class="fas fa-code text-4xl mb-4 text-muted"></i>
                                <p class="text-lg">Select a file from the tree to begin editing</p>
                                <p class="text-sm mt-2 text-muted">Supports YAML, JSON, JavaScript, TypeScript, and more</p>
                            </div>
                        </div>
                        <div id="editorContainer" class="hidden h-full">
                            <div id="aceEditor" class="h-full w-full"></div>
                        </div>
                        <div id="composerContainer" class="hidden h-full overflow-hidden"></div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('ide-view', IdeView);
