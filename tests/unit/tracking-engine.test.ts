import { describe, it, expect, vi } from 'vitest';
import { TrackingEngine } from '../../src/engines/tracking-engine.js';

describe('TrackingEngine', () => {
  it('fires tracking pixels', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const engine = new TrackingEngine('session-1', fetchFn);

    await engine.fireEvent('impression', ['https://tracker.example.com/imp']);

    expect(fetchFn).toHaveBeenCalledWith('https://tracker.example.com/imp', expect.any(Object));
  });

  it('fires each event only once (idempotency)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const engine = new TrackingEngine('session-1', fetchFn);

    await engine.fireEvent('start', ['https://tracker.example.com/start']);
    await engine.fireEvent('start', ['https://tracker.example.com/start']);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fires to multiple URLs for same event', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const engine = new TrackingEngine('session-1', fetchFn);

    await engine.fireEvent('impression', [
      'https://tracker1.example.com/imp',
      'https://tracker2.example.com/imp',
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
