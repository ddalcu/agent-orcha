/**
 * Text formatter function
 *
 * Formats text with various transformations like uppercase, lowercase, title case, etc.
 */

export default {
  name: 'text-formatter',
  description: 'Formats text with various transformations (uppercase, lowercase, title case, reverse).',

  parameters: {
    text: {
      type: 'string',
      description: 'The text to format',
    },
    format: {
      type: 'string',
      description: 'Format type: "uppercase", "lowercase", "titlecase", "reverse", or "alternating"',
    },
  },

  execute: async ({ text, format }) => {
    if (!text) {
      throw new Error('Text is required');
    }

    if (!format) {
      throw new Error('Format type is required');
    }

    switch (format.toLowerCase()) {
      case 'uppercase':
        return text.toUpperCase();

      case 'lowercase':
        return text.toLowerCase();

      case 'titlecase':
        return text
          .toLowerCase()
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');

      case 'reverse':
        return text.split('').reverse().join('');

      case 'alternating':
        return text
          .split('')
          .map((char, i) => (i % 2 === 0 ? char.toUpperCase() : char.toLowerCase()))
          .join('');

      default:
        throw new Error(`Unknown format type: ${format}. Valid options: uppercase, lowercase, titlecase, reverse, alternating`);
    }
  },
};

export const metadata = {
  name: 'text-formatter',
  description: 'Formats text with various transformations',
  version: '1.0.0',
  author: 'Agent Orchestrator',
  tags: ['text', 'formatting', 'string-manipulation'],
};
