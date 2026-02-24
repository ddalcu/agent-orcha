/**
 * Renders markdown to sanitized HTML with syntax highlighting
 */
export class MarkdownRenderer {
  constructor() {
    // Configure marked for streaming-friendly rendering
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        gfm: true,              // GitHub Flavored Markdown
        breaks: true,           // Convert \n to <br>
        headerIds: false,       // Disable header IDs (not needed for chat)
        mangle: false,          // Don't mangle email addresses
        sanitize: false,        // We'll use DOMPurify instead
      });
    }

  }

  /**
   * Render markdown string to sanitized HTML
   * @param {string} markdown - Raw markdown text
   * @returns {string} Sanitized HTML string
   */
  render(markdown) {
    if (!markdown) return '';

    try {
      // Step 1: Parse markdown to HTML
      const rawHtml = marked.parse(markdown);

      // Step 2: Sanitize HTML with DOMPurify
      const cleanHtml = DOMPurify.sanitize(rawHtml, {
        ALLOWED_TAGS: [
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'p', 'br', 'strong', 'em', 'u', 's', 'del',
          'ul', 'ol', 'li',
          'a', 'code', 'pre',
          'blockquote', 'hr',
          'table', 'thead', 'tbody', 'tr', 'th', 'td',
          'span', 'div'
        ],
        ALLOWED_ATTR: ['href', 'class', 'id', 'target', 'rel'],
        ALLOW_DATA_ATTR: false,
      });

      return cleanHtml;
    } catch (error) {
      console.error('Markdown rendering error:', error);
      // Fallback to plain text on error
      return this.escapeHtml(markdown);
    }
  }

  /**
   * Apply syntax highlighting to rendered markdown HTML
   * @param {HTMLElement} element - DOM element containing rendered markdown
   */
  highlightCode(element) {
    if (typeof hljs === 'undefined') return;

    const codeBlocks = element.querySelectorAll('pre code');
    codeBlocks.forEach(block => {
      // Remove existing highlighting
      block.removeAttribute('data-highlighted');
      // Apply syntax highlighting
      hljs.highlightElement(block);
    });
  }

  /**
   * Escape HTML for fallback rendering
   * @param {string} text
   * @returns {string}
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Create singleton instance
export const markdownRenderer = new MarkdownRenderer();
