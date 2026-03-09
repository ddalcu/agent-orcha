import { Component } from '../utils/Component.js';
import { api } from '../services/ApiService.js';

const LEVEL_CLASSES = {
    trace: 'log-trace',
    debug: 'log-debug',
    info: 'log-info',
    warn: 'log-warn',
    error: 'log-error',
    fatal: 'log-fatal',
};

const MAX_VISIBLE_LINES = 2000;

export class LogViewer extends Component {
    postRender() {
        this._eventSource = null;
        this._open = false;
        this._autoScroll = true;
        this._lineCount = 0;

        this.querySelector('#log-toggle').addEventListener('click', () => this._toggle());
        this.querySelector('#log-clear').addEventListener('click', (e) => { e.stopPropagation(); this._clear(); });
        this.querySelector('#log-autoscroll').addEventListener('click', (e) => { e.stopPropagation(); this._toggleAutoScroll(); });

        const body = this.querySelector('#log-body');
        body.addEventListener('scroll', () => {
            const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
            if (this._autoScroll !== atBottom) {
                this._autoScroll = atBottom;
                this._updateAutoScrollBtn();
            }
        });
    }

    disconnectedCallback() {
        this._disconnect();
    }

    _toggle() {
        this._open = !this._open;
        const panel = this.querySelector('#log-panel');
        const chevron = this.querySelector('#log-chevron');

        if (this._open) {
            panel.classList.remove('log-panel-closed');
            panel.classList.add('log-panel-open');
            chevron.classList.add('log-chevron-open');
            this._connect();
        } else {
            panel.classList.remove('log-panel-open');
            panel.classList.add('log-panel-closed');
            chevron.classList.remove('log-chevron-open');
            this._disconnect();
        }
    }

    _connect() {
        if (this._eventSource) return;
        this._eventSource = api.streamLogs();
        this._eventSource.onmessage = (e) => {
            try {
                const entry = JSON.parse(e.data);
                this._appendLine(entry);
            } catch { /* ignore malformed */ }
        };
        this._eventSource.onerror = () => {
            // Reconnect is automatic with EventSource
        };
    }

    _disconnect() {
        if (this._eventSource) {
            this._eventSource.close();
            this._eventSource = null;
        }
    }

    _appendLine(entry) {
        const body = this.querySelector('#log-body');
        if (!body) return;

        const line = document.createElement('div');
        line.className = `log-line ${LEVEL_CLASSES[entry.level] || ''}`;

        const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false }) : '';
        const lvl = (entry.level || '').toUpperCase().padEnd(5);
        const comp = entry.component ? `[${entry.component}] ` : '';

        line.textContent = `${time} ${lvl} ${comp}${entry.message}`;
        body.appendChild(line);
        this._lineCount++;

        // Prune old lines to prevent memory bloat
        if (this._lineCount > MAX_VISIBLE_LINES) {
            const excess = this._lineCount - MAX_VISIBLE_LINES;
            for (let i = 0; i < excess; i++) {
                body.firstChild?.remove();
            }
            this._lineCount = MAX_VISIBLE_LINES;
        }

        if (this._autoScroll) {
            body.scrollTop = body.scrollHeight;
        }

    }

    _clear() {
        const body = this.querySelector('#log-body');
        if (body) body.innerHTML = '';
        this._lineCount = 0;
    }

    _toggleAutoScroll() {
        this._autoScroll = !this._autoScroll;
        this._updateAutoScrollBtn();
        if (this._autoScroll) {
            const body = this.querySelector('#log-body');
            if (body) body.scrollTop = body.scrollHeight;
        }
    }

    _updateAutoScrollBtn() {
        const btn = this.querySelector('#log-autoscroll');
        if (btn) {
            btn.classList.toggle('log-autoscroll-active', this._autoScroll);
        }
    }

    template() {
        return `
            <div id="log-panel" class="log-panel log-panel-closed">
                <div id="log-toggle" class="log-header">
                    <div class="log-header-left">
                        <i id="log-chevron" class="fas fa-chevron-up log-chevron"></i>
                        <i class="fas fa-terminal log-terminal-icon"></i>
                        <span class="log-title">Console</span>
                    </div>
                    <div class="log-header-right">
                        <button id="log-autoscroll" class="log-btn log-autoscroll-active" title="Auto-scroll">
                            <i class="fas fa-angles-down"></i>
                        </button>
                        <button id="log-clear" class="log-btn" title="Clear">
                            <i class="fas fa-ban"></i>
                        </button>
                    </div>
                </div>
                <div id="log-body" class="log-body"></div>
            </div>
            <style>
                .log-panel {
                    background: #11111b;
                    border-top: 1px solid #313244;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    transition: height 0.25s ease;
                }
                .log-panel-closed { height: 36px; }
                .log-panel-open { height: 250px; }

                .log-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 0 12px;
                    height: 36px;
                    min-height: 36px;
                    cursor: pointer;
                    user-select: none;
                    border-bottom: 1px solid #313244;
                }
                .log-header:hover { background: #181825; }
                .log-header-left, .log-header-right {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .log-chevron {
                    font-size: 10px;
                    color: #6c7086;
                    transition: transform 0.25s ease;
                }
                .log-chevron-open { transform: rotate(180deg); }

                .log-terminal-icon { font-size: 11px; color: #89b4fa; }
                .log-title { font-size: 12px; color: #a6adc8; font-weight: 500; }

                .log-btn {
                    background: none;
                    border: none;
                    color: #6c7086;
                    cursor: pointer;
                    font-size: 12px;
                    padding: 2px 6px;
                    border-radius: 4px;
                }
                .log-btn:hover { color: #cdd6f4; background: #1e1e2e; }
                .log-autoscroll-active { color: #89b4fa; }

                .log-body {
                    flex: 1;
                    overflow-y: auto;
                    overflow-x: hidden;
                    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
                    font-size: 11.5px;
                    line-height: 1.5;
                    padding: 4px 0;
                }
                .log-body::-webkit-scrollbar { width: 6px; }
                .log-body::-webkit-scrollbar-track { background: transparent; }
                .log-body::-webkit-scrollbar-thumb { background: #313244; border-radius: 3px; }

                .log-line {
                    padding: 0 12px;
                    white-space: pre;
                    color: #a6adc8;
                }
                .log-line:hover { background: #181825; }

                .log-trace { color: #585b70; }
                .log-debug { color: #6c7086; }
                .log-info  { color: #a6adc8; }
                .log-warn  { color: #f9e2af; }
                .log-error { color: #f38ba8; }
                .log-fatal { color: #f38ba8; font-weight: 600; }
            </style>
        `;
    }
}

customElements.define('log-viewer', LogViewer);
