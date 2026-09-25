#!/usr/bin/env node

/**
 * componentize-routes.mjs — turn the WHOLE markup-port clone into a real React
 * component project, automatically: every section of every route becomes a named
 * component, shared sections (footer, style embeds, widgets — byte-identical
 * across routes) are deduped into ONE component, and each route gets a composed
 * page (<GlobalStyles/><Navbar/><HeroSection/>…<Footer/>).
 *
 * This is Phase 7 of the skill: the answer to "the clone should already BE a
 * componentized website project". It automates what extract-section does for one
 * section, across the entire site.
 *
 * DOM-exactness rule (what keeps the pixel-diff at 0): each section component's
 * HOST IS THE SECTION'S OWN ELEMENT — we render the real <section …attrs> tag via
 * JSX and inject only its innerHTML. No wrapper divs are added anywhere, so child
 * selectors (main > section) and the replayed scripts behave identically. Page
 * shells (page-wrapper div, <main>) are re-emitted as JSX with their exact attrs.
 *
 * Outputs (these generated paths are (re)written on each run — rerunning after a
 * re-slice refreshes them; nothing OUTSIDE these paths is touched):
 *   src/components/sections/shared/<Name>.tsx     deduped byte-identical sections
 *   src/components/sections/<slug>/<Name>.tsx     per-route sections (verbatim C1)
 *   src/components/pages/<Slug>Page.tsx           per-route composition
 *   src/generated/pages-map.tsx                   slug → Page component map
 *   src/generated/page.componentized.example.tsx  catch-all page.tsx swap example
 *
 * After running: review the example, swap it into app/[[...slug]]/page.tsx
 * (keep the route JSON — metadata + the script-replay runtime still read it),
 * `npm run build`, and RE-RUN the full qa-diff gate (must stay 0-flagged).
 *
 * Navbars: usually NOT byte-identical across routes (only the active-link state
 * differs), so they are emitted per-route by design; unifying them behind an
 * `activePath` prop is a small follow-up edit, flagged in each page header.
 *
 * Usage (from the clone workspace root):
 *   node scripts/componentize-routes.mjs            # all routes
 *   node scripts/componentize-routes.mjs --routes index,about --dry-run
 *
 * Pure Node built-ins + sibling extract-section.mjs exports.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { childrenOf, deriveName, escapeTemplate, jsxAttrs, htmlToJsx } from './extract-section.mjs';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const attrOf = (attrs, name) => {
  const m = (attrs || '').match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3] ?? '') : null;
};
const pascal = (s) => s.split(/[-_\s.]+/).filter(Boolean).map((w) => (w[0] || '').toUpperCase() + w.slice(1)).join('') || 'Index';
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** Open-tag info (tag, full attr string, inner range) for an element node.
 *  innerTo is anchored on the element's OWN closing tag ending exactly at node.end
 *  (childrenOf guarantees node.end is past `</tag>`): a plain lastIndexOf('</') would
 *  (a) match a NEIGHBOR's close tag at node.end in minified HTML (no whitespace
 *  between siblings — doubled close tags, hit 31/211 sections on the Webflow corpus),
 *  and (b) match a literal '</' inside a rawtext child (<script>/<style> strings). */
export function openTagOf(html, node) {
  const openEnd = (() => {
    // find the true end of the open tag (quote-safe)
    let j = node.start;
    while (j < html.length) {
      const c = html[j];
      if (c === '"' || c === "'") { const q = html.indexOf(c, j + 1); j = q === -1 ? html.length : q + 1; continue; }
      if (c === '>') return j + 1;
      j++;
    }
    return node.start;
  })();
  const tail = html.slice(Math.max(openEnd, node.end - (node.tag.length + 16)), node.end);
  const m = tail.match(new RegExp(`</${node.tag}\\s*>$`, 'i'));
  const innerTo = m ? node.end - m[0].length : openEnd; // no close tag (void/self-closed) → empty inner
  return { openEnd, innerFrom: openEnd, innerTo: Math.max(innerTo, openEnd) };
}

/**
 * walkRoute(bodyHTML) → ordered layout of a route:
 *   { wrapper: {tag,attrs}|null, parts: [ {kind:'section', node} |
 *     {kind:'main', tag, attrs, children:[node]} ] }
 * Handles all measured structural variants (page-wrapper roots with siblings,
 * flat header/main/footer, navbar-inside-main, routes without <main>).
 */
export function walkRoute(bodyHTML) {
  const roots = childrenOf(bodyHTML).filter((n) => n.kind === 'element');
  let wrapper = null;
  let level = roots;
  if (roots.length >= 1) {
    const w = roots.find((r) => /(^|\s)(page-wrapper|page_wrapper)(\s|$)/.test(attrOf(r.attrs, 'class') || ''));
    if (w) {
      wrapper = { tag: w.tag, attrs: w.attrs, siblingsBefore: [], siblingsAfter: [] };
      const { innerFrom, innerTo } = openTagOf(bodyHTML, w);
      const inner = childrenOf(bodyHTML, innerFrom, innerTo).filter((n) => n.kind === 'element');
      const idx = roots.indexOf(w);
      wrapper.siblingsBefore = roots.slice(0, idx);
      wrapper.siblingsAfter = roots.slice(idx + 1);
      level = inner;
    }
  }
  const parts = [];
  for (const node of level) {
    if (node.tag === 'main') {
      const { innerFrom, innerTo } = openTagOf(bodyHTML, node);
      const children = childrenOf(bodyHTML, innerFrom, innerTo).filter((n) => n.kind === 'element');
      parts.push({ kind: 'main', tag: node.tag, attrs: node.attrs, children });
    } else {
      parts.push({ kind: 'section', node });
    }
  }
  return { wrapper, parts };
}

const C2_CAP = 30_000; // same byte cap as extract-section's CLI

/** Decide whether a section is SAFE to emit as editable C2 JSX or must stay a C1 innerHTML
 *  blob. Errs toward C1: a wrong C2 silently breaks a replayed-script animation (the JS can't
 *  find the DOM it expects after React reconciliation); a wrong C1 just means less-editable.
 *  Matches Gabriel's actual VyndHub split (the dense JS-driven widgets stayed C1). */
export function classifySection(node, innerHTML) {
  const reasons = [];
  const bytes = node.html.length;
  if (bytes > C2_CAP) reasons.push(`size ${bytes}B > ${C2_CAP}`);
  const styleCount = (innerHTML.match(/\bstyle\s*=/g) || []).length;
  if (styleCount > 40 || styleCount / Math.max(1, bytes / 1000) > 3.0) reasons.push(`inline-style density (${styleCount})`);
  if (/role\s*=\s*["'](tablist|tabpanel|dialog|alertdialog|tree|treegrid|grid|listbox|menu|menubar|toolbar|combobox)["']/.test(node.html))
    reasons.push('interactive ARIA role');
  const stateHooks = (innerHTML.match(/\bdata-[a-z][\w]*-(?:state|idx|index|active|open|tab|step|selected)\s*=/g) || []).length;
  if (stateHooks > 5) reasons.push(`${stateHooks} JS-state data-hooks`);
  if (bytes > 5000) {
    const freq = new Map();
    for (const c of childrenOf(innerHTML).filter((n) => n.kind === 'element')) freq.set(c.tag, (freq.get(c.tag) || 0) + 1);
    const maxRepeat = Math.max(0, ...freq.values());
    if (maxRepeat > 30) reasons.push(`${maxRepeat} repeated <${[...freq.entries()].sort((a, b) => b[1] - a[1])[0][0]}> siblings (JS-generated)`);
  }
  return { mode: reasons.length ? 'C1' : 'C2', reasons };
}

export const shouldEmitC2 = (node, innerHTML) => classifySection(node, innerHTML).mode === 'C2';

/** C1 — host element with innerHTML injected (byte-identical to the blob; for JS-driven sections). */
function emitC1Section(name, Tag, attrs, inner, origin) {
  return `/**
 * ${name} — componentized from ${origin} by componentize-routes.mjs (C1 = verbatim).
 * Kept as innerHTML because this section is JS-driven (dense inline styles / state hooks);
 * the host <${Tag}> + exact attributes render a byte-identical DOM. Edit the markup string below.
 */
const html = \`${escapeTemplate(inner)}\`;

export function ${name}() {
  return (
    <${Tag}${attrs}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
`;
}

/** C2 — the section transpiled to real, editable JSX (no dangerouslySetInnerHTML). */
function emitC2Section(name, node, origin) {
  const jsx = htmlToJsx(node.html); // full outerHTML → JSX tree (host + children)
  return `/**
 * ${name} — componentized from ${origin} by componentize-routes.mjs (C2 = editable JSX).
 * Real JSX you can edit directly. The rendered DOM matches the clone; replayed scripts and
 * globals.css still drive behavior + styling.
 */
export function ${name}() {
  return (
${jsx}  );
}
`;
}

/** Navbar — one shared C2 component with an `activePath` prop. Active state is driven generically
 *  by matching each <a href> against activePath → aria-current="page" (CSS that keys off
 *  [aria-current=page] picks it up; class-based active styling can be wired to the same match). */
function emitNavbar(name, node, origin) {
  let jsx = htmlToJsx(node.html);
  // strip the representative capture's BAKED active state — both aria-current and active-class
  // tokens — so no link is hard-coded active; activePath drives it instead.
  jsx = jsx.replace(/\s+aria-current=(?:"[^"]*"|\{[^}]*\})/g, '');
  jsx = jsx.replace(/className="([^"]*)"/g, (m, cls) => {
    const kept = cls.split(/\s+/).filter((c) => !/^(active|is-active|is-current|current|selected|w--current|w--currentp)$/i.test(c)).join(' ');
    return kept ? `className="${kept}"` : '';
  });
  // inject a conditional aria-current on every <a href="…"> (CSS keyed off [aria-current=page]
  // — best practice, the VyndHub clone uses it — gets the active style automatically). Scan for the
  // open-tag end tracking quotes + brace depth: a regex on `>` breaks on the `>` inside a JSX
  // expression like the `{...({…} as Record<string, string>)}` spread.
  let injected = '', k = 0;
  while (k < jsx.length) {
    const at = jsx.indexOf('<a', k);
    if (at === -1) { injected += jsx.slice(k); break; }
    injected += jsx.slice(k, at + 2);
    k = at + 2;
    if (!/[\s/>]/.test(jsx[at + 2] || '')) continue; // <article>/<aside>, not <a>
    // scan to the open-tag end, tracking quotes + brace depth (skip '>' inside "" or {…})
    let j = at + 2, q = null, depth = 0;
    while (j < jsx.length) {
      const c = jsx[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
      j++;
    }
    const rest = jsx.slice(at + 2, j); // attrs between "<a" and the closing ">"
    const hrefM = rest.match(/\bhref=("[^"]*"|\{[^}]*\})/);
    injected += rest + (hrefM ? ` aria-current={_active(${hrefM[1]}) ? "page" : undefined}` : '') + '>';
    k = j + 1;
  }
  jsx = injected;
  return `/**
 * ${name} — componentized from ${origin} by componentize-routes.mjs (C2, parameterized).
 * One navbar for every route: pass activePath="/slug/" and each link's aria-current is set by
 * an href match. If the original styled the active link with a CLASS, wire that class to the
 * same match (or style [aria-current=page] in globals.css).
 */
export function ${name}({ activePath = "" }: { activePath?: string }) {
  const _norm = (p: string) => (p.replace(/\\/+$/, "") || "/");
  const _active = (href: string) => {
    const a = _norm(activePath), h = _norm(href);
    return a === h || (h !== "/" && a.startsWith(h + "/"));
  };
  return (
${jsx}  );
}
`;
}

/** Dispatcher: classify the section and emit C1 or C2, counting into `stats`. */
function emitSection(name, node, bodyHTML, origin, stats) {
  const { innerFrom, innerTo } = openTagOf(bodyHTML, node);
  const inner = bodyHTML.slice(innerFrom, innerTo);
  if (shouldEmitC2(node, inner)) { if (stats) stats.c2++; return emitC2Section(name, node, origin); }
  if (stats) stats.c1++;
  return emitC1Section(name, node.tag, jsxAttrs(node.attrs || '', node.tag), inner, origin);
}

/** Plan all components across routes: dedupe byte-identical sections into shared/. */
export function planComponents(routes) {
  // routes: Map<slug, bodyHTML>
  const occurrences = new Map(); // hash -> { html, node-ish, name, slugs:[], }
  const perRoute = new Map();    // slug -> { wrapper, parts:[ ...with section refs ] }
  for (const [slug, body] of routes) {
    const layout = walkRoute(body);
    const named = new Map();
    const nameFor = (node) => {
      let n = deriveName(node.tag, node.attrs);
      const c = (named.get(n) || 0) + 1;
      named.set(n, c);
      return c > 1 ? `${n}${c}` : n;
    };
    const annotate = (node) => {
      const h = sha1(node.html);
      const name = nameFor(node);
      if (!occurrences.has(h)) occurrences.set(h, { node, name, slugs: [] });
      occurrences.get(h).slugs.push(slug);
      return { node, hash: h, name };
    };
    const parts = layout.parts.map((p) => (p.kind === 'main'
      ? { ...p, children: p.children.map(annotate) }
      : { kind: 'section', ...annotate(p.node) }));
    const wrapper = layout.wrapper
      ? {
          ...layout.wrapper,
          siblingsBefore: layout.wrapper.siblingsBefore.map(annotate),
          siblingsAfter: layout.wrapper.siblingsAfter.map(annotate),
        }
      : null;
    perRoute.set(slug, { wrapper, parts, body });
  }
  // shared = byte-identical in >= 2 routes; names deduped across the shared set.
  // Keep the derived name as-is (no digit stripping) — a suffix then unambiguously
  // means "Nth distinct shared component of this derived type".
  const shared = new Map(); // hash -> exported name
  const sharedNames = new Set();
  for (const [h, occ] of occurrences) {
    if (new Set(occ.slugs).size < 2) continue;
    let n = occ.name; let i = 2;
    while (sharedNames.has(n)) n = `${occ.name}${i++}`;
    sharedNames.add(n);
    shared.set(h, n);
  }
  return { perRoute, shared, occurrences, sharedNames };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const WS = process.cwd();
  const ROUTES_DIR = path.join(WS, flag('--routes-dir', 'src/generated/routes'));
  const OUT_SECTIONS = path.join(WS, flag('--out-sections', 'src/components/sections'));
  const OUT_PAGES = path.join(WS, flag('--out-pages', 'src/components/pages'));
  const GEN = path.join(WS, flag('--gen', 'src/generated'));
  const ONLY = flag('--routes') ? new Set(flag('--routes').split(',').map((s) => s.trim())) : null;
  const DRY = has('--dry-run');

  if (!fs.existsSync(ROUTES_DIR)) {
    console.error(`componentize-routes: no route JSONs at ${ROUTES_DIR} — run from a markup-port clone workspace.`);
    process.exit(2);
  }
  const routes = new Map();
  for (const f of fs.readdirSync(ROUTES_DIR).filter((x) => x.endsWith('.json') && x !== 'manifest.json')) {
    const slug = f.replace(/\.json$/, '');
    if (ONLY && !ONLY.has(slug)) continue;
    const data = JSON.parse(fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8'));
    if (data.bodyHTML) routes.set(slug, data.bodyHTML);
  }
  if (!routes.size) { console.error('componentize-routes: no routes matched.'); process.exit(2); }

  const { perRoute, shared, sharedNames } = planComponents(routes);

  let filesWritten = 0;
  const write = (file, content) => {
    filesWritten++;
    if (DRY) { process.stderr.write(`  [dry] ${path.relative(WS, file)}\n`); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  };
  const stats = { c2: 0, c1: 0 };
  const slugPath = (slug) => (slug === 'index' ? '/' : '/' + slug.split('__').join('/') + '/');
  const isNavbar = (s) => s.node && deriveName(s.node.tag, s.node.attrs || '') === 'Navbar';
  let navbarEmitted = false; // the navbar is unified into ONE shared C2 component with activePath

  // 1. shared components (emit once, from the first occurrence's node)
  const emittedShared = new Set();
  for (const [slug, { parts, wrapper, body }] of perRoute) {
    const all = [
      ...(wrapper ? [...wrapper.siblingsBefore, ...wrapper.siblingsAfter] : []),
      ...parts.flatMap((p) => (p.kind === 'main' ? p.children : [p])),
    ];
    for (const s of all) {
      if (isNavbar(s)) continue; // navbars handled specially in step 2 (unified w/ activePath)
      const sharedName = shared.get(s.hash);
      if (sharedName && !emittedShared.has(s.hash)) {
        emittedShared.add(s.hash);
        write(path.join(OUT_SECTIONS, 'shared', `${sharedName}.tsx`),
          emitSection(sharedName, s.node, body, `route "${slug}" (byte-identical across routes)`, stats));
      }
    }
  }

  // 2. per-route sections + page composition
  const pageEntries = [];
  for (const [slug, { wrapper, parts, body }] of perRoute) {
    const pageName = `${pascal(slug)}Page`;
    const imports = new Map(); // name -> import path
    const refFor = (s) => {
      // Navbar: one shared, parameterized C2 component for ALL routes (emit once).
      if (isNavbar(s)) {
        if (!navbarEmitted) {
          navbarEmitted = true; stats.c2++;
          write(path.join(OUT_SECTIONS, 'shared', 'Navbar.tsx'),
            emitNavbar('Navbar', s.node, `route "${slug}" (unified across routes)`));
        }
        imports.set('Navbar', '@/components/sections/shared/Navbar');
        return { name: 'Navbar', activePath: slugPath(slug) };
      }
      const sharedName = shared.get(s.hash);
      if (sharedName) {
        imports.set(sharedName, `@/components/sections/shared/${sharedName}`);
        return { name: sharedName };
      }
      // avoid a per-route export sharing its name with a DIFFERENT shared component
      // (legal TS, but confusing during review) — qualify with the route name.
      const name = sharedNames.has(s.name) ? `${pascal(slug)}${s.name}` : s.name;
      imports.set(name, `@/components/sections/${slug}/${name}`);
      write(path.join(OUT_SECTIONS, slug, `${name}.tsx`), emitSection(name, s.node, body, `route "${slug}"`, stats));
      return { name };
    };
    const renderList = (list, indent) => list.map((s) => {
      const r = refFor(s);
      return r.activePath ? `${indent}<${r.name} activePath=${JSON.stringify(r.activePath)} />` : `${indent}<${r.name} />`;
    }).join('\n');
    let inner = '';
    for (const p of parts) {
      if (p.kind === 'main') {
        inner += `      <main${jsxAttrs(p.attrs || '', 'main')}>\n${renderList(p.children, '        ')}\n      </main>\n`;
      } else {
        inner += `${renderList([p], '      ')}\n`;
      }
    }
    let bodyJsx;
    if (wrapper) {
      const before = wrapper.siblingsBefore.length ? renderList(wrapper.siblingsBefore, '      ') + '\n' : '';
      const after = wrapper.siblingsAfter.length ? renderList(wrapper.siblingsAfter, '      ') + '\n' : '';
      bodyJsx = `${before}      <${wrapper.tag}${jsxAttrs(wrapper.attrs || '', wrapper.tag)}>\n${inner.replace(/^/gm, '  ')}      </${wrapper.tag}>\n${after}`;
    } else {
      bodyJsx = inner;
    }
    const importLines = [...imports.entries()].map(([n, p]) => `import { ${n} } from "${p}";`).join('\n');
    write(path.join(OUT_PAGES, `${pageName}.tsx`),
      `/**
 * ${pageName} — composed from route "${slug}" by componentize-routes.mjs.
 * Order and shell (wrappers/<main>) match the original DOM exactly.
 * The Navbar is the one shared, parameterized component (activePath drives the active link).
 */
${importLines}

export function ${pageName}() {
  return (
    <>
${bodyJsx}    </>
  );
}
`);
    pageEntries.push([slug, pageName]);
  }

  // 3. pages map + catch-all example
  write(path.join(GEN, 'pages-map.tsx'),
    `/** slug → composed page component (generated by componentize-routes.mjs). */
import type { ComponentType } from "react";
${pageEntries.map(([, n]) => `import { ${n} } from "@/components/pages/${n}";`).join('\n')}

export const PAGES: Record<string, ComponentType> = {
${pageEntries.map(([s, n]) => `  ${JSON.stringify(s)}: ${n},`).join('\n')}
};
`);

  write(path.join(GEN, 'page.componentized.example.tsx'),
    `/**
 * EXAMPLE catch-all page for the componentized clone — adapt your existing
 * src/app/[[...slug]]/page.tsx to render PAGES[key] instead of the bodyHTML blob.
 * Keep generateStaticParams/generateMetadata/MarkupPortRuntime exactly as they are
 * (the route JSON still provides metadata + the replayed scripts); only the body
 * render changes:
 *
 *   const C = PAGES[slugArrToKey(slug)];
 *   {C ? <C /> : <div style={{display:"contents"}} suppressHydrationWarning
 *                     dangerouslySetInnerHTML={{ __html: route.bodyHTML }} />}
 *
 * Then: npm run build && re-run the FULL qa-diff gate (must stay 0-flagged).
 */
export {};
`);

  // 4. ambient JSX types for custom-element tags (hyphenated, like <astro-island>, <inkeep-portal>)
  //    — strict TS rejects them as unknown intrinsic elements. C2 transpile INLINES the whole
  //    subtree, so a custom element can appear DEEP inside a section (not just as the host) — scan
  //    every section's full HTML for `<x-y` tags, not only the section/wrapper tag. Over-declaring
  //    (a custom element that only appears in a C1 blob) is harmless.
  const customEls = new Set();
  const CE_RE = /<([a-z][a-z0-9]*-[a-z0-9-]*)[\s/>]/gi;
  for (const [, { parts, wrapper, body: _b }] of perRoute) {
    const nodes = [
      ...(wrapper ? [...wrapper.siblingsBefore, ...wrapper.siblingsAfter] : []),
      ...parts.flatMap((p) => (p.kind === 'main' ? p.children : [p])),
    ];
    for (const s of nodes) if (s.node) for (const m of s.node.html.matchAll(CE_RE)) customEls.add(m[1].toLowerCase());
    if (wrapper && wrapper.tag.includes('-')) customEls.add(wrapper.tag);
  }
  // C2 sections inline `style={{ "--x": … }}` custom props, which @types/react's CSSProperties
  // rejects by default — ship a one-line ambient augmentation so every C2 component compiles.
  if (stats.c2 > 0) {
    write(path.join(WS, flag('--types', 'src/types'), 'css-properties.d.ts'),
      `// Allow CSS custom properties (--x) in style objects on C2 components (componentize-routes.mjs).\n` +
      `import "react";\n\ndeclare module "react" {\n  interface CSSProperties {\n    [key: \`--\${string}\`]: string | number | undefined;\n  }\n}\n`);
  }
  if (customEls.size) {
    write(path.join(WS, flag('--types', 'src/types'), 'custom-elements.d.ts'),
      `// Ambient JSX types for custom-element hosts emitted by componentize-routes.mjs.\n` +
      `// Without these, strict TS rejects e.g. <${[...customEls][0]}> as an unknown intrinsic element.\n` +
      `import type { DetailedHTMLProps, HTMLAttributes } from "react";\n\n` +
      `declare module "react" {\n  namespace JSX {\n    interface IntrinsicElements {\n` +
      [...customEls].sort().map((t) => `      ${JSON.stringify(t)}: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;`).join('\n') +
      `\n    }\n  }\n}\n`);
  }

  const total = stats.c2 + stats.c1;
  process.stderr.write(
    `componentize-routes: ${routes.size} route(s) → ${pageEntries.length} page(s), ` +
    `${shared.size} shared component(s), ${filesWritten} file(s)${DRY ? ' (dry-run)' : ''}\n` +
    `  sections: ${stats.c2} C2 (editable JSX) / ${stats.c1} C1 (JS-driven verbatim)` +
    `${total ? ` — ${Math.round((stats.c2 / total) * 100)}% editable` : ''}\n` +
    `  Next: adapt app/[[...slug]]/page.tsx per src/generated/page.componentized.example.tsx,\n` +
    `  npm run build, and re-run the full qa-diff gate.\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
