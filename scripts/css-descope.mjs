#!/usr/bin/env node

/**
 * css-descope.mjs — strip framework CSS scoping so compiled stylesheets match
 * un-scoped cloned markup. TRANSFORM ONLY: it does not gather CSS sources,
 * dedupe across files, or set ordering — those stay LLM-driven.
 *
 * Astro ([data-astro-cid-*]) and Vue ([data-v-*]) — both attribute-scoping, so the
 * selector keeps a real compound after the strip; safe + fixture-tested. Svelte
 * (.svelte-*) is class-scoping and Svelte DOUBLES the class for specificity
 * (`code.svelte-x.svelte-x`); a blind global strip would turn a bare `.svelte-x{}`
 * rule into an empty selector. So svelte is handled PER selector-unit (only on
 * selector heads, never declaration bodies): strip `.svelte-x` from a compound unit
 * only when a real selector remains; if a unit is ONLY `.svelte-x` hashes, keep ONE
 * (it still matches the ported markup, which carries the class) — never emit an empty
 * unit. Fixture-tested against real pocketbase.io CodeBlock rules + synthetic edges.
 *
 * What it does, per the website-cloner SKILL's "port real compiled CSS" recipe:
 *   1. strip [data-astro-cid-XXXX] attribute selectors
 *   2. repair dangling combinators the strip creates ( >{ -> > *{ , +{ , ~{ )
 *   3. remove rule blocks whose body is now empty
 *   4. pin @layer order: hoist ONE `@layer a, b, c;` (first-appearance order) to the
 *      top, so concatenating multiple stylesheets can't let a later file's @layer
 *      statement set the cascade precedence (silent override of base by utilities)
 *
 * Usage:
 *   node scripts/css-descope.mjs [--framework astro] <file1.css> [file2.css ...] [--out src/app/globals.css]
 *   node scripts/css-descope.mjs raw.css            # prints to stdout
 *
 * Concatenates inputs in the order given (the caller controls ordering).
 * Prints a summary to stderr. Exits non-zero if a dangling combinator survives
 * the repair (a signal the input uses a scoping pattern this version misses).
 *
 * Pure Node fs + RegExp. Zero new dependencies.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const getFlag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT = getFlag('--out', null);
let FRAMEWORK = getFlag('--framework', null);
const files = args.filter((a, i) => {
  if (a.startsWith('--')) return false;
  if (args[i - 1] === '--out' || args[i - 1] === '--framework') return false;
  return true;
});

if (files.length === 0) {
  console.error('css-descope: no input files. Usage: css-descope.mjs [--framework astro] <file.css...> [--out path]');
  process.exit(2);
}

// Scoping patterns per framework. Only astro is enabled until a fixture exists
// for the others.
const SCOPING = {
  astro: /\[data-astro-cid-[\w-]+\]/g,
  vue: /\[data-v-[\w-]+\]/g,
  svelte: /\.svelte-[\w-]+/g, // class-scoping — handled per-unit (see stripSvelteSelectorHeads)
};

function detectFramework(css) {
  if (/\[data-astro-cid-[\w-]+\]/.test(css)) return 'astro';
  if (/\[data-v-[\w-]+\]/.test(css)) return 'vue';
  if (/\.svelte-[\w-]+/.test(css)) return 'svelte';
  return null;
}

// Svelte de-scope. Operate ONLY on selector heads (the text before each `{`), never on
// declaration bodies, so a `.svelte-x` substring inside a value/string is never touched.
// Per compound unit: strip `.svelte-x` only if a real selector survives; if the unit is
// purely `.svelte-x` hash(es), keep ONE (the ported markup carries the class, so the rule
// still matches) — this is what prevents the "empty selector" the global strip would make.
// Per comma-segment COLLISION GUARD: if the fully-stripped selector is a PURE type/universal
// selector (no class/id/attribute — e.g. `code`, `a`, `div`, `* `), keep the ORIGINAL
// scoped selector instead. A bare element rule collides with global element styles, and the
// scoped CodeBlock rule on pocketbase (`code.svelte-x{display:block;width:100%}`) de-scoped
// to `code` and stole width:100% from inline `<code>`, wrapping text on every docs page.
// The ported markup keeps the class, so the scoped form stays pixel-faithful.
// Split a selector list on TOP-LEVEL commas only — a comma inside :not(.a, .b) / :is() / an
// attribute value must NOT split the selector (head.split(',') mis-segmented those).
function splitTopLevelCommas(s) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

// Attribute-scoping de-scope (Astro [data-astro-cid], Vue [data-v]) limited to selector HEADS,
// so the scoping token's text inside a declaration body (content:"[data-v-x]", a custom prop,
// a url() data-URI) is never erased — a global String.replace corrupted those.
function stripAttrScopingHeads(css, pattern, stats) {
  return css.replace(/([^{}]+)(\{)/g, (full, head, brace) => {
    if (/^\s*@/.test(head)) return full; // at-rule prelude carries no styled selector
    return head.replace(pattern, () => { stats.stripped++; return ''; }) + brace;
  });
}

function stripSvelteSelectorHeads(css, stats) {
  return css.replace(/([^{}]+)(\{)/g, (full, head, brace) => {
    // at-rule head (@media/@supports/@layer/@keyframes …) carries no styled selector
    if (/^\s*@/.test(head)) return full;
    const newHead = splitTopLevelCommas(head).map((sel) => {
      if (!sel.includes('.svelte-')) return sel;
      let removedInSel = 0;
      const stripped = sel.replace(/(^|[\s>+~(,])([^\s>+~(){},]+)/g, (m, sep, unit) => {
        if (!unit.includes('.svelte-')) return m;
        const removed = (unit.match(/\.svelte-[\w-]+/g) || []).length;
        const bare = unit.replace(/\.svelte-[\w-]+/g, '').trim();
        // The unit regex stops at `(`, so `.svelte-x:not(.foo)` captures unit `.svelte-x:not`
        // → bare `:not`. Treat a bare pseudo prefix (`:not`/`:has`/`:is`/`::before`) the same as
        // an all-hash unit: keep ONE hash, else the strip yields an UNBOUNDED `:not(.foo)` rule.
        if (bare === '' || /^::?[\w-]+$/.test(bare)) {
          // unit is ONLY svelte hash(es) (optionally + a pseudo): keep one so it still matches
          removedInSel += Math.max(0, removed - 1);
          return sep + unit.match(/\.svelte-[\w-]+/)[0] + bare;
        }
        removedInSel += removed;
        return sep + bare;
      });
      if (!/[.#[]/.test(stripped)) { stats.keptScoped++; return sel; } // pure-type → keep scope
      stats.stripped += removedInSel;
      return stripped;
    }).join(',');
    return newHead + brace;
  });
}

function descope(css, framework) {
  const stats = { stripped: 0, combinators: 0, emptyRemoved: 0, layers: 0, keptScoped: 0 };
  const pattern = SCOPING[framework];

  // 1. strip scoping selectors — all paths now operate on selector HEADS only (never bodies):
  //    svelte = per-unit safe + collision guard; astro/vue = attribute-selector strip in heads.
  if (framework === 'svelte') {
    css = stripSvelteSelectorHeads(css, stats);
  } else {
    css = stripAttrScopingHeads(css, pattern, stats);
  }

  // 2. repair dangling combinators the strip leaves directly before `{`
  //    e.g. ".tabs>{"  ->  ".tabs> *{"   (matches the fixture convention "> *{")
  css = css.replace(/([>+~])(\s*)\{/g, (_m, comb) => { stats.combinators++; return `${comb} *{`; });

  // 3. remove rule blocks whose body is now empty: `selector{}` / `selector{  }`
  css = css.replace(/([^{}]*)\{\s*\}/g, (m, sel) => {
    // keep at-rules with intentionally empty bodies untouched (rare); only drop
    // ordinary empty style rules.
    if (sel.trim().startsWith('@')) return m;
    stats.emptyRemoved++;
    return '';
  });

  // 4. pin @layer order. Across concatenated stylesheets the cascade precedence is
  //    set by the FIRST @layer declaration seen; if file B (concatenated after A)
  //    is the first to name a layer, it can silently reorder the cascade. Collect
  //    every layer name (from `@layer a, b;` statements AND `@layer x {` blocks) in
  //    first-appearance order, dedupe, and hoist one canonical declaration to the top.
  const order = [];
  const seen = new Set();
  const layerRe = /@layer\s+([^{;]+?)\s*[{;]/g;
  let lm;
  while ((lm = layerRe.exec(css))) {
    for (const name of lm[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!seen.has(name)) { seen.add(name); order.push(name); }
    }
  }
  if (order.length) { css = `@layer ${order.join(', ')};\n` + css; stats.layers = order.length; }

  return { css, stats };
}

// Detect the de-scope collision: a selector segment carrying the SAME
// [data-astro-cid-*] on both an ancestor AND a descendant. Stripping the cid turns
// it into a plain descendant rule that can now match injected (cid-less) markup
// which was inert in the original — a style silently activates on the clone. We
// only WARN (the transform is unchanged); the orchestrator / pixel-diff verifies.
function findCollisions(css) {
  const samples = [];
  let count = 0;
  const ruleRe = /([^{}]+)\{/g;
  let m;
  while ((m = ruleRe.exec(css))) {
    for (const seg of m[1].split(',')) {
      const cids = seg.match(/data-astro-cid-[\w-]+/g);
      if (!cids || cids.length < 2) continue;
      const counts = {};
      let repeated = false;
      for (const c of cids) { counts[c] = (counts[c] || 0) + 1; if (counts[c] >= 2) repeated = true; }
      if (repeated) { count++; if (samples.length < 5) samples.push(seg.trim().replace(/\s+/g, ' ').slice(0, 110)); }
    }
  }
  return { count, samples };
}

const sources = await Promise.all(files.map((f) => readFile(f, 'utf8')));
let combined = sources.join('\n');

if (!FRAMEWORK) FRAMEWORK = detectFramework(combined);
if (!FRAMEWORK || !SCOPING[FRAMEWORK]) {
  console.error(`css-descope: no supported scoping detected (astro, vue, svelte implemented). Pass --framework or check the input.`);
  process.exit(2);
}

const { css, stats } = descope(combined, FRAMEWORK);

// Validation gate: no dangling combinator should remain right before `{`.
const dangling = (css.match(/[>+~]\s*\{/g) || []).length;
process.stderr.write(
  `css-descope[${FRAMEWORK}]: ${stats.stripped} scoping selectors stripped, ` +
  `${stats.combinators} combinators repaired, ${stats.emptyRemoved} empty rules removed` +
  `${stats.keptScoped ? `, ${stats.keptScoped} kept scoped (pure-type collision guard)` : ''}` +
  `${stats.layers ? `, @layer order pinned (${stats.layers} layers)` : ''}\n`
);

const collisions = findCollisions(combined);
if (collisions.count > 0) {
  process.stderr.write(
    `css-descope: ⚠ ${collisions.count} selector(s) carry the same data-astro-cid on an ancestor AND a descendant.\n` +
    `  De-scoping can over-match injected (cid-less) markup that was inert in the original — verify these in the pixel-diff:\n`
  );
  for (const s of collisions.samples) process.stderr.write(`    ${s}\n`);
}
if (dangling > 0) {
  console.error(`css-descope: ${dangling} dangling combinator(s) survived repair — refusing to emit broken CSS. Inspect the input scoping pattern.`);
  process.exit(1);
}

if (OUT) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, css, 'utf8');
  process.stderr.write(`css-descope: wrote ${OUT}\n`);
} else {
  process.stdout.write(css);
}
