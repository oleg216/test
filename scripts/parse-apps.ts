/**
 * Parse app links from data/1.txt, fetch names from Google Play, write to data/app_rotation.csv
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const raw = readFileSync(resolve(process.cwd(), 'data', '1.txt'), 'utf-8');
const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

// Extract unique bundles
const bundleSet = new Set<string>();
const bundleList: string[] = [];
for (const line of lines) {
  const m = line.match(/[?&]id=([a-zA-Z0-9._]+)/);
  if (m && !bundleSet.has(m[1])) {
    bundleSet.add(m[1]);
    bundleList.push(m[1]);
  }
}

console.log(`Found ${bundleList.length} unique bundles. Fetching names from Google Play...`);

interface AppInfo {
  bundle: string;
  name: string;
  storeurl: string;
  ver: string;
}

const CONCURRENCY = 20;

interface AppData {
  name: string;
  ver: string;
}

async function fetchAppData(bundle: string): Promise<AppData> {
  const url = `https://play.google.com/store/apps/details?id=${bundle}&hl=en`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept-Language': 'en-US,en' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!res.ok) return { name: bundle, ver: '1.0.0' };
    const html = await res.text();

    // Extract name — try multiple sources
    let name = bundle;
    // 1) og:title meta tag (most reliable on current Google Play)
    const ogMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
    if (ogMatch) {
      let parsed = ogMatch[1]
        .replace(/ - Apps on Google Play$/, '')
        .replace(/ – Apps on Google Play$/, '')
        .replace(/ - Приложения в Google Play$/, '')
        .replace(/ - Google Play のアプリ$/, '')
        .trim();
      if (parsed && parsed !== 'Google Play' && parsed.length < 100) name = parsed;
    }
    // 2) Fallback: <title> tag
    if (name === bundle) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        let parsed = titleMatch[1]
          .replace(/ - Apps on Google Play$/, '')
          .replace(/ – Apps on Google Play$/, '')
          .trim();
        if (parsed && parsed !== 'Google Play' && parsed.length < 100) name = parsed;
      }
    }

    // Extract version — Google Play embeds it in structured data or visible text
    // Pattern 1: JSON-LD or script data with "version" near the bundle
    let ver = '1.0.0';

    // Look for version in the page — typically appears as text like "Current Version" or in JSON
    // Google Play 2024+ uses AF_initDataCallback with version info
    const versionPatterns = [
      // Pattern: [["X.Y.Z"]] near the bundle or version context
      /\[\[\["(\d+\.\d+[\d.]*)"(?:\]\]|\],")/g,
      // Pattern: "softwareVersion":"X.Y.Z"
      /"softwareVersion"\s*:\s*"([^"]+)"/g,
      // Pattern: visible version text after "Current Version"
      /Current Version<\/div>[^<]*<div[^>]*><span[^>]*>([^<]+)/g,
      // Pattern: data in AF_initDataCallback — version often at specific positions
      /\["(\d+\.\d+\.\d+[\d.]*)"\]/g,
    ];

    for (const pattern of versionPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const candidate = match[1].trim();
        // Validate: looks like a version (digits and dots, 3+ chars)
        if (/^\d+\.\d+/.test(candidate) && candidate.length >= 3 && candidate.length <= 30) {
          ver = candidate;
          break;
        }
      }
      if (ver !== '1.0.0') break;
    }

    return { name, ver };
  } catch {
    return { name: bundle, ver: '1.0.0' };
  }
}

async function main() {
  const results: AppInfo[] = [];
  let done = 0;

  for (let i = 0; i < bundleList.length; i += CONCURRENCY) {
    const batch = bundleList.slice(i, i + CONCURRENCY);
    const data = await Promise.all(batch.map(b => fetchAppData(b)));
    for (let j = 0; j < batch.length; j++) {
      results.push({
        bundle: batch[j],
        name: data[j].name,
        storeurl: `https://play.google.com/store/apps/details?id=${batch[j]}`,
        ver: data[j].ver,
      });
    }
    done += batch.length;
    console.log(`  ${done}/${bundleList.length} done`);
  }

  // Write CSV
  function csvEsc(val: string): string {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  }

  const header = 'bundle,name,storeurl,ver';
  const rows = results.map(r =>
    `${r.bundle},${csvEsc(r.name)},${r.storeurl},${r.ver}`
  );

  const csv = [header, ...rows].join('\n') + '\n';
  const outPath = resolve(process.cwd(), 'data', 'app_rotation_new.csv');
  writeFileSync(outPath, csv, 'utf-8');
  console.log(`\nDone! ${results.length} apps → ${outPath}`);

  // Show some samples
  const named = results.filter(r => r.name !== r.bundle);
  const versioned = results.filter(r => r.ver !== '1.0.0');
  console.log(`Names resolved: ${named.length}/${results.length}`);
  console.log(`Versions resolved: ${versioned.length}/${results.length}`);
  console.log('Samples:');
  for (const r of results.slice(0, 15)) {
    console.log(`  ${r.bundle} → ${r.name} (v${r.ver})`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
