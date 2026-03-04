import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const DSP_URL = process.env.DSP_URL || 'http://localhost:4200';

const SESSION_CONFIG = {
  device: {
    os: 'AndroidTV' as const,
    vendor: 'Sony',
    model: 'BRAVIA-XR',
    screenWidth: 1920,
    screenHeight: 1080,
    deviceId: 'test-lifecycle-device',
    ifa: 'test-lifecycle-ifa',
    ip: '10.0.0.1',
    networkType: 'WiFi' as const,
    userAgent: 'Mozilla/5.0 (Linux; Android 12; BRAVIA XR) AppleWebKit/537.36',
    timezone: 'America/New_York',
  },
  rtbEndpoint: `${DSP_URL}/bid`,
  contentUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  appBundle: 'com.test.lifecycle',
  appName: 'LifecycleTest',
  appStoreUrl: 'https://play.google.com/store/apps/details?id=com.test.lifecycle',
};

const EXPECTED_TRACKING_EVENTS = [
  'impression',
  'start',
  'firstQuartile',
  'midpoint',
  'thirdQuartile',
  'complete',
];

const TERMINAL_STATES = new Set([
  'STOPPED',
  'ERROR_VAST',
  'ERROR_MEDIA',
  'ERROR_NETWORK',
  'ERROR_TIMEOUT',
]);

async function pollSession(sessionId: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`);
    if (!res.ok) {
      // Session might be cleaned up after stopping — check list
      const listRes = await fetch(`${BASE_URL}/api/sessions`);
      const list = await listRes.json();
      const found = list.sessions?.find((s: any) => s.id === sessionId);
      if (found && TERMINAL_STATES.has(found.state)) return found;
      if (!found) {
        // Session removed — it completed; return a synthetic result
        return { id: sessionId, state: 'STOPPED', removed: true };
      }
    } else {
      const session = await res.json();
      if (TERMINAL_STATES.has(session.state)) return session;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error(`Session ${sessionId} did not reach terminal state within ${timeoutMs}ms`);
}

describe('Session Lifecycle (requires running server + mock DSP)', () => {
  it('full session: CREATED → ... → STOPPED with 6 tracking events', async () => {
    // Reset mock DSP tracked events
    await fetch(`${DSP_URL}/reset`, { method: 'POST' });

    // Create session
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SESSION_CONFIG),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.id).toBeDefined();
    expect(created.state).toBe('CREATED');

    const sessionId = created.id;

    // Poll until terminal state (mock ad is 10s + 5s content + buffer)
    const final = await pollSession(sessionId, 60_000);

    expect(final.state).toBe('STOPPED');

    // Verify tracking events on mock DSP
    const statsRes = await fetch(`${DSP_URL}/stats`);
    const stats = await statsRes.json();
    const eventNames = stats.events.map((e: any) => e.event);

    for (const expected of EXPECTED_TRACKING_EVENTS) {
      expect(eventNames).toContain(expected);
    }
  }, 90_000);

  it('session with invalid RTB endpoint fails gracefully', async () => {
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...SESSION_CONFIG,
        rtbEndpoint: 'http://127.0.0.1:19999/nonexistent',
      }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const final = await pollSession(created.id, 30_000);

    expect(final.state).toMatch(/^ERROR_/);
  }, 45_000);

  it('stop session mid-flight', async () => {
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SESSION_CONFIG),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    // Wait a bit for session to start processing
    await new Promise(r => setTimeout(r, 3000));

    // Stop the session
    const stopRes = await fetch(`${BASE_URL}/api/sessions/${created.id}`, {
      method: 'DELETE',
    });

    // Might be 200 (stopped) or 404 (already finished/cleaned up)
    expect([200, 404]).toContain(stopRes.status);

    if (stopRes.status === 200) {
      const final = await pollSession(created.id, 15_000);
      expect(TERMINAL_STATES.has(final.state)).toBe(true);
    }
  }, 30_000);
});
