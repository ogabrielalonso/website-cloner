#!/usr/bin/env node

/**
 * extract-head-css.mjs — per-route <head> CSS preservation for a HYBRID markup-port
 * clone (discovered cloning daytona.io: home is Framer, the 470 collection routes are
 * Astro — two stacks with conflicting tag-level resets `*{} body{} html{} :root{}`).
 *
 * A single monolithic globals.css can't hold both: the Astro reset leaks onto the
 * Framer home and vice-versa. The faithful fix is to re-emit, per route, EXACTLY the
 * <head> stylesheets the original page shipped — each route loads only its own CSS,
 * zero cross-stack bleed, byte-identical cascade to the original.
 *
 * For each raw HTML it records, in document order, an ordered list of head CSS items:
 *   { t: "l", href }  — a <link rel="stylesheet"> (root-relative href kept verbatim)
 *   { t: "s", css }   — a head-level inline <style> block (editor-bar / empty dropped)
 * and writes it as `headCSS` onto the matching src/generated/routes/<slug>.json.
 *
 * Deterministic, idempotent, zero tokens. Run AFTER slice-routes.
 *   node scripts/extract-head-css.mjs
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const WS = process.cwd();
const RAW = path.join(WS, flag("--raw", "docs/research/raw-html"));
const ROUTES = path.join(WS, flag("--out", "src/generated"), "routes");

const attrOf = (tag, name) =>
  (tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")) || []).slice(1).find((x) => x != null) || "";

if (!fs.existsSync(RAW) || !fs.existsSync(ROUTES)) {
  console.error("extract-head-css: need docs/research/raw-html + src/generated/routes (run slice-routes first).");
  process.exit(1);
}

let n = 0, totalLinks = 0, totalStyles = 0, totalScripts = 0;
for (const file of fs.readdirSync(RAW).filter((f) => f.endsWith(".html"))) {
  const slug = file.replace(/\.html$/, "");
  const routeFile = path.join(ROUTES, slug + ".json");
  if (!fs.existsSync(routeFile)) continue;

  const html = fs.readFileSync(path.join(RAW, file), "utf8");
  const bodyAt = html.search(/<body\b/i);
  const head = bodyAt === -1 ? html : html.slice(0, bodyAt);

  // Walk head in document order, capturing <link rel=stylesheet> and <style> blocks.
  const items = [];
  const re = /<link\b[^>]*>|<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(head))) {
    const tag = m[0];
    if (tag.startsWith("<link")) {
      if (!/rel\s*=\s*["'][^"']*stylesheet/i.test(tag)) continue;
      const href = attrOf(tag, "href");
      if (href) { items.push({ t: "l", href }); totalLinks++; }
    } else {
      const css = (m[1] || "").trim();
      if (!css) continue;                                   // empty block
      if (/__framer-editorbar/.test(css)) continue;         // editor chrome, never visitor-facing
      items.push({ t: "s", css }); totalStyles++;
    }
  }

  // HEAD-level inline <script> (no src, not JSON). These ran in <head> BEFORE the body
  // on the original — e.g. Astro's anti-FOUC ThemeProvider setup. In markup-port they
  // must run in preInline (before externalScripts/island hydration), or an island that
  // calls ThemeProvider.updatePickers() during hydration hits an undefined global.
  const headInline = [];
  const sre = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = sre.exec(head))) {
    const attrs = sm[1] || "";
    if (/\bsrc\s*=/.test(attrs)) continue;                         // external, handled by slice
    if (/type\s*=\s*["'][^"']*json/i.test(attrs)) continue;       // data island
    const body = (sm[2] || "").trim();
    if (!body) continue;
    if (/__framer_force_showing_editorbar/.test(body)) continue;  // editor-only
    headInline.push(body);
  }

  const r = JSON.parse(fs.readFileSync(routeFile, "utf8"));
  r.headCSS = items;
  r.headInline = headInline;
  fs.writeFileSync(routeFile, JSON.stringify(r));
  totalScripts += headInline.length;
  n++;
}

console.log(`extract-head-css: ${n} route(s); ${totalLinks} <link> + ${totalStyles} head <style> + ${totalScripts} head <script> preserved per-route.`);
