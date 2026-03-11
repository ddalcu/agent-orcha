/**
 * Shared card utilities for consistent UI across views.
 */

export function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function resourceCard({ id, selected, content, className = '' }) {
    const cls = selected ? 'card active' : 'card';
    return `<div class="${cls} ${className}" data-name="${escapeHtml(id)}">${content}</div>`;
}

export function badge(text, variant = 'accent') {
    return `<span class="badge badge-${variant}">${escapeHtml(text)}</span>`;
}

export function statusDot(status) {
    return `<span class="status-dot status-dot-${status}"></span>`;
}
