/**
 * Timestamp converter function
 *
 * Converts timestamps between different formats and timezones.
 */

export default {
  name: 'timestamp-converter',
  description: 'Converts timestamps between Unix timestamp, ISO 8601, and human-readable formats.',

  parameters: {
    timestamp: {
      type: 'string',
      description: 'The timestamp to convert (Unix timestamp or ISO 8601 string)',
    },
    outputFormat: {
      type: 'string',
      description: 'Output format: "unix", "iso", "human", or "full" (all formats)',
    },
  },

  execute: async ({ timestamp, outputFormat = 'full' }) => {
    if (!timestamp) {
      throw new Error('Timestamp is required');
    }

    let date;

    // Parse the input timestamp
    if (!isNaN(timestamp)) {
      // Unix timestamp
      const ts = Number(timestamp);
      date = new Date(ts > 9999999999 ? ts : ts * 1000);
    } else {
      // ISO string or other parseable format
      date = new Date(timestamp);
    }

    if (isNaN(date.getTime())) {
      throw new Error('Invalid timestamp format');
    }

    const results = {
      unix: Math.floor(date.getTime() / 1000),
      unixMs: date.getTime(),
      iso: date.toISOString(),
      human: date.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      }),
      utc: date.toUTCString(),
    };

    // Return based on output format
    switch (outputFormat.toLowerCase()) {
      case 'unix':
        return `Unix timestamp: ${results.unix}`;

      case 'iso':
        return `ISO 8601: ${results.iso}`;

      case 'human':
        return results.human;

      case 'full':
        return `Timestamp Conversion Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Unix (seconds):     ${results.unix}
Unix (milliseconds): ${results.unixMs}

ISO 8601:           ${results.iso}
UTC:                ${results.utc}

Human-readable:     ${results.human}`;

      default:
        throw new Error(`Unknown output format: ${outputFormat}. Valid options: unix, iso, human, full`);
    }
  },
};

export const metadata = {
  name: 'timestamp-converter',
  description: 'Converts timestamps between different formats',
  version: '1.0.0',
  author: 'Agent Orchestrator',
  tags: ['time', 'date', 'converter', 'utility'],
};
