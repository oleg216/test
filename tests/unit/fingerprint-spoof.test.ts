import { describe, it, expect } from 'vitest';
import { buildFingerprintScript } from '../../src/emulation/fingerprint-spoof.js';
import type { FingerprintProfile } from '../../src/shared/types.js';

const sampleFp: FingerprintProfile = {
  platform: 'Linux armv8l',
  hwConcurrency: 4,
  deviceMemory: 2,
  maxTouchPoints: 0,
  connection: { type: 'wifi', downlink: 25, rtt: 30, effectiveType: '4g' },
  screen: { colorDepth: 24, pixelDepth: 24 },
  webgl: { vendor: 'ARM', renderer: 'Mali-G78' },
  canvasNoiseSeed: 123456,
  audioNoiseSeed: 654321,
  fonts: ['Roboto', 'Noto Sans'],
  plugins: 0,
  storageQuota: 1073741824,
};

describe('buildFingerprintScript', () => {
  it('returns a non-empty string', () => {
    const script = buildFingerprintScript(sampleFp);
    expect(script).toBeTruthy();
    expect(typeof script).toBe('string');
  });

  it('contains navigator overrides', () => {
    const script = buildFingerprintScript(sampleFp);
    expect(script).toContain('Navigator.prototype');
    expect(script).toContain('"Linux armv8l"');
    expect(script).toContain('hardwareConcurrency');
    expect(script).toContain('deviceMemory');
    expect(script).toContain('maxTouchPoints');
    expect(script).toContain('webdriver');
  });

  it('contains WebGL spoofing', () => {
    const script = buildFingerprintScript(sampleFp);
    expect(script).toContain('UNMASKED_VENDOR_WEBGL');
    expect(script).toContain('UNMASKED_RENDERER_WEBGL');
    expect(script).toContain('"ARM"');
    expect(script).toContain('"Mali-G78"');
  });

  it('contains canvas noise with seed', () => {
    const script = buildFingerprintScript(sampleFp);
    expect(script).toContain('toDataURL');
    expect(script).toContain('123456');
  });

  it('contains audio noise with seed', () => {
    const script = buildFingerprintScript(sampleFp);
    expect(script).toContain('createOscillator');
    expect(script).toContain('654321');
  });

  it('contains font override', () => {
    const script = buildFingerprintScript(sampleFp);
    expect(script).toContain('Roboto');
    expect(script).toContain('Noto Sans');
  });

  it('produces valid JavaScript (no syntax errors)', () => {
    const script = buildFingerprintScript(sampleFp);
    // This will throw if the script has syntax errors
    expect(() => new Function(script)).not.toThrow();
  });
});
