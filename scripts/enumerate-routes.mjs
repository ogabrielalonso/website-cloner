#!/usr/bin/env node

/**
 * enumerate-routes.mjs — deterministic sitemap → route list.
 *
 * Implements Decision 1 ("curl sitemap.xml") from the SKILL as a committed,
 * auditable script so the orchestrator never writes a one-off fetcher per clone.
 *
 * Strategy (tried in order, first success wins):
 *   1. <origin>/sitemap.xml
 *   2. <origin>/sitemap-0.xml   (paginated Astro / Next default)
 *   3. <origin>/sitemap_index.xml
 *
 * If the fetched document is a sitemap INDEX (<sitemapindex>), every child
 * <loc> is followed and all <url> entries are merged.  Only same-origin URLs
 * survive; each is reduced to path-only, deduped, and sorted lexicographically.
 *
 * Output:
 *   docs/research/routes.txt  — one route per line (or --out <path>)
 *   stderr                    — running log + final count
 *
 * Flags:
 *   --origin <url>   Explicit origin (scheme+host only; trailing slash ignored).
 *                    Absent → read source_input from docs/research/.template-snapshot
 *                    (same contract as css-collector.mjs).
 *   --out    <path>  Output file (default: docs/research/routes.txt).
 *   --file   <path>  Parse a LOCAL xml file instead of fetching — useful for
 *                    offline tests or when you've already saved a sitemap.
 *
 * Exports:
 *   parseSitemap(xml, origin) → string[]   Pure function — routes, deduped, sorted.
 *   fetchSitemap(origin)      → string[]   Fetch+parse pipeline, all probes + index
 *                                          following included.
 *
 * Usage (from the clone workspace root):
 *   node scripts/enumerate-routes.mjs
 *   node scripts/enumerate-routes.mjs --origin https://site.com
 *   node scripts/enumerate-routes.mjs --origin https://site.com --out docs/research/routes.txt
 *   node scripts/enumerate-routes.mjs --file /tmp/sitemap.xml --origin https://site.com
 *
 * Pure Node built-ins. Zero new dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

// Browser UA — some CDNs refuse the default Node/fetch UA (hotlink protection).
const UA = flag('--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');

// Some sitemap generators wrap <loc> values in CDATA: <loc><![CDATA[https://…]]></loc>.
const stripCdata = (s) => s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();

// ─── Helpers ────────────────────────────────────────────────────────────────

function readOriginFromSnapshot() {
  const WS = process.cwd();
  const snap = path.join(WS, 'docs/research/.template-snapshot');
  try {
    const m = fs.readFileSync(snap, 'utf8').match(/source_input=(\S+)/);
    if (m) return new URL(m[1]).origin;
  } catch { /* none */ }
  return null;
}

/**
 * parseSitemap(xml, origin) → string[]
 *
 * Pure parser — no I/O. Handles both regular sitemaps (<urlset>) and sitemap
 * indexes (<sitemapindex>). For a sitemap index it returns the child <loc>
 * values (which fetchSitemap will then follow); for a regular sitemap it
 * returns the page <loc> values.
 *
 * Filtering: keeps only same-origin URLs, strips query+hash, returns path-only
 * routes (deduplicated, sorted).
 *
 * NOTE: "origin" must be the full scheme+host (e.g. "https://example.com").
 */
export function parseSitemap(xml, origin) {
  // Normalise origin: strip trailing slash, lower-case scheme+host.
  const normOrigin = new URL(origin).origin; // throws if invalid — intentional

  // Detect index vs regular sitemap.
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const tag = isIndex ? 'sitemap' : 'url';

  // Extract all <loc>…</loc> values inside the target tag blocks.
  const locRe = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<loc>\\s*([\\s\\S]*?)\\s*<\\/loc>[\\s\\S]*?<\\/${tag}>`, 'gi');
  const locs = [];
  let m;
  while ((m = locRe.exec(xml))) locs.push(stripCdata(m[1].trim()));

  // Fallback: bare <loc> scan (some generators emit them outside tag wrappers).
  if (locs.length === 0) {
    const bareRe = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
    while ((m = bareRe.exec(xml))) locs.push(stripCdata(m[1].trim()));
  }

  // Filter to same-origin, reduce to path-only, dedupe, sort.
  const seen = new Set();
  const routes = [];
  for (const raw of locs) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (u.origin !== normOrigin) continue;
    const route = u.pathname; // path-only (no query, no hash, no origin)
    if (seen.has(route)) continue;
    seen.add(route);
    routes.push(route);
  }
  routes.sort();
  return routes;
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * fetchSitemap(origin) → string[]
 *
 * Probes the three standard sitemap paths in order and returns the final
 * deduplicated, sorted route list for the origin.  Sitemap indexes are
 * followed one level deep (each child loc is fetched and parsed).
 */
export async function fetchSitemap(origin) {
  const normOrigin = new URL(origin).origin;
  const probes = [
    `${normOrigin}/sitemap.xml`,
    `${normOrigin}/sitemap-0.xml`,
    `${normOrigin}/sitemap_index.xml`,
  ];

  let xml = null;
  let usedUrl = null;
  for (const probe of probes) {
    try {
      process.stderr.write(`enumerate-routes: probing ${probe} …\n`);
      const candidate = await fetchText(probe);
      // A 200 with zero <loc> entries is a tombstone (e.g. Vaultix /sitemap.xml).
      // Treat it as a miss and continue to the next probe so we don't skip a
      // sibling path that actually contains routes (e.g. /sitemap-0.xml).
      const isIndex = /<sitemapindex[\s>]/i.test(candidate);
      const earlyRoutes = parseSitemap(candidate, normOrigin);
      if (!isIndex && earlyRoutes.length === 0) {
        process.stderr.write(`enumerate-routes: ${probe} → 200 but 0 routes; continuing to next probe …\n`);
        continue;
      }
      xml = candidate;
      usedUrl = probe;
      process.stderr.write(`enumerate-routes: found sitemap at ${probe}\n`);
      break;
    } catch (err) {
      process.stderr.write(`enumerate-routes: ${probe} → ${err.message}\n`);
    }
  }

  if (!xml) {
    throw new Error('enumerate-routes: no sitemap found at any of the three probe paths.');
  }

  const isIndex = /<sitemapindex[\s>]/i.test(xml);

  if (!isIndex) {
    // Regular sitemap — parse directly.
    const routes = parseSitemap(xml, normOrigin);
    process.stderr.write(`enumerate-routes: ${routes.length} route(s) parsed from ${usedUrl}\n`);
    return routes;
  }

  // Sitemap index — follow each child <loc>.
  process.stderr.write('enumerate-routes: document is a sitemap INDEX — following child sitemaps …\n');
  // Child sitemap <loc>s may live on the same origin (usual) or a CDN; extract the
  // full absolute URLs raw (parseSitemap would strip them to same-origin paths).
  const rawChildLocs = [];
  const rawRe = /<sitemap[\s\S]*?<loc>\s*([\s\S]*?)\s*<\/loc>[\s\S]*?<\/sitemap>/gi;
  let rm;
  while ((rm = rawRe.exec(xml))) rawChildLocs.push(stripCdata(rm[1].trim()));

  const seen = new Set();
  const all = [];
  for (const childUrl of rawChildLocs) {
    try {
      process.stderr.write(`enumerate-routes: fetching child sitemap ${childUrl} …\n`);
      const childXml = await fetchText(childUrl);
      const childRoutes = parseSitemap(childXml, normOrigin);
      for (const r of childRoutes) {
        if (!seen.has(r)) { seen.add(r); all.push(r); }
      }
      process.stderr.write(`enumerate-routes: +${childRoutes.length} route(s) from ${childUrl}\n`);
    } catch (err) {
      process.stderr.write(`enumerate-routes: WARNING — child sitemap ${childUrl} failed: ${err.message}\n`);
    }
  }

  all.sort();
  process.stderr.write(`enumerate-routes: ${all.length} total route(s) after merging all child sitemaps\n`);
  return all;
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

async function main() {
  const WS = process.cwd();
  const localFile = flag('--file');
  const outRel = flag('--out', 'docs/research/routes.txt');
  const outAbs = path.resolve(WS, outRel);

  // Resolve origin.
  let rawOrigin = flag('--origin');
  if (!rawOrigin) rawOrigin = readOriginFromSnapshot();
  if (!rawOrigin) {
    process.stderr.write(
      'enumerate-routes: no origin (pass --origin https://site.com, or run from a' +
      ' workspace with docs/research/.template-snapshot).\n'
    );
    process.exit(2);
  }

  let origin;
  try { origin = new URL(rawOrigin).origin; }
  catch {
    process.stderr.write(`enumerate-routes: invalid origin "${rawOrigin}"\n`);
    process.exit(2);
  }

  let routes;

  if (localFile) {
    // --file mode: parse a local XML without fetching anything.
    const absFile = path.resolve(WS, localFile);
    if (!fs.existsSync(absFile)) {
      process.stderr.write(`enumerate-routes: --file "${absFile}" not found\n`);
      process.exit(1);
    }
    const xml = fs.readFileSync(absFile, 'utf8');
    // A sitemap INDEX lists child SITEMAP urls, not page routes. parseSitemap would return
    // those sitemap urls — writing them to routes.txt as if they were pages is silently wrong
    // (downstream fetches XML, slice-routes gets no <body>). Abort and print the children so the
    // operator can fetch each leaf and re-run --file on it (or use network mode, which follows).
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    if (isIndex) {
      const children = parseSitemap(xml, origin);
      process.stderr.write(
        'enumerate-routes: ERROR — --file is a sitemap INDEX (lists child sitemaps, not pages).\n' +
        '  Fetch each child sitemap and run --file on it, or run without --file to follow them:\n' +
        children.map((c) => `    ${c}`).join('\n') + '\n'
      );
      process.exit(2);
    }
    routes = parseSitemap(xml, origin);
    process.stderr.write(`enumerate-routes: parsed ${routes.length} route(s) from ${absFile}\n`);
  } else {
    try {
      routes = await fetchSitemap(origin);
    } catch (err) {
      process.stderr.write(`enumerate-routes: FATAL — ${err.message}\n`);
      process.exit(1);
    }
  }

  if (routes.length === 0) {
    process.stderr.write('enumerate-routes: WARNING — 0 routes found; routes.txt will be empty.\n');
  }

  // Write output file.
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, routes.join('\n') + (routes.length ? '\n' : ''), 'utf8');

  process.stderr.write(`\nenumerate-routes: ${routes.length} route(s) → ${path.relative(WS, outAbs)}\n`);
}

// isMain guard — allows importing parseSitemap / fetchSitemap in tests without
// triggering the CLI side-effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`enumerate-routes: ${e.message}\n`); process.exit(2); });
}
