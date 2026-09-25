#!/usr/bin/env node

/**
 * qa-diff.mjs — objective pixel-diff QA gate for a website clone (Phase 5).
 *
 * Captures every route × {desktop 1440×900, mobile 390×844} for the CLONE and the
 * ORIGINAL, computes a pixelmatch signal, subtracts an animation NOISE floor
 * (original captured twice), and flags routes whose real difference exceeds a
 * threshold. The diff itself is deterministic — zero LLM tokens. The orchestrator reads
 * the JSON table + diff PNGs and diagnoses each flagged route (that part stays
 * generative — see SKILL Phase 5).
 *
 * Runs its OWN headless Playwright (separate Chromium from the Chrome DevTools MCP
 * session — no contention). Playwright + pixelmatch + pngjs are lazy-installed into
 * a shared cache dir (NOT the clone) on first use, so a clone that never reaches
 * Phase 5 never pays for them.
 *
 * Offline fallback: if --original is unreachable, diff against cached baseline
 * screenshots saved in Phase 1 (docs/design-references/original/<route>-<vp>.png),
 * with a fixed noise allowance, and flag in the report that the gate ran cached.
 *
 * Usage:
 *   node scripts/qa-diff.mjs --clone http://localhost:3000 --original https://site.com --routes /,/about,/pricing
 *   node scripts/qa-diff.mjs --clone http://localhost:3000 --baseline docs/design-references/original --routes /
 *   (--out defaults to docs/research/qa ; --threshold default 0.005 = 0.5% ; --concurrency default 4)
 *
 * Exit non-zero if any route×viewport exceeds the threshold (a real diff, not noise).
 *
 * NOTE: the diff/crop math below is fixture-gated against real PNGs; the Playwright
 * capture path is exercised on the first real clone (it cannot be unit-tested without
 * a browser). It uses only standard Playwright APIs.
 */

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const CLONE = flag('--clone');
const ORIGINAL = flag('--original', null);
const BASELINE = flag('--baseline', 'docs/design-references/original');
let ROUTES = (flag('--routes', '/') || '/').split(',').map((r) => r.trim()).filter(Boolean);
const MANIFEST = flag('--manifest', null);
const OUT = flag('--out', 'docs/research/qa');
const THRESHOLD = Number(flag('--threshold', '0.005')) || 0.005;
const CONCURRENCY = Number(flag('--concurrency', '4')) || 4;
const has = (n) => args.includes(n);
const DARK = has('--dark');                          // add a dark-mode variant of each viewport
const DPR2 = has('--dpr2');                          // add a 2× (retina) desktop viewport
const CAPTURE_ORIGINAL = has('--capture-original');  // save originals to --baseline, no diff
const ACCEPT_COOKIES = has('--accept-cookies');      // seed common consent cookies/localStorage
// --hide "<sel>,<sel>": display:none these on BOTH clone+original captures — for 3rd-party
// preview chrome / chat widgets / banners not covered by --accept-cookies that would
// otherwise diff as a real difference (or appear on only one side).
const HIDE = (flag('--hide', null) || '').split(',').map((s) => s.trim()).filter(Boolean);

// Whole-site coverage: union the markup-port manifest's routes so the gate never
// silently skips a route the orchestrator forgot to pass in --routes.
if (MANIFEST && existsSync(MANIFEST)) {
  try {
    const paths = Object.keys(JSON.parse(readFileSync(MANIFEST, 'utf8')).paths || {});
    if (paths.length) ROUTES = [...new Set([...ROUTES, ...paths])];
  } catch { /* malformed manifest — keep --routes */ }
}

const BASE_VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900, dpr: 1, mobile: false },
  { name: 'mobile', w: 390, h: 844, dpr: 3, mobile: true },
];
if (DPR2) BASE_VIEWPORTS.push({ name: 'desktop-2x', w: 1440, h: 900, dpr: 2, mobile: false });
// --dark doubles each viewport with an OS dark-color-scheme variant so a .dark theme is
// diffed too. Opt-in — the default stays light-only to keep the gate fast.
const VIEWPORTS = DARK
  ? BASE_VIEWPORTS.flatMap((vp) => [vp, { ...vp, name: `${vp.name}-dark`, colorScheme: 'dark' }])
  : BASE_VIEWPORTS;

// Seed the common consent platforms so a GDPR modal doesn't dominate every diff image
// (Cookiebot/OneTrust read a cookie; CookieYes/Osano read localStorage). Opt-in via --accept-cookies.
const SEED_CONSENT = () => {
  try {
    document.cookie = 'CookieConsent=true; path=/';
    document.cookie = 'OptanonConsent=groups=C0001:1,C0002:1,C0003:1,C0004:1; path=/';
  } catch { /* noop */ }
  try {
    localStorage.setItem('cookieyes-consent', 'yes');
    localStorage.setItem('osano_consentmanager', '{"ANALYTICS":"ACCEPT","MARKETING":"ACCEPT"}');
  } catch { /* noop */ }
};

// Inject a stylesheet hiding the --hide selectors, before any page CSS, on both sides.
const SEED_HIDE = (selectors) => {
  const css = selectors.map((s) => `${s}{display:none !important;visibility:hidden !important;}`).join('');
  const add = () => { const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el); };
  if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
};

const CACHE = process.env.WEBSITE_CLONER_CACHE || path.join(homedir(), '.cache', 'website-cloner');
const DEPS = path.join(CACHE, 'qa-deps');
const NM = path.join(DEPS, 'node_modules');

/** Lazy-install Playwright + pixelmatch + pngjs into the shared cache (once). */
function loadDeps() {
  const missing = ['playwright', 'pixelmatch', 'pngjs'].some((p) => !existsSync(path.join(NM, p)));
  if (missing) {
    mkdirSync(DEPS, { recursive: true });
    if (!existsSync(path.join(DEPS, 'package.json'))) writeFileSync(path.join(DEPS, 'package.json'), '{"private":true}\n');
    process.stderr.write('qa-diff: first run — installing playwright + pixelmatch + pngjs into the cache (~once)…\n');
    execSync('npm i --no-audit --no-fund playwright pixelmatch@5 pngjs', { cwd: DEPS, stdio: 'inherit' });
    execSync('node node_modules/playwright/cli.js install chromium', { cwd: DEPS, stdio: 'inherit' });
  }
  const r = (pkg) => require(require.resolve(pkg, { paths: [NM] }));
  return { chromium: r('playwright').chromium, pixelmatch: r('pixelmatch'), PNG: r('pngjs').PNG };
}

/** Crop a parsed PNG to w×h (top-left), returning a Buffer of RGBA. */
function cropData(png, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    png.data.copy(out, y * w * 4, y * png.width * 4, y * png.width * 4 + w * 4);
  }
  return out;
}

/** Fraction of mismatched pixels between two PNG files (cropped to common size). */
function diffImages(PNG, pixelmatch, aPath, bPath, diffOutPath) {
  const a = PNG.sync.read(readFileSync(aPath));
  const b = PNG.sync.read(readFileSync(bPath));
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const da = (a.width === w && a.height === h) ? a.data : cropData(a, w, h);
  const db = (b.width === w && b.height === h) ? b.data : cropData(b, w, h);
  const out = new PNG({ width: w, height: h });
  const mismatched = pixelmatch(da, db, out.data, w, h, { threshold: 0.1 });
  if (diffOutPath) writeFileSync(diffOutPath, PNG.sync.write(out));
  // fullPage screenshots are scrollHeight-tall — a clone that crashed/hydration-failed and
  // renders only the hero is SHORTER, and the diff is cropped to the common (short) area, so a
  // pixel-perfect hero would pass as clean while most content is MISSING. Fold a continuous
  // height-mismatch penalty: a 10000px original vs 800px clone → max(pixelFrac, ~0.92), past any
  // threshold. The noise floor (original-vs-original) has matching heights → penalty ≈ 0, so it
  // never inflates the floor; only a real clone/original size gap triggers it.
  const pixelFraction = mismatched / (w * h);
  // Tolerance band: markup-port serves identical HTML so healthy clone/original heights match
  // within a few %; only penalize a GROSS shortfall (missing sections / crashed hydration).
  // ≥90% height match → 0 penalty (no false flags on the proven clones); below that it ramps.
  const heightRatio = Math.min(a.height, b.height) / Math.max(a.height, b.height || 1);
  const heightPenalty = heightRatio >= 0.9 ? 0 : (0.9 - heightRatio);
  return Math.max(pixelFraction, heightPenalty);
}

const slug = (route) => (route === '/' ? 'home' : route.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'home');

// A crashed/disconnected SHARED Chromium throws these on every subsequent capture.
// They are INFRA failures (re-run the routes), NOT pixel regressions — distinct from a
// real HTTP 4xx/5xx (a genuinely broken clone route), which must STILL count as a flag.
// Observed in a Nextra clone: one mid-run browser death poisoned 24 routes as "flagged"
// with signal:null, masking the one real regression and inflating the count 1 → 25.
const isBrowserDead = (e) =>
  /has been closed|Target crashed|Target page, context or browser|browser has been disconnected|Protocol error.*(closed|crashed)/i
    .test(String((e && e.message) || e));

// The clone (or original) SERVER being unreachable is also INFRA, not a pixel regression —
// a `next start` reaped mid-gate makes every pending route throw a connection error. Distinct
// from HTTP 4xx/5xx (the server answered with an error page → a real broken route → flag).
// Re-running the browser won't help (the server is down), so this is classified directly.
const isServerDown = (e) =>
  /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ECONNREFUSED|ECONNRESET/i
    .test(String((e && e.message) || e));

// Reuses a single shared browser (launched once in main) — one Chromium process,
// one context per capture. Throws on a 4xx/5xx response so a 404/500 error page can
// never diff as a "valid" screenshot and pass the gate.
//
// Determinism initScript: injected before any site JS runs (both original and clone).
// 1. Seeded PRNG  — Math.random() always returns the same sequence per-capture so that
//    random-selection animations (halftone cell matrices, particle systems) choose the
//    same elements in both captures.
// 2. setInterval neutralised — setInterval calls return a fake ID but never schedule
//    the callback. This freezes ongoing animation loops (cell-lighting cycles, auto-
//    rotating carousels, tickers) whose tick-count is non-deterministic due to browser
//    scheduling jitter, which would otherwise shift the PRNG sequence unpredictably.
//    Applied to BOTH original and clone, so the comparison stays fair: both show the
//    same static initial state. Trade-off (accepted): content REVEALED only by an
//    interval (e.g. polling) stays hidden on both sides and isn't validated by the diff.
const SEED_RANDOM = () => {
  let seed = 0xdeadbeef;
  Math.random = () => {
    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  // Neutralise setInterval: return a unique fake ID, never schedule the callback.
  // clearInterval on fake IDs is a safe no-op.
  let _siCounter = 0x7f000000;
  window.setInterval = () => ++_siCounter;
  // Track pending requestAnimationFrame IDs so capture() can freeze ALL canvas/JS
  // animation loops atomically right before the screenshot (the canvas keeps its
  // last-drawn frame — the noise floor absorbs phase differences; we deliberately do
  // NOT clear canvases, which would blind the diff to canvas content entirely).
  const _realRAF = window.requestAnimationFrame.bind(window);
  const _rafIds = new Set();
  window.requestAnimationFrame = (cb) => {
    const id = _realRAF((...a) => { _rafIds.delete(id); cb(...a); });
    _rafIds.add(id);
    return id;
  };
  window._qaCancelAllRAFs = () => {
    _rafIds.forEach((id) => cancelAnimationFrame(id));
    _rafIds.clear();
    window.requestAnimationFrame = () => 0; // loops can't reschedule after the stop point
  };
};

async function capture(browser, url, vp, outPath) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr, isMobile: vp.mobile, hasTouch: vp.mobile, ...(vp.colorScheme ? { colorScheme: vp.colorScheme } : {}) });
  try {
    await ctx.addInitScript(SEED_RANDOM);
    if (ACCEPT_COOKIES) await ctx.addInitScript(SEED_CONSENT);
    if (HIDE.length) await ctx.addInitScript(SEED_HIDE, HIDE);
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()} at ${url}`);
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
    await page.evaluate(async () => {
      const h = document.body.scrollHeight;
      for (let y = 0; y < h; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
      window.scrollTo(0, 0);
    });
    // Wait long enough for time-based animation chains (GSAP delayedCall cascades,
    // staggered entrances) to reach a stable terminal state. setInterval is neutralised
    // by the initScript, so no ongoing loop disturbs that state — observed worst case on
    // real sites was ~3.7s of chained delayedCalls, hence 4s.
    await page.waitForTimeout(4000);
    // Freeze every animation loop atomically (canvas keeps its last frame) and drop
    // any dev overlay, then let pending paints flush before the capture.
    await page.evaluate(() => {
      window._qaCancelAllRAFs?.();
      document.querySelector('nextjs-portal')?.remove();
    });
    await page.waitForTimeout(50);
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await ctx.close();
  }
}

/** Simple concurrency-limited map. */
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return out;
}

async function main() {
  const { chromium, pixelmatch, PNG } = loadDeps();

  // --capture-original: save the live original's screenshots as Phase-1 baselines (for the
  // offline-fallback diff). No clone, no diff — just the capture loop against --original.
  if (CAPTURE_ORIGINAL) {
    if (!ORIGINAL) { console.error('qa-diff --capture-original: requires --original <url>'); process.exit(2); }
    mkdirSync(BASELINE, { recursive: true });
    const jobs = ROUTES.flatMap((route) => VIEWPORTS.map((vp) => ({ route, vp })));
    const browser = await chromium.launch();
    let saved = 0, failed = 0;
    try {
      await mapLimit(jobs, CONCURRENCY, async ({ route, vp }) => {
        const tag = `${slug(route)}-${vp.name}`;
        try { await capture(browser, ORIGINAL.replace(/\/+$/, '') + route, vp, path.join(BASELINE, `${tag}.png`)); saved++; }
        catch (e) { failed++; process.stderr.write(`  FAILED ${route} [${vp.name}] — ${e.message}\n`); }
      });
    } finally { await browser.close(); }
    process.stderr.write(`\nqa-diff --capture-original: saved ${saved} baseline(s) → ${BASELINE}${failed ? ` (${failed} failed)` : ''}\n`);
    process.exit(failed > 0 ? 1 : 0);
  }

  if (!CLONE) { console.error('qa-diff: --clone <url> is required (e.g. http://localhost:3000)'); process.exit(2); }
  mkdirSync(OUT, { recursive: true });

  // Run counter — the gate loop is the #1 token/wall-clock sink when driven by an
  // agent (observed: 68 full-gate runs in one clone session). Persist a counter and
  // remind loudly: iterate on the FLAGGED routes only; full --manifest goes last.
  const counterFile = path.join(OUT, '.run-count');
  let runCount = 1;
  try { runCount = Number(readFileSync(counterFile, 'utf8').trim()) + 1; } catch { /* first run */ }
  try { writeFileSync(counterFile, String(runCount)); } catch { /* best effort */ }
  if (runCount > 5) {
    const scope = MANIFEST ? '--manifest (full gate)' : `--routes ${ROUTES.join(',')}`;
    process.stderr.write(
      `qa-diff: ⚠ run #${runCount} (${scope}). The gate loop is the #1 token/wall-clock sink. During the\n` +
      `  fix loop, re-diff ONLY the flagged routes (--routes /a,/b) and use 'tsc --noEmit' for type checks;\n` +
      `  save the full --manifest gate + one 'npm run build' for the FINAL confirmation pass.\n`
    );
  }

  const jobs = ROUTES.flatMap((route) => VIEWPORTS.map((vp) => ({ route, vp })));
  const usingLive = !!ORIGINAL;

  // Shared Chromium with relaunch-on-death. ensureBrowser() relaunches at most one
  // process at a time (a single in-flight promise so concurrent jobs don't stampede a
  // dozen relaunches); cap() retries a capture ONCE through the fresh browser. A route
  // that still can't be captured is tagged infraError (re-run) — NOT a pixel flag — so
  // one crash never masks a real regression nor inflates the flagged count.
  const browserRef = { browser: await chromium.launch() };
  let relaunching = null;
  const ensureBrowser = async () => {
    if (browserRef.browser.isConnected()) return;
    if (!relaunching) {
      relaunching = (async () => {
        try { await browserRef.browser.close(); } catch { /* already dead */ }
        try {
          browserRef.browser = await chromium.launch();
          process.stderr.write('  qa-diff: shared browser died — relaunched, retrying affected route(s)\n');
        } catch (launchErr) {
          // Relaunch itself failed (missing binary, OOM, sandbox) — INFRA, not a pixel verdict.
          const err = new Error(`browser relaunch failed — ${launchErr.message}`);
          err.infra = true;
          throw err;
        }
      })().finally(() => { relaunching = null; });
    }
    await relaunching;
  };
  const cap = async (url, vp, outPath) => {
    try {
      return await capture(browserRef.browser, url, vp, outPath);
    } catch (e) {
      if (!isBrowserDead(e)) throw e;        // HTTP 4xx/5xx / bad selector stays a real flag
      await ensureBrowser();
      try {
        return await capture(browserRef.browser, url, vp, outPath);
      } catch (e2) {
        if (isBrowserDead(e2)) { const err = new Error(`browser unavailable — ${e2.message}`); err.infra = true; throw err; }
        throw e2;                            // retry hit a genuine route error → real flag
      }
    }
  };

  let results;
  try {
    results = await mapLimit(jobs, CONCURRENCY, async ({ route, vp }) => {
      const tag = `${slug(route)}-${vp.name}`;
      try {
        const clonePng = path.join(OUT, `clone-${tag}.png`);
        await cap(CLONE.replace(/\/+$/, '') + route, vp, clonePng);

        let noise = 0;
        let origA;
        if (usingLive) {
          origA = path.join(OUT, `orig-${tag}-a.png`);
          const origB = path.join(OUT, `orig-${tag}-b.png`);
          await cap(ORIGINAL.replace(/\/+$/, '') + route, vp, origA);
          await cap(ORIGINAL.replace(/\/+$/, '') + route, vp, origB);
          noise = diffImages(PNG, pixelmatch, origA, origB, null);
        } else {
          origA = path.join(BASELINE, `${tag}.png`);
          if (!existsSync(origA)) return { route, viewport: vp.name, error: `no baseline at ${origA}`, signal: null, noise: null, delta: null, flagged: true };
          noise = 0.002; // fixed allowance when we can't measure live animation noise
        }

        const signal = diffImages(PNG, pixelmatch, clonePng, origA, path.join(OUT, `diff-${tag}.png`));
        const delta = Math.max(0, signal - noise);
        return { route, viewport: vp.name, signal: +signal.toFixed(4), noise: +noise.toFixed(4), delta: +delta.toFixed(4), flagged: delta > THRESHOLD };
      } catch (e) {
        // Browser death (after relaunch+retry) or a down server is INFRA, not a pixel verdict — re-run it.
        if ((e && e.infra) || isServerDown(e)) return { route, viewport: vp.name, error: e.message, signal: null, noise: null, delta: null, flagged: false, infraError: true };
        // A capture/HTTP/navigation failure (4xx/5xx, bad selector) IS a real flag.
        return { route, viewport: vp.name, error: e.message, signal: null, noise: null, delta: null, flagged: true };
      }
    });
  } finally {
    try { await browserRef.browser.close(); } catch { /* already closed */ }
  }

  const report = { clone: CLONE, source: usingLive ? ORIGINAL : `baseline:${BASELINE}`, threshold: THRESHOLD, mode: usingLive ? 'live-noise-floor' : 'cached-baseline', results };
  writeFileSync(path.join(OUT, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n');

  process.stderr.write(`\nqa-diff (${report.mode}) — route × viewport : signal / noise / delta\n`);
  for (const r of results) {
    const line = r.infraError ? `INFRA ${r.error}` : r.error ? `ERROR ${r.error}` : `${r.signal} / ${r.noise} / ${r.delta}${r.flagged ? '  ⚠ FLAGGED' : '  ok'}`;
    process.stderr.write(`  ${r.route} [${r.viewport}] : ${line}\n`);
  }
  const flagged = results.filter((r) => r.flagged && !r.infraError).length;
  const infra = results.filter((r) => r.infraError);
  if (infra.length) {
    const infraRoutes = [...new Set(infra.map((r) => r.route))];
    process.stderr.write(
      `\nqa-diff: ⚠ ${infra.length} capture(s) failed on INFRA (browser/server death), NOT pixel regressions —\n` +
      `  re-run only these and they'll likely pass: --routes ${infraRoutes.join(',')}\n`
    );
  }
  process.stderr.write(`\nqa-diff: ${flagged} pixel-flagged of ${results.length}${infra.length ? ` (+${infra.length} infra-error)` : ''} · report → ${path.join(OUT, 'qa-report.json')}\n`);
  // exit 1 = pixel regressions (fix the clone); 3 = infra-only (re-run those routes); 0 = clean.
  process.exit(flagged > 0 ? 1 : (infra.length > 0 ? 3 : 0));
}

export { diffImages, cropData, isBrowserDead, isServerDown };

// Run the CLI only when invoked directly (not when imported for testing).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error('qa-diff:', e.stack || e.message); process.exit(2); });
