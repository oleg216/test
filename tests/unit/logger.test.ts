import { describe, it, expect } from 'vitest';
import { createLogger, maskSensitiveData } from '../../src/shared/logger.js';

describe('maskSensitiveData', () => {
  it('masks ifa values', () => {
    const data = { ifa: 'secret-ifa-value', name: 'test' };
    const masked = maskSensitiveData(data);
    expect(masked.ifa).toBe('***MASKED***');
    expect(masked.name).toBe('test');
  });

  it('masks ip values', () => {
    const data = { ip: '192.168.1.1' };
    const masked = maskSensitiveData(data);
    expect(masked.ip).toBe('***MASKED***');
  });

  it('masks deviceId values', () => {
    const data = { deviceId: 'dev-123' };
    const masked = maskSensitiveData(data);
    expect(masked.deviceId).toBe('***MASKED***');
  });
});

describe('createLogger', () => {
  it('creates a logger instance', () => {
    const logger = createLogger('test');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
