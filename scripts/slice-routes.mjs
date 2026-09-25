#!/usr/bin/env node

/**
 * slice-routes.mjs — deterministic markup-port slicer for static / Astro / Vite /
 * SvelteKit exports. The biggest reusable piece of the markup-port path.
 *
 * For each raw HTML page saved to docs/research/raw-html/<slug>.html (where the slug
 * encodes the route: "/" → index, "/blog/x" → blog__x), emit
 * src/generated/routes/<slug>.json with everything the React shell + replay runtime
 * needs:
 *   - bodyHTML        : cleaned <body> inner HTML — executable <script> stripped, but
 *                       JSON data islands KEPT (frameworks read per-component data
 *                       from <script type="application/json">; stripping them freezes
 *                       switchers/carousels on their first state).
 *   - externalScripts : [{ src, type, attrs }] in document order. Replay these with
 *                       async=false ordering so the real init sequence is preserved;
 *                       attrs are kept verbatim (type="module", async, fs-*, data-*).
 *   - prePaint        : concatenated FOUC class-adder inline scripts (run before paint)
 *   - deferredInline  : other functional inline scripts (run after mount, in order)
 *   - metadata        : lang, title, description, ogImage, canonical, hasLoader
 * Plus src/generated/manifest.json: route→slug, per-route meta, and dynamic-route
 * families grouped by first path segment (blog / features / team / …).
 *
 * It only ROUTES the original scripts, never rewrites them — re-running the literal
 * scripts is what makes the GSAP/canvas behaviour pixel-1:1. See the SKILL's
 * "ESM-module sites" section for how the runtime replays externalScripts.
 *
 * Usage (from the clone workspace root):
 *   node scripts/slice-routes.mjs
 *   node scripts/slice-routes.mjs --raw docs/research/raw-html --out src/generated
 *
 * Pure Node fs. Zero new dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const WS = process.cwd();
const RAW = path.join(WS, flag('--raw', 'docs/research/raw-html'));
const GEN = path.join(WS, flag('--out', 'src/generated'));
const OUT = path.join(GEN, 'routes');

if (!fs.existsSync(RAW)) {
  console.error(`slice-routes: no raw HTML at ${RAW} (pass --raw). Save each route as <slug>.html first ("/blog/x" → blog__x.html).`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const slugToPath = (slug) => (slug === 'index' ? '/' : '/' + slug.split('__').join('/') + '/');
// match BOTH double- and single-quoted attrs: WordPress/Yoast emit single-quoted
// `<script type='application/ld+json'>`, and double-quote-only matching silently dropped
// those JSON-LD blocks from bodyHTML (failed the isJsonIsland keep-guard → stripped).
const attrOf = (s, name) => {
  const m = s.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[1] ?? m[2] ?? '') : '';
};

function scanScripts(html) {
  const out = [];
  // quoted-attr-aware: a `>` inside an attribute value (e.g. data-x="a>b", a JSON-in-attr)
  // must NOT end the open tag, or an external <script src> gets misclassified as inline and
  // the body extraction corrupts. `(?:[^>"']|"[^"]*"|'[^']*')*` skips over quoted spans.
  const re = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = (m[1] || '').trim();
    out.push({ attrs, body: m[2] || '', type: attrOf(attrs, 'type').toLowerCase(), src: attrOf(attrs, 'src') });
  }
  return out;
}
const isJsonIsland = (s) => /application\/(ld\+)?json/i.test(s.type);
// pre-paint: tiny inline scripts that only toggle <html> classes for FOUC
const isPrePaint = (s) =>
  !s.src && !isJsonIsland(s) && /classList\.add\(/.test(s.body) && s.body.length < 600 &&
  !/getElementById|querySelector|requestAnimationFrame|addEventListener/.test(s.body);

const routes = {};
const families = {}; // firstSegment -> [subslug]
let emptyBodies = 0; // routes whose raw HTML had no well-formed <body> (bad fetch)

for (const file of fs.readdirSync(RAW).filter((f) => f.endsWith('.html'))) {
  const slug = file.replace(/\.html$/, '');
  const routePath = slugToPath(slug);
  const html = fs.readFileSync(path.join(RAW, file), 'utf8');

  const htmlTag = (html.match(/<html\b[^>]*>/i) || ['<html>'])[0];
  const lang = attrOf(htmlTag, 'lang') || 'en';
  const title = ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const description = attrOf((html.match(/<meta[^>]*name="description"[^>]*>/i) || [''])[0], 'content');
  const ogImage = attrOf((html.match(/<meta[^>]*property="og:image"[^>]*>/i) || [''])[0], 'content');
  const canonical = attrOf((html.match(/<link[^>]*rel="canonical"[^>]*>/i) || [''])[0], 'href');

  const bodyOpen = html.search(/<body\b[^>]*>/i);
  const bodyTag = (html.match(/<body\b[^>]*>/i) || ['<body>'])[0];
  const bodyClose = html.lastIndexOf('</body>');
  // Guard: a partial / bot-blocked / redirect-stub fetch can lack a well-formed body.
  // Without this, slice() would emit near-whole-document garbage as "bodyHTML" silently.
  let body;
  if (bodyOpen === -1 || bodyClose === -1 || bodyClose < bodyOpen) {
    console.error(`slice-routes: WARNING — ${file} has no well-formed <body>…</body> (partial/bot-blocked fetch?); emitting EMPTY bodyHTML for ${routePath}.`);
    emptyBodies++;
    body = '';
  } else {
    body = html.slice(bodyOpen + bodyTag.length, bodyClose);
  }

  const all = scanScripts(html);
  const externalScripts = all.filter((s) => s.src).map((s) => ({ src: s.src, type: s.type, attrs: s.attrs }));
  const deferredInline = all.filter((s) => !s.src && !isJsonIsland(s) && !isPrePaint(s)).map((s) => s.body);
  const prePaint = all.filter(isPrePaint).map((s) => s.body).join('\n');

  // strip executable <script> from the body, but KEEP JSON data islands
  body = body.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, a) =>
    /application\/(ld\+)?json/i.test(attrOf(a, 'type')) ? full : '');

  routes[routePath] = {
    slug, path: routePath, lang, title, description, ogImage, canonical,
    hasLoader: /id="(stage|loader|preloader)"/i.test(html) || /data-[\w-]*loader/i.test(html),
    prePaint, deferredInline, externalScripts, bodyHTML: body,
  };
  fs.writeFileSync(path.join(OUT, slug + '.json'), JSON.stringify(routes[routePath]));

  if (slug.includes('__')) {
    const [fam, ...rest] = slug.split('__');
    (families[fam] ||= []).push(rest.join('/'));
  }
}

const manifest = {
  paths: Object.fromEntries(Object.values(routes).map((r) => [r.path, r.slug])),
  meta: Object.fromEntries(Object.values(routes).map((r) => [r.path, {
    title: r.title, description: r.description, ogImage: r.ogImage, lang: r.lang,
  }])),
  families: Object.fromEntries(Object.entries(families).map(([k, v]) => [k, v.sort()])),
};
fs.writeFileSync(path.join(GEN, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`slice-routes: ${Object.keys(routes).length} routes → ${path.relative(WS, OUT)}`);
for (const [fam, subs] of Object.entries(families)) console.log(`  family ${fam}: ${subs.length}`);
if (emptyBodies) console.error(`slice-routes: ⚠ ${emptyBodies} route(s) had EMPTY bodyHTML — re-fetch those pages before building (likely a bad/blocked fetch).`);
