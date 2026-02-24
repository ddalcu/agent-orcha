import pino from 'pino';

export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  component?: string;
}

class LogBuffer {
  private buffer: LogEntry[];
  private maxSize: number;
  private index = 0;
  private full = false;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  push(entry: LogEntry): void {
    this.buffer[this.index] = entry;
    this.index = (this.index + 1) % this.maxSize;
    if (this.index === 0) this.full = true;
  }

  getEntries(limit?: number): LogEntry[] {
    const entries: LogEntry[] = this.full
      ? [...this.buffer.slice(this.index), ...this.buffer.slice(0, this.index)]
      : this.buffer.slice(0, this.index);
    return limit ? entries.slice(-limit) : entries;
  }
}

const logBuffer = new LogBuffer(200);

export function getRecentLogs(limit?: number): LogEntry[] {
  return logBuffer.getEntries(limit);
}

/**
 * Shared Pino configuration that can be used by both the standalone logger and Fastify
 */
export function getPinoConfig() {
  const logLevel = process.env.LOG_LEVEL || 'debug';
  const isDevelopment = process.env.NODE_ENV !== 'production';
  console.log("LogLevel", logLevel);
  return {
    level: logLevel,
    transport: isDevelopment
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
 * Create a pino logger instance
 */
function createPinoLogger() {
  return pino(getPinoConfig());
}

// Export the raw pino instance for use in the application
export const pinoLogger = createPinoLogger();

/**
 * Create a wrapper that accepts console-like API and converts to pino API.
 * Warn/error/fatal levels are also captured in the in-memory ring buffer.
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
      if (args.length > 0) {
        pinoInstance.debug({ data: args }, message);
      } else {
        pinoInstance.debug(message);
      }
    },
    trace: (message: string, ...args: unknown[]) => {
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
