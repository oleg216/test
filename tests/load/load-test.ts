const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const CONCURRENT_SESSIONS = parseInt(process.env.LOAD_SESSIONS || '50', 10);

const sampleConfig = {
  device: {
    os: 'AndroidTV',
    vendor: 'Sony',
    model: 'BRAVIA-XR',
    screenWidth: 1920,
    screenHeight: 1080,
    deviceId: 'load-test-device',
    ifa: 'load-test-ifa',
    ip: '10.0.0.1',
    networkType: 'WiFi',
    userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36',
    timezone: 'America/New_York',
  },
  rtbEndpoint: 'https://ssp.example.com/bid',
  contentUrl: 'https://cdn.example.com/stream.m3u8',
  appBundle: 'com.loadtest.app',
  appName: 'LoadTest',
  appStoreUrl: 'https://play.google.com/store/apps/details?id=com.loadtest.app',
};

async function createSession(index: number): Promise<{ id: string; status: number; time: number }> {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...sampleConfig,
      device: { ...sampleConfig.device, deviceId: `load-${index}`, ifa: `ifa-${index}` },
    }),
  });
  const time = Date.now() - start;
  const body = await res.json();
  return { id: body.id || '', status: res.status, time };
}

async function runLoadTest() {
  console.log(`Starting load test with ${CONCURRENT_SESSIONS} concurrent sessions...`);
  console.log(`Target: ${BASE_URL}`);
  console.log('---');

  const startTime = Date.now();

  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENT_SESSIONS }, (_, i) => createSession(i))
  );

  const totalTime = Date.now() - startTime;
  const successes = results.filter(r => r.status === 'fulfilled' && (r.value as any).status === 201);
  const failures = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && (r.value as any).status !== 201));

  const times = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map(r => r.value.time);

  console.log(`Total time: ${totalTime}ms`);
  console.log(`Successes: ${successes.length}/${CONCURRENT_SESSIONS}`);
  console.log(`Failures: ${failures.length}/${CONCURRENT_SESSIONS}`);
  if (times.length > 0) {
    console.log(`Avg response time: ${Math.round(times.reduce((a: number, b: number) => a + b, 0) / times.length)}ms`);
    console.log(`Max response time: ${Math.max(...times)}ms`);
    console.log(`Min response time: ${Math.min(...times)}ms`);
  }

  await new Promise(resolve => setTimeout(resolve, 5000));

  const sessionsRes = await fetch(`${BASE_URL}/api/sessions`);
  const sessionsBody = await sessionsRes.json();
  console.log(`\nActive sessions after 5s: ${sessionsBody.sessions?.length || 0}`);

  const stateCounts: Record<string, number> = {};
  for (const s of sessionsBody.sessions || []) {
    stateCounts[s.state] = (stateCounts[s.state] || 0) + 1;
  }
  console.log('State distribution:', stateCounts);
}

runLoadTest().catch(console.error);
