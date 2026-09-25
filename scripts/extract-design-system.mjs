#!/usr/bin/env node

/**
 * extract-design-system.mjs — distill a clone's compiled stylesheet into a
 * professional, agent-consumable design system: docs/research/DESIGN.md (the
 * "design system prompt" — readable by humans AND usable as context for any
 * agent building NEW sections that look native to the site) plus
 * docs/research/design-tokens.json (machine-readable).
 *
 * Deterministic-first: everything here is parsed and FREQUENCY-RANKED from the
 * real compiled CSS — the palette/scales that the site ACTUALLY uses, not what
 * a doc claims. The orchestrator's only generative job afterwards is the small
 * "Design feel" paragraph at the top of DESIGN.md (marked with a TODO).
 *
 * What it extracts (each with usage counts):
 *   - :root custom properties, grouped by kind (color / size / other)
 *   - effective color palette (every #hex / rgb / oklch / hsl in the CSS, ranked)
 *   - typography: font families, the font-size scale, weights, letter-spacing
 *   - spacing scale (padding/margin/gap values, ranked)
 *   - border radii, shadows, z-index layers
 *   - breakpoints (@media min/max-width, deduped)
 *   - @keyframes (names + animated properties)
 *
 * Usage (from the clone workspace root):
 *   node scripts/extract-design-system.mjs
 *   node scripts/extract-design-system.mjs --css src/app/globals.css \
 *     --out-md docs/research/DESIGN.md --out-json docs/research/design-tokens.json
 *
 * Pure Node built-ins. Zero new dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const has = (n) => args.includes(n);

// ─── CSS block parser (quote-safe — same approach as extract-section) ───────

function cssBlocks(css) {
  // comment-aware: a '{'/'}' inside /* */ must not open/close blocks
  const blocks = [];
  let i = 0;
  let preludeStart = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (css[i] === '"' || css[i] === "'") {
      const q = css.indexOf(css[i], i + 1);
      i = q === -1 ? css.length : q + 1;
      continue;
    }
    if (css[i] !== '{') { i++; continue; }
    const prelude = css.slice(preludeStart, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1; let j = i + 1;
    while (j < css.length && depth > 0) {
      const c = css[j];
      if (c === '/' && css[j + 1] === '*') {
        const end = css.indexOf('*/', j + 2);
        j = end === -1 ? css.length : end + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const q = css.indexOf(c, j + 1);
        j = q === -1 ? css.length : q + 1;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      j++;
    }
    blocks.push({ prelude, body: css.slice(i + 1, j - 1) });
    i = j;
    preludeStart = j;
  }
  return blocks;
}

// Walk nested blocks (@layer/@media/@supports) yielding { selector, body, media }.
function* walkRules(css, media = null) {
  for (const b of cssBlocks(css)) {
    if (/^@(layer|supports)/i.test(b.prelude)) yield* walkRules(b.body, media);
    else if (/^@media/i.test(b.prelude)) yield* walkRules(b.body, b.prelude);
    else if (/^@/.test(b.prelude)) yield { selector: b.prelude, body: b.body, media, atRule: true };
    else yield { selector: b.prelude, body: b.body, media };
  }
}

const count = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const ranked = (map, min = 1) => [...map.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]);

// ─── Extractors (all pure: css string in, ranked data out) ───────────────────

export function extractRootVars(css) {
  const vars = {};
  for (const r of walkRules(css)) {
    if (r.atRule) continue;
    const isRoot = r.selector.split(',').some((s) => ['html', ':root', ':host'].includes(s.trim()));
    if (!isRoot) continue;
    for (const decl of r.body.split(';')) {
      const m = decl.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+)$/);
      if (m) vars[m[1]] = m[2].trim();
    }
  }
  const kindOf = (name, value) =>
    /#|rgb|oklch|hsl|color/i.test(value) || /color|bg|border|accent|brand/i.test(name) ? 'color'
      : /^[\d.]+(px|rem|em|%|vw|vh)/.test(value) || /space|gap|size|width|radius/i.test(name) ? 'size'
      : 'other';
  const grouped = { color: {}, size: {}, other: {} };
  for (const [k, v] of Object.entries(vars)) grouped[kindOf(k, v)][k] = v;
  return grouped;
}

export function extractColors(css) {
  // Walk declaration VALUES only (skip custom-prop declarations, url() contents,
  // selectors and comments) — a raw-text scan inflates counts and matches junk.
  const colors = new Map();
  // paren-BALANCED (one nesting level) so a color carrying a nested function —
  // rgb(255 0 0 / var(--x)) — isn't truncated at the inner ")" (matches tokenize-css COLOR_RE).
  const FN = '\\((?:[^()]|\\([^()]*\\))*\\)';
  const re = new RegExp(`#[0-9a-fA-F]{3,8}\\b|rgba?${FN}|oklch${FN}|hsla?${FN}`, 'g');
  const masked = (s) => s.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, ' ');
  for (const r of walkRules(css)) {
    if (r.atRule) continue;
    for (const decl of r.body.split(';')) {
      const c = decl.indexOf(':');
      if (c === -1) continue;
      if (decl.slice(0, c).trim().startsWith('--')) continue;
      for (const m of masked(decl.slice(c + 1)).match(re) || []) count(colors, m.toLowerCase());
    }
  }
  return ranked(colors, 2);
}

export function extractTypography(css) {
  const families = new Map(); const sizes = new Map(); const weights = new Map(); const tracking = new Map();
  for (const r of walkRules(css)) {
    for (const decl of r.body.split(';')) {
      const c = decl.indexOf(':');
      if (c === -1) continue;
      const prop = decl.slice(0, c).trim().toLowerCase();
      const val = decl.slice(c + 1).trim();
      if (prop === 'font-family') count(families, val.replace(/\s+/g, ' '));
      else if (prop === 'font-size') {
        const clean = val.replace(/\s*!important\s*$/i, '');
        // fixed sizes (1rem, 14px) AND fluid ones (clamp/min/max/calc) — skip bare 0/keywords
        if ((/^[\d.]/.test(clean) && parseFloat(clean) > 0) || /^(clamp|min|max|calc)\(/i.test(clean)) count(sizes, clean);
      }
      else if (prop === 'font-weight') count(weights, val);
      else if (prop === 'letter-spacing' && val !== 'normal') count(tracking, val);
    }
  }
  const toPx = (v) => (v.endsWith('rem') ? parseFloat(v) * 16 : v.endsWith('px') ? parseFloat(v) : NaN);
  // ascending by px-equivalent; non-convertible (em/%/clamp/calc) sort to the END, by text
  const sizeScale = ranked(sizes).sort((a, b) => {
    const pa = toPx(a[0]); const pb = toPx(b[0]);
    const ka = Number.isNaN(pa) ? Infinity : pa; const kb = Number.isNaN(pb) ? Infinity : pb;
    return ka - kb || a[0].localeCompare(b[0]);
  });
  return { families: ranked(families), sizeScale, weights: ranked(weights), tracking: ranked(tracking) };
}

export function extractScale(css, props) {
  const values = new Map();
  const propSet = new Set(props);
  for (const r of walkRules(css)) {
    for (const decl of r.body.split(';')) {
      const c = decl.indexOf(':');
      if (c === -1) continue;
      const prop = decl.slice(0, c).trim().toLowerCase();
      if (!propSet.has(prop)) continue;
      for (const v of decl.slice(c + 1).trim().split(/\s+/)) {
        if (/^-?[\d.]+(px|rem|em)$/.test(v) && parseFloat(v) !== 0) count(values, v);
      }
    }
  }
  return ranked(values, 2);
}

export function extractBreakpoints(css) {
  const bps = new Map();
  const scan = (text) => {
    for (const m of text.matchAll(/@media[^{]+/g)) {
      const widths = m[0].match(/(min|max)-width\s*:\s*([\d.]+\w+)/g);
      if (widths) for (const w of widths) count(bps, w.replace(/\s+/g, ''));
    }
  };
  scan(css);
  return ranked(bps);
}

export function extractKeyframes(css) {
  const out = [];
  const walk = (text) => {
    for (const b of cssBlocks(text)) {
      if (/^@keyframes/i.test(b.prelude)) {
        const name = b.prelude.replace(/^@keyframes\s+/i, '').trim();
        const props = new Set();
        for (const step of cssBlocks(b.body)) {
          for (const d of step.body.split(';')) {
            const p = d.split(':')[0]?.trim();
            if (p) props.add(p);
          }
        }
        out.push({ name, animates: [...props].filter(Boolean) });
      } else if (/^@(layer|media|supports)/i.test(b.prelude)) walk(b.body);
    }
  };
  walk(css);
  return out;
}

export function buildDesignSystem(css) {
  return {
    rootVars: extractRootVars(css),
    palette: extractColors(css).slice(0, 24),
    typography: extractTypography(css),
    spacing: extractScale(css, ['padding', 'margin', 'gap', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'margin-top', 'margin-bottom', 'row-gap', 'column-gap']).slice(0, 20),
    radii: extractScale(css, ['border-radius']).slice(0, 10),
    shadows: ranked(new Map([...css.matchAll(/box-shadow\s*:\s*([^;}{]+)/g)].map((m) => [m[1].trim(), 1])
      .reduce((acc, [v]) => (acc.set(v, (acc.get(v) || 0) + 1), acc), new Map()))).slice(0, 8),
    zIndex: ranked(new Map([...css.matchAll(/z-index\s*:\s*(-?\d+)/g)].reduce((acc, m) => (acc.set(m[1], (acc.get(m[1]) || 0) + 1), acc), new Map())))
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0])).slice(0, 12),
    breakpoints: extractBreakpoints(css),
    keyframes: extractKeyframes(css),
  };
}

// ─── Renderers ────────────────────────────────────────────────────────────────

const table = (rows, headers) => {
  if (!rows.length) return '_none found_\n';
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n` +
    rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`).join('\n') + '\n';
};

export function renderMarkdown(ds, meta) {
  const vars = (obj) => table(Object.entries(obj).map(([k, v]) => [`\`${k}\``, `\`${v.length > 60 ? v.slice(0, 57) + '…' : v}\``]), ['Token', 'Value']);
  return `# DESIGN.md — ${meta.site}

> Design system distilled deterministically from the site's REAL compiled CSS
> (frequency-ranked: this is what the site actually uses). Use this document as
> the design context for building NEW sections/pages that look native to the site.
>
> _Source: \`${meta.cssPath}\` · generated by \`scripts/extract-design-system.mjs\`_

## Design feel

<!-- TODO(orchestrator): one paragraph — overall aesthetic, mood, density,
     motion personality. The only generative section of this file. -->

## Design tokens (\`:root\`)

### Colors
${vars(ds.rootVars.color)}
### Sizes
${vars(ds.rootVars.size)}
### Other
${vars(ds.rootVars.other)}

## Effective palette (frequency-ranked across ALL css)

${table(ds.palette.map(([c, n]) => [`\`${c}\``, n]), ['Color', 'Uses'])}

## Typography

**Families:**
${table(ds.typography.families.map(([f, n]) => [`\`${f.slice(0, 70)}\``, n]), ['Font stack', 'Uses'])}
**Size scale (ascending):**
${table(ds.typography.sizeScale.map(([s, n]) => [`\`${s}\``, n]), ['Size', 'Uses'])}
**Weights:** ${ds.typography.weights.map(([w, n]) => `\`${w}\` (${n})`).join(' · ') || '_none_'}
**Letter-spacing:** ${ds.typography.tracking.slice(0, 8).map(([t, n]) => `\`${t}\` (${n})`).join(' · ') || '_none_'}

## Spacing scale (frequency-ranked)

${table(ds.spacing.map(([s, n]) => [`\`${s}\``, n]), ['Value', 'Uses'])}

## Radii

${table(ds.radii.map(([r, n]) => [`\`${r}\``, n]), ['Radius', 'Uses'])}

## Shadows

${ds.shadows.length ? ds.shadows.map(([s]) => `- \`${s.slice(0, 100)}\``).join('\n') : '_none found_'}

## Breakpoints

${table(ds.breakpoints.map(([b, n]) => [`\`${b}\``, n]), ['Query', 'Uses'])}

## Animations (@keyframes)

${ds.keyframes.length ? ds.keyframes.map((k) => `- **${k.name}** — animates: ${k.animates.join(', ')}`).join('\n') : '_none found_'}

## How to use this file

- Building a new section: match the palette, pick sizes/spacings FROM the scales above (never invent off-scale values), reuse the \`:root\` tokens by name.
- Re-branding: change the \`:root\` color tokens first (they cascade); then sweep the top "effective palette" hexes that are hardcoded outside tokens.
- For agents: paste this file as design context — it is the system prompt of this site's visual language.
`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

/** Enumerate values that survive tokenization (a re-brander must still hand-edit them):
 *  alpha-hex colors (per-instance opacity a var() can't carry without color-mix()), the brand
 *  glow box-shadow recipes, and a reminder of the markup-side residue (data-* color attrs). */
export function buildRebrandChecklist(css) {
  const alphaHex = new Map();
  for (const m of css.matchAll(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{4}\b/g)) {
    const k = m[0].toLowerCase(); alphaHex.set(k, (alphaHex.get(k) || 0) + 1);
  }
  const glows = new Set();
  for (const m of css.matchAll(/box-shadow\s*:[^;{}]*#[0-9a-fA-F]{4,8}[^;{}]*/gi)) glows.add(m[0].trim().replace(/\s+/g, ' ').slice(0, 110));
  return { alphaHex: [...alphaHex.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30), glows: [...glows].slice(0, 12) };
}

function renderRebrandChecklist(rc) {
  const L = ['# Rebrand checklist', '',
    'These values are NOT covered by the `:root` tokens — `tokenize-css` cannot fold them (a',
    '`var()` can\'t carry per-instance opacity without `color-mix()`, and `data-*` color attributes',
    'are read by JS at runtime, not the CSS). After swapping the accent token, hand-edit these too.', ''];
  L.push('## Alpha-hex colors (per-instance opacity — glow/overlay)', '');
  if (rc.alphaHex.length) {
    L.push('| Hex (incl. alpha) | Uses |', '|---|---|');
    for (const [v, n] of rc.alphaHex) L.push(`| \`${v}\` | ${n} |`);
  } else L.push('_None found._');
  L.push('', '## Glow `box-shadow` recipes (derived from the accent — update by hand)', '');
  if (rc.glows.length) for (const g of rc.glows) L.push(`- \`${g}\``);
  else L.push('_None found._');
  L.push('', '## Markup-side residue (grep these — they live in components / route JSON, not CSS)', '',
    '```bash',
    '# data-* color attributes read by replayed JS (halftone canvas, charts):',
    `grep -rnoE 'data-[a-z-]*color="#[0-9a-fA-F]{3,8}"' src/`,
    '# any remaining raw hex in component className/style strings:',
    `grep -rnoE '#[0-9a-fA-F]{6,8}' src/components/ | head`,
    '```', '');
  return L.join('\n');
}

function main() {
  const WS = process.cwd();
  const CSS_PATH = path.join(WS, flag('--css', 'src/app/globals.css'));
  const OUT_MD = path.join(WS, flag('--out-md', 'docs/research/DESIGN.md'));
  const OUT_JSON = path.join(WS, flag('--out-json', 'docs/research/design-tokens.json'));
  const REBRAND = has('--rebrand-checklist');

  if (!fs.existsSync(CSS_PATH)) {
    console.error(`extract-design-system: no stylesheet at ${CSS_PATH} (pass --css). Run after globals.css is ported.`);
    process.exit(2);
  }
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const ds = buildDesignSystem(css);
  const site = path.basename(WS);

  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, renderMarkdown(ds, { site, cssPath: path.relative(WS, CSS_PATH) }), 'utf8');
  fs.writeFileSync(OUT_JSON, JSON.stringify(ds, null, 2) + '\n', 'utf8');

  if (REBRAND) {
    const rcPath = path.join(WS, 'docs/research/REBRAND_CHECKLIST.md');
    fs.writeFileSync(rcPath, renderRebrandChecklist(buildRebrandChecklist(css)), 'utf8');
    process.stderr.write(`extract-design-system: → ${path.relative(WS, rcPath)} (values tokenize can't fold)\n`);
  }

  process.stderr.write(
    `extract-design-system: ${Object.keys(ds.rootVars.color).length + Object.keys(ds.rootVars.size).length + Object.keys(ds.rootVars.other).length} tokens, ` +
    `${ds.palette.length} palette colors, ${ds.typography.sizeScale.length} type sizes, ${ds.spacing.length} spacing values, ` +
    `${ds.breakpoints.length} breakpoints, ${ds.keyframes.length} keyframes\n` +
    `  → ${path.relative(WS, OUT_MD)}\n  → ${path.relative(WS, OUT_JSON)}\n` +
    `  NOTE: fill the "Design feel" paragraph (the one generative section).\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
