#!/usr/bin/env node

/**
 * css-collector.mjs — deterministically gather EVERY CSS source a markup-port clone
 * needs, so none is silently missed. Closes the gap that bit the Vaultix clone: the
 * orchestrator saved 2 of 5 linked stylesheets by hand → 3 sheets' worth of rules missing
 * → silent visual drift.
 *
 * Operating on the saved raw HTML (zero LLM tokens), it:
 *   1. enumerates every <link rel="stylesheet"> across all pages (deduped, resolved
 *      to absolute via the origin) and downloads each to docs/research/css/.
 *   2. extracts every HEAD-level inline <style> block (global/critical CSS that the
 *      markup-port body slice does NOT keep) to docs/research/css/, deduped by hash.
 *   3. writes docs/research/css/manifest.json — the ORDERED source list to hand to
 *      css-descope (preflight/base first is still the orchestrator's call; this preserves
 *      first-appearance order as a sane default).
 *
 * BODY <style> blocks are intentionally left alone — slice-routes.mjs keeps them
 * inline in bodyHTML, so extracting them here would double-apply. Runtime-injected
 * CSS (CSS-in-JS, <link> added by JS) won't be in static HTML — for those, still do
 * a live `list_network_requests resourceTypes:["stylesheet"]` pass. This script is
 * the deterministic FLOOR: every static stylesheet, never missed.
 *
 * Usage (from the clone workspace root):
 *   node scripts/css-collector.mjs                       # origin from .template-snapshot
 *   node scripts/css-collector.mjs --origin https://site.com --referer https://site.com
 *   node scripts/css-collector.mjs --raw docs/research/raw-html --out docs/research/css --dry-run
 *
 * Pure Node built-ins. Zero new dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const WS = process.cwd();
const RAW = path.join(WS, flag('--raw', 'docs/research/raw-html'));
const OUT = path.join(WS, flag('--out', 'docs/research/css'));
const DRY = has('--dry-run');
const UA = flag('--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
const REFERER = flag('--referer', null);

function readOriginFromSnapshot() {
  const snap = path.join(WS, 'docs/research/.template-snapshot');
  try {
    const m = fs.readFileSync(snap, 'utf8').match(/source_input=(\S+)/);
    if (m) return new URL(m[1]).origin;
  } catch { /* none */ }
  return null;
}
const ORIGIN = flag('--origin', readOriginFromSnapshot());

if (!fs.existsSync(RAW)) {
  console.error(`css-collector: no raw HTML at ${RAW} (pass --raw). Save each route as <slug>.html first.`);
  process.exit(1);
}
if (!ORIGIN) {
  console.error('css-collector: no origin (pass --origin https://site.com, or run from a workspace with docs/research/.template-snapshot).');
  process.exit(2);
}

const slugToPath = (slug) => (slug === 'index' ? '/' : '/' + slug.split('__').join('/') + '/');
const attrOf = (tag, name) => (tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1] || '';

// first-appearance-ordered external stylesheet URLs, and head <style> blocks (by hash)
const externals = [];           // { url, fromSlug }
const seenUrl = new Set();
const inlineBlocks = [];         // { hash, css, fromSlug }
const seenInline = new Set();

for (const file of fs.readdirSync(RAW).filter((f) => f.endsWith('.html')).sort()) {
  const slug = file.replace(/\.html$/, '');
  const base = ORIGIN + slugToPath(slug);
  const html = fs.readFileSync(path.join(RAW, file), 'utf8');
  const bodyAt = html.search(/<body\b/i);
  const head = bodyAt === -1 ? html : html.slice(0, bodyAt);

  // 1. external <link rel="stylesheet"> (rel may sit before or after href)
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["'][^"']*stylesheet/i.test(tag)) continue;
    const href = attrOf(tag, 'href');
    if (!href) continue;
    let abs; try { abs = new URL(href, base).href; } catch { continue; }
    if (seenUrl.has(abs)) continue;
    seenUrl.add(abs);
    externals.push({ url: abs, fromSlug: slug });
  }

  // 2. HEAD-level inline <style> blocks (global/critical CSS, deduped by content)
  for (const m of head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = (m[1] || '').trim();
    if (!css) continue;
    const hash = crypto.createHash('sha1').update(css).digest('hex').slice(0, 12);
    if (seenInline.has(hash)) continue;
    seenInline.add(hash);
    inlineBlocks.push({ hash, css, fromSlug: slug });
  }
}

async function download(url, dest) {
  const headers = { 'User-Agent': UA, ...(REFERER ? { Referer: REFERER } : {}) };
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const manifest = { origin: ORIGIN, order: [], external: [], inline: [], generatedFrom: path.relative(WS, RAW) };

if (!DRY) fs.mkdirSync(OUT, { recursive: true });

let idx = 0, failed = 0;
for (const { url, fromSlug } of externals) {
  const namePart = (url.split('/').pop() || 'sheet.css').replace(/[?#].*$/, '').replace(/[^\w.-]/g, '_');
  const fname = `ext-${String(idx).padStart(2, '0')}-${namePart.endsWith('.css') ? namePart : namePart + '.css'}`;
  const dest = path.join(OUT, fname);
  if (DRY) {
    process.stderr.write(`  [dry] external ${url}  →  ${path.relative(WS, dest)}\n`);
  } else {
    try { await download(url, dest); process.stderr.write(`  downloaded  ${fname}  (${url})\n`); }
    catch (e) { failed++; process.stderr.write(`  FAILED      ${fname}  (${url}) — ${e.message}\n`); }
  }
  manifest.external.push({ file: fname, url, fromSlug });
  manifest.order.push(fname);
  idx++;
}

let inIdx = 0;
for (const { hash, css, fromSlug } of inlineBlocks) {
  const fname = `head-inline-${String(inIdx).padStart(2, '0')}-${hash}.css`;
  const dest = path.join(OUT, fname);
  if (!DRY) fs.writeFileSync(dest, css + '\n');
  manifest.inline.push({ file: fname, hash, fromSlug });
  manifest.order.push(fname);
  inIdx++;
}

if (!DRY) fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

process.stderr.write(
  `\ncss-collector: ${externals.length} external stylesheet(s)` +
  (failed ? ` (${failed} FAILED)` : '') +
  `, ${inlineBlocks.length} head inline block(s) → ${path.relative(WS, OUT)}\n` +
  `  Pass the manifest.order files to css-descope (preflight/base first, font @import at the very top).\n`
);
process.exit(failed > 0 ? 1 : 0);
