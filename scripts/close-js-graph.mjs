#!/usr/bin/env node

/**
 * close-js-graph.mjs — transitive ESM import-graph closer for Astro / Vite / SvelteKit
 * sites. Implements the SKILL "ESM-module sites" step:
 *
 *   "Re-host the JS graph TRANSITIVELY. The HTML only lists the per-component entry
 *    scripts; the shared chunks (gsap, ScrollTrigger, SplitText, custom eases) appear
 *    only as `import … from "./X.js"` INSIDE those bundles. Fetch every entry, then
 *    recursively fetch every relative import it pulls until the graph closes — miss this
 *    and nothing animates."
 *
 * Entry points are read from:
 *   --manifest <path>  src/generated/manifest.json written by slice-routes.mjs.
 *                      Union of every externalScripts[].src across all routes that is
 *                      same-origin (matching --origin) and ends in .js or .mjs.
 *   --entry <url>...   One or more explicit entry-point URLs (repeatable flag).
 *   Both flags may be combined; entries are deduped before fetching starts.
 *
 * For each fetched module:
 *   1. Extract all RELATIVE import specifiers (starting with ./ or ../) from:
 *        static   import { x } from "./y.js"
 *        side-fx  import "./y.js"
 *        re-export export { x } from "./y.js"
 *        dynamic  import("./y.js")  or  import('./y.js')
 *      Bare specifiers (e.g. "gsap") and absolute URLs are intentionally ignored —
 *      bare specifiers are npm packages that don't exist as fetchable paths, and
 *      absolute URLs are handled by their own origin rules.
 *   2. Resolve each relative specifier against that module's own URL.
 *   3. If the resolved URL has not been visited yet, enqueue it.
 *   4. Download the module to --out preserving the origin pathname (same rule as
 *      download-assets.mjs deriveDest) so the already-ported HTML references work.
 *
 * Flags:
 *   --manifest <path>     Path to src/generated/manifest.json (default: src/generated/manifest.json)
 *   --entry <url>         Extra entry-point URL (repeatable)
 *   --origin <origin>     Scheme+host used to filter manifest entries (e.g. https://site.com).
 *                         Auto-detected from the first --entry URL when not supplied.
 *   --out <dir>           Output ROOT (default: public). deriveDest appends the origin
 *                         pathname, so /_astro/X.js → public/_astro/X.js. Do NOT pass
 *                         public/_astro — that double-nests to public/_astro/_astro/X.js.
 *   --referer <url>       Value for the Referer header (pass the original site origin to
 *                         beat hotlink-protection; see download-assets.mjs notes)
 *   --batch <n>           Max parallel in-flight fetches (default: 8)
 *   --dry-run             Print the seed entries that would be fetched; no writes (does
 *                         NOT recurse the transitive graph — it can't read sources without fetching)
 *
 * Usage (from the clone workspace root):
 *   node scripts/close-js-graph.mjs --manifest src/generated/manifest.json --origin https://site.com
 *   node scripts/close-js-graph.mjs --entry https://site.com/_astro/main.Abc123.js   # --out defaults to public
 *   node scripts/close-js-graph.mjs --entry https://site.com/_astro/x.js --entry https://site.com/_astro/y.js
 *
 * EXPORT: extractImports(jsSource: string) → string[]
 *   Returns the list of relative import specifiers in jsSource (those starting with
 *   ./ or ../). Safe to import from other scripts; the main() runner is guard-gated.
 *
 * Pure Node built-ins. Zero new dependencies.
 */

import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const getFlag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const getFlags = (name) => {
  // Collect every occurrence of a repeatable flag (e.g. --entry url1 --entry url2).
  const values = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name && args[i + 1] && !args[i + 1].startsWith('--')) {
      values.push(args[i + 1]);
    }
  }
  return values;
};
const has = (name) => args.includes(name);

const WS = process.cwd();
const MANIFEST_PATH = getFlag('--manifest', 'src/generated/manifest.json');
const ENTRY_FLAGS = getFlags('--entry');
// Default 'public' — NOT 'public/_astro'. deriveDest mirrors the FULL origin pathname
// (which already starts with /_astro/ or /_next/), so OUT must be the public root or the
// path double-nests (public/_astro/_astro/X.js → transitive shared-chunk 404s → dead
// animations). Same rule and default as download-assets.mjs.
const OUT = getFlag('--out', 'public');
const REFERER = getFlag('--referer', null);
const DRY = has('--dry-run');
// 8 parallel fetches: less aggressive than download-assets.mjs (16) because JS bundles
// are typically larger and we're doing recursive sequential resolution per-module.
const BATCH = Number(getFlag('--batch', '8')) || 8;

// Real browser UA — CDNs 403 the default fetch UA (identical strategy to download-assets.mjs).
const UA = getFlag('--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
const HEADERS = { 'User-Agent': UA, ...(REFERER ? { Referer: REFERER } : {}) };

// ---------------------------------------------------------------------------
// EXPORTED pure function — extractImports(jsSource) → string[]
//
// Matches relative import/export/dynamic-import specifiers. Only relative paths
// (starting with ./ or ../) are returned; bare specifiers and absolute URLs are
// excluded by design (bare = npm packages not fetchable by URL; absolute = cross-
// origin, handled separately).
//
// Patterns covered:
//   import x from "./x.js"
//   import { x } from './x.js'
//   import "./x.js"
//   export { x } from "./x.js"
//   export * from "./x.js"
//   export * as ns from "./x.js"
//   import("./x.js")
//   import('./x.js')
// ---------------------------------------------------------------------------
export function extractImports(jsSource) {
  const specifiers = new Set();

  // Strip comments first so a commented-out `// import "./old.js"` or block-commented
  // code can't produce false-positive specifiers (which would 404 and fail the run).
  // The `[^:]` guard keeps `https://…` inside string literals intact.
  const code = '\n' + jsSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  // Static and re-export forms:
  //   import [anything] from "specifier"
  //   import "specifier"
  //   export [anything] from "specifier"
  // The `import`/`export` keyword must sit at a STATEMENT boundary (preceded by ;}{ or a
  // newline — the leading "\n" above anchors a file-start import). This excludes the keyword
  // appearing INSIDE a string literal (e.g. a baked error message "cannot import from './x'"),
  // which previously produced a phantom specifier → 404 → pipeline exit(1).
  const staticRe = /(?<=[;}{\n])\s*(?:import|export)\b[^"'`]*?(?:from\s*)?["'](\.[^"'`]+)["']/g;
  let m;
  while ((m = staticRe.exec(code)) !== null) {
    const spec = m[1].trim();
    if (spec.startsWith('./') || spec.startsWith('../')) specifiers.add(spec);
  }

  // Dynamic import: import("./x.js") or import('./x.js'). `import` here is an expression, so it
  // can't require a statement boundary — instead reject when preceded by a quote/identifier
  // char (excludes `"import('./x')"` in a string and `_import(`).
  // Template-literal dynamic imports are intentionally skipped (can't resolve statically).
  const dynRe = /(?<!["'`\w$.])import\s*\(\s*["'](\.[^"'`]+)["']\s*\)/g;
  while ((m = dynRe.exec(code)) !== null) {
    const spec = m[1].trim();
    if (spec.startsWith('./') || spec.startsWith('../')) specifiers.add(spec);
  }

  return [...specifiers];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Derive local output path from a URL (mirrors download-assets.mjs deriveDest). */
function deriveDest(url) {
  const u = new URL(url);
  const pathname = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  return join(WS, OUT, pathname || 'index.js');
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** Fetch one module URL and return its text (or null on error). */
async function fetchModule(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === 1) {
        process.stderr.write(`  FAILED      ${url} — ${err.message}\n`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Walk the graph BFS-style, fetching up to BATCH modules concurrently.
 * Returns an array of result records.
 */
async function closeGraph(seeds) {
  const visited = new Set();   // URLs already downloaded or queued
  const queue = [...seeds];    // URLs waiting to be fetched
  const results = [];

  // Seed the visited set so we don't re-download entries already on disk.
  for (const url of seeds) visited.add(url);

  while (queue.length > 0) {
    const batch = queue.splice(0, BATCH);
    await Promise.all(batch.map(async (url) => {
      const dest = deriveDest(url);

      if (!DRY && await exists(dest)) {
        // Capture the record BEFORE the async gap — under Promise.all another task can
        // push to `results` in between, so results[results.length-1] would be the wrong one.
        const rec = { url, localPath: dest, status: 'exists', newImports: 0 };
        results.push(rec);
        // Even if the file already exists, parse its imports to close the graph (a prior
        // run may have fetched it but not its transitive deps).
        let source;
        try { source = await readFile(dest, 'utf8'); } catch { source = null; }
        if (source) {
          const specs = extractImports(source);
          let enqueued = 0;
          for (const spec of specs) {
            const resolved = new URL(spec, url).href;
            if (!visited.has(resolved)) {
              visited.add(resolved);
              queue.push(resolved);
              enqueued++;
            }
          }
          rec.newImports = enqueued;
        }
        return;
      }

      if (DRY) {
        results.push({ url, localPath: dest, status: 'dry-run', newImports: 0 });
        // In dry-run we can't read the source, so we can't recurse further.
        return;
      }

      const source = await fetchModule(url);
      if (source === null) {
        results.push({ url, localPath: dest, status: 'failed', newImports: 0 });
        return;
      }

      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, source, 'utf8');

      const specs = extractImports(source);
      let enqueued = 0;
      for (const spec of specs) {
        const resolved = new URL(spec, url).href;
        if (!visited.has(resolved)) {
          visited.add(resolved);
          queue.push(resolved);
          enqueued++;
        }
      }

      results.push({ url, localPath: dest, status: 'downloaded', newImports: enqueued });
      process.stderr.write(`  downloaded   ${url}  (${specs.length} imports, ${enqueued} new)\n`);
    }));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Entry-point collection helpers
// ---------------------------------------------------------------------------

/** Read manifest.json and return same-origin .js/.mjs entry URLs. */
async function entriesFromManifest(manifestPath, origin) {
  let raw;
  try {
    raw = await readFile(join(WS, manifestPath), 'utf8');
  } catch (err) {
    process.stderr.write(`close-js-graph: cannot read manifest at ${manifestPath} — ${err.message}\n`);
    return [];
  }

  let manifest;
  try { manifest = JSON.parse(raw); } catch (err) {
    process.stderr.write(`close-js-graph: manifest JSON parse error — ${err.message}\n`);
    return [];
  }

  // The manifest produced by slice-routes.mjs has a `paths` map (routePath → slug).
  // The per-route detail files live at src/generated/routes/<slug>.json.
  // We read each route JSON to get its externalScripts.
  const routeDir = join(WS, dirname(manifestPath), 'routes');
  const urls = new Set();

  for (const slug of Object.values(manifest.paths || {})) {
    let routeData;
    try {
      const routeRaw = await readFile(join(routeDir, slug + '.json'), 'utf8');
      routeData = JSON.parse(routeRaw);
    } catch {
      continue; // Skip missing or malformed route files gracefully.
    }
    for (const { src } of routeData.externalScripts || []) {
      if (!src) continue;
      // Resolve relative src values against the origin (some manifests use /path, others full URLs).
      let abs;
      try { abs = new URL(src, origin + '/').href; } catch { continue; }
      if (origin && !abs.startsWith(origin)) continue;  // cross-origin: skip
      if (!/\.(mjs|js)(\?.*)?$/.test(abs)) continue;    // only JS modules
      urls.add(abs.split('?')[0]); // drop query strings — the file content is the same
    }
  }

  return [...urls];
}

// ---------------------------------------------------------------------------
// Main (guard-gated for importability)
// ---------------------------------------------------------------------------

async function main() {
  // --- Collect entries ---
  const explicitEntries = ENTRY_FLAGS.filter((u) => {
    try { new URL(u); return true; } catch { return false; }
  });

  // Auto-detect origin from explicit entries when --origin is not supplied.
  let ORIGIN = getFlag('--origin', null);
  if (!ORIGIN && explicitEntries.length > 0) {
    try { ORIGIN = new URL(explicitEntries[0]).origin; } catch { /* ignore */ }
  }

  // Origin is required: manifest src values are often root-relative (/_astro/x.js) and
  // the entry filter is origin-scoped, so an empty origin silently resolves nothing.
  // It is auto-detected from a full-URL --entry above; otherwise demand it explicitly.
  if (!ORIGIN) {
    process.stderr.write(
      'close-js-graph: --origin <https://site.com> is required (or pass a full-URL --entry to auto-detect it).\n'
    );
    process.exit(2);
  }

  // Always attempt the manifest (default path) — entriesFromManifest returns [] gracefully
  // if the file is absent — and union it with any explicit --entry URLs.
  const manifestEntries = await entriesFromManifest(MANIFEST_PATH, ORIGIN);

  const allEntries = [...new Set([...manifestEntries, ...explicitEntries])];

  if (allEntries.length === 0) {
    process.stderr.write(
      'close-js-graph: no same-origin .js/.mjs entries found. ' +
      'Pass --entry <url> or check --manifest / --origin.\n'
    );
    process.exit(1);
  }

  process.stderr.write(
    `close-js-graph: ${allEntries.length} seed(s), batch=${BATCH}` +
    (DRY ? ', DRY RUN' : '') + '\n'
  );

  const results = await closeGraph(allEntries);

  const tally = results.reduce((acc, r) => {
    const k = r.status === 'downloaded' ? 'downloaded'
      : r.status === 'exists' ? 'skipped(exists)'
      : r.status === 'failed' ? 'failed'
      : r.status === 'dry-run' ? 'dry-run'
      : 'other';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  process.stderr.write(`\nclose-js-graph: ${JSON.stringify(tally)} — ${results.length} module(s) total\n`);

  const failed = results.filter((r) => r.status === 'failed').length;
  process.exit(failed > 0 ? 1 : 0);
}

// Guard so the file is importable (for tests and other scripts using extractImports).
// process.argv[1] is undefined when the module is loaded via --input-type=module or
// dynamic import() without a file path, so guard before calling pathToFileURL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`close-js-graph: ${e.message}\n`); process.exit(2); });
}
