#!/usr/bin/env node

/**
 * download-assets.mjs — deterministic asset downloader for a website clone.
 *
 * Replaces the per-run "write a download script from scratch" step. Given the
 * list of asset URLs discovered via the browser MCP (list_network_requests),
 * it mirrors each asset to public/ preserving the ORIGIN PATH verbatim — the
 * only safe rule, because ported markup (dangerouslySetInnerHTML) references
 * those exact paths (e.g. /logos/logo-1.svg, /_astro/x.webp).
 *
 * Input: a JSON array on stdin (preferred — avoids shell quoting of URLs with
 * query strings) or via --manifest <path>. Each item is either:
 *   "https://site.com/logos/logo-1.svg"
 *   { "url": "https://site.com/x.webp", "dest": "public/images/x.webp" }  // explicit dest optional
 *
 * Behavior:
 *   - dest defaults to <out>/<url.pathname> (full origin-path mirror, no type bucketing).
 *   - fonts.googleapis.com / fonts.gstatic.com are skipped (handled by next/font/google).
 *   - idempotent: existing files are skipped, not re-fetched.
 *   - batched 16 concurrent (--batch N to lower on a self-hosted origin that 429s), one retry on failure.
 *   - writes docs/research/asset-manifest-result.json as an auditable receipt.
 *   - exits non-zero if any download failed.
 *
 * Usage:
 *   list_network_requests(...) | node scripts/download-assets.mjs            # stdin
 *   node scripts/download-assets.mjs --manifest urls.json --out public
 *   node scripts/download-assets.mjs --manifest urls.json --dry-run          # print derived paths, no fetch
 *
 * Pure Node built-ins. Zero new dependencies.
 */

import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const getFlag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const OUT = getFlag('--out', 'public');
const MANIFEST = getFlag('--manifest', null);
const DRY = has('--dry-run');
// Receipt path is configurable so the same script can be reused for a second pass
// (e.g. JS bundles → docs/research/js) without clobbering the asset receipt.
const RECEIPT = getFlag('--receipt', 'docs/research/asset-manifest-result.json');
const SKIP_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
// 16 is safe on any modern CDN (HTTP/2 multiplexing). Drop to --batch 4 for a
// self-hosted origin if it starts returning 429s.
const BATCH = Number(getFlag('--batch', '16')) || 16;
// Always send a real browser User-Agent (some CDNs 403 the default fetch UA), and
// an optional Referer. Premium-agency CDNs hotlink-protect by referer — pass the
// ORIGINAL SITE origin (--referer https://site.com) so cross-origin asset fetches
// pass the check (this has historically unblocked ~half the assets on such sites).
const UA = getFlag('--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
const REFERER = getFlag('--referer', null);
const HEADERS = { 'User-Agent': UA, ...(REFERER ? { Referer: REFERER } : {}) };

async function readInput() {
  if (MANIFEST) return readFile(MANIFEST, 'utf8');
  // stdin
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function deriveDest(url) {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  return join(OUT, path || 'index');
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function downloadOne(item) {
  const url = typeof item === 'string' ? item : item.url;
  let host;
  try { host = new URL(url).host; } catch {
    return { url, localPath: null, status: 'invalid-url', bytes: 0 };
  }
  if (SKIP_HOSTS.has(host)) {
    return { url, localPath: null, status: 'skipped-google-font', bytes: 0 };
  }
  const dest = (typeof item === 'object' && item.dest) ? item.dest : deriveDest(url);
  if (DRY) return { url, localPath: dest, status: 'dry-run', bytes: 0 };
  if (await exists(dest)) return { url, localPath: dest, status: 'exists', bytes: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return { url, localPath: dest, status: 'downloaded', bytes: buf.length };
    } catch (err) {
      if (attempt === 1) return { url, localPath: dest, status: `failed: ${err.message}`, bytes: 0 };
    }
  }
  return { url, localPath: dest, status: 'failed: unknown', bytes: 0 };
}

async function main() {
  const raw = await readInput();
  let items;
  try { items = JSON.parse(raw); } catch (e) {
    console.error(`download-assets: input is not valid JSON (${e.message})`);
    process.exit(2);
  }
  if (!Array.isArray(items)) {
    console.error('download-assets: input must be a JSON array of URLs or {url,dest} objects');
    process.exit(2);
  }

  // Dedupe by derived dest so the same asset referenced twice downloads once.
  const seen = new Set();
  const queue = [];
  for (const it of items) {
    const url = typeof it === 'string' ? it : it?.url;
    if (!url) continue;
    const key = (typeof it === 'object' && it.dest) ? it.dest : url;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(it);
  }

  const results = [];
  for (let i = 0; i < queue.length; i += BATCH) {
    const slice = queue.slice(i, i + BATCH);
    results.push(...await Promise.all(slice.map(downloadOne)));
  }

  const tally = results.reduce((acc, r) => {
    const k = r.status.startsWith('failed') ? 'failed'
      : r.status === 'downloaded' ? 'downloaded'
      : r.status === 'exists' ? 'skipped(exists)'
      : r.status === 'skipped-google-font' ? 'skipped(font)'
      : r.status === 'dry-run' ? 'dry-run' : 'other';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  for (const r of results) {
    process.stderr.write(`  ${r.status.padEnd(22)} ${r.url}\n`);
  }
  process.stderr.write(`\ndownload-assets: ${JSON.stringify(tally)}\n`);

  if (!DRY) {
    await mkdir(dirname(RECEIPT), { recursive: true });
    await writeFile(RECEIPT, JSON.stringify(results, null, 2) + '\n', 'utf8');
    process.stderr.write(`download-assets: receipt → ${RECEIPT}\n`);
  }

  const failed = results.filter((r) => r.status.startsWith('failed')).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('download-assets:', e.message); process.exit(2); });
