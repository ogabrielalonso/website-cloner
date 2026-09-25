#!/usr/bin/env node

/**
 * hybrid-postprocess.mjs — stack-aware fixup for a HYBRID markup-port clone.
 *
 * daytona.io is two stacks behind one origin: the home `/` is a Framer SPA, the 470
 * collection routes are an Astro v4 site. slice-routes is stack-agnostic, so this pass
 * applies the right treatment per route (detected from the route's own scripts/markup):
 *
 *   FRAMER route (externalScripts has framerusercontent.com/.../script_main.*.mjs):
 *     • drop analytics scripts (zeroclick, events.framer, GTM…)
 *     • promote the process.env.NODE_ENV polyfill to preInline (bundle reads it on eval)
 *     • inject the data-framer-appear-animation marker in preInline (bundle queries it)
 *     • drop the editor-only __framer_force_showing_editorbar preload
 *
 *   ASTRO route (references /_astro/…):
 *     • drop analytics scripts (external + inline PostHog)
 *     • promote HEAD inline scripts (captured by extract-head-css) to preInline so the
 *       anti-FOUC ThemeProvider exists before island hydration; dedupe them out of deferredInline
 *     • /_astro/ and /fonts/ are kept ROOT-RELATIVE (download them to public/) — a cross-origin
 *       CDN does NOT work for Astro: @font-face .otf/.ttf are CORS-restricted and the origin
 *       sends no CORS header → fonts fail → fallback-metric reflow (the 1–7% text-shift diff).
 *       (The Framer bundle stays on framerusercontent.com only because THAT CDN sends CORS.)
 *
 * Deterministic, idempotent, zero tokens. Run AFTER slice-routes + extract-head-css.
 *   node scripts/hybrid-postprocess.mjs
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const WS = process.cwd();
const ROUTES = path.join(WS, flag("--out", "src/generated"), "routes");

const ANALYTICS_HOSTS = [
  "zeroclick.ai", "events.framer.com", "googletagmanager.com",
  "google-analytics.com", "doubleclick.net", "hotjar.com", "segment.com", "segment.io",
];
const isAnalytics = (src) => ANALYTICS_HOSTS.some((h) => src.includes(h));
const isFramerBundle = (src) => /framerusercontent\.com\/.*script_main.*\.mjs/.test(src);
const isProcessEnvPolyfill = (code) => /NODE_ENV/.test(code) && /window\.process/.test(code) && code.length < 400;
const isEditorbar = (code) => /__framer_force_showing_editorbar/.test(code);
// inline 3rd-party analytics snippets (PostHog init) — drop to keep the console clean and
// avoid firing tracking from the clone; purely analytical, no visual/behavioural effect.
const isInlineAnalytics = (code) => /posthog\s*(\.|\[)/.test(code) || /\bposthog\.init\b/.test(code);

const APPEAR_MARKER_INJECTOR =
  `(function(){try{if(!document.querySelector('script[data-framer-appear-animation]')){` +
  `var m=document.createElement('script');m.setAttribute('data-framer-appear-animation','no-preference');` +
  `document.head.appendChild(m);}}catch(e){}})();`;

if (!fs.existsSync(ROUTES)) {
  console.error(`hybrid-postprocess: no routes dir at ${ROUTES} (run slice-routes first).`);
  process.exit(1);
}

let framer = 0, astro = 0, droppedScripts = 0, promotedHead = 0;
for (const file of fs.readdirSync(ROUTES).filter((f) => f.endsWith(".json"))) {
  const fp = path.join(ROUTES, file);
  const r = JSON.parse(fs.readFileSync(fp, "utf8"));

  const isFramer = (r.externalScripts || []).some((s) => isFramerBundle(s.src || ""));

  // both stacks: drop analytics
  const beforeExt = r.externalScripts.length;
  r.externalScripts = r.externalScripts.filter((s) => !isAnalytics(s.src || ""));
  droppedScripts += beforeExt - r.externalScripts.length;

  if (isFramer) {
    const preInline = [];
    const keptDeferred = [];
    let envPolyfill = null;
    for (const code of r.deferredInline || []) {
      if (!code || !code.trim()) continue;
      if (isProcessEnvPolyfill(code)) { envPolyfill = code; continue; }
      if (isEditorbar(code)) continue;
      keptDeferred.push(code);
    }
    preInline.push(envPolyfill || `typeof document<"u"&&(window.process={...window.process,env:{...(window.process&&window.process.env),NODE_ENV:"production"}});`);
    preInline.push(APPEAR_MARKER_INJECTOR);
    r.preInline = preInline;
    r.deferredInline = keptDeferred;
    framer++;
  } else {
    // Astro: keep /_astro/ and /fonts/ ROOT-RELATIVE so they resolve to the clone's own
    // public/ tree (the asset graph is downloaded locally). Cross-origin CDN does NOT work
    // for Astro: @font-face .otf/.ttf are CORS-restricted and www.daytona.io serves no CORS
    // header, so fonts fail → fallback metrics → global text reflow (the 1–7% diff).
    //
    // Promote HEAD inline scripts (captured by extract-head-css) to preInline so they run
    // BEFORE externalScripts/island hydration — the anti-FOUC ThemeProvider must exist
    // before an island calls ThemeProvider.updatePickers() on hydrate. Remove them from
    // deferredInline (dedupe by trimmed body) so they don't run twice.
    const headInline = (r.headInline || []).filter((s) => s && s.trim() && !isInlineAnalytics(s));
    if (headInline.length) {
      const headSet = new Set((r.headInline || []).map((s) => (s || "").trim()));
      r.preInline = headInline;
      r.deferredInline = (r.deferredInline || []).filter((s) => !headSet.has((s || "").trim()));
      promotedHead += headInline.length;
    }
    r.deferredInline = (r.deferredInline || []).filter((s) => !isInlineAnalytics(s));
    astro++;
  }

  fs.writeFileSync(fp, JSON.stringify(r));
}

console.log(`hybrid-postprocess: ${framer} Framer + ${astro} Astro route(s); ${droppedScripts} analytics script(s) dropped; ${promotedHead} Astro head inline script(s) promoted to preInline (Astro /_astro/ + /fonts/ kept root-relative — download to public/).`);
