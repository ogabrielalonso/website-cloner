#!/usr/bin/env node

/**
 * extract-asset-urls.mjs — deterministic "grep src=/srcset=/url()" asset-URL floor
 * for markup-port sites. Produces the complete asset URL list that
 * sanitize-asset-names.mjs and download-assets.mjs consume.
 *
 * WHY: Once every route's raw HTML and stylesheets are on disk, you don't need a live
 * browser session to enumerate assets — a pure regex scan is faster, reproducible, and
 * catches every variant including srcset candidates and CSS background-images.  This is
 * the "deterministic grep" step called out in the SKILL's Phase 2 "Asset Discovery"
 * note: "once you've saved every route's raw HTML + the stylesheets to disk, the
 * fastest complete pass is a deterministic grep of src=, srcset=, and url(…) across
 * those files (resolve to absolute, dedupe)".  Reserve live list_network_requests for
 * dynamically-loaded assets that only appear at runtime.
 *
 * Scans every *.html file under --html-dir and every *.css file under --css-dir:
 *   HTML: src="…"  and  srcset="url 1x, url2 2x"
 *   CSS:  url(…) including balanced-paren Webflow filenames like url(hero (1).avif)
 *         (strips only a trailing unbalanced ")" — the url() closer — per the gotcha
 *         documented in the SKILL's Webflow section).
 *
 * Each URL is resolved to absolute via --origin (falls back to .template-snapshot).
 * Keeps http(s), root-relative (/…), and relative (…) refs; skips data: and blob:.
 * Output is deduped, sorted, one URL per line — ready for sanitize-asset-names.mjs and
 * download-assets.mjs.
 *
 * Usage (from the clone workspace root):
 *   node scripts/extract-asset-urls.mjs
 *   node scripts/extract-asset-urls.mjs --origin https://site.com
 *   node scripts/extract-asset-urls.mjs --html-dir docs/research/raw-html \
 *       --css-dir docs/research/css --out docs/research/asset-urls-all.txt
 *
 * Exports (importable for tests — guarded by isMain):
 *   extractFromHtml(str, base)  → string[]  absolute URLs from src= / srcset=
 *   extractFromCss(str, base)   → string[]  absolute URLs from url(…)
 *
 * Pure Node built-ins. Zero new dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

// ---------------------------------------------------------------------------
// Core extraction helpers — exported so fixture tests can import them.
// ---------------------------------------------------------------------------

/**
 * Resolve a raw URL token to an absolute https URL.
 * Returns null for data:, blob:, empty strings, and anything un-parseable.
 * @param {string} raw   - the raw URL string extracted from markup/CSS
 * @param {string} base  - absolute base URL to resolve relative refs against
 * @returns {string|null}
 */
function resolveUrl(raw, base) {
  if (!raw) return null;
  raw = raw.trim();
  if (!raw) return null;
  // skip data URIs and blob URLs — they are inline/ephemeral, not downloadable assets
  if (/^data:/i.test(raw) || /^blob:/i.test(raw)) return null;
  // skip CSS functional values used inside url() — url(var(--x)), env(), calc(), image-set()…
  // and gradients. new URL() would happily build https://site/var(--x) → a guaranteed 404 that
  // makes download-assets exit non-zero and blocks the pipeline.
  if (/^[a-z-]+\(/i.test(raw)) return null;
  // skip fragment-only refs (url(#mask) — same-document SVG filter/clip) and CSS keywords
  if (raw.startsWith('#')) return null;
  if (/^(none|auto|inherit|initial|unset|revert|normal|currentcolor)$/i.test(raw)) return null;
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

/**
 * Yield the raw inner token of every `url(…)` in a string, paren-depth-aware so
 * balanced-paren filenames (`url(hero (1).avif)`) survive intact and quotes are stripped.
 * Shared by extractFromHtml and extractFromCss so BOTH handle the Webflow paren case — the
 * HTML path previously used a `[^)]*` regex that truncated `hero (1).avif` to `hero (1`.
 * @param {string} str
 * @returns {string[]} raw url() inner tokens (unresolved)
 */
function scanUrlTokens(str) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    const idx = str.indexOf('url(', i);
    if (idx === -1) break;
    let j = idx + 4;
    let depth = 1;
    while (j < str.length && depth > 0) {
      if (str[j] === '(') depth++;
      else if (str[j] === ')') depth--;
      if (depth > 0) j++;
      else break;
    }
    let raw = str.slice(idx + 4, j).trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    } else {
      const opens = (raw.match(/\(/g) || []).length;
      const closes = (raw.match(/\)/g) || []).length;
      if (closes > opens) raw = raw.slice(0, raw.lastIndexOf(')')).trimEnd();
    }
    out.push(raw.trim());
    i = j + 1;
  }
  return out;
}

/**
 * Extract absolute asset URLs from an HTML string.
 * Handles:
 *   src="…"       — images, scripts, iframes, video posters, etc.
 *   srcset="u1 1x, u2 2x"  — responsive image candidates (splits on comma, takes
 *                             the URL token before any optional descriptor).
 *
 * @param {string} str   - raw HTML content
 * @param {string} base  - absolute base URL (e.g. "https://site.com/")
 * @returns {string[]}   - deduped absolute URLs (not globally deduped — caller dedupes)
 */
export function extractFromHtml(str, base) {
  const found = new Set();

  // src="…" or src='…'
  const srcRe = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let m;
  while ((m = srcRe.exec(str))) {
    const url = resolveUrl(m[1] ?? m[2], base);
    if (url) found.add(url);
  }

  // srcset="url1 1x, url2 2x" — each comma-separated candidate is "url [descriptor]"
  const srcsetRe = /\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = srcsetRe.exec(str))) {
    const raw = m[1] ?? m[2];
    for (const candidate of raw.split(',')) {
      // A srcset candidate is "url [width/density descriptor]"; the URL is the first
      // whitespace-delimited token.
      const token = candidate.trim().split(/\s+/)[0];
      const url = resolveUrl(token, base);
      if (url) found.add(url);
    }
  }

  // url(...) anywhere in the HTML — inline style="background-image:url(…)" and head
  // <style> blocks. Page-builder sites (Divi, Elementor) put backgrounds here with
  // ZERO <img> tags, so src/srcset alone would miss every hero/parallax image. Use the
  // shared paren-depth scanner so `url(hero (1).avif)` isn't truncated at the inner ")".
  for (const raw of scanUrlTokens(str)) {
    const url = resolveUrl(raw, base);
    if (url) found.add(url);
  }

  return [...found];
}

/**
 * Extract absolute asset URLs from a CSS string.
 * Handles url(…) with or without quotes, and the balanced-paren Webflow filename
 * case: url(hero (1).avif)  — the outer ")" is the CSS url() closer, NOT part of
 * the filename; the inner "(" and its matching ")" are part of the filename.
 *
 * Strategy: capture the entire url( content by tracking paren depth, then strip
 * optional surrounding quotes, then strip only a TRAILING unbalanced ")" (the one
 * depth-tracking reveals as the url() closer).
 *
 * @param {string} str   - raw CSS content
 * @param {string} base  - absolute base URL
 * @returns {string[]}
 */
export function extractFromCss(str, base) {
  const found = new Set();

  // Shared paren-depth scanner (handles balanced-paren Webflow filenames + quote stripping).
  for (const raw of scanUrlTokens(str)) {
    const url = resolveUrl(raw, base);
    if (url) found.add(url);
  }

  return [...found];
}

// ---------------------------------------------------------------------------
// CLI entry-point — only runs when executed directly, not when imported.
// ---------------------------------------------------------------------------

const isMain = import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : '');

if (isMain) {
  const WS = process.cwd();
  const HTML_DIR = path.join(WS, flag('--html-dir', 'docs/research/raw-html'));
  const CSS_DIR  = path.join(WS, flag('--css-dir',  'docs/research/css'));
  const OUT      = path.join(WS, flag('--out',       'docs/research/asset-urls-all.txt'));

  // Resolve origin: explicit flag > .template-snapshot > error
  function readOriginFromSnapshot() {
    const snap = path.join(WS, 'docs/research/.template-snapshot');
    try {
      const m = fs.readFileSync(snap, 'utf8').match(/source_input=(\S+)/);
      if (m) return new URL(m[1]).origin;
    } catch { /* none */ }
    return null;
  }
  const ORIGIN = flag('--origin', readOriginFromSnapshot());

  if (!ORIGIN) {
    console.error(
      'extract-asset-urls: no origin (pass --origin https://site.com, or run from a ' +
      'workspace with docs/research/.template-snapshot).'
    );
    process.exit(2);
  }

  const allUrls = new Set();
  let htmlFiles = 0;
  let cssFiles  = 0;

  // Scan HTML files
  if (fs.existsSync(HTML_DIR)) {
    for (const f of fs.readdirSync(HTML_DIR).filter((n) => n.endsWith('.html'))) {
      const fpath = path.join(HTML_DIR, f);
      const src = fs.readFileSync(fpath, 'utf8');
      // Derive the base URL from the slug (mirrors how css-collector/slice-routes do it)
      const slug = f.replace(/\.html$/, '');
      const routePath = slug === 'index' ? '/' : '/' + slug.split('__').join('/') + '/';
      const base = ORIGIN + routePath;
      for (const u of extractFromHtml(src, base)) allUrls.add(u);
      htmlFiles++;
    }
  } else {
    process.stderr.write(`extract-asset-urls: no HTML dir at ${HTML_DIR} — skipping HTML scan\n`);
  }

  // Scan CSS files
  if (fs.existsSync(CSS_DIR)) {
    for (const f of fs.readdirSync(CSS_DIR).filter((n) => n.endsWith('.css'))) {
      const fpath = path.join(CSS_DIR, f);
      const src = fs.readFileSync(fpath, 'utf8');
      // CSS url() refs are resolved relative to the stylesheet's own URL; for collected
      // sheets the origin is the best we can do (the filenames were renamed anyway).
      const base = ORIGIN + '/';
      for (const u of extractFromCss(src, base)) allUrls.add(u);
      cssFiles++;
    }
  } else {
    process.stderr.write(`extract-asset-urls: no CSS dir at ${CSS_DIR} — skipping CSS scan\n`);
  }

  if (htmlFiles === 0 && cssFiles === 0) {
    process.stderr.write(
      'extract-asset-urls: ⚠ WARNING — scanned 0 HTML and 0 CSS files. Did you save raw ' +
      'HTML (slice step) and run css-collector.mjs first? Output will be empty.\n'
    );
  }

  const sorted = [...allUrls].sort();

  // Write output
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, sorted.join('\n') + (sorted.length ? '\n' : ''), 'utf8');

  process.stderr.write(
    `\nextract-asset-urls: scanned ${htmlFiles} HTML file(s), ${cssFiles} CSS file(s)\n` +
    `  ${sorted.length} unique asset URL(s) → ${path.relative(WS, OUT)}\n` +
    `  Feed this list to sanitize-asset-names.mjs then download-assets.mjs.\n`
  );

  process.exit(0);
}
