import pino from 'pino';
import { Writable } from 'stream';
import { isSea } from './sea/bootstrap.ts';

export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  component?: string;
}

type LogSubscriber = (entry: LogEntry) => void;

class LogBuffer {
  private buffer: LogEntry[];
  private maxSize: number;
  private index = 0;
  private full = false;
  private subscribers: Set<LogSubscriber> = new Set();

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  push(entry: LogEntry): void {
    this.buffer[this.index] = entry;
    this.index = (this.index + 1) % this.maxSize;
    if (this.index === 0) this.full = true;
    for (const cb of this.subscribers) cb(entry);
  }

  getEntries(limit?: number): LogEntry[] {
    const entries: LogEntry[] = this.full
      ? [...this.buffer.slice(this.index), ...this.buffer.slice(0, this.index)]
      : this.buffer.slice(0, this.index);
    return limit ? entries.slice(-limit) : entries;
  }

  subscribe(cb: LogSubscriber): void {
    this.subscribers.add(cb);
  }

  unsubscribe(cb: LogSubscriber): void {
    this.subscribers.delete(cb);
  }
}

const logBuffer = new LogBuffer(500);

export function getRecentLogs(limit?: number): LogEntry[] {
  return logBuffer.getEntries(limit);
}

export function subscribeToLogs(cb: (entry: LogEntry) => void): void {
  logBuffer.subscribe(cb);
}

export function unsubscribeFromLogs(cb: (entry: LogEntry) => void): void {
  logBuffer.unsubscribe(cb);
}

// ANSI color codes for log levels
const LEVEL_COLORS: Record<number, string> = {
  10: '\x1b[90m',   // trace — gray
  20: '\x1b[36m',   // debug — cyan
  30: '\x1b[32m',   // info  — green
  40: '\x1b[33m',   // warn  — yellow
  50: '\x1b[31m',   // error — red
  60: '\x1b[35m',   // fatal — magenta
};
const LEVEL_LABELS: Record<number, string> = {
  10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL',
};
const RESET = '\x1b[0m';

/**
 * Lightweight pino destination that formats JSON log lines with colors.
 * Runs in-process (no worker threads) so it works inside SEA binaries.
 */
function createPrettyDestination(): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        const obj = JSON.parse(chunk.toString());
        const color = LEVEL_COLORS[obj.level] || '';
        const label = LEVEL_LABELS[obj.level] || 'LOG';
        const time = obj.time ? new Date(obj.time).toLocaleTimeString('en-GB', { hour12: false }) : '';
        const comp = obj.component ? `${obj.component} ` : '';
        const msg = obj.msg || '';
        let line = `${color}${time} ${label.padEnd(5)}${RESET} ${comp}${msg}`;
        // Render error details when present (pino serialises errors under `err`)
        if (obj.err) {
          const errMsg = obj.err.message || obj.err.code || '';
          if (errMsg && !msg.includes(errMsg)) line += ` ${errMsg}`;
          if (obj.err.stack) {
            const stackLines = obj.err.stack.split('\n').slice(1, 4).map((l: string) => `  ${l.trim()}`);
            line += `\n${stackLines.join('\n')}`;
          }
        }
        process.stdout.write(line + '\n');
      } catch {
        process.stdout.write(chunk);
      }
      callback();
    },
  });
}

/**
 * Shared Pino configuration that can be used by both the standalone logger and Fastify
 */
export function getPinoConfig() {
  const logLevel = process.env.LOG_LEVEL || 'debug';
  const isDevelopment = process.env.NODE_ENV !== 'production';
  // pino-pretty uses worker threads with dynamic require() — not available in SEA binaries
  const usePretty = isDevelopment && !isSea();
  return {
    level: logLevel,
    transport: usePretty
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,component',
            messageFormat: '{component} {msg}',
          },
        }
      : undefined,
  };
}

/**
 * Create a pino logger instance.
 * In SEA mode, uses an in-process pretty formatter instead of raw JSON.
 */
function createPinoLogger() {
  if (isSea()) {
    const logLevel = process.env.LOG_LEVEL || 'debug';
    return pino({ level: logLevel }, createPrettyDestination());
  }
  return pino(getPinoConfig());
}

// Export the raw pino instance for use in the application
export const pinoLogger = createPinoLogger();

/**
 * Create a wrapper that accepts console-like API and converts to pino API.
 * All levels are captured in the in-memory ring buffer for the log viewer.
 */
function createLoggerWrapper(pinoInstance: pino.Logger, component?: string) {
  const capture = (level: string, message: string) => {
    logBuffer.push({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(component ? { component } : {}),
    });
  };

  return {
    info: (message: string, ...args: unknown[]) => {
      capture('info', message);
      if (args.length > 0) {
        pinoInstance.info({ data: args }, message);
      } else {
        pinoInstance.info(message);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      capture('warn', message);
      if (args.length > 0) {
        pinoInstance.warn({ data: args }, message);
      } else {
        pinoInstance.warn(message);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      capture('error', message);
      if (args.length > 0) {
        const firstArg = args[0];
        if (firstArg instanceof Error) {
          pinoInstance.error({ err: firstArg, data: args.slice(1) }, message);
        } else {
          pinoInstance.error({ data: args }, message);
        }
      } else {
        pinoInstance.error(message);
      }
    },
    debug: (message: string, ...args: unknown[]) => {
      capture('debug', message);
      if (args.length > 0) {
        pinoInstance.debug({ data: args }, message);
      } else {
        pinoInstance.debug(message);
      }
    },
    trace: (message: string, ...args: unknown[]) => {
      capture('trace', message);
      if (args.length > 0) {
        pinoInstance.trace({ data: args }, message);
      } else {
        pinoInstance.trace(message);
      }
    },
    fatal: (message: string, ...args: unknown[]) => {
      capture('fatal', message);
      if (args.length > 0) {
        const firstArg = args[0];
        if (firstArg instanceof Error) {
          pinoInstance.fatal({ err: firstArg, data: args.slice(1) }, message);
        } else {
          pinoInstance.fatal({ data: args }, message);
        }
      } else {
        pinoInstance.fatal(message);
      }
    },
  };
}

// Export the wrapper for application use
export const logger = createLoggerWrapper(pinoLogger);

/**
 * Create a child logger with a component prefix
 * @param component - The component name (e.g., 'VectorFactory', 'FunctionLoader')
 * @returns A logger with the component automatically prefixed to all messages
 *
 * @example
 * const logger = createLogger('VectorFactory');
 * logger.info('Loading documents'); // Logs: [VectorFactory] Loading documents
 */
export function createLogger(component: string) {
  const childLogger = pinoLogger.child({ component: `[${component}]` });
  return createLoggerWrapper(childLogger, component);
}
