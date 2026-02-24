import { JSDOM } from 'jsdom';

const SKIP = new Set([
  'SCRIPT', 'STYLE', 'NAV', 'FOOTER', 'HEADER', 'ASIDE', 'NOSCRIPT', 'SVG', 'IFRAME',
]);

function walk(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';

  const el = node as Element;
  if (SKIP.has(el.tagName)) return '';

  const kids = Array.from(el.childNodes).map(walk).join('');
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
    default: return kids;
  }
}

export function htmlToMarkdown(html: string): string {
  const dom = new JSDOM(html);
  const body = dom.window.document.body;
  if (!body) return '';

  const raw = walk(body);
  return raw.replace(/\n{3,}/g, '\n\n').trim();
}
