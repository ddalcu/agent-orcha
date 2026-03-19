import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';

const renderer = {
  link(href: string, title: string | null | undefined, text: string) {
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
  },
};

const marked = new Marked({ gfm: true, breaks: true, renderer });

export function renderMarkdown(markdown: string): string {
  if (!markdown) return '';
  try {
    const rawHtml = marked.parse(markdown) as string;
    return DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'br', 'strong', 'em', 'u', 's', 'del',
        'ul', 'ol', 'li',
        'a', 'code', 'pre',
        'blockquote', 'hr',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'span', 'div',
      ],
      ALLOWED_ATTR: ['href', 'class', 'id', 'target', 'rel'],
      ALLOW_DATA_ATTR: false,
    });
  } catch {
    const div = document.createElement('div');
    div.textContent = markdown;
    return div.innerHTML;
  }
}

export function highlightCode(element: HTMLElement): void {
  element.querySelectorAll('pre code').forEach((block) => {
    (block as HTMLElement).removeAttribute('data-highlighted');
    hljs.highlightElement(block as HTMLElement);
  });
}
