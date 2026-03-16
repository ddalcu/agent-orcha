import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';

export function createCanvasWriteTool(): StructuredTool {
  return tool(
    async () => {
      return 'Canvas updated successfully.';
    },
    {
      name: 'canvas_write',
      description:
        'Write content to the canvas side pane. Replaces any existing canvas content. ' +
        'Use this for documents, articles, reports, code, HTML pages/games, and any substantial output. ' +
        'For HTML apps/games, use format "html" so they render live. ' +
        'For source code (Python, JS, etc.), use format "code" with the appropriate language. ' +
        'For documents and articles, use format "markdown".',
      schema: z.object({
        content: z
          .string()
          .describe('The content to display in the canvas pane.'),
        title: z
          .string()
          .optional()
          .describe('Title for the canvas header.'),
        format: z
          .enum(['markdown', 'html', 'code'])
          .default('markdown')
          .describe(
            'Content format. "markdown" for documents/articles (rendered as rich text). ' +
            '"html" for web pages, apps, and games (rendered live in an iframe). ' +
            '"code" for source code like Python, JavaScript, etc. (syntax-highlighted).'
          ),
        language: z
          .string()
          .optional()
          .describe(
            'Programming language for syntax highlighting when format is "code" (e.g. "python", "javascript", "go"). Ignored for other formats.'
          ),
        mode: z
          .enum(['preview', 'code'])
          .optional()
          .describe(
            'Which view to show initially. Defaults to "preview" for markdown/html, "code" for code format.'
          ),
      }),
    },
  );
}

export function createCanvasAppendTool(): StructuredTool {
  return tool(
    async () => {
      return 'Content appended to canvas successfully.';
    },
    {
      name: 'canvas_append',
      description:
        'Append content to the existing canvas. Use this to incrementally build documents, ' +
        'add new sections, or extend code. The canvas must already be open (via canvas_write). ' +
        'The appended content uses the same format as the original canvas_write call.',
      schema: z.object({
        content: z
          .string()
          .describe('The content to append to the existing canvas.'),
      }),
    },
  );
}
