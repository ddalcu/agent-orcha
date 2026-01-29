
import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

const FILE_ICONS = {
    yaml: { icon: 'fa-file-code', color: 'text-orange-400' },
    yml: { icon: 'fa-file-code', color: 'text-orange-400' },
    json: { icon: 'fa-file-code', color: 'text-yellow-400' },
    js: { icon: 'fa-file-code', color: 'text-yellow-300' },
    ts: { icon: 'fa-file-code', color: 'text-yellow-300' },
    txt: { icon: 'fa-file-lines', color: 'text-gray-400' },
    md: { icon: 'fa-file-lines', color: 'text-blue-400' },
    default: { icon: 'fa-file', color: 'text-gray-500' },
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

function getExtension(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export class IdeView extends Component {
    constructor() {
        super();
        this.editor = null;
        this.currentFile = null;
        this.isDirty = false;
        this.treeData = [];
        this.expandedDirs = new Set();
        this._handleKeyDown = this._handleKeyDown.bind(this);
    }

    disconnectedCallback() {
        document.removeEventListener('keydown', this._handleKeyDown);
        if (this.editor) {
            this.editor.destroy();
            this.editor = null;
        }
    }

    async postRender() {
        document.addEventListener('keydown', this._handleKeyDown);

        const saveBtn = this.querySelector('#saveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this._saveFile());
        }

        await this._loadTree();
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
    }

    _buildTreeHTML(nodes, depth) {
        return nodes.map(node => {
            if (node.type === 'directory') {
                const isExpanded = this.expandedDirs.has(node.path);
                const chevron = isExpanded ? 'fa-chevron-down' : 'fa-chevron-right';
                const childrenHTML = isExpanded
                    ? this._buildTreeHTML(node.children || [], depth + 1)
                    : '';

                return `
                    <div class="tree-item tree-depth-${Math.min(depth, 5)} flex items-center gap-2 cursor-pointer hover:bg-dark-hover rounded text-sm text-gray-300"
                         data-path="${node.path}" data-type="directory">
                        <i class="fas ${chevron} text-xs text-gray-500 w-3"></i>
                        <i class="fas fa-folder${isExpanded ? '-open' : ''} text-yellow-500 text-sm"></i>
                        <span>${node.name}</span>
                    </div>
                    ${childrenHTML}
                `;
            }

            const ext = getExtension(node.name);
            const iconInfo = FILE_ICONS[ext] || FILE_ICONS.default;
            const isActive = this.currentFile && this.currentFile.path === node.path;
            const activeClass = isActive ? 'bg-dark-hover text-white' : '';

            return `
                <div class="tree-item tree-depth-${Math.min(depth, 5)} flex items-center gap-2 cursor-pointer hover:bg-dark-hover rounded text-sm text-gray-300 ${activeClass}"
                     data-path="${node.path}" data-type="file">
                    <span class="w-3"></span>
                    <i class="fas ${iconInfo.icon} ${iconInfo.color} text-sm"></i>
                    <span class="truncate max-w-[160px]">${node.name}</span>
                </div>
            `;
        }).join('');
    }

    _attachTreeListeners() {
        this.querySelectorAll('.tree-item').forEach(item => {
            item.addEventListener('click', () => {
                const filePath = item.dataset.path;
                const type = item.dataset.type;

                if (type === 'directory') {
                    this._toggleDir(filePath);
                } else {
                    this._openFile(filePath);
                }
            });
        });
    }

    _toggleDir(dirPath) {
        if (this.expandedDirs.has(dirPath)) {
            this.expandedDirs.delete(dirPath);
        } else {
            this.expandedDirs.add(dirPath);
        }
        this._renderTree();
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
            this._renderEditor();
            this._renderTree();
        } catch (err) {
            console.error('Failed to read file:', err);
        }
    }

    _renderEditor() {
        const editorContainer = this.querySelector('#editorContainer');
        const welcomePanel = this.querySelector('#welcomePanel');
        const breadcrumb = this.querySelector('#breadcrumb');
        const saveBtn = this.querySelector('#saveBtn');
        const dirtyIndicator = this.querySelector('#dirtyIndicator');

        if (!this.currentFile) {
            if (welcomePanel) welcomePanel.classList.remove('hidden');
            if (editorContainer) editorContainer.classList.add('hidden');
            return;
        }

        if (welcomePanel) welcomePanel.classList.add('hidden');
        if (editorContainer) editorContainer.classList.remove('hidden');

        // Update breadcrumb
        if (breadcrumb) {
            const parts = this.currentFile.path.split('/');
            breadcrumb.textContent = parts.join(' / ');
        }

        // Update dirty state
        this._updateDirtyState();

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
        if (!this.currentFile || !this.isDirty || !this.editor) return;

        const content = this.editor.getValue();

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
                    savedMsg.classList.remove('hidden', 'text-green-400');
                    savedMsg.classList.add('text-yellow-400');
                } else if (reloaded) {
                    savedMsg.textContent = `Saved & reloaded ${result.reloaded}`;
                    savedMsg.classList.remove('hidden', 'text-yellow-400');
                    savedMsg.classList.add('text-green-400');
                } else {
                    savedMsg.textContent = 'Saved!';
                    savedMsg.classList.remove('hidden', 'text-yellow-400');
                    savedMsg.classList.add('text-green-400');
                }
                setTimeout(() => savedMsg.classList.add('hidden'), 2500);
            }
        } catch (err) {
            console.error('Failed to save file:', err);
            alert('Failed to save file.');
        }
    }

    template() {
        return `
            <div class="flex flex-col h-full">
                <!-- Toolbar -->
                <div class="flex items-center justify-between bg-dark-surface border border-dark-border rounded-t-lg px-4 py-2 flex-shrink-0">
                    <div class="flex items-center gap-2 text-sm text-gray-400">
                        <i class="fas fa-code text-green-400"></i>
                        <span id="breadcrumb">Select a file to edit</span>
                    </div>
                    <div class="flex items-center gap-3">
                        <span id="dirtyIndicator" class="hidden text-yellow-400 text-xs flex items-center gap-1">
                            <i class="fas fa-circle text-[6px]"></i> Unsaved
                        </span>
                        <span id="savedMsg" class="hidden text-green-400 text-xs">Saved!</span>
                        <button id="saveBtn" class="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors opacity-50 cursor-not-allowed" disabled>
                            <i class="fas fa-save mr-1"></i> Save
                        </button>
                    </div>
                </div>

                <!-- Main content -->
                <div class="flex flex-1 min-h-0 border border-t-0 border-dark-border rounded-b-lg overflow-hidden">
                    <!-- File tree sidebar -->
                    <div class="w-60 flex-shrink-0 bg-dark-surface border-r border-dark-border overflow-y-auto">
                        <div class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-dark-border">
                            Explorer
                        </div>
                        <div id="fileTree" class="py-1">
                            <div class="px-4 py-8 text-center text-gray-500 text-sm">
                                <i class="fas fa-spinner fa-spin mr-2"></i> Loading...
                            </div>
                        </div>
                    </div>

                    <!-- Editor / Welcome -->
                    <div class="flex-1 min-w-0 relative">
                        <div id="welcomePanel" class="flex items-center justify-center h-full text-gray-500">
                            <div class="text-center">
                                <i class="fas fa-code text-4xl mb-4 text-gray-600"></i>
                                <p class="text-lg">Select a file from the tree to begin editing</p>
                                <p class="text-sm mt-2 text-gray-600">Supports YAML, JSON, JavaScript, TypeScript, and more</p>
                            </div>
                        </div>
                        <div id="editorContainer" class="hidden h-full">
                            <div id="aceEditor" class="h-full w-full"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('ide-view', IdeView);
