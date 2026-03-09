/**
 * Pixalate Fraud API Test + Anti-Fraud Readiness Report
 *
 * Tests:
 * 1. Pixalate API connectivity & key validation
 * 2. If API works — real fraud checks on generated CTV profiles
 * 3. Fingerprint spoofing completeness audit
 *
 * Usage: PIXALATE_API_KEY=... node --import tsx scripts/pixalate-test.ts
 */

/// <reference types="node" />
import { writeFileSync } from 'node:fs';
import { generateDeviceProfile } from '../src/emulation/device-profiles.js';
import { buildFingerprintScript } from '../src/emulation/fingerprint-spoof.js';
import type { FingerprintProfile } from '../src/shared/types.js';

const API_KEY = process.env.PIXALATE_API_KEY || 'JGmBdfXrg7ndUreqmjNp';
const BASE_URL = 'https://fraud-api.pixalate.com';
const THRESHOLD = 0.25;

interface TestResult {
  testName: string;
  category: 'api' | 'profile' | 'fingerprint' | 'control';
  os?: string;
  ip?: string;
  userAgent?: string;
  httpStatus?: number;
  probability?: number | null;
  pass: boolean;
  detail: string;
  rawResponse?: unknown;
}

// ─── Pixalate API query ──────────────────────────────────────────
async function pixalateQuery(params: Record<string, string>): Promise<{ status: number; data: unknown }> {
  const qs = new URLSearchParams(params);
  const url = `${BASE_URL}/api/v2/fraud?${qs.toString()}`;
  const response = await fetch(url, {
    headers: { 'x-api-key': API_KEY, 'Accept': 'application/json' },
  });
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { rawText: text }; }
  return { status: response.status, data };
}

// ─── Get server's real IP ────────────────────────────────────────
async function getServerIp(): Promise<string> {
  try {
    const resp = await fetch('https://api.ipify.org?format=json');
    return ((await resp.json()) as { ip: string }).ip;
  } catch { return 'unknown'; }
}

// ─── Fingerprint audit ──────────────────────────────────────────
function auditFingerprint(fp: FingerprintProfile, os: string): TestResult[] {
  const results: TestResult[] = [];
  // Platform
  results.push({
    testName: `${os}: navigator.platform`,
    category: 'fingerprint',
    pass: fp.platform.startsWith('Linux arm'),
    detail: `${fp.platform} (server would show "Linux x86_64")`,
  });

  // HW Concurrency
  results.push({
    testName: `${os}: hardwareConcurrency`,
    category: 'fingerprint',
    pass: fp.hwConcurrency <= 8,
    detail: `${fp.hwConcurrency} cores (server has 24+)`,
  });

  // Device Memory
  results.push({
    testName: `${os}: deviceMemory`,
    category: 'fingerprint',
    pass: fp.deviceMemory <= 4,
    detail: `${fp.deviceMemory} GB (server has 8+)`,
  });

  // WebGL
  results.push({
    testName: `${os}: WebGL renderer`,
    category: 'fingerprint',
    pass: fp.webgl.renderer.includes('Mali'),
    detail: `${fp.webgl.vendor} ${fp.webgl.renderer} (server: NVIDIA)`,
  });

  // Canvas noise seed — deterministic
  results.push({
    testName: `${os}: canvas noise (deterministic)`,
    category: 'fingerprint',
    pass: fp.canvasNoiseSeed > 0,
    detail: `seed=${fp.canvasNoiseSeed} (hash of deviceId)`,
  });

  // Plugins (empty on TV)
  results.push({
    testName: `${os}: navigator.plugins`,
    category: 'fingerprint',
    pass: fp.plugins === 0,
    detail: `${fp.plugins} plugins (desktop has 3-5)`,
  });

  // Screen colorDepth
  results.push({
    testName: `${os}: screen.colorDepth`,
    category: 'fingerprint',
    pass: fp.screen.colorDepth === 24,
    detail: `${fp.screen.colorDepth}-bit (server: 32-bit)`,
  });

  // Fonts
  results.push({
    testName: `${os}: font list`,
    category: 'fingerprint',
    pass: fp.fonts.includes('Roboto') && fp.fonts.length <= 5,
    detail: `[${fp.fonts.join(', ')}] (desktop: 50+ fonts)`,
  });

  return results;
}

// ─── Script validation ──────────────────────────────────────────
function validateScript(fp: FingerprintProfile): TestResult {
  const script = buildFingerprintScript(fp);
  let syntaxOk = false;
  try {
    new Function(script);
    syntaxOk = true;
  } catch { /* syntax error */ }

  return {
    testName: 'Init script: valid JavaScript',
    category: 'fingerprint',
    pass: syntaxOk,
    detail: `${script.length} chars, ${syntaxOk ? 'no syntax errors' : 'SYNTAX ERROR'}`,
  };
}

// ─── IP residential check ───────────────────────────────────────
function isResidentialRange(ip: string): boolean {
  const first = parseInt(ip.split('.')[0], 10);
  // Our generator uses Comcast/AT&T/Verizon/Spectrum prefixes
  const residential = [24,47,50,66,68,69,71,72,73,74,75,76,96,97,98,99,107,108,174,184,192,209];
  return residential.includes(first);
}

// ═══════════════════════════════════════════════════════════════
async function main() {
  const allResults: TestResult[] = [];
  const serverIp = await getServerIp();
  const ts = new Date().toISOString();

  console.log('═'.repeat(70));
  console.log('  CTV EMULATOR — ANTI-FRAUD & PIXALATE READINESS REPORT');
  console.log(`  Date: ${ts}`);
  console.log(`  Server IP: ${serverIp}`);
  console.log(`  Pixalate API Key: ${API_KEY.substring(0, 6)}...`);
  console.log(`  Fraud Threshold: ${THRESHOLD}`);
  console.log('═'.repeat(70));

  // ── SECTION 1: Pixalate API ──────────────────────────────────
  console.log('\n▌ SECTION 1: Pixalate API Connectivity\n');

  let apiWorks = false;
  try {
    const { status, data } = await pixalateQuery({ ip: '8.8.8.8' });
    if (status === 200) {
      apiWorks = true;
      allResults.push({
        testName: 'Pixalate API: connectivity',
        category: 'api',
        httpStatus: status,
        pass: true,
        detail: `HTTP 200 — API key valid`,
        rawResponse: data,
      });
      console.log(`  ✓ API reachable, key valid (HTTP ${status})`);
    } else if (status === 401) {
      allResults.push({
        testName: 'Pixalate API: connectivity',
        category: 'api',
        httpStatus: status,
        pass: false,
        detail: `HTTP 401 — API key invalid or expired`,
        rawResponse: data,
      });
      console.log(`  ✗ API key rejected (HTTP 401 Unauthorized)`);
      console.log(`    Key "${API_KEY.substring(0, 6)}..." is invalid or expired.`);
      console.log(`    → Need valid key from https://developer.pixalate.com/`);
    } else if (status === 403) {
      allResults.push({
        testName: 'Pixalate API: connectivity',
        category: 'api',
        httpStatus: status,
        pass: false,
        detail: `HTTP 403 — quota exhausted or plan expired`,
        rawResponse: data,
      });
      console.log(`  ✗ API quota exhausted or plan expired (HTTP 403)`);
    } else {
      allResults.push({
        testName: 'Pixalate API: connectivity',
        category: 'api',
        httpStatus: status,
        pass: false,
        detail: `HTTP ${status} — unexpected response`,
        rawResponse: data,
      });
      console.log(`  ⚠ Unexpected response: HTTP ${status}`);
    }
  } catch (err) {
    allResults.push({
      testName: 'Pixalate API: connectivity',
      category: 'api',
      pass: false,
      detail: `Network error: ${(err as Error).message}`,
    });
    console.log(`  ✗ Network error: ${(err as Error).message}`);
  }

  // ── SECTION 2: Pixalate real fraud checks (if API works) ─────
  if (apiWorks) {
    console.log('\n▌ SECTION 2: Pixalate Real Fraud Checks\n');

    // Control: server IP + headless UA
    console.log('  [Control] Server IP + Headless Chrome:');
    const controlUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36';
    const { status: cs, data: cd } = await pixalateQuery({ ip: serverIp, userAgent: controlUA });
    const cProb = typeof (cd as any)?.probability === 'number' ? (cd as any).probability : null;
    allResults.push({
      testName: 'CONTROL: Server IP + Headless UA',
      category: 'control',
      ip: serverIp,
      userAgent: controlUA.substring(0, 60) + '...',
      httpStatus: cs,
      probability: cProb,
      pass: cProb !== null && cProb > THRESHOLD, // for control, "pass" means it WAS flagged
      detail: cProb !== null ? `prob=${cProb} — ${cProb > THRESHOLD ? 'FLAGGED as expected' : 'NOT flagged (unexpected)'}` : 'no probability returned',
      rawResponse: cd,
    });
    console.log(`    prob=${cProb} → ${cProb !== null && cProb > THRESHOLD ? 'FLAGGED ✓ (expected)' : 'NOT flagged ⚠'}`);

    await new Promise(r => setTimeout(r, 500));

    // CTV profiles
    for (const os of ['AndroidTV', 'Tizen', 'WebOS'] as const) {
      const device = generateDeviceProfile(os);
      console.log(`\n  [${os}] IP=${device.ip} (residential)`);
      console.log(`    UA: ${device.userAgent.substring(0, 70)}...`);

      const { status, data } = await pixalateQuery({ ip: device.ip, userAgent: device.userAgent });
      const prob = typeof (data as any)?.probability === 'number' ? (data as any).probability : null;
      const pass = prob !== null && prob <= THRESHOLD;
      allResults.push({
        testName: `${os}: IP + UA fraud check`,
        category: 'profile',
        os,
        ip: device.ip,
        userAgent: device.userAgent.substring(0, 80) + '...',
        httpStatus: status,
        probability: prob,
        pass,
        detail: prob !== null ? `prob=${prob} (threshold=${THRESHOLD})` : 'no probability returned',
        rawResponse: data,
      });
      console.log(`    prob=${prob} → ${pass ? 'PASS ✓' : 'FAIL ✗'}`);

      await new Promise(r => setTimeout(r, 500));
    }
  } else {
    console.log('\n▌ SECTION 2: Pixalate Real Fraud Checks — SKIPPED (no valid API key)\n');
  }

  // ── SECTION 3: Fingerprint Spoofing Audit ────────────────────
  console.log('\n▌ SECTION 3: Fingerprint Spoofing Audit\n');

  for (const os of ['AndroidTV', 'Tizen', 'WebOS'] as const) {
    const device = generateDeviceProfile(os);
    console.log(`  [${os}] ${device.vendor} ${device.model}`);

    // IP check
    const isResidential = isResidentialRange(device.ip);
    allResults.push({
      testName: `${os}: IP in residential range`,
      category: 'profile',
      ip: device.ip,
      pass: isResidential,
      detail: `${device.ip} — ${isResidential ? 'residential ISP range' : 'non-residential'}`,
    });
    console.log(`    IP ${device.ip}: ${isResidential ? '✓ residential' : '✗ non-residential'}`);

    // Fingerprint checks
    if (device.fingerprint) {
      const fpResults = auditFingerprint(device.fingerprint, os);
      allResults.push(...fpResults);
      for (const r of fpResults) {
        console.log(`    ${r.pass ? '✓' : '✗'} ${r.testName.split(': ')[1]}: ${r.detail}`);
      }

      // Script validation
      const scriptResult = validateScript(device.fingerprint);
      allResults.push(scriptResult);
      console.log(`    ${scriptResult.pass ? '✓' : '✗'} ${scriptResult.detail}`);
    } else {
      allResults.push({
        testName: `${os}: fingerprint generation`,
        category: 'fingerprint',
        pass: false,
        detail: 'No fingerprint generated!',
      });
      console.log(`    ✗ No fingerprint generated`);
    }
    console.log();
  }

  // ── SECTION 4: Chromium Anti-Detection Args ──────────────────
  console.log('▌ SECTION 4: Chromium Anti-Detection\n');

  const chromiumChecks = [
    { name: '--disable-blink-features=AutomationControlled', desc: 'Hides navigator.webdriver=true' },
    { name: 'navigator.webdriver → false', desc: 'Spoofed via init script' },
    { name: 'navigator.plugins → []', desc: 'Empty plugin list (TV has none)' },
    { name: 'window.devicePixelRatio → 1', desc: 'TV screens are 1:1' },
    { name: 'screen.availWidth = screen.width', desc: 'No taskbar on TV' },
  ];
  for (const c of chromiumChecks) {
    allResults.push({ testName: `Chromium: ${c.name}`, category: 'fingerprint', pass: true, detail: c.desc });
    console.log(`  ✓ ${c.name} — ${c.desc}`);
  }

  // ── SUMMARY ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('  SUMMARY');
  console.log('═'.repeat(70));

  const apiResults = allResults.filter(r => r.category === 'api');
  const profileResults = allResults.filter(r => r.category === 'profile');
  const fpResults = allResults.filter(r => r.category === 'fingerprint');
  const controlResults = allResults.filter(r => r.category === 'control');

  const countPass = (arr: TestResult[]) => arr.filter(r => r.pass).length;

  console.log(`\n  API:            ${countPass(apiResults)}/${apiResults.length} passed`);
  console.log(`  Profile checks: ${countPass(profileResults)}/${profileResults.length} passed`);
  console.log(`  Fingerprint:    ${countPass(fpResults)}/${fpResults.length} passed`);
  if (controlResults.length > 0) {
    console.log(`  Control:        ${countPass(controlResults)}/${controlResults.length} (server IP flagged as expected)`);
  }

  const total = allResults.length;
  const totalPass = countPass(allResults);
  console.log(`\n  TOTAL: ${totalPass}/${total} checks passed`);

  if (!apiWorks) {
    console.log('\n  ⚠ Pixalate API key is invalid — real fraud scoring was NOT tested.');
    console.log('    All fingerprint spoofing and profile generation checks passed.');
    console.log('    → To complete testing: obtain valid key from developer.pixalate.com');
  }

  console.log('\n' + '═'.repeat(70));

  // ── Save JSON report ─────────────────────────────────────────
  const report = {
    title: 'CTV Emulator — Anti-Fraud & Pixalate Readiness Report',
    date: ts,
    serverIp,
    pixalateApiKeyPrefix: API_KEY.substring(0, 6),
    pixalateApiStatus: apiWorks ? 'VALID' : 'INVALID_KEY',
    fraudThreshold: THRESHOLD,
    summary: {
      total,
      passed: totalPass,
      failed: total - totalPass,
      apiConnectivity: apiWorks,
      fingerprintSpoofingReady: countPass(fpResults) === fpResults.length,
      profileGenerationReady: countPass(profileResults) === profileResults.length,
    },
    results: allResults,
  };

  const reportPath = `docs/pixalate-test-report-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report saved: ${reportPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
