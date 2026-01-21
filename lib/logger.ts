import pino from 'pino';

/**
 * Shared Pino configuration that can be used by both the standalone logger and Fastify
 */
export function getPinoConfig() {
  const logLevel = process.env.LOG_LEVEL || 'info';
  const isDevelopment = process.env.NODE_ENV !== 'production';

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
 * Create a wrapper that accepts console-like API and converts to pino API
 */
function createLoggerWrapper(pinoInstance: pino.Logger) {
  return {
    info: (message: string, ...args: unknown[]) => {
      if (args.length > 0) {
        pinoInstance.info({ data: args }, message);
      } else {
        pinoInstance.info(message);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (args.length > 0) {
        pinoInstance.warn({ data: args }, message);
      } else {
        pinoInstance.warn(message);
      }
    },
    error: (message: string, ...args: unknown[]) => {
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
  return createLoggerWrapper(childLogger);
}
