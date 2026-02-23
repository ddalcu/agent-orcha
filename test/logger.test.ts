import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getPinoConfig, logger, createLogger } from '../lib/logger.ts';

describe('getPinoConfig', () => {
  it('should return a config object with level', () => {
    const config = getPinoConfig();
    assert.ok(config.level);
    assert.equal(typeof config.level, 'string');
  });

  it('should include transport in non-production env', () => {
    // Default NODE_ENV in tests is not 'production'
    const config = getPinoConfig();
    assert.ok(config.transport || process.env.NODE_ENV === 'production');
  });
});

describe('logger', () => {
  it('should have all standard log methods', () => {
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.warn, 'function');
    assert.equal(typeof logger.error, 'function');
    assert.equal(typeof logger.debug, 'function');
    assert.equal(typeof logger.trace, 'function');
    assert.equal(typeof logger.fatal, 'function');
  });

  it('should not throw when called', () => {
    // These should simply not throw
    logger.info('test info');
    logger.warn('test warn');
    logger.error('test error');
    logger.debug('test debug');
    logger.info('test with args', { key: 'value' });
    logger.error('test with error', new Error('test'));
  });
});

describe('createLogger', () => {
  it('should create a child logger with component name', () => {
    const childLogger = createLogger('TestComponent');
    assert.equal(typeof childLogger.info, 'function');
    assert.equal(typeof childLogger.error, 'function');

    // Should not throw
    childLogger.info('test message');
    childLogger.error('test error', new Error('test'));
  });
});
