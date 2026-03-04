import { describe, it, expect } from 'vitest';

describe('API Integration', () => {
  const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

  it('health check responds OK', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('metrics endpoint returns prometheus format', async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain('sessions_running');
  });

  it('GET /api/sessions returns empty list initially', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.sessions).toEqual([]);
  });

  it('POST /api/sessions with invalid body returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/sessions/:id with unknown id returns 404', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it('GET /api/workers returns worker list', async () => {
    const res = await fetch(`${BASE_URL}/api/workers`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.workers)).toBe(true);
  });
});
