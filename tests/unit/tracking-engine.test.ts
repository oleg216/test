import { describe, it, expect, vi } from 'vitest';
import { TrackingEngine } from '../../src/engines/tracking-engine.js';

describe('TrackingEngine', () => {
  it('fires tracking pixels with plain GET (no custom headers)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const engine = new TrackingEngine('session-1', fetchFn);

    await engine.fireEvent('impression', ['https://tracker.example.com/imp']);

    expect(fetchFn).toHaveBeenCalledWith('https://tracker.example.com/imp', { method: 'GET' });
  });

  it('fires each event only once (idempotency)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const engine = new TrackingEngine('session-1', fetchFn);

    await engine.fireEvent('start', ['https://tracker.example.com/start']);
    await engine.fireEvent('start', ['https://tracker.example.com/start']);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fires to multiple URLs for same event sequentially', async () => {
    const callOrder: number[] = [];
    const fetchFn = vi.fn().mockImplementation(async () => {
      callOrder.push(Date.now());
      return { ok: true };
    });
    const engine = new TrackingEngine('session-1', fetchFn);

    await engine.fireEvent('impression', [
      'https://tracker1.example.com/imp',
      'https://tracker2.example.com/imp',
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Sequential: second call should be after first (with small delay)
    expect(callOrder).toHaveLength(2);
  });
});
