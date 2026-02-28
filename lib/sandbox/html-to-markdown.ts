import { JSDOM } from 'jsdom';

export interface HtmlToMarkdownOptions {
  includeNavigation?: boolean;
}

const SKIP_ALWAYS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME']);
const SKIP_FULL_PAGE = new Set(['NAV', 'FOOTER', 'HEADER', 'ASIDE']);

function walk(node: Node, skip: Set<string>): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';

  const el = node as Element;
  if (SKIP_ALWAYS.has(el.tagName)) return '';
  if (skip.has(el.tagName)) return '';

  const kids = Array.from(el.childNodes).map(c => walk(c, skip)).join('');
  const t = kids.trim();

  switch (el.tagName) {
    case 'H1': return `\n# ${t}\n`;
    case 'H2': return `\n## ${t}\n`;
    case 'H3': return `\n### ${t}\n`;
    case 'H4': return `\n#### ${t}\n`;
    case 'H5': return `\n##### ${t}\n`;
    case 'H6': return `\n###### ${t}\n`;
    case 'P': case 'DIV': case 'SECTION': case 'ARTICLE': case 'MAIN':
      return t ? `\n\n${t}\n` : '';
    case 'BR': return '\n';
    case 'STRONG': case 'B': return `**${kids}**`;
    case 'EM': case 'I': return `*${kids}*`;
    case 'A': {
      const href = el.getAttribute('href');
      return href && t ? `[${t}](${href})` : t;
    }
    case 'UL': case 'OL': return `\n${kids}\n`;
    case 'LI': return `\n- ${t}`;
    case 'PRE': return `\n\`\`\`\n${kids}\n\`\`\`\n`;
    case 'CODE': {
      if (el.parentNode && (el.parentNode as Element).tagName === 'PRE') return kids;
      return `\`${kids}\``;
    }
    case 'BLOCKQUOTE': return `\n> ${t.replace(/\n/g, '\n> ')}\n`;
    case 'HR': return '\n---\n';
    case 'IMG': {
      const alt = el.getAttribute('alt') ?? '';
      const src = el.getAttribute('src') ?? '';
      return src ? `![${alt}](${src})` : '';
    }
    case 'INPUT': {
      const type = el.getAttribute('type') ?? 'text';
      const name = el.getAttribute('name') ?? '';
      const value = el.getAttribute('value') ?? '';
      const placeholder = el.getAttribute('placeholder') ?? '';
      const parts = [`input:${type}`];
      if (name) parts.push(`name="${name}"`);
      if (value) parts.push(`value="${value}"`);
      if (placeholder) parts.push(`placeholder="${placeholder}"`);
      return `[${parts.join(' ')}]`;
    }
    case 'BUTTON': return `[button: ${t}]`;
    case 'SELECT': {
      const name = el.getAttribute('name') ?? '';
      const options = Array.from(el.querySelectorAll('option'))
        .map(o => `${o.hasAttribute('selected') ? '(*)' : '( )'} ${(o.textContent ?? '').trim()}`)
        .join(', ');
      return `[select${name ? ` name="${name}"` : ''}: ${options}]`;
    }
    case 'TEXTAREA': {
      const name = el.getAttribute('name') ?? '';
      return `[textarea${name ? ` name="${name}"` : ''}: ${t}]`;
    }
    case 'FORM': {
      const action = el.getAttribute('action') ?? '';
      return `\n[form${action ? ` action="${action}"` : ''}]\n${kids}\n[/form]\n`;
    }
    case 'LABEL': {
      const forAttr = el.getAttribute('for') ?? '';
      return forAttr ? `[label for="${forAttr}": ${t}]` : t;
    }
    default: return kids;
  }
}

export function htmlToMarkdown(html: string, options?: HtmlToMarkdownOptions): string {
  const dom = new JSDOM(html);
  const body = dom.window.document.body;
  if (!body) return '';

  const skip = options?.includeNavigation ? new Set<string>() : SKIP_FULL_PAGE;
  const raw = walk(body, skip);
  return raw.replace(/\n{3,}/g, '\n\n').trim();
}
