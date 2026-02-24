import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { htmlToMarkdown } from '../../lib/sandbox/html-to-markdown.ts';

describe('htmlToMarkdown', () => {
  it('should convert headings', () => {
    const md = htmlToMarkdown('<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>');
    assert.ok(md.includes('# Title'));
    assert.ok(md.includes('## Subtitle'));
    assert.ok(md.includes('### Section'));
  });

  it('should convert paragraphs', () => {
    const md = htmlToMarkdown('<p>Hello world</p>');
    assert.ok(md.includes('Hello world'));
  });

  it('should convert bold and italic', () => {
    const md = htmlToMarkdown('<strong>bold</strong> and <em>italic</em>');
    assert.ok(md.includes('**bold**'));
    assert.ok(md.includes('*italic*'));
  });

  it('should convert links', () => {
    const md = htmlToMarkdown('<a href="https://example.com">Click here</a>');
    assert.ok(md.includes('[Click here](https://example.com)'));
  });

  it('should convert unordered lists', () => {
    const md = htmlToMarkdown('<ul><li>One</li><li>Two</li></ul>');
    assert.ok(md.includes('- One'));
    assert.ok(md.includes('- Two'));
  });

  it('should convert code blocks', () => {
    const md = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
    assert.ok(md.includes('```'));
    assert.ok(md.includes('const x = 1;'));
  });

  it('should convert inline code', () => {
    const md = htmlToMarkdown('Use <code>npm install</code> to install');
    assert.ok(md.includes('`npm install`'));
  });

  it('should convert blockquotes', () => {
    const md = htmlToMarkdown('<blockquote>A wise quote</blockquote>');
    assert.ok(md.includes('> A wise quote'));
  });

  it('should convert images', () => {
    const md = htmlToMarkdown('<img src="pic.png" alt="A picture">');
    assert.ok(md.includes('![A picture](pic.png)'));
  });

  it('should convert horizontal rules', () => {
    const md = htmlToMarkdown('<hr>');
    assert.ok(md.includes('---'));
  });

  it('should skip script, style, nav, footer tags', () => {
    const md = htmlToMarkdown(
      '<p>Visible</p><script>evil()</script><style>.x{}</style><nav>Menu</nav><footer>Foot</footer>'
    );
    assert.ok(md.includes('Visible'));
    assert.ok(!md.includes('evil'));
    assert.ok(!md.includes('.x{}'));
    assert.ok(!md.includes('Menu'));
    assert.ok(!md.includes('Foot'));
  });

  it('should collapse multiple newlines', () => {
    const md = htmlToMarkdown('<p>A</p><p></p><p></p><p>B</p>');
    assert.ok(!md.includes('\n\n\n'));
  });

  it('should handle empty HTML', () => {
    const md = htmlToMarkdown('');
    assert.equal(md, '');
  });

  it('should handle plain text', () => {
    const md = htmlToMarkdown('Just plain text');
    assert.equal(md, 'Just plain text');
  });
});
