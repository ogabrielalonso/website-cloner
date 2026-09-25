#!/usr/bin/env node

/**
 * verify-content-fidelity.mjs — content-fidelity gate for a website clone (Phase 8 companion).
 *
 * The pixel-diff gate (qa-diff.mjs) is the visual backstop, but on animation-heavy sites its
 * NOISE FLOOR can swamp the signal (continuous animation flags routes run-to-run), so a real
 * CONTENT regression in a C2-componentized section (a dropped word, a collapsed-away space, a
 * lost block) can hide under the noise. This gate catches that class deterministically and
 * cheaply: it serves the built clone, fetches each route's RENDERED HTML, strips tags
 * quote-aware down to the visible text-token stream, and asserts it is byte-identical to the
 * captured original snapshot in docs/research/raw-html/<slug>.html.
 *
 * It is the gate that would have caught the whitespace/<textarea> C2 transpile bugs (commit
 * 6a568ed) WITHOUT a human remembering to hand-run a one-liner — exactly the bug class that
 * typecheck and (on an animated site) the pixel gate both miss.
 *
 * Comparison is text-only (attributes/markup ignored): two renders that show the same words in
 * the same order pass, regardless of class soup or wrapper churn. Entity decoding is symmetric
 * and broad (named + numeric) so &#8217; on one side and a UTF-8 ' on the other are not a false
 * divergence. <script>/<style>/<svg>/<template> and comments are dropped on BOTH sides.
 *
 * Usage (mirror qa-diff: caller builds + serves, this hits the running URL):
 *   nohup npx next start -p 4900 & disown        # build first: rm -rf .next && npx next build
 *   node scripts/verify-content-fidelity.mjs --base http://localhost:4900
 *   # then kill the server
 *
 * Flags:
 *   --base <url>          running clone server (required)
 *   --manifest <path>     route source of truth (default src/generated/manifest.json)
 *   --snapshots <dir>     captured originals (default docs/research/raw-html)
 *   --routes a,b,c        restrict to a subset (default: every manifest route that has a snapshot)
 *   --out <path>          JSON report (default docs/research/qa/content-fidelity.json)
 *   --max-divergences N   stop listing per-route divergences after N (default 1; report still counts all)
 *
 * Exit non-zero if ANY route's text stream diverges from its snapshot (a real content regression).
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const BASE = flag('--base');
const MANIFEST = flag('--manifest', 'src/generated/manifest.json');
const SNAPSHOTS = flag('--snapshots', 'docs/research/raw-html');
const OUT = flag('--out', 'docs/research/qa/content-fidelity.json');
const MAX_DIV = Number(flag('--max-divergences', '1')) || 1;
const SUBSET = (flag('--routes', '') || '').split(',').map((r) => r.trim()).filter(Boolean);

if (!BASE) {
  console.error('verify-content-fidelity: --base <url> is required (a running clone server).');
  process.exit(2);
}

// ── entity decode (symmetric on both sides) ───────────────────────────────────────────────────
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', times: '×', divide: '÷', deg: '°',
  plusmn: '±', middot: '·', bull: '•', dagger: '†', sect: '§',
  para: '¶', euro: '€', pound: '£', cent: '¢', yen: '¥',
  frac12: '½', frac14: '¼', frac34: '¾', prime: '′', Prime: '″',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  infin: '∞', ne: '≠', le: '≤', ge: '≥', shy: '', zwnj: '', zwj: '',
};
const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
  });

// ── quote-aware text tokenizer: emit collapsed visible-text tokens, ignore all markup ─────────
function textTokens(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] === '<') {
      // skip a tag, honoring quoted attribute values so a `>` inside an attr doesn't end it early
      let j = i + 1;
      let q = 0;
      while (j < n) {
        const c = html[j];
        if (c === '"' || c === "'") { if (!q) q = c; else if (q === c) q = 0; }
        else if (c === '>' && !q) break;
        j++;
      }
      i = j + 1;
    } else {
      let j = i;
      while (j < n && html[j] !== '<') j++;
      const t = decodeEntities(html.slice(i, j)).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
      i = j;
    }
  }
  return out;
}

// ── route → snapshot slug (mirror slice-routes.mjs: "/" → index, "/blog/x" → blog__x) ──────────
const routeToSlug = (route) => {
  const r = route.replace(/^\/+|\/+$/g, '');
  return r === '' ? 'index' : r.replace(/\//g, '__');
};

// ── fetch rendered HTML, following redirects (trailingSlash 308 etc.) ──────────────────────────
function fetchHtml(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 5) return resolve({ status: 0, body: '' });
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(fetchHtml(next, redirects + 1));
      }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

// ── route set: manifest paths ∩ snapshots (or --routes subset) ─────────────────────────────────
function loadRoutes() {
  let routes = [];
  if (existsSync(MANIFEST)) {
    try { routes = Object.keys(JSON.parse(readFileSync(MANIFEST, 'utf8')).paths || {}); } catch { /* fall through */ }
  }
  if (!routes.length && existsSync(SNAPSHOTS)) {
    // no manifest → derive routes from snapshot filenames
    routes = readdirSync(SNAPSHOTS).filter((f) => f.endsWith('.html')).map((f) => {
      const slug = f.replace(/\.html$/, '');
      return slug === 'index' ? '/' : '/' + slug.replace(/__/g, '/') + '/';
    });
  }
  if (SUBSET.length) routes = routes.filter((r) => SUBSET.includes(r));
  return [...new Set(routes)];
}

async function main() {
  const routes = loadRoutes();
  if (!routes.length) {
    console.error(`verify-content-fidelity: no routes (manifest ${MANIFEST} / snapshots ${SNAPSHOTS}).`);
    process.exit(2);
  }
  const results = [];
  let identical = 0;
  let diverged = 0;
  let skipped = 0;

  for (const route of routes) {
    const slug = routeToSlug(route);
    const snapPath = path.join(SNAPSHOTS, `${slug}.html`);
    if (!existsSync(snapPath)) { skipped++; results.push({ route, status: 'skipped', reason: 'no snapshot' }); continue; }

    const orig = textTokens(readFileSync(snapPath, 'utf8'));
    const url = new URL(route, BASE).href;
    const res = await fetchHtml(url);
    if (res.status === 0 || res.status >= 400) {
      diverged++;
      results.push({ route, status: 'error', http: res.status, origTokens: orig.length });
      continue;
    }
    const clone = textTokens(res.body);

    let k = 0;
    while (k < orig.length && k < clone.length && orig[k] === clone[k]) k++;
    const isIdentical = k >= orig.length && k >= clone.length;
    if (isIdentical) {
      identical++;
      results.push({ route, status: 'identical', tokens: orig.length });
    } else {
      diverged++;
      const divergences = [];
      // collect up to MAX_DIV first-divergence windows (re-sync naively by advancing both)
      let a = k;
      let b = k;
      while (divergences.length < MAX_DIV && (a < orig.length || b < clone.length)) {
        divergences.push({
          at: a,
          orig: orig.slice(Math.max(0, a - 1), a + 3),
          clone: clone.slice(Math.max(0, b - 1), b + 3),
        });
        // crude resync: skip one token on the longer side, else both
        if (orig.length - a > clone.length - b) a++;
        else if (clone.length - b > orig.length - a) b++;
        else { a++; b++; }
        while (a < orig.length && b < clone.length && orig[a] !== clone[b]) { a++; b++; }
        while (a < orig.length && b < clone.length && orig[a] === clone[b]) { a++; b++; }
        if (a >= orig.length && b >= clone.length) break;
      }
      results.push({ route, status: 'diverged', origTokens: orig.length, cloneTokens: clone.length, firstDivergeAt: k, divergences });
    }
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  const report = { base: BASE, total: routes.length, identical, diverged, skipped, results };
  writeFileSync(OUT, JSON.stringify(report, null, 2));

  // console summary
  for (const r of results) {
    if (r.status === 'identical') console.log(`✓ ${r.route}  (${r.tokens} tokens)`);
    else if (r.status === 'skipped') console.log(`· ${r.route}  skipped (${r.reason})`);
    else if (r.status === 'error') console.log(`✗ ${r.route}  HTTP ${r.http} (orig ${r.origTokens} tokens)`);
    else {
      console.log(`✗ ${r.route}  orig=${r.origTokens} clone=${r.cloneTokens} diverge@${r.firstDivergeAt}`);
      for (const d of r.divergences) {
        console.log(`    orig:  ${JSON.stringify(d.orig)}`);
        console.log(`    clone: ${JSON.stringify(d.clone)}`);
      }
    }
  }
  console.log(`\nverify-content-fidelity: ${identical}/${routes.length - skipped} routes text-identical` +
    (skipped ? ` (${skipped} skipped, no snapshot)` : '') + ` · report → ${OUT}`);

  process.exit(diverged > 0 ? 1 : 0);
}

main();
