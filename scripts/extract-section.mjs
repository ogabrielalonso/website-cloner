#!/usr/bin/env node

/**
 * extract-section.mjs — extract one section of a markup-port clone as a reusable
 * React component, ON DEMAND. The bridge between "pixel-perfect replica" and
 * "editable/reusable code" — without touching the proven markup-port pipeline.
 *
 * Reads the route JSON the clone already has (src/generated/routes/<slug>.json),
 * finds the natural sections (direct children of <main>, plus navbar/footer/
 * global-style blocks wherever they live — handles all structural variants:
 * Webflow page-wrapper, Astro flat header/main/footer, navbar-inside-main pages),
 * and emits src/components/sections/<Name>.tsx.
 *
 * Two output modes:
 *   C1 (default)  — the section's REAL HTML wrapped in dangerouslySetInnerHTML.
 *                   Zero fidelity risk (byte-identical markup), editable as HTML.
 *   C2 (--c2)     — the HTML transpiled to real JSX (class→className, style
 *                   strings→objects, kebab attrs→camelCase, islands kept via
 *                   per-node dangerouslySetInnerHTML). Fully editable React code.
 *                   RECOMMENDED ONLY for clean component markup (Astro). Webflow
 *                   commerce islands / vendor-prefixed inline styles are safer in
 *                   C1. Sections > 30kB fall back to C1 (pass --force to override).
 *
 * --with-css additionally emits <Name>.extracted.css: a best-effort slice of the
 * clone's globals.css containing the rules that mention the section's classes,
 * plus the :root token blocks, html/body base rules, @font-face, and the
 * @keyframes those rules animate — what a transplant into another project needs.
 *
 * Usage (from the clone workspace root):
 *   node scripts/extract-section.mjs --route index --list
 *   node scripts/extract-section.mjs --route index --section hero
 *   node scripts/extract-section.mjs --route about --section team --c2
 *   node scripts/extract-section.mjs --route index --section footer --with-css
 * Flags: --routes-dir src/generated/routes · --out src/components/sections ·
 *        --css src/app/globals.css · --force (override the 30kB C2 cap)
 *
 * The component depends on the clone's stylesheet — copy the extracted CSS (or
 * the clone's globals.css) into the destination project. Behavior driven by the
 * site's replayed scripts is NOT bundled (static markup + styles only).
 *
 * Pure Node built-ins. Zero new dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const has = (n) => args.includes(n);

// ─── Minimal HTML structural parser (void/rawtext-aware, quote-safe) ─────────

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAWTEXT = new Set(['script', 'style', 'textarea', 'title']);

// Match one tag from position i. Attribute values may contain ">" — consume
// quoted strings as units. Returns { tag, attrs, selfClosing, closing, end } or null.
function readTag(html, i) {
  if (html[i] !== '<') return null;
  if (html.startsWith('<!--', i)) {
    const end = html.indexOf('-->', i + 4);
    return { comment: true, end: end === -1 ? html.length : end + 3 };
  }
  if (html.startsWith('<!', i)) { // doctype etc — skip to next '>'
    const end = html.indexOf('>', i);
    return { comment: true, end: end === -1 ? html.length : end + 1 };
  }
  const closing = html[i + 1] === '/';
  let j = i + (closing ? 2 : 1);
  const nameStart = j;
  while (j < html.length && /[a-zA-Z0-9:-]/.test(html[j])) j++;
  const tag = html.slice(nameStart, j).toLowerCase();
  if (!tag) return null;
  // consume to '>', honoring quotes
  let attrs = '';
  const attrStart = j;
  while (j < html.length) {
    const c = html[j];
    if (c === '"' || c === "'") {
      const q = html.indexOf(c, j + 1);
      j = q === -1 ? html.length : q + 1;
    } else if (c === '>') {
      attrs = html.slice(attrStart, j);
      break;
    } else j++;
  }
  const selfClosing = /\/\s*$/.test(attrs) || VOID.has(tag);
  return { tag, attrs: attrs.replace(/\/\s*$/, '').trim(), selfClosing, closing, end: j + 1 };
}

/**
 * childrenOf(html, from, to) → direct children of the region [from,to) as
 * [{ kind: 'element'|'text', tag, attrs, start, end, html }] — the structural
 * walker behind --list / extraction. Rawtext elements (script/style/…) are
 * skipped to their literal close tag so embedded "<" can't derail depth.
 */
export function childrenOf(html, from = 0, to = html.length) {
  const out = [];
  let i = from;
  let textStart = from;
  const flushText = (upto) => {
    const t = html.slice(textStart, upto);
    if (t.trim()) out.push({ kind: 'text', start: textStart, end: upto, html: t });
  };
  while (i < to) {
    if (html[i] !== '<') { i++; continue; }
    const t = readTag(html, i);
    if (!t) { i++; continue; }
    if (t.comment) { flushText(i); i = t.end; textStart = i; continue; }
    if (t.closing) { flushText(i); i = t.end; textStart = i; continue; } // stray close at this level
    flushText(i);
    const start = i;
    if (t.selfClosing) {
      out.push({ kind: 'element', tag: t.tag, attrs: t.attrs, start, end: t.end, html: html.slice(start, t.end) });
      i = t.end; textStart = i; continue;
    }
    if (RAWTEXT.has(t.tag)) {
      const close = html.toLowerCase().indexOf(`</${t.tag}`, t.end);
      const end = close === -1 ? to : html.indexOf('>', close) + 1;
      out.push({ kind: 'element', tag: t.tag, attrs: t.attrs, start, end, html: html.slice(start, end) });
      i = end; textStart = i; continue;
    }
    // scan forward for the matching close of t.tag, tracking depth of SAME tag
    // via a generic open/close depth counter over all tags.
    let depth = 1;
    let k = t.end;
    while (k < to && depth > 0) {
      if (html[k] !== '<') { k++; continue; }
      const u = readTag(html, k);
      if (!u) { k++; continue; }
      if (u.comment) { k = u.end; continue; }
      if (RAWTEXT.has(u.tag) && !u.closing) {
        const close = html.toLowerCase().indexOf(`</${u.tag}`, u.end);
        k = close === -1 ? to : html.indexOf('>', close) + 1;
        continue;
      }
      if (!u.closing && !u.selfClosing) depth++;
      else if (u.closing) depth--;
      k = u.end;
    }
    out.push({ kind: 'element', tag: t.tag, attrs: t.attrs, start, end: k, html: html.slice(start, k) });
    i = k; textStart = i;
  }
  flushText(to);
  return out;
}

// ─── Section discovery & naming ──────────────────────────────────────────────

const attrOf = (attrs, name) => {
  const m = (attrs || '').match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3] ?? '') : null;
};
const pascal = (s) => s.split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

export function deriveName(tag, attrs) {
  const cls = attrOf(attrs, 'class') || '';
  if (/navbar_component|w-nav(\s|$)/.test(cls) || tag === 'nav' || tag === 'header') return 'Navbar';
  if (tag === 'footer' || /(^|\s)section_footer(\s|$)/.test(cls)) return 'Footer';
  if (/global-styles/.test(cls)) return 'GlobalStyles';
  if (/(^|\s)data-wf--/.test(attrs || '')) return 'TemplateWidget';
  const sec = cls.match(/section_([\w-]+)/);
  const ident = (name) => (/^[a-zA-Z_$][\w$]*$/.test(name) ? name : 'Section');
  if (sec) return ident(pascal(sec[1]) + 'Section');
  // Astro-style: first data-* attr that's not framework scoping
  const data = (attrs || '').match(/data-(?!astro-cid)(?!wf)([\w-]+)/);
  if (data) return ident(pascal(data[1]) + 'Section');
  // first class can be an arbitrary-Tailwind value (bg-[#050505]) or start with a
  // digit — both make invalid TS identifiers; fall back to plain 'Section'.
  if (cls) return ident(pascal(cls.split(/\s+/)[0]) + 'Section');
  return 'Section';
}

/**
 * findSections(bodyHTML) → flat candidate list [{ name, tag, classes, html, bytes }].
 * Structure-agnostic: unwraps a single page-wrapper root if present, then expands
 * any <main> into its direct children. Navbar/footer are recognized by tag/class
 * wherever they live (page-wrapper sibling OR inside main — both real variants).
 */
export function findSections(bodyHTML) {
  const inner = (node) => {
    // Use the tokenizer for the open tag's true end — a bare indexOf('>') would stop
    // inside an attribute value that contains '>'.
    const t = readTag(bodyHTML, node.start);
    const from = t ? t.end : bodyHTML.indexOf('>', node.start) + 1;
    const to = bodyHTML.lastIndexOf('</', node.end);
    return childrenOf(bodyHTML, from, to).filter((n) => n.kind === 'element');
  };
  // Recursively expand structural containers (page-wrapper divs and <main>)
  // wherever they sit — the wrapper may have siblings (e.g. a vendor widget
  // next to page-wrapper), and navbar/footer may live inside <main> on some
  // routes. Everything that isn't a container is a section candidate.
  const expand = (node) => {
    const cls = attrOf(node.attrs, 'class') || '';
    if (/(^|\s)(page-wrapper|page_wrapper)(\s|$)/.test(cls) || node.tag === 'main') {
      const kids = inner(node);
      return kids.length ? kids.flatMap(expand) : [node];
    }
    return [node];
  };
  const sections = childrenOf(bodyHTML).filter((n) => n.kind === 'element').flatMap(expand);
  const seen = new Map();
  return sections.map((s) => {
    let name = deriveName(s.tag, s.attrs);
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name}${n}`;
    return { name, tag: s.tag, classes: (attrOf(s.attrs, 'class') || '').slice(0, 80), html: s.html, bytes: s.html.length };
  });
}

// ─── C1 emission: template-literal escaping (round-trip safe) ────────────────

export const escapeTemplate = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
export const unescapeTemplate = (s) => s.replace(/\\\$\{/g, '${').replace(/\\`/g, '`').replace(/\\\\/g, '\\');

function emitC1(name, html, meta) {
  return `/**
 * ${name} — extracted from route "${meta.route}" of ${meta.site} by extract-section.mjs (C1).
 *
 * The markup below is the ORIGINAL site's HTML, verbatim (same DOM = same fidelity).
 * It depends on the clone's stylesheet: bring ${name}.extracted.css (run with
 * --with-css) or the clone's src/app/globals.css into the destination project.
 * Behavior driven by the site's replayed scripts is NOT bundled.
 */
const html = \`${escapeTemplate(html)}\`;

export function ${name}() {
  return (
    <div
      style={{ display: "contents" }}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
`;
}

// ─── C2 emission: deterministic HTML → JSX transpile ─────────────────────────

// Build a child tree (elements + text) for JSX emission.
function parseTree(html, from = 0, to = html.length) {
  const nodes = [];
  let i = from;
  let textStart = from;
  const flushText = (upto) => {
    if (upto > textStart) nodes.push({ kind: 'text', text: html.slice(textStart, upto) });
  };
  while (i < to) {
    if (html[i] !== '<') { i++; continue; }
    const t = readTag(html, i);
    if (!t) { i++; continue; }
    flushText(i);
    if (t.comment) { i = t.end; textStart = i; continue; } // drop comments
    if (t.closing) { i = t.end; textStart = i; continue; }
    if (t.selfClosing) {
      nodes.push({ kind: 'element', tag: t.tag, attrs: t.attrs, children: [] });
      i = t.end; textStart = i; continue;
    }
    if (RAWTEXT.has(t.tag)) {
      const close = html.toLowerCase().indexOf(`</${t.tag}`, t.end);
      const contentEnd = close === -1 ? to : close;
      nodes.push({ kind: 'raw', tag: t.tag, attrs: t.attrs, content: html.slice(t.end, contentEnd) });
      i = close === -1 ? to : html.indexOf('>', close) + 1; textStart = i; continue;
    }
    // find matching close (same generic depth logic as childrenOf)
    let depth = 1; let k = t.end;
    while (k < to && depth > 0) {
      if (html[k] !== '<') { k++; continue; }
      const u = readTag(html, k);
      if (!u) { k++; continue; }
      if (u.comment) { k = u.end; continue; }
      if (RAWTEXT.has(u.tag) && !u.closing) {
        const close = html.toLowerCase().indexOf(`</${u.tag}`, u.end);
        k = close === -1 ? to : html.indexOf('>', close) + 1; continue;
      }
      if (!u.closing && !u.selfClosing) depth++;
      else if (u.closing) depth--;
      k = u.end;
    }
    const innerFrom = t.end;
    const innerTo = html.lastIndexOf('</', k);
    nodes.push({ kind: 'element', tag: t.tag, attrs: t.attrs, children: parseTree(html, innerFrom, innerTo) });
    i = k; textStart = i;
  }
  flushText(to);
  return nodes;
}

const JSX_ATTR = { class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength', autocomplete: 'autoComplete', autofocus: 'autoFocus', autoplay: 'autoPlay', crossorigin: 'crossOrigin', srcset: 'srcSet', frameborder: 'frameBorder', allowfullscreen: 'allowFullScreen', contenteditable: 'contentEditable', spellcheck: 'spellCheck', enctype: 'encType', novalidate: 'noValidate', playsinline: 'playsInline',
  // more HTML attrs React expects camelCased
  inputmode: 'inputMode', accesskey: 'accessKey', autocapitalize: 'autoCapitalize', referrerpolicy: 'referrerPolicy', fetchpriority: 'fetchPriority', hreflang: 'hrefLang', formaction: 'formAction', formmethod: 'formMethod', formtarget: 'formTarget', formnovalidate: 'formNoValidate', charset: 'charSet', datetime: 'dateTime', itemprop: 'itemProp', itemtype: 'itemType', itemid: 'itemID', itemref: 'itemRef', itemscope: 'itemScope', usemap: 'useMap', srclang: 'srcLang', nomodule: 'noModule', httpequiv: 'httpEquiv', colspan: 'colSpan', rowspan: 'rowSpan',
  // camelCase SVG attrs React expects — if the source lowercased them (camelCase rawNames are
  // otherwise preserved by the plain branch; hyphenated SVG attrs pass through via the spread).
  viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', patternunits: 'patternUnits', patterncontentunits: 'patternContentUnits', patterntransform: 'patternTransform', clippathunits: 'clipPathUnits', maskunits: 'maskUnits', maskcontentunits: 'maskContentUnits', markerheight: 'markerHeight', markerwidth: 'markerWidth', markerunits: 'markerUnits', refx: 'refX', refy: 'refY', stopcolor: 'stopColor', stopopacity: 'stopOpacity', stddeviation: 'stdDeviation', basefrequency: 'baseFrequency', numoctaves: 'numOctaves', startoffset: 'startOffset', textlength: 'textLength', lengthadjust: 'lengthAdjust', pathlength: 'pathLength', spreadmethod: 'spreadMethod' };
const HTML_BOOL = new Set(['allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'hidden', 'inert', 'loop', 'multiple', 'muted', 'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected']);

// SVG ELEMENT names React expects in camelCase. The HTML parser lowercases tags, so a C2
// transpile would emit `<fegaussianblur>` / `<lineargradient>` which strict TS rejects as
// unknown intrinsic elements. Map them back. (Plain lowercase SVG tags — rect, path, g — are fine.)
const SVG_TAG = Object.fromEntries(['feGaussianBlur', 'feColorMatrix', 'feOffset', 'feBlend', 'feFlood', 'feComposite', 'feMerge', 'feMergeNode', 'feMorphology', 'feDropShadow', 'feImage', 'feTile', 'feTurbulence', 'feDisplacementMap', 'feConvolveMatrix', 'feComponentTransfer', 'feDiffuseLighting', 'feSpecularLighting', 'feDistantLight', 'fePointLight', 'feSpotLight', 'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA', 'linearGradient', 'radialGradient', 'clipPath', 'textPath', 'foreignObject', 'animateMotion', 'animateTransform'].map((t) => [t.toLowerCase(), t]));
const jsxTag = (tag) => SVG_TAG[tag] || tag;
// Element-specific boolean attrs are only valid on certain tags (`disabled` on <a> is a TS error).
// hidden/inert are global. Unknown tag → assume valid (backward-compatible).
const BOOL_TAGS = {
  disabled: 'button,input,select,textarea,optgroup,option,fieldset', checked: 'input', selected: 'option',
  required: 'input,textarea,select', readonly: 'input,textarea', multiple: 'input,select',
  autofocus: 'button,input,select,textarea', controls: 'audio,video', loop: 'audio,video', muted: 'audio,video',
  autoplay: 'audio,video', playsinline: 'audio,video', default: 'track', open: 'details,dialog', reversed: 'ol',
  novalidate: 'form', allowfullscreen: 'iframe',
};
const boolOk = (lower, tag) => !tag || lower === 'hidden' || lower === 'inert' || !BOOL_TAGS[lower] || BOOL_TAGS[lower].split(',').includes(tag);
// Attributes React types as a NUMBER — emit `rows={6}` not `rows="6"` (else TS2322 string≠number).
const NUMERIC_ATTR = new Set(['tabindex', 'maxlength', 'minlength', 'rows', 'cols', 'size', 'span', 'start', 'rowspan', 'colspan']);
// Standard HTML + SVG attributes that are SAFE to emit as named JSX props. Anything NOT here
// (framework attrs like Vue's `exact`, capitalized `Title`, Webflow customs, unknowns) routes to
// the Record<string,string> spread so it renders verbatim AND always type-checks. Deliberately
// EXCLUDES context-sensitive standard attrs (value/loading/selected/checked/multiple) that are
// valid only on specific elements (`value` on <a> is a TS error) → those spread too.
// (HTML attrs React wants camelCased — inputmode, fetchpriority, hreflang, charset… — live in
// JSX_ATTR above, NOT here, so they're emitted as inputMode/fetchPriority/… and not lowercased.)
const SAFE_ATTR = new Set([
  // global
  'id', 'title', 'lang', 'dir', 'role', 'slot', 'translate', 'draggable', 'nonce', 'color', 'part', 'popover',
  // links / media / embeds
  'href', 'src', 'alt', 'type', 'rel', 'target', 'download', 'ping', 'media', 'sizes', 'decoding',
  'poster', 'preload', 'kind', 'label', 'coords', 'shape', 'content', 'integrity', 'manifest',
  'allow', 'sandbox', 'width', 'height', 'cite', 'open',
  // forms
  'name', 'placeholder', 'action', 'method', 'accept', 'pattern', 'step', 'max', 'min', 'list', 'dirname',
  'form', 'formaction', 'formmethod', 'formtarget', 'wrap', 'autocomplete', 'capture', 'low', 'high', 'optimum',
  // tables
  'headers', 'scope', 'abbr',
  // SVG geometry / presentation that are plain (camelCase ones live in JSX_ATTR; hyphenated ones spread)
  'd', 'fill', 'stroke', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points', 'transform',
  'opacity', 'offset', 'result', 'in', 'in2', 'mode', 'operator', 'values', 'scale', 'order', 'divisor', 'bias',
  'seed', 'version', 'mask', 'clip', 'filter', 'display', 'visibility', 'overflow', 'cursor', 'direction', 'xmlns',
]);

// Split declarations on ';' ONLY at paren depth 0 — a data URI like
// url(data:image/png;base64,…) contains ';' inside url() and must not be cut.
function splitDecls(style) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of style) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ';' && depth <= 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function styleToObject(style) {
  const entries = [];
  for (const decl of splitDecls(style)) {
    const c = decl.indexOf(':');
    if (c === -1) continue;
    const prop = decl.slice(0, c).trim();
    const val = decl.slice(c + 1).trim();
    if (!prop) continue;
    let key;
    if (prop.startsWith('--')) key = JSON.stringify(prop);
    else {
      // Leading-hyphen camelCase already capitalizes vendor prefixes (-webkit-mask →
      // WebkitMask — what React wants for webkit/moz/o). React's ONE exception: -ms-
      // must stay lowercase (msTransform), so undo the capital for Ms*.
      key = prop.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (/^Ms[A-Z]/.test(key)) key = 'ms' + key.slice(2);
      if (!/^[a-zA-Z_$][\w$]*$/.test(key)) key = JSON.stringify(key);
    }
    entries.push(`${key}: ${JSON.stringify(val)}`);
  }
  return `{{ ${entries.join(', ')} }}`;
}

export function jsxAttrs(attrsStr, tag) {
  const out = [];
  // Framework directive / custom attrs (Alpine x-data/@click/x-cloak, HTMX hx-get, Vue
  // :class/v-if, hyperscript _) must reach the DOM VERBATIM — React renders them as-is, but
  // camelCasing breaks the directive and emitting them as named JSX props fails strict TS on
  // intrinsic elements. Collect them into one spread cast to Record<string,string> (verified
  // to compile clean in React 19 strict) so the DOM is correct AND the clone builds.
  const spread = [];
  // name-start now also accepts @ (Alpine @click) and the body accepts @ . so x-on:click.away
  // and :class survive as single names.
  const re = /([@a-zA-Z_:][\w:.@-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(attrsStr || ''))) {
    const rawName = m[1];
    const val = m[3] ?? m[4] ?? m[5];
    const lower = rawName.toLowerCase();
    if (lower === 'style' && val !== undefined) { out.push(`style=${styleToObject(val)}`); continue; }
    if (lower.startsWith('data-') || lower.startsWith('aria-')) {
      // data-/aria- are valid React props as-is (and querySelector('[data-x]') needs them)
      out.push(val === undefined ? `${lower}=""` : `${lower}=${JSON.stringify(val)}`);
      continue;
    }
    const numeric = NUMERIC_ATTR.has(lower) && val !== undefined && /^-?\d+$/.test(val.trim());
    // Boolean HTML attrs are TRUE when present, regardless of value (`disabled="disabled"`,
    // `hidden`, `selected="selected"`) → emit BARE; emitting the string fails React's boolean type.
    // But an element-specific boolean on the WRONG tag (`disabled` on <a>) is a TS error → spread
    // it verbatim (renders the attr, non-functional exactly like the original).
    if (HTML_BOOL.has(lower)) {
      if (boolOk(lower, tag)) out.push(JSX_ATTR[lower] || lower);
      else spread.push(`${JSON.stringify(lower)}: ""`);
      continue;
    }
    if (JSX_ATTR[lower]) {
      const name = JSX_ATTR[lower];
      out.push(val === undefined ? `${name}=""` : numeric ? `${name}={${val.trim()}}` : `${name}=${JSON.stringify(val)}`);
      continue;
    }
    if (/[-:@.]/.test(rawName)) {
      // custom hyphenated / namespaced / Alpine-shorthand attr → verbatim via spread
      spread.push(`${JSON.stringify(rawName)}: ${JSON.stringify(val === undefined ? '' : val)}`);
      continue;
    }
    if (numeric) { out.push(`${lower}={${val.trim()}}`); continue; } // rows={6}, cols={4}…
    // Plain attr NOT in the safe standard-HTML/SVG allowlist (framework attrs like `exact`,
    // capitalized `Title`, context-invalid `value` on <a>, unknowns) → spread (renders + compiles).
    if (!SAFE_ATTR.has(lower)) { spread.push(`${JSON.stringify(rawName)}: ${JSON.stringify(val === undefined ? '' : val)}`); continue; }
    // safe standard attribute → named prop (canonical lowercase; HTML attrs are case-insensitive)
    out.push(val === undefined ? `${lower}=""` : `${lower}=${JSON.stringify(val)}`);
  }
  if (spread.length) out.push(`{...({ ${spread.join(', ')} } as Record<string, string>)}`);
  return out.length ? ' ' + out.join(' ') : '';
}

// JSX text emission, two concerns in one single-pass-friendly order:
//   1. Whitespace: the browser collapses any run of whitespace to ONE space under
//      white-space:normal, but JSX *removes* a whitespace run that spans a newline (so source
//      "pipelines,\n   optimize" renders as "pipelines,optimize" — no space). Pre-collapse every
//      run to a single space here so the rendered text matches the browser. Leading/trailing
//      single spaces are preserved (significant for inline flow; CSS trims them at block edges).
//      <pre>/<textarea> are whitespace-significant and are emitted verbatim elsewhere, never here.
//   2. Escaping: `{` `}` break expressions; a raw `<` starts a tag and a raw `>` is rejected by TS
//      (TS1382). Escape all four AFTER collapsing — two chained passes would corrupt their own
//      output (the "}" inside the first escape gets re-escaped by the second).
const jsxText = (t) => t.replace(/\s+/g, ' ').replace(/[<>{}]/g, (c) => ({ '<': "{'<'}", '>': "{'>'}", '{': "{'{'}", '}': "{'}'}" }[c]));

function emitJsxNode(node, indent, pre = false) {
  const pad = '  '.repeat(indent);
  if (node.kind === 'text') {
    const t = node.text;
    if (pre) return `${pad}{${JSON.stringify(t)}}\n`; // inside <pre>: whitespace is significant → verbatim
    if (!t.trim()) {
      // whitespace-only: a same-line gap between inline elements is significant →
      // {" "}; a newline+indent gap is formatting → drop (matches browser collapse
      // in block context and standard JSX semantics).
      return t.includes('\n') ? '' : `${pad}{" "}\n`;
    }
    return `${pad}${jsxText(t.trim())}\n`;
  }
  if (node.kind === 'raw') {
    // React FORBIDS dangerouslySetInnerHTML on <textarea> (build-time prerender error) — its
    // content is the value → emit defaultValue (uncontrolled, renders the text statically).
    if (node.tag === 'textarea') return `${pad}<textarea${jsxAttrs(node.attrs, node.tag)} defaultValue={${JSON.stringify(node.content)}} />\n`;
    // <script>/<style>/<title> keep content verbatim via dangerouslySetInnerHTML.
    return `${pad}<${jsxTag(node.tag)}${jsxAttrs(node.attrs, node.tag)} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(node.content)} }} />\n`;
  }
  const open = `<${jsxTag(node.tag)}${jsxAttrs(node.attrs, node.tag)}`;
  if (!node.children || node.children.length === 0) return `${pad}${open} />\n`;
  // Inline emission is needed not only for real text, but also for a WHITESPACE-ONLY text node
  // that sits BETWEEN two element/raw siblings: that space separates inline elements
  // (`<a>…</a> <a>…</a>`), and block-mode would drop it → text re-wraps on narrow viewports.
  const sigSpace = (i) => {
    const prev = node.children[i - 1];
    const next = node.children[i + 1];
    return prev && next && prev.kind !== 'text' && next.kind !== 'text';
  };
  const hasInline = node.children.some((c, i) => c.kind === 'text' && (c.text.trim() || sigSpace(i)));
  const childPre = pre || node.tag === 'pre'; // <pre> descendants keep whitespace verbatim
  if (hasInline) {
    // mixed content: emit children INLINE to preserve original whitespace exactly.
    let inner = '';
    node.children.forEach((c, i) => {
      if (c.kind === 'text') {
        if (childPre) inner += `{${JSON.stringify(c.text)}}`; // verbatim inside <pre>
        else if (c.text.trim()) inner += jsxText(c.text);
        else if (sigSpace(i)) inner += "{' '}"; // significant separator space (browser collapses to one)
      } else if (c.kind === 'raw' && c.tag === 'textarea') inner += `<textarea${jsxAttrs(c.attrs, c.tag)} defaultValue={${JSON.stringify(c.content)}} />`;
      else if (c.kind === 'raw') inner += `<${jsxTag(c.tag)}${jsxAttrs(c.attrs, c.tag)} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(c.content)} }} />`;
      else inner += emitJsxNode(c, 0, childPre).trimEnd().replace(/\n\s*/g, '');
    });
    return `${pad}${open}>${inner}</${jsxTag(node.tag)}>\n`;
  }
  let out = `${pad}${open}>\n`;
  for (const c of node.children) out += emitJsxNode(c, indent + 1, childPre);
  out += `${pad}</${jsxTag(node.tag)}>\n`;
  return out;
}

export function htmlToJsx(html) {
  const tree = parseTree(html);
  return tree.filter((n) => n.kind !== 'text' || n.text.trim()).map((n) => emitJsxNode(n, 3)).join('');
}

function emitC2(name, html, meta) {
  const jsx = htmlToJsx(html);
  return `/**
 * ${name} — extracted from route "${meta.route}" of ${meta.site} by extract-section.mjs (C2 JSX).
 *
 * Deterministic transpile of the ORIGINAL markup (same DOM = same fidelity):
 * class→className, inline styles→objects, JSON/style islands kept verbatim.
 * Styling depends on the clone's stylesheet — bring ${name}.extracted.css
 * (--with-css) or globals.css. Replayed-script behavior is NOT bundled.
 */
export function ${name}() {
  return (
    <>
${jsx}    </>
  );
}
`;
}

// ─── --with-css: best-effort stylesheet slice for transplanting ──────────────

function cssBlocks(css) {
  // top-level blocks [{ prelude, body, start, end }] — body excludes outer braces.
  // Quoted strings are skipped when counting braces (content: "}" must not end a block).
  const blocks = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1; let j = open + 1;
    while (j < css.length && depth > 0) {
      const c = css[j];
      if (c === '"' || c === "'") {
        const q = css.indexOf(c, j + 1);
        j = q === -1 ? css.length : q + 1;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      j++;
    }
    blocks.push({ prelude, body: css.slice(open + 1, j - 1), start: i, end: j });
    i = j;
  }
  return blocks;
}

export function extractCss(fragmentHtml, css) {
  const classes = new Set();
  let m;
  const clsRe = /class\s*=\s*"([^"]*)"/g;
  while ((m = clsRe.exec(fragmentHtml))) for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  const tags = new Set([...fragmentHtml.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)].map((x) => x[1].toLowerCase()));
  // Compiled CSS stores special chars in class selectors CSS-ESCAPED (Tailwind
  // arbitrary values: class "bg-[#050505]" → selector ".bg-\[\#050505\]"), so each
  // special char must match with an OPTIONAL preceding backslash.
  const classRegex = (c) => {
    const pattern = [...c].map((ch) => {
      const esc = ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      return /[a-zA-Z0-9_-]/.test(ch) ? esc : `\\\\?${esc}`;
    }).join('');
    return new RegExp(`\\.${pattern}(?![\\w-])`);
  };
  const classRegexes = [...classes].map(classRegex);
  const matchesSelector = (sel) => {
    for (const re of classRegexes) if (re.test(sel)) return true;
    // tag-only rules for tags present in the fragment (typography baseline)
    const tagOnly = sel.split(',').some((s) => { const t = s.trim().split(/[\s>+~:.[]/)[0].toLowerCase(); return t && tags.has(t); });
    return tagOnly;
  };
  const keep = [];
  const usedAnimations = new Set();
  const walk = (cssText, wrap) => {
    for (const b of cssBlocks(cssText)) {
      if (/^@(media|supports|layer)/i.test(b.prelude)) {
        walk(b.body, wrap.concat(b.prelude));
      } else if (/^@font-face/i.test(b.prelude) || /^:root/.test(b.prelude) || /^(html|body)(\s|,|$|\{)/.test(b.prelude + '{')) {
        keep.push({ wrap, prelude: b.prelude, body: b.body });
      } else if (/^@keyframes/i.test(b.prelude)) {
        keep.push({ wrap, prelude: b.prelude, body: b.body, keyframes: b.prelude.replace(/^@keyframes\s+/i, '').trim() });
      } else if (matchesSelector(b.prelude)) {
        keep.push({ wrap, prelude: b.prelude, body: b.body });
        const anim = b.body.match(/animation(?:-name)?\s*:\s*([^;]+)/g) || [];
        for (const a of anim) for (const w of a.split(':')[1].split(/[\s,]+/)) if (/^[a-zA-Z_][\w-]*$/.test(w)) usedAnimations.add(w);
      }
    }
  };
  walk(css, []);
  const final = keep.filter((k) => !k.keyframes || usedAnimations.has(k.keyframes));
  // Statement at-rules (@import / @layer order) have no { } block, so cssBlocks never
  // sees them — carry them over verbatim (font imports + cascade order matter).
  const statements = css.match(/@(?:import|layer)\s+[^{;]+;/g) || [];
  // re-serialize, grouping identical wrappers
  let out = statements.length ? statements.join('\n') + '\n' : '';
  for (const k of final) {
    const openers = k.wrap.map((w) => `${w} {`).join('\n');
    const closers = '}\n'.repeat(k.wrap.length);
    out += `${openers}${openers ? '\n' : ''}${k.prelude} {${k.body}}\n${closers}`;
  }
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const WS = process.cwd();
  const ROUTES_DIR = path.join(WS, flag('--routes-dir', 'src/generated/routes'));
  const OUT_DIR = path.join(WS, flag('--out', 'src/components/sections'));
  const CSS_PATH = path.join(WS, flag('--css', 'src/app/globals.css'));
  const routeArg = flag('--route');
  const sectionArg = flag('--section');
  const C2 = has('--c2');
  const FORCE = has('--force');
  const WITH_CSS = has('--with-css');
  const C2_CAP = 30_000;

  if (!routeArg) {
    console.error('extract-section: --route <slug|path> is required (e.g. --route index, --route /about/)');
    process.exit(2);
  }
  if (!fs.existsSync(ROUTES_DIR)) {
    console.error(`extract-section: no route JSONs at ${ROUTES_DIR} — run from a markup-port clone workspace.`);
    process.exit(2);
  }

  // resolve route: exact slug, path → slug, or fuzzy contains
  const slugs = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json').map((f) => f.replace(/\.json$/, ''));
  const pathToSlug = (p) => (p === '/' ? 'index' : p.replace(/^\/+|\/+$/g, '').split('/').join('__'));
  let slug = slugs.includes(routeArg) ? routeArg : null;
  if (!slug) slug = slugs.includes(pathToSlug(routeArg)) ? pathToSlug(routeArg) : null;
  if (!slug) { const c = slugs.filter((s) => s.includes(routeArg)); if (c.length === 1) slug = c[0]; else if (c.length > 1) { console.error(`extract-section: ambiguous route "${routeArg}": ${c.join(', ')}`); process.exit(2); } }
  if (!slug) { console.error(`extract-section: route "${routeArg}" not found. Available: ${slugs.join(', ')}`); process.exit(2); }

  const route = JSON.parse(fs.readFileSync(path.join(ROUTES_DIR, slug + '.json'), 'utf8'));
  const sections = findSections(route.bodyHTML || '');
  const site = path.basename(WS);

  if (has('--list') || !sectionArg) {
    process.stderr.write(`extract-section: sections of "${slug}" (${sections.length}):\n`);
    sections.forEach((s, i) => process.stderr.write(`  ${String(i).padStart(2)}  ${s.name.padEnd(26)} <${s.tag}> ${Math.round(s.bytes / 1024)}kB  ${s.classes}\n`));
    if (!sectionArg) process.stderr.write(`\nPick one: node scripts/extract-section.mjs --route ${slug} --section <name|index>\n`);
    process.exit(0);
  }

  // resolve section: numeric index, exact name, or fuzzy (case-insensitive contains)
  let target = /^\d+$/.test(sectionArg) ? sections[Number(sectionArg)] : null;
  if (!target) {
    const lc = sectionArg.toLowerCase();
    const c = sections.filter((s) => s.name.toLowerCase() === lc);
    const c2 = c.length ? c : sections.filter((s) => s.name.toLowerCase().includes(lc) || s.classes.toLowerCase().includes(lc));
    if (c2.length === 1) target = c2[0];
    else if (c2.length > 1) { console.error(`extract-section: ambiguous section "${sectionArg}": ${c2.map((s) => s.name).join(', ')} — use the index.`); process.exit(2); }
  }
  if (!target) { console.error(`extract-section: section "${sectionArg}" not found in "${slug}". Run with --list.`); process.exit(2); }

  let mode = C2 ? 'C2' : 'C1';
  if (mode === 'C2' && target.bytes > C2_CAP && !FORCE) {
    process.stderr.write(`extract-section: ⚠ section is ${Math.round(target.bytes / 1024)}kB > ${C2_CAP / 1000}kB — JSX of a blob that size isn't meaningfully editable; falling back to C1 (pass --force to override).\n`);
    mode = 'C1';
  }

  const meta = { route: slug, site };
  const code = mode === 'C2' ? emitC2(target.name, target.html, meta) : emitC1(target.name, target.html, meta);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${target.name}.tsx`);
  fs.writeFileSync(outFile, code, 'utf8');
  process.stderr.write(`extract-section: ${mode} → ${path.relative(WS, outFile)} (${Math.round(code.length / 1024)}kB)\n`);

  if (WITH_CSS) {
    if (!fs.existsSync(CSS_PATH)) process.stderr.write(`extract-section: ⚠ no stylesheet at ${CSS_PATH} — skipping CSS slice.\n`);
    else {
      const css = extractCss(target.html, fs.readFileSync(CSS_PATH, 'utf8'));
      const cssFile = path.join(OUT_DIR, `${target.name}.extracted.css`);
      const header = `/* ${target.name}.extracted.css — best-effort slice of the clone's globals.css for\n * transplanting ${target.name} into another project: rules matching the section's\n * classes + :root tokens + html/body base + @font-face + used @keyframes.\n * Cascade/order nuances may need a manual pass — verify visually. */\n`;
      fs.writeFileSync(cssFile, header + css, 'utf8');
      process.stderr.write(`extract-section: css → ${path.relative(WS, cssFile)} (${Math.round(css.length / 1024)}kB)\n`);
    }
  }

  process.stderr.write(`\n  import { ${target.name} } from "@/components/sections/${target.name}";\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
