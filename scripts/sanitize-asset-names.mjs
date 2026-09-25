#!/usr/bin/env node

/**
 * sanitize-asset-names.mjs — fix asset filenames Next.js can't serve.
 *
 * Next reserves "()" in URL path segments (route groups), so a public/ asset like
 * "ai-hero (1).avif" 404s when requested as ".../ai-hero%20(1).avif" (plain spaces
 * are fine; the parens are the problem). This renames such files (strip parens,
 * spaces → dashes) and rewrites every reference to them in the ported markup + CSS.
 *
 * Driven by the KNOWN asset URL list (not on-disk state) so it stays correct and
 * idempotent even if the extractor re-runs and restores parenthesised refs.
 *
 * Run from the clone workspace root, AFTER assets are downloaded:
 *   node scripts/sanitize-asset-names.mjs
 *   node scripts/sanitize-asset-names.mjs --urls docs/research/asset-urls-all.txt --public public
 *
 * Rewrites references in the ported markup (src/content recursive .html), the
 * markup-port route JSON (src/generated/routes/*.json — where the sliced bodyHTML
 * lives), and src/app/globals.css. Add more targets with --rewrite-glob <dirs/files>.
 *
 * Pure Node fs. Zero new dependencies. No-op (exit 0) if the URL list is absent or
 * has no parenthesised filenames.
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, flag('--public', 'public'));
const LIST = path.join(ROOT, flag('--urls', 'docs/research/asset-urls-all.txt'));

const sanitizeBase = (name) => name.replace(/\s*\(/g, '-').replace(/\)/g, '').replace(/\s+/g, '-');
const stripHost = (u) => u.replace(/^https?:\/\/[^/]+/, '');

if (!fs.existsSync(LIST)) {
  console.error(`sanitize: no URL list at ${LIST} (pass --urls). Nothing to do.`);
  process.exit(0);
}
const urls = fs.readFileSync(LIST, 'utf8').trim().split('\n').filter(Boolean);

const replacements = [];
let renamed = 0;
for (const url of urls) {
  const decodedPath = decodeURIComponent(stripHost(url)); // /dir/name (1).avif
  const base = path.basename(decodedPath);
  if (!/[()]/.test(base)) continue;
  const newBase = sanitizeBase(base);
  if (newBase === base) continue;

  const dir = path.dirname(decodedPath);
  const oldFile = path.join(PUBLIC, decodedPath);
  const newFile = path.join(PUBLIC, dir, newBase);
  if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) { fs.renameSync(oldFile, newFile); renamed++; }
  // rewrite both the decoded ("name (1)") and the %20-encoded form of the basename
  replacements.push([base, newBase]);
  replacements.push([base.replace(/ /g, '%20'), newBase]);
}

// Source files to rewrite: ported HTML content (recursive) + globals.css + any extras.
const walkFiles = (dir, out, exts = ['.html']) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out, exts);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
};
const targets = [];
walkFiles(path.join(ROOT, 'src/content'), targets);                       // rebuild path: ported HTML
walkFiles(path.join(ROOT, 'src/generated/routes'), targets, ['.json']);   // markup-port path: sliced bodyHTML lives in the route JSON — miss this and paren-asset refs 404
const css = path.join(ROOT, 'src/app/globals.css');
if (fs.existsSync(css)) targets.push(css);
const extra = flag('--rewrite-glob', null);
if (extra) for (const d of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
  const p = path.join(ROOT, d);
  if (!fs.existsSync(p)) continue;
  if (fs.statSync(p).isDirectory()) walkFiles(p, targets, ['.html', '.json']); else targets.push(p);
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rewriteFile = (file) => {
  let s = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const [from, to] of replacements) {
    // Only rewrite the basename in a URL CONTEXT — preceded by a path separator, a quote, or
    // a `url(` opener. A bare split/join replaced the filename ANYWHERE, so a basename that
    // happened to equal a word/phrase in the page body text got silently rewritten too.
    const re = new RegExp('([/"\'(])' + escRe(from), 'g');
    const next = s.replace(re, (_m, boundary) => { changed = true; return boundary + to; });
    s = next;
  }
  if (changed) fs.writeFileSync(file, s);
  return changed;
};

let touched = 0;
for (const f of [...new Set(targets)]) if (rewriteFile(f)) touched++;

console.log(`sanitize: renamed ${renamed} files, rewrote ${touched} source files (${replacements.length / 2} paren-assets)`);
