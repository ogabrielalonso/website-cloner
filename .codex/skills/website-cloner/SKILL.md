---
name: website-cloner
description: Clone a single page or an entire website (all routes via sitemap) into a verifiable 1:1 Next.js build — for framework sites it ports the real compiled CSS/markup/scripts (not a from-scratch rebuild), dispatches parallel builders per template, and gates on an automated desktop+mobile pixel-diff. Use whenever the user wants to clone, replicate, rebuild, reverse-engineer, or copy any website or whole site (also "make a copy of this site", "rebuild this page", "pixel-perfect clone", "clone all pages"). Args: one or more target URLs.
argument-hint: "<url1> [<url2> ...]"
user-invocable: true
---

# Website Cloner

Target: **$ARGUMENTS**. Take it apart and rebuild it in this scaffold until the result cannot be told apart from the original, pixel for pixel.

Given several URLs, treat each one as a separate job and run them side by side whenever that is possible. Give every site its own folder for extraction output (for example `docs/research/<hostname>/`) so nothing from one target leaks into another.

This is not a two-phase process (inspect then build). You are a **orchestrator walking the job site** — as you inspect each section of the page, you write a detailed specification to a file, then hand that file to a specialist builder agent with everything they need. Extraction and construction happen in parallel, but extraction is meticulous and produces auditable artifacts.

## Autonomy & Completion Contract (read first)

Run **end-to-end to completion without asking the user anything.** The expectation is: invoke the skill, walk away, return to a finished, verified clone. Honor it.

- **Never pause for clarification or confirmation.** Resolve every choice from this skill's defaults (scope, whole-site-vs-page, parallel-vs-sequential, fidelity, strategy). The ONLY acceptable stop-and-ask is a hard external blocker you cannot work around: an invalid/unreachable URL, an auth/login wall, or active anti-bot. Report it plainly and clone whatever IS reachable.
- **The pixel-diff QA gate (Phase 5) is a LOOP, not a checkpoint.** Iterate fix → re-check → repeat until desktop is pixel-identical and every route's mobile diff is within sub-line noise. Do NOT declare complete before the gate passes. **Cost discipline (this is the #1 token sink):** during the loop re-diff ONLY the flagged routes (`qa-diff … --routes /a,/b`) and check types with `tsc --noEmit` (~5s) — re-running the full `--manifest` gate + a full `npm run build` every iteration dominates the cost on multi-route sites (a 19-route Webflow run cost ~$99 by doing 16 full-gate+build cycles; scoped re-diffs would have been a fraction). Run the full `--manifest` gate + one `npm run build` ONCE at the end to confirm nothing regressed. If one element is genuinely un-cloneable (DRM video, server-only personalization, anti-bot asset), make everything else 1:1 and name that single residual.
- **Self-correct; don't surface trivia.** A broken builder output, a font-load race, a stripped data island, an un-rendered canvas, a missing srcset variant — diagnose the root cause and fix it yourself. That's the job, not a question.
- **Honesty over claims.** "1:1 / 100%" is something you *measure and prove* with the gate, per viewport — never something you assert from a screenshot or to satisfy the user. A truthful "pixel-identical on desktop, sub-line residual on mobile" beats a hollow "100%". State desktop and mobile separately; name any residual and what it maps to.
- **Realistic guarantee:** the skill cannot promise a literal 100% on every conceivable site (some content is fundamentally un-reproducible). What it guarantees is: run autonomously, port the real CSS/markup/scripts 1:1, and *relentlessly drive to the measured 1:1 the gate can verify*, reporting any honest residual.

## Speed & Concurrency

The pipeline is faster when each step runs on the right substrate and independent work runs in parallel. The critical path is the **Phase 1 interaction sweep** (browser-bound, orchestrator judgment) — it cannot be parallelized, only kept lean. Everything below overlaps work *around* it.

**Substrate per step — pick the fastest correct one:**
- **Pure bash** — the committed scripts (the authoritative set): `bootstrap-clone.sh`, `enumerate-routes.mjs`, `slice-routes.mjs`, `css-collector.mjs`, `css-descope.mjs`, `extract-asset-urls.mjs`, `download-assets.mjs`, `close-js-graph.mjs`, `sanitize-asset-names.mjs`, `gen-content-barrel.mjs`, `qa-diff.mjs`, `clone-cost.mjs`, `extract-section.mjs`, `tokenize-css.mjs`, `extract-design-system.mjs`, `componentize-routes.mjs`, and (Framer / hybrid two-stack only) `capture-routes.sh`, `extract-head-css.mjs`, `hybrid-postprocess.mjs` — deterministic, zero LLM tokens, parallel-safe. Use these instead of writing one-off code each run. (`sync-skills.mjs` is also committed but is a dev-only maintenance tool — it regenerates the Codex copy of this skill — not a clone step.)
- **Main loop (orchestrator)** — anything needing the live Chrome DevTools MCP browser session (recon, extraction, topology, QA diagnosis). It cannot be moved to a subprocess (no shared browser).
- **Agent subagents in git worktrees** — the per-section builders. The bootstrapped workspace is now a git repo (`bootstrap-clone.sh` runs `git init`), so `git worktree` works.
- Do **not** shell out to a headless `claude -p` for browser work — it has no access to the open MCP session.

**Overlap work around the interaction sweep (Phase 1):**
- Once the COMPLETE CSS source set is on disk — i.e. AFTER `css-collector.mjs` has gathered every `<link>` sheet across all routes AND the one live `list_network_requests resourceTypes:["stylesheet"]` runtime-injected pass (per Decision 2 step 1) — fire `node scripts/css-descope.mjs … --out src/app/globals.css &` as a **background job**. globals.css is then ready before the sweep ends — the single biggest wall-clock win (it moves the foundation barrier earlier). **Do not fire it after only the first page's network sheets** — a later-route stylesheet would be missing and globals.css silently builds from an incomplete set. **Guard the background job:** `css-descope` exits non-zero and writes NOTHING when a dangling combinator survives, so `globals.css` would silently stay the scaffold's `@import "tailwindcss"` stub → an unstyled clone. Before dispatching any builder, `wait` for that job, check its exit status, AND confirm `globals.css` is no longer the stub.
- After `list_network_requests resourceTypes:["script"]`, download JS bundles in the **background** too: `printf '%s' "$bundleUrls" | node scripts/download-assets.mjs --out docs/research/js --receipt docs/research/bundle-manifest-result.json &`. (Bundles load on first navigation — safe to fetch early. Images/media need the full scroll+click sweep first, so download those *after* the sweep.)
- For whole-site clones, open up to **4 Chrome MCP pages** (`new_page`) for **stateless** per-route reads in parallel (screenshots, CSS-var/keyframe/font extraction) — pass an explicit page id on every call, and stagger `navigate_page` by ~500ms on `*.pages.dev`/`*.vercel.app` to dodge bot detection. The interaction sweep itself stays on **one** page, sequential.
- **Concurrent clone sessions:** with the MCP registered as `npx chrome-devtools-mcp@latest --isolated` (the recommended config — temp profile per session, auto-cleaned) parallel sessions don't collide. WITHOUT `--isolated` they share ONE Chrome profile and a second concurrent clone fails with `The browser is already running` / `the selected page has been closed` (observed live: retries + inflated cost) — in that case clone sequentially. If you see those errors, check the MCP config first.

**Builders (Phase 3):**
- Cap concurrency at **min(section_count, 8)** — above ~8 parallel Sonnet builders the org rate limit throttles and you gain nothing.
- **Dispatch in dependency layers:** Layer 1 = leaf components dispatch immediately once globals.css exists; Layer 2 = components that import a Layer 1 one (e.g. a section importing `HalftoneCanvas`) dispatch **only after that dependency is merged to main** (branch the worktree from updated main, or its `tsc --noEmit` fails on the missing import); Layer 3 (e.g. a shared sub-page shell importing Navbar+Footer) after both merge.
- Builders must **never** write `globals.css` or `icons.tsx` — the orchestrator owns both; builders use the imports the orchestrator provides.
- **Merge validation:** the worktree merge loop is serial. For **intermediate** merges validate with `npx tsc --noEmit` (~5s); run the full `npm run build` **once** after the last merge.

**Foundation barrels (Phase 2):** run the `gen-content-barrel.mjs` instances for each content type in parallel — `… blog & … features & … team & wait`.

**QA (Phase 5):** `qa-diff.mjs` runs its own headless Playwright (separate from the MCP browser) and diffs all routes in parallel — see Phase 5.

## Model Tiers

Dispatch each subagent on the cheapest model that holds fidelity (≈35–45% cost cut vs all-Opus; fidelity proven by the Phase 5 gate). The **orchestrator is the session model** (Opus) — never pass a model for orchestrator-inline work (it would spawn a subagent and bust the cache). For every `Task`/Agent **dispatch**, set `model` explicitly:

| Dispatched subagent | model | effort |
|---|---|---|
| Builders: complex-interactive / medium-animated / canvas-renderer / GSAP-bearing | `sonnet` | high (medium for simple) |
| **behavior-porter** (GSAP/canvas math port — the fidelity-critical role) | `opus` | — |
| canvas-runtime-author, page-html-slicer, js-deobfuscator, interaction-sweep, page-topology, svg / font / design-token extractors, interaction-verifier, page-assembly (FOUC/Lenis) | `sonnet` | high/medium |
| slug-template builder, simple `page.tsx` compose, stylesheet-fetcher, css-de-scope, keyframe-extractor, asset-downloader, js-bundle-fetcher | `haiku` | none (Haiku rejects `effort`) |
| Orchestrator, QA root-cause diagnosis, worktree merge | session model (Opus) — no `model` | — |

- **Truly-static** sections (no GSAP, no data islands) may use `haiku`; any section with GSAP / custom eases stays `sonnet` (a wrong ease passes `tsc` but fails the pixel-diff).
- **Escalation:** if a `sonnet` builder fails the gate after one retry, re-dispatch that specific builder on `opus`.
- Determinized steps that are now committed scripts (the authoritative list under Speed & Concurrency above) use **no model** — they are pure bash.

**Measure before optimizing.** `node scripts/clone-cost.mjs --session <id>` (or pass transcript `.jsonl` paths) reports a clone's real cost from its transcript — per-model tokens, sub-dispatch count (the signal for whether tiers even fired), and an A/B delta across sessions. Ground every cost change in this number, not a guess.

**The table above is for the component-rebuild path (many dispatched builders).** On the dominant **markup-port** path the orchestrator does the work inline (0–few dispatches), so the tiers barely fire — measured: 3 real clones (Astro + 2× Webflow) ran ~$40–68 all-Opus with **zero** sub-dispatches. There the real cost driver is the orchestrator's own **cache-read**, and the only lever is the **orchestrator model itself**.

**Orchestrator-model A/B — MEASURED; do not re-run it expecting savings.** Same site, isolated A/B: Sonnet 4.6 **held fidelity** (0/42 flagged, max delta 0.0049, two subtle root-causes correctly diagnosed) but cost **$45.59 vs $24.30 on Opus** (+88% gross, +16% per route). The cause is structural, not price: Sonnet works in ~4× smaller steps (842 messages vs 186, 4.3× the output tokens, 68 gate runs) — its 40% lower unit price is swallowed by the higher consumption. **Per-token price ≠ per-task cost.** Verdict: **Opus is the orchestrator default**; Sonnet is a quality-viable fallback when Opus isn't available, not a cost optimization. Re-test only on a future model generation, measuring with `clone-cost.mjs` per completed clone — never assume from the price table.

## What Gets Cloned by Default

Whatever `$ARGUMENTS` points at is the target, and what a visitor sees at that address is what you reproduce. When the user has not said otherwise, work from these settings:

- **Fidelity:** pixel-perfect. Colors, spacing, typography and animations all match the original exactly.
- **Included:** the visual layout and styling, how components are structured and how they respond to interaction, the responsive design, and mock data where a demo needs it.
- **Out of scope:** Real backend / database, a WORKING auth flow, real-time features, SEO optimization, accessibility audit. (Cloning the *content* behind a login you're authorized to access IS possible via session injection — see "Auth-walled / login-gated content" in Other target stacks; it's the live auth FLOW that's out of scope.)
- **Customization:** none. This is a faithful copy, not a redesign.

Anything the user asks for explicitly (a different fidelity target, customizations, extra context) takes precedence over this list.

## Phase 0: Workspace Bootstrap

This skill is installed globally but builds inside a Next.js + shadcn/ui + Tailwind v4 scaffold — it is **not** self-contained. Before anything else, make sure you are working inside a fresh scaffold dedicated to this clone.

**Are you already inside a scaffold?** You are if the current directory has a `package.json` whose `name` is `website-cloner` AND a `src/app/` directory. If so, clone in place and skip to Pre-Flight.

**Otherwise (the normal case — invoked from anywhere), materialize a dedicated workspace.** Run the bootstrap script with the first URL. It derives a slug from the hostname, stamps a clean copy of the template into `~/code/study/Websites/<slug>/`, runs `npm install`, and prints the workspace path as its final stdout line:

```bash
/Users/ogabrielalonso/code/vyndhub/tools/website-cloner/scripts/bootstrap-clone.sh "<first-url>"
```

- **Base dir:** `~/code/study/Websites/` — one subfolder per clone, mirroring how `~/code/study/Decode/` holds one subfolder per decoded repo. Override with `WEBSITES_HOME=<dir>` only if the user asks for a different location.
- **`cd` into the printed workspace path.** Every subsequent phase (Pre-Flight, Reconnaissance, Foundation, builders, assembly, QA) runs inside this workspace, never in the template repo.
- The scaffold is exported from the template's **committed** state (`git archive HEAD`), so it is always clean (no `node_modules`, no `.git`, no prior-clone artifacts). If the user just refined the template and wants those changes in this clone, they must commit them in the template repo first — the bootstrap script **warns** when the template has uncommitted tracked changes, and stamps `docs/research/.template-snapshot` with the template commit this workspace came from.
- **Multiple URLs:** if they belong to the same site, bootstrap once and build every page inside that one workspace. For unrelated sites, bootstrap a separate workspace per site.
- **Never edit the template repo itself during a clone.** The template is the system; the workspace is the product. Refinements to the skill/template are a separate, deliberate act.

## Pre-Flight

1. **Browser automation is required.** This skill is built for the **Chrome DevTools MCP** (`mcp__chrome-devtools__*`). Confirm it is connected; if not, tell the user to add it (`claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --isolated` — the `--isolated` flag gives each session its own temp Chrome profile so concurrent clones can't collide) and restart the session. Other browser MCPs (Playwright, Puppeteer) can substitute, but every extraction recipe below is written for Chrome DevTools MCP. The tools you will lean on:
   - `navigate_page`, `new_page`, `wait_for` — load and settle the target
   - `take_snapshot` — a11y/DOM tree with element **uids** (prefer over screenshots for structure; uids feed `click`/`hover`/`take_screenshot`/`evaluate_script`)
   - `evaluate_script` — run a `() => {…}` function in the page; returns JSON directly (this is how every extraction script below runs — no `JSON.stringify` needed)
   - `list_network_requests` / `get_network_request` — enumerate the real assets (fonts, images, media, CSS) and APIs, filtered by `resourceTypes`
   - `take_screenshot` — full-page or per-element (`uid`), written to `filePath`
   - `emulate` — viewport + DPR, `mobile`/`touch`, and `colorScheme` (dark/light)
   - `list_console_messages` — surface loaded libraries and errors

   This skill cannot work without browser automation.
2. Split `$ARGUMENTS` into its URLs, then normalize each one and check that it is well formed. If any URL is invalid, ask the user to fix it before you go further. Then open every valid URL through the browser MCP to confirm it is reachable.
3. Verify the base project builds: `npm run build`. After Phase 0 the scaffold is already in place inside your workspace. If `npm run build` fails here, fix the workspace (or re-run the bootstrap script) before proceeding — never start cloning on a broken scaffold.
4. The core output directories (`docs/research/`, `docs/research/components/`, `docs/design-references/`, `scripts/`) ship pre-created in the scaffold. For multiple clones, also prepare per-site folders like `docs/research/<hostname>/` and `docs/design-references/<hostname>/`.
5. When working with multiple sites in one command, default to running them in parallel (sequentially only if resources are clearly constrained). Do not ask — decide and proceed.

## Choose Your Strategy (decide this right after Pre-Flight)

Before extracting anything, make two decisions. Getting them right is the difference between a "close enough" rebuild and a **verifiable 1:1** clone. These are the hardest-won lessons — internalize them.

### Decision 1 — Single page, or the whole site?

Enumerate every route deterministically: `node scripts/enumerate-routes.mjs` (origin from `.template-snapshot`, or `--origin https://site.com`) probes `/sitemap.xml`, `/sitemap-0.xml`, `/sitemap_index.xml` in order, follows sitemap-index children, keeps same-origin paths, dedupes + sorts → `docs/research/routes.txt`. Then also crawl the nav + footer for internal links the sitemap may omit.

**Decide autonomously — do not ask:**
- The user explicitly limited scope to one page, OR the URL is a deep link with no sibling routes → clone just that page.
- Otherwise (the URL is a site root, or the user named the site / said "all pages" / "the whole site" / "todas as páginas") → **clone the WHOLE site**: enumerate EVERY internal route from the sitemap + nav/footer crawl and build all of them. Group repeated layouts into **templates** (one blog-post template serves N posts; one team template serves M members) and build dynamic routes (`app/blog/[slug]/page.tsx` + `generateStaticParams`) backed by a per-slug content map — so "all pages" stays cheap no matter how many (each extra page is just a content file; generate the slug→HTML barrel deterministically with `node scripts/gen-content-barrel.mjs --content-dir src/content/<type>`, which writes the `index.ts` map — fallback: hand-write it). External domains are out of scope. Reuse the shared `<Navbar/>` / `<Footer/>` across every route. When in doubt, clone the whole site — that's the user's default intent.

### Decision 2 — Rebuild from specs, or PORT THE REAL COMPILED CSS?

> **First ask what the user will DO with the clone — this is an EDITABILITY decision, not only a fidelity one. State which you are producing; never silently hand back a replica when they wanted components.**
> - **"I want a pixel-perfect running replica"** (host it, study it, demo it) → **markup-port**: serve the real `<body>` HTML + replay the real scripts. Trivially 1:1, cheap, fast — but the output is a **frozen replica**, NOT editable components (each route is a raw HTML blob in `src/generated/routes/*.json`; there are no `Hero.tsx`/`Features.tsx`). Editing = hand-editing markup/CSS.
> - **"I want an editable / reusable codebase"** (import components, change props, maintain it) → **component-rebuild**: dispatch builders that produce real React components from extracted specs, then let the Phase-5 pixel-diff gate drive them toward the original. You get editable code — but expect **"faithful with named residuals", not literal 0/N**, and it's slower + pricier. Fidelity tops out higher the cleaner the source structure is; **class-soup sites (Webflow auto-classes, heavy IX2) rebuild poorly** — there, markup-port is the only path to true fidelity, and "editable" means accepting a lower-fidelity rebuild.
> - **Can't have literal-100%-both in one artifact for a complex site.** If both genuinely matter, the proven answer is **replica + on-demand extraction**: clone via markup-port (pixel-perfect, cheap), then extract any section the user wants to reuse/edit as a real component with the committed `node scripts/extract-section.mjs --route <slug> --list` → `--section <name>` (C1 = the section's verbatim HTML in a named component, zero fidelity risk; `--c2` = real transpiled JSX, recommended for clean Astro markup only; `--with-css` = a best-effort globals.css slice for transplanting into another project). This was studied against full componentization of the pipeline and won: ~72% of sections are byte-unique (dedupe gains are tiny), structural variants break eager slicing, and on-demand extraction adds zero risk to the proven path. Do NOT fold componentization INTO the markup-port pipeline itself (rebuilding the slicer to emit components inline) — that's the studied-and-rejected approach. (This is distinct from **Phase 7**, which componentizes the finished clone as a SEPARATE deterministic post-pass *after* the gate passes — see Phase 7; that one is the default deliverable.)

First detect the stack — it dictates the fidelity strategy. `evaluate_script` the `<script>`/`<link>` tags + `meta[name=generator]` (Astro = `_astro/*` + `data-astro-cid-*`; Next = `_next/*`; also Nuxt, SvelteKit, Vite).

> **Library-detection caveat:** GSAP / Framer / Lenis imported as ES modules are NOT on `window` — `window.gsap` is `false` even when GSAP drives the whole site. Read the component scripts' `import` statements (fetch the JS bundles) to see the real stack. GSAP and every plugin (ScrollTrigger, SplitText, Flip, CustomEase) are **free** since v3.13 — `npm i gsap` and port the real eases/timelines 1:1 (e.g. `CustomEase.create("name","0.7,0,0.2,1")`).

**If the target ships COMPILED CSS** (a Tailwind build, CSS modules, Astro/Next/Vue/Svelte scoped styles — i.e. nearly every modern framework site), **do NOT hand-rebuild styles from `getComputedStyle` specs.** That path always drifts. Port the real CSS verbatim — it is pixel-perfect by construction:

1. **Gather every CSS source deterministically first:** `node scripts/css-collector.mjs` reads the saved raw HTML and downloads every `<link rel="stylesheet">` across all pages (deduped, resolved via the origin in `.template-snapshot`) **and** extracts every HEAD-level inline `<style>` block, writing them + an ordered `manifest.json` to `docs/research/css/`. This is the floor that prevents the silent "saved 2 of 5 sheets → drift" miss (real Vaultix bug). THEN do one live `list_network_requests resourceTypes:["stylesheet"]` pass to catch any stylesheet injected at runtime (not in the static HTML). Body `<style>` blocks are left in the markup by `slice-routes.mjs` — don't double them here.
2. **De-scope** the framework's scoping so rules match your markup. For **Astro**, run the committed transform (it strips `[data-astro-cid-*]`, repairs dangling combinators `>{` → `> *{`, removes empty rules, and refuses to emit broken CSS):

   ```bash
   node scripts/css-descope.mjs --framework astro <stylesheet1.css> [stylesheet2.css ...] --out src/app/globals.css
   ```

   It is **transform-only** — you still choose which sources to pass and their order (preflight/base first, font `@import` at the very top). Astro, Vue (`[data-v-xxxx]`) **and Svelte (`.svelte-xxxx`) are all auto-detected and stripped.** Svelte is class-scoping and DOUBLES the class for specificity (`code.svelte-x.svelte-x` → `code`); the script handles it per selector-unit (only on selector heads, never inside declaration values/strings) — it strips `.svelte-x` from a compound unit only when a real selector survives, and keeps ONE hash when a unit is *bare* `.svelte-x` (the ported markup still carries the class, so the rule keeps matching instead of collapsing to an empty selector). **Collision guard:** if de-scoping a selector would leave a PURE type/universal selector (no class/id/attribute — `code`, `a`, `div span`), it keeps the original scoped selector instead — a bare element rule collides with global element styles (pocketbase's scoped block-`code` de-scoped to `code` stole `width:100%` from inline `<code>`, wrapping text on every docs page). Proven on pocketbase.io (44 routes, 0/88). If the script ever exits non-zero (an unhandled scoping shape): regex-strip by hand, fix dangling combinators, and re-scan for empty selectors. **When it warns about a de-scope collision** (same cid on ancestor AND descendant — the stripped rule can now over-match other markup, e.g. a generic `.chart{width:100%}` inside a `@media` leaking onto every chart): fix by **re-scoping that rule to its component's parent class** (`.feature-chart .chart{…}`) rather than deleting it — verified by the pixel-diff both times this fired in production.
3. Concatenate (preflight/base first, keeping the font `@import` at the very top), and write it as `src/app/globals.css`. Drop the scaffold's `@import "tailwindcss"` — the compiled output already contains every utility the markup uses; regenerating would double the preflight.
4. Build each section/page by **replicating the exact original markup** (same classes AND same `data-*` — the JS hooks select by them). Don't invent Tailwind. For content-heavy pages the fastest faithful path is to render the page's exact `<main>` inner HTML via `dangerouslySetInnerHTML` (sliced from the live HTML with a real parser) and port that page's JS into a `useEffect`.

If the target ships hand-written CSS (rare) or it's one simple page, the spec-driven rebuild in the phases below is fine.

> **Heavy-runtime sites are still markup-port — NOT a "too hard to clone" category.** Three.js/WebGL (GLB/Draco/HDRI/MSDF 3D), Rive, Taxi.js SPA transitions, Lenis smooth scroll — when the whole app is one (often obfuscated) bundle, you do **not** rebuild the 3D/animation from specs. You replay the *real* bundle against the ported DOM and it runs 1:1 for free. Verified on landonorris.com (WebGL helmets/track + 8 Rive canvases + Taxi + Lenis): **0/12 pixel-diff flagged**. The live-animated WebGL/Rive regions read as *noise* in the pixel-diff (noise floor = original captured twice), never as defects. The only real obstacle on these sites is **asset access**, not behavior — see "Hotlink-protected / runtime-fetched asset graphs" below.

### Port behavior 1:1 — non-negotiable for animation-rich sites

- **Port every bespoke script faithfully — never substitute a generic reveal.** A generic "fade-up on scroll" in place of the site's real per-section animation/interaction is an instant tell and the user WILL notice (this exact shortcut got called out). Fetch each component's JS bundle, de-minify it, and reproduce every duration / ease / stagger / ScrollTrigger config / count-up / tab-switch / accordion / form handler / pinned-scroll exactly. Delegate one builder per template, each porting its scripts into `src/lib/sections/<name>.ts`, self-guarded by section presence and scoped to a root element. Shared sections (CTA, FAQ, comparison, charts) get one faithful port reused everywhere.
- **Preserve data islands.** When slicing markup, strip executable `<script>` but KEEP `<script type="application/json">` (and any `data-*-data` island). Frameworks pass per-component data through these; stripping them silently breaks switchers / carousels / counters that do `JSON.parse(island.textContent)`. (Symptom: an interactive widget renders its first state and never changes.)
- **Re-init canvases/effects inside injected markup.** `dangerouslySetInnerHTML` inserts `<canvas>`/`<img>` but does NOT run the JS that draws them. A runtime must scan the injected DOM for `[data-halftone]`, `[data-halftone-image]`, Lottie, particle/WebGL canvases, etc. and re-run their renderer (ported 1:1). Skipping this leaves blank boxes where the signature visual should be (e.g. dot-rendered team photos).
- **Route-aware FOUC classes.** If the site adds anti-FOUC classes to `<html>` (`is-loading`, `*-pre-anim`) that hide content until JS reveals it, add home-only ones (a loader lock, or a `hero-pre-anim` that also hides the SHARED navbar) ONLY on the home route; add the rest everywhere. A home-only class leaking onto subpages hides a shared element (the navbar) with nothing to un-hide it.
- **Download ALL responsive image variants.** Frameworks emit one hashed file per srcset size. Grep every `src` AND `srcset` across all pages and download each variant, or a viewport will 404 the exact size it requests.
- **Silence expected-empty tweens at the root:** `gsap.config({ nullTargetWarn: false })` once at registration — sections legitimately have optional elements; don't guard every call.

### Webflow / IX2 / Finsweet sites

Webflow exports clone best via **markup-port** (serve each route's exact `<body>` inner HTML through `dangerouslySetInnerHTML` and replay the original script sequence in a client `WebflowRuntime`), not component rebuild. **Slice with the same generic `node scripts/slice-routes.mjs` used for ESM sites** — it keeps the script order + attrs Webflow needs; do NOT write a bespoke Webflow extractor (proven on landonorris.com: the generic slicer + the runtime below hit 0/12). The Webflow-specific concerns below are all in the *runtime replay*, not the slicer. Gotchas — 1–5 (every Webflow site), then 9–14 (Ecommerce + heavy IX2-reveal templates; proven on rosalia-template, 0/38). Learned the hard way:

1. **Parens in asset filenames 404 on Next.** Next reserves `()` for route groups, so `public/…/hero (1).avif` 404s. After downloading assets, run `node scripts/sanitize-asset-names.mjs` — it renames paren files and rewrites every reference in the ported HTML + globals.css (driven by the asset-URL list, idempotent).
2. **Allow balanced parens in the asset-URL regex.** A `[^()]` URL class silently drops `hero%20(1).avif`; allow parens and strip only a trailing unbalanced `)` (the CSS `url(…)` closer).
3. **GSAP must load before `webflow.js`.** IX2 calls `window.gsap.matchMedia()` on init, and on the clone `document.readyState` is already `complete` so IX2 inits immediately — reorder every `gsap` `<script>` ahead of jQuery / webflow.js.
4. **Queue `DOMContentLoaded`, don't fire it eagerly.** Scripts register `DOMContentLoaded` handlers; collect them and fire all of them *after* the whole script sequence has run (mirrors the real once-after-parse event) — firing per-script leaves later-loaded globals (GSAP) undefined.
5. **Preserve `type="module"` and `fs-*`/`data-*` script attributes.** Finsweet Attributes v2 is ESM (`<script async type="module" fs-list>`); dropping `type="module"` → "Cannot use import statement outside a module".
9. **IX2 scroll-reveal RACE — inject the replay at PARSE TIME, not in a `useEffect`.** The client `MarkupPortRuntime` inits IX2 *after* React hydration; the QA harness (and a fast user) scroll before IX2's initial in-view scan runs, so above-the-fold `SCROLL_INTO_VIEW`+`SLIDE` reveals stay stuck at `opacity:0` (they're two-way w/ `autoStopEventId` → never re-fire once started in-view). **Non-deterministic (~50% hit, WORSE at low concurrency = faster load).** Fix that made it 5/5 deterministic: emit the replay as an **inline `<script>` in the SSR'd page** (after the body div, `dangerouslySetInnerHTML`, `window.__wfBooted` guard) so the browser runs it during initial parse — mirroring the live site. This is the single biggest fidelity fix for animation-heavy Webflow; prefer it over the client runtime when IX2 reveals dominate.
10. **Webflow Commerce csrf/apollo retry-loop hangs `networkidle` → every commerce route times out in qa-diff.** webflow.js POSTs `/.wf_graphql/csrf` then `/.wf_graphql/apollo`; on the clone they 404 → webflow RETRIES csrf in a tight loop → `networkidle` never settles → 60s timeout. Fix: a Next `middleware.ts` matching `/.wf_graphql/:path*` returning the real shapes — csrf → `{"ok":1}` (+ set the wf-csrf cookie), apollo → the live empty-cart Dynamo3 JSON (`commerceOrder:null`). Lets the handshake complete once so the cart renders empty like the original (backend is out of scope).
11. **Localize the JS bundles too (not just images).** Keeping jQuery + webflow.schunk (~1.5 MB) + main on the CDN adds latency to the onload-chained sequence → later IX2 init → worse reveal race (#9). Download all (webfont/jQuery/schunk/main) to `public`, rewrite `externalScripts` src → root-relative, drop integrity/crossorigin (same-origin).
12. **Utility pages carry `<body class="body">` that flips the font to system-ui.** `/licencing` (and 404/password) use plain `<h1>/<h2>` inheriting `body`; the template's `.body{font-family:system-ui}` (class specificity) beats `body{font-family:Inter}`. The slicer discards body-tag attrs → clone body has no class → wrong font → text-ghost diff. Fix: capture `bodyAttrs` per route (like htmlAttrs) and apply to `document.body` in the bootstrap (`suppressHydrationWarning` on the layout `<body>`).
13. **`.w-webflow-badge` is injected on the clone but ABSENT on the paid original.** webflow.js adds the "Made in Webflow" badge because localhost isn't the licensed domain; the paid template suppresses it → diff = an extra fixed element. Fix: `.w-webflow-badge{display:none!important}` in globals.css. (A promo widget's own "Made in Webflow" label is separate markup — keep it.)
14. **`output:standalone` + `next start` is unstable** (process exits mid-run → CONNECTION_REFUSED in qa-diff). Serve the QA target via `node .next/standalone/server.js` with `public/` and `.next/static/` copied into `.next/standalone/` first (re-copy after every rebuild). Also: a nested CSS `@import` for Google Fonts registers `@font-face` too late on light pages → use a direct `<head>` `<link rel=stylesheet>`. (Spaces/`%20` in Webflow filenames serve fine from Next `public/` — only parens break, see #1.)

### ESM-module sites (Astro / Vite / SvelteKit)

These ship ESM bundles (`<script type="module" src="/_astro/*.js">`), not Webflow's jQuery/IIFE model — so the markup-port runtime differs:

- **Slice deterministically.** Save each route's raw HTML to `docs/research/raw-html/<slug>.html` (slug-encode the path: `"/"` → `index.html`, `"/blog/x"` → `blog__x.html`), then run `node scripts/slice-routes.mjs`. It writes per-route JSON (cleaned `bodyHTML` with JSON islands kept, ordered `externalScripts` with attrs preserved, `prePaint`, `deferredInline`) + `src/generated/manifest.json` with dynamic-route families — the markup-port input, zero tokens. For the page + runtime, copy the proven skeleton `scripts/templates/markup-port-page.tsx.tmpl` — it has THREE file sections to split out (`src/lib/routes.ts`, `src/app/[[...slug]]/page.tsx` server, `src/components/MarkupPortRuntime.tsx` client) that serve `bodyHTML` via `dangerouslySetInnerHTML` (display:contents wrapper), replay `externalScripts` in order with attrs preserved, run `deferredInline`, then re-fire `DOMContentLoaded`/`load`. **Before relying on the `display:contents` wrapper, grep the ported CSS for `body > ` / `main > ` direct-child selectors** — the wrapper is a real DOM child, so a `body > *` rule would match it instead of the ported sections (silent layout breakage). If any exist, host the bodyHTML on the real body/main element instead (Phase 7's componentize already does this). (App Router forbids `generateStaticParams` in a `"use client"` file — that's why page and runtime are separate.)
- **Re-host the JS graph TRANSITIVELY.** The HTML only lists the per-component *entry* scripts; the shared chunks (`gsap`, `ScrollTrigger`, `SplitText`, custom eases) appear only as `import … from "./X.js"` **inside** those bundles. Run the committed closer: `node scripts/close-js-graph.mjs --manifest src/generated/manifest.json --origin <origin> [--referer <origin>]` — it reads every route's `externalScripts`, fetches each module, extracts its relative `import` / `export … from` / `import()` specifiers (comments stripped to avoid false positives), and recurses until the graph closes, mirroring each module under `public/` preserving its origin path (so `/_astro/X.js` → `public/_astro/X.js`). **Keep the default `--out public` — do NOT pass `--out public/_astro`**, which double-nests to `public/_astro/_astro/X.js` so the entries load but their transitive `import "./shared.js"` 404 → dead animations, `is-loading` stuck (caught as a uniform 26/26 pixel-diff on the Vaultix Astro clone). Miss this step entirely and nothing animates.
- **Replay in document order with `async=false`.** Inject each `externalScripts` entry as a real `<script>` preserving its attrs (`type="module"`, `async`, `fs-*`, `data-*`) and set `script.async = false` so the browser keeps the original execution order. Module init runs **on module evaluation** (not necessarily `DOMContentLoaded`), and each module does its own `gsap.registerPlugin(...)` — don't centralize plugin registration.
- JSON islands and pre-paint FOUC scripts are handled exactly as in the Webflow gotchas above — the slicer already separates them.

### Hotlink-protected / runtime-fetched asset graphs (agency CDNs)

Premium-agency builds (OFF+BRAND, etc.) often load one obfuscated app bundle whose `.glb/.riv/.hdr/.wasm/msdf` asset graph is built *inside* the bundle (you can't enumerate it via `list_network_requests` up front), AND the agency CDN hotlink-protects by `Referer` — every asset 403s from any origin but the original, which **silently kills the entire JS app** on the clone (blank `<canvas>` at the default 300×150, no Lenis/Rive/WebGL/Taxi). Two cases:

- **Static, enumerable assets** → `node scripts/download-assets.mjs --referer https://<original>/` mirrors them with the right Referer (the default fetch UA + no Referer is what 403s).
- **The bundle + its in-bundle asset graph** → you can't mirror what you can't list. **Proxy instead:** copy the committed template `cp scripts/templates/asset-proxy-route.ts src/app/<seg>/[...path]/route.ts`, set its `HOSTS` + `REFERER`, and rewrite the bundle's 2–3 base-URL string constants to `/<seg>/<key>` (re-host the bundle same-origin first, then a trivial `String.replace`). The handler re-fetches upstream WITH the Referer and disk-caches each asset once — the clone keeps working even if the CDN later goes down.
- **Next private-folder trap:** the proxy folder must **NOT** start with `_` — `app/_ob/` is a *private folder*, silently excluded from routing, so the handler 404s and never appears in `next build`. Use `app/ob/`. (Add the cache dir, e.g. `.asset-proxy-cache/`, to `.gitignore`.)

### Embed-injected page content (iubenda, etc.)

Some routes ship near-empty static HTML + an inline 3rd-party loader (`cdn.iubenda.com/iubenda.js`) that injects the real body client-side. The markup-port runtime must execute each route's **`deferredInline`** scripts (the slicer separates them) **before** re-dispatching `load` — the loader registers a `window.load` handler. Symptom: one legal/policy page shows a large mobile diff while its statically-shipped sibling is 0%. (Reproduce exactly what the live embed shows — if iubenda returns "policy no longer active", the faithful clone shows that too.)

### Other target stacks (quick reference)

Detect the stack in Pre-Flight (Decision 2), then apply — the markup-port recipe holds; these are the per-stack specifics (each verified against the real platform).

- **Next.js target (`/_next/static/`) — cloning Next.js INTO the Next.js scaffold.** Identify the router: `<script id="__NEXT_DATA__" type="application/json">` = **Pages Router** (slice-routes keeps it — a JSON island); `window.__next_f` = **App Router**. **Proven on Nextra (App Router, 59 routes, 56–57/59 pixel-perfect).** Next-into-Next has four traps the generic markup-port flow gets WRONG — do not replay external chunks the way you would for Webflow/Astro:
  - **Capture the SETTLED (post-hydration) DOM, not the SSR shell.** App Router streams Server Components via `__next_f.push(...)`; snapshot each route with headless Playwright (MCP `navigate_page` → `wait_for` content) only after `document.readyState==="complete"` AND `__next_f` stops growing (poll ~50ms, settle ~3 ticks, 5s ceiling) — this also bakes client-rendered mermaid SVGs / KaTeX that curl-SSR misses. Save THAT as `docs/research/raw-html/<slug>.html`, then slice.
  - **Do NOT replay the original's external App Router chunks — they can't hydrate (two-React conflict).** The scaffold is itself App-Router React rooting `document`; a second React from the injected chunks can't hydrate the same document → zero React interactivity (theme toggle, sidebar, search all dead) plus load + console noise. ALSO the original's inline `self.__next_f.push(...)` RSC scripts collide with the clone's own `__next_f` stream ("enqueue into closed stream" ×N) → **filter `__next_f` inline scripts OUT** of the replay. The WORKING replay is **only the functional inline scripts** — the next-themes `color-scheme` setter + anti-FOUC (without it the bg/scheme drifts → ~0.86 whole-page diff). Native `<a>` nav + `<details>` work; React-driven controls are the documented residual.
  - **Next 16 FORBIDS `public/_next/`** (hard build error `public-next-folder-conflict`) — the old "files land at public/_next without patching" advice is WRONG for Next 16. Re-host the origin's `_next/static` ASSETS (CSS, fonts, media — NOT the JS chunks you are not replaying) to **`public/orig-next/`** and remap every `/_next/` → `/orig-next/` in the route JSONs + globals.css (+ any surviving webpack `.p="/_next/"` publicPath literal). The clone's OWN build keeps `/_next/`. **Gotcha:** a relocate step that does `rmSync(orig-next)` then `rename(_next → orig-next)` WIPES already-relocated assets on a re-run — make it idempotent (merge, don't rm-then-rename).
  - **Webpack dynamic chunks** (only if you must fetch a specific one): the runtime maps chunk-id→hash via `__webpack_require__.u`, NOT ESM `import()`, so `close-js-graph` misses them — `evaluate_script` the site's own `__webpack_require__.u` to enumerate the chunk URLs. (Componentize auto-emits `custom-elements.d.ts` for custom-element hosts like `<inkeep-portal>`; boolean host attrs are handled.)
- **Open shadow DOM (web-component / live-MDX demos).** Signal: hosts like `<div mode="open" …></div>` that render visibly on the live site but are EMPTY in saved HTML, leaving a shorter block (a Nextra `/docs/guide/markdown` clone came out 100px short on one demo → mobile 0.0489). Cause: the demo content lives in an **open shadow root** built by client JS, and neither `curl`/SSR HTML nor `element.outerHTML` serializes shadow trees. Fix at capture time — when you snapshot the hydrated DOM via Chrome MCP, use `document.documentElement.getHTML({ serializableShadowRoots: true })` (NOT `outerHTML`) so each open shadow root is emitted as a declarative `<template shadowrootmode="open">…</template>` inside its host. React 19 re-emits that template verbatim through `dangerouslySetInnerHTML`, the browser's HTML parser reconstructs the real shadow root on the static load, and the `MarkupPortRuntime` DSD-hydration effect covers the innerHTML-injection path too — so the demo renders at full height and the route diffs clean. **Note:** the build caches SSG renders by source file, so after hand-patching a generated route/section, `rm -rf .next` before re-building or the change won't appear.
- **Pure client-rendered SPA (Vite/Vue/CRA, empty `#app`/`#root` shell).** Signal: `curl` body is a ≤500-char shell, slice-routes `bodyHTML` near-empty. The one case markup-port can't read from the server. **Proven on hoppscotch.io (the API-client APP itself — 30 routes, 0/60).**
  - **Snapshot the SETTLED hydrated DOM — go STATIC, do NOT replay the bundle.** Per route: MCP `navigate_page`, settle-poll the root's `innerHTML` + `fonts.ready`, then `evaluate_script(()=>document.querySelector('#app').outerHTML)` and save THAT as the raw HTML, then slice. Capture the **root only** (Crisp/PostHog/toasts live outside `#app` → naturally excluded). **Replaying the bundle is WRONG here** (the old advice): it re-mounts, fires backend/auth/sync/websocket calls that 404 with no backend, and **WIPES the content** (version badge → "vundefined", sections vanish) — same failure family as Nuxt and Next-into-Next's two-React. Serve the snapshot verbatim, no scripts.
  - **State via localStorage, not headers.** Many SPAs ignore `navigator.language`/OS theme and read `localStorage` (e.g. `persistence.v1:locale`). Seed the canonical values via `addInitScript` BEFORE boot; bake `<html class="dark" …>` in layout (`slice-routes` drops html attrs).
  - **JS-driven responsive → DUAL-DOM.** When the layout reflows in JS (`useBreakpoints`/splitpanes hide a sidebar, move a rail to a bottom bar) it is NOT pure CSS, so a single desktop snapshot can't match mobile. Capture BOTH viewports' DOMs, render both, and toggle at the breakpoint: `.vp-desktop/.vp-mobile{display:contents}` + a media query flipping the off-viewport one to `display:none`.
  - **Per-route headCSS for runtime-injected StyleModules.** Editors (CodeMirror's generated `.ͼ1`/`.ͼo` classes, equal-specificity last-wins) inject `<style>` at runtime; folding all routes' inline blocks into one globals.css flips the winner → text shifts a few px → ghosting. Keep globals.css = external `<link>` sheets ONLY; render each route's OWN head `<style>` blocks in the page body via `extract-head-css.mjs` → `route.headCSS`.
  - **Capture gotchas:** reflect each `<input>/<textarea>` live `.value` → its `value` attribute before serializing (DOM properties aren't in `outerHTML` → empty fields otherwise); strip caret/focus artifacts (`.cm-activeLine`). `tokenize-css` is safe on compiled-Tailwind now (it skips `rgb(… / var(--tw-…))` opacity-fn values).
  - **Auth boundary:** public routes (`/`, `/settings`, …) snapshot real content; gated routes (`/admin/*`, `/orgs/*`) render the logged-out shell → clone them as the exact anonymous shell and document it (no creds), or use the "Auth-walled" recipe to inject a session.
- **Canvas-only / WebGL (Three.js, importmap ESM; entire viewport is a `<canvas>`).** Signal: `curl` body is a tiny shell, **no portable DOM at all**, the `<canvas>` is created by JS at runtime, `<script type="importmap">` + `three`/`webgl` refs. markup-port has nothing to port → **replay the REAL bundle** (heavy-runtime, like landonorris — do NOT rebuild the 3D from specs; the original module script runs verbatim and renders 1:1 for free). **Proven on threejs.org/examples (0/2, signal ≤ live noise floor).**
  - **Serve via a root ROUTE HANDLER (`src/app/route.ts`), NOT a React page.** Two hard reasons: (1) the `<script type="importmap">` must be in the served HTML BEFORE the module runs — it can't be injected client-side (the `MarkupPortRuntime` useEffect path is too late); (2) the module `appendChild`s the WebGLRenderer canvas into its container, and React hydration would treat those JS-added nodes as a mismatch and tear them out. So: `route.ts` with `export const dynamic = "force-static"` + `GET(){ return new Response(HTML, {headers:{'content-type':'text/html'}}) }`; delete `src/app/{page,layout,globals.css}` so the handler owns `/` (Next 16 builds a root route-handler with no layout).
  - **Localize the EXACT module graph from the network, not close-js-graph.** importmap bare-specifiers (`three`, `three/addons/`) + transitive `jsm/*` deps + `jsm/libs/draco/*` (wasm decoder) + `models/*.glb` don't resolve through `close-js-graph`'s static-import scan → enumerate what the browser ACTUALLY fetched via `list_network_requests resourceTypes:["script"]` after load, mirror all of it to `public/` preserving origin paths, and repoint the importmap + script srcs to root-absolute (`/build`, `/jsm`, `/models`). (CDN like `threejs.org/build/*` serves "latest" un-versioned → MUST localize or it drifts on the next release.)
  - **Gate in LIVE mode, never `--baseline`.** The canvas animates every frame → a static baseline PNG vs an arbitrary frame falsely flags; live mode's noise floor (original captured 2×) absorbs the animation (observed signal 0.009 ≤ noise 0.0119 → delta 0). Clone serves at `/` but the original is a deep-link → add a Next `rewrite` so the clone also answers the original path, then `--original <origin> --routes <original-path>`. Phase 6/7 are N/A (no compiled CSS to tokenize, no React sections); the editable surface IS `route.ts` + the `/jsm` modules.
- **Framer (`meta generator="Framer"`, `data-framer-*`, `framerusercontent.com`).** SSR's real content → `slice-routes` works; markup-port as usual. **Proven on daytona.io home (0/2).** The old "CSS via `adoptedStyleSheets`" guidance was WRONG for this site — verify per-target. Gotchas:
  - **CSS ships as inline `<style>` in `<head>`, NOT `adoptedStyleSheets`** (≥ this Framer version): `data-framer-css-ssr-minified` (the big compiled block, `html,body,#main{…}` + every `.framer-*` rule), `data-framer-font-css` (@font-face), breakpoint/scrollbar/background blocks. **`css-collector.mjs` catches them** as head inline blocks — no live adoptedStyleSheets walk needed. The 100+ `--token-*` design tokens live EMBEDDED in that block, NOT in `:root` (the recon `:root` walk returns ~2 vars) → port the block verbatim, do NOT run css-descope or token extraction. (If a future Framer target DOES use adoptedStyleSheets — empty css-collector output — fall back to the runtime walk → `framer-runtime.css`.)
  - **Bundle replay = full hydration, free.** The `<script type="module" data-framer-bundle="main" src="…framerusercontent.com/sites/…/script_main.*.mjs">` hydrates `#main` from the embedded `data-framer-hydrate-v2` JSON island (no backend fetch) and imports its OWN React (hydrates only `#main`, no two-React conflict with the Next scaffold). Keep it on the CDN (its transitive `./react.*.mjs` / `./framer.*.mjs` chunks resolve same-origin). **`framerusercontent.com` images and fonts are CORS-enabled and NOT Referer-hotlinked** (200 from any origin) → keep on CDN; no `--referer` needed (contra the generic agency-CDN advice).
  - **Two inline scripts must run BEFORE the bundle (preInline), not deferredInline** (where slice puts them): the `window.process={env:{NODE_ENV:"production"}}` polyfill (the bundle reads `process.env` on eval → ReferenceError otherwise), and a re-created `<script data-framer-appear-animation="no-preference">` marker (slice keeps the body but DROPS the attrs; the bundle queries the selector to decide appear animations). **Filter analytics** (`zeroclick.ai`, `events.framer.com`, GTM) out of externalScripts. The committed `hybrid-postprocess.mjs` does all of this (detects Framer routes by the `script_main` bundle).
- **HYBRID two-stack sites (e.g. Framer marketing + Astro blog/docs behind one origin).** **Proven on daytona.io (471 routes: 1 Framer home + 470 Astro collections, stratified gate 0/42).** Detect per-route (`meta generator`) — a sitemap-index split into per-collection child sitemaps is the tell. The hard part is that the two stacks ship **conflicting tag-level resets** (`*{} body{} html{} :root{}`) that cross-contaminate in one globals.css. Fixes (all in committed scripts):
  - **Per-route headCSS, empty globals.css.** Each route re-emits its OWN `<head>` `<style>`/`<link>` (the original's exact set) via React 19 `precedence` hoisting in `page.tsx` — zero cross-stack bleed. `extract-head-css.mjs` captures `headCSS` (ordered links + style blocks) AND `headInline` (head `<script>` bodies) per route onto the route JSON; the catch-all page renders `route.headCSS`. globals.css stays empty (still imported by layout, so the Next CSS pipeline is intact).
  - **Astro fonts MUST be localized (CORS).** `@font-face` .otf/.ttf are CORS-restricted; an Astro stylesheet served cross-origin resolves its `url(/fonts/…)` to the original origin → fonts fail → fallback-metric reflow (a uniform 1–7% text-shift diff on every Astro page, the #1 root cause). **Download `/_astro/` + `/fonts/` to `public/`** (root-relative paths resolve locally); `hybrid-postprocess.mjs` keeps Astro paths root-relative (does NOT rewrite to CDN). (Framer fonts on framerusercontent CDN are fine — that CDN sends CORS; Astro's self-hosted fonts do not.)
  - **Astro head inline scripts → preInline.** An anti-FOUC `ThemeProvider` defined in `<head>` must exist before island hydration (an island calls `ThemeProvider.updatePickers()` on hydrate) — `hybrid-postprocess.mjs` promotes Astro `headInline` to preInline and dedupes them out of deferredInline; it also drops inline analytics (PostHog).
  - **Close the Astro island JS graph.** `close-js-graph`'s `--entry` flag under-seeded here (1 seed); seed every `/_astro/*.js` island/entry, or recurse the relative imports manually — missing `jsx-runtime`/`client`/component chunks → "Failed to fetch dynamically imported module" + dead islands (navbar/menu still SSR-visible, so the pixel-diff passes but the console errors and interactivity dies).
  - **GitHub-API-403 (star-count island) and other 3rd-party 403s that the ORIGINAL ALSO logs are fidelity, not defects** — leave them; "clean console" means *matching the original's console*.
- **Next-16 + markup-port infra gotchas (bit the daytona run, apply to ANY Next-16 clone):**
  - **`dynamicParams = false` makes the dev/prod server CRASH (`Internal: NoFallbackError`)** when something requests an un-generated dynamic path — and content pages prefetch/link hundreds of sibling routes you may not have sliced yet, so the server dies mid-gate (every pending route then reads as INFRA `ERR_CONNECTION_REFUSED`). Set **`dynamicParams = true`** so un-sliced paths resolve to a clean `notFound()`/404 (the page already calls `notFound()` when `loadRoute` is null).
  - **Next 16 snapshots `public/` at BUILD time.** Assets added to `public/` AFTER `next build` 404 even after a server restart — **rebuild** after downloading any new public asset (the Astro JS chunks 404'd until a rebuild).
  - **Capture all routes cheaply with the committed `capture-routes.sh`** (xargs-parallel curl of the SSR HTML, slug-encoded; retry 502s with `--force`).
  - **The live original can hang qa-diff's `networkidle`** (PostHog flags / tracker polling never idles) — small early gates pass by timing, later/bigger ones hang. When that happens, the proof is the largest clean stratified run + by-construction non-regression (script-only changes don't touch bodyHTML/headCSS) + a direct clone-vs-original screenshot compare; promote a good capture and use `--baseline` for a repeatable gate.
- **SvelteKit (`data-sveltekit-*` attrs, `/_app/immutable/`).** SSR's real content → `slice-routes` works; markup-port as usual. **Proven on pocketbase.io (44 routes, 0/88).** CSS ships as real `<link>` sheets under `/_app/immutable/assets/*.css` (css-collector catches them) and uses Svelte class-scoping (`.svelte-<hash>`, doubled for specificity) — `css-descope --framework svelte` auto-detects and strips it, keeping pure-type rules scoped (see the de-scope step — that's the 6th gotcha, handled there). Five runtime gotchas, hard-won:
  - **Hydrate into the SvelteKit shell wrapper, not `document.body`.** The bootstrap inline script runs `kit.start(app, document.currentScript.parentElement, …)` — it hydrates its SCRIPT's parent. In `app.html` that parent is the shell wrapper (pocketbase: `<body><div class="page-body">%sveltekit.body%</div>`), whose `display:flex;min-height:100vh` + base background are load-bearing. The stock `MarkupPortRuntime` appends inline scripts to `document.body` → SvelteKit mounts one level too high and DROPS the wrapper. Fix: inject the SvelteKit inline scripts into the wrapper (`document.querySelector('.page-body')` with fallback chain), not `document.body`. Success tell: the wrapper survives and heights match.
  - **CSS-preload 404 → SvelteKit renders its `500` page OVER your content.** The client preloads each route-node's `_app/immutable/assets/*.css`; a 404 throws "Unable to preload CSS…" → hydration aborts → the `+error` boundary paints `<h1>500</h1>` and wipes the SSR DOM. Fix: copy the original `_app/immutable/assets/*.css` (real hashed names) into `public/_app/immutable/assets/`. Keep globals.css for first paint — the duplicate rules are identical, no cascade conflict.
  - **`trailingSlash:true` in `next.config`.** SvelteKit emits depth-relative asset paths (`./_app/` at `/`, `../../_app/` at `/docs/x/`) that resolve to `/_app/` only with the original's trailing slash — match it so the runtime `base` computation is identical.
  - **close-js-graph seeds:** the app loads via the bootstrap's dynamic `import()`, NOT `<script src>`, so the manifest's `externalScripts` only has pagefind — pass `entry/start.js` + `entry/app.js` (and every `nodes/*`/`chunks/*` ref grepped from the raw HTML) as `--entry`. A `nodes/*` 404 that also 404s on the original is a benign false-positive; `extract-asset-urls` also false-positives on inline `new URL(".",location)` → filter to real asset extensions.
  - **pagefind search:** mirror `/pagefind/` core (pagefind-ui.js/css, pagefind.js, pagefind-entry.json, the wasm + pf_meta) so the box inits clean; the per-query index is optional (search backend is out of scope).
- **Nuxt (`#__nuxt`, `window.__NUXT__`, Vue `data-v-*`, `/_nuxt/*` chunks; `meta generator` null).** Nuxt UI v4 + Tailwind v4 (oklch tokens), often dark-by-default. SSRs the full DOM → `slice-routes` works; curl gets full SSR. **Proven on nuxt.com (316 routes: home + ~22 marketing/modules + 248 `/docs/4.x/*` + 49 `/blog/*`); 74-route stratified gate (--hide .carbon) = 131/148 pairs pixel-perfect (Δ~0.000X–0.003), 17 flagged = exactly the named residuals below.** The decisive call:
  - **Go STATIC — do NOT replay the Vue bundle.** nuxt.com is data-driven: payload extraction (real data in per-route `/_payload.json`; the inline `#__NUXT_DATA__` island is minimal ~1.5KB) + client `/api/*` fetches (sponsors, v1/modules, navigation.json). Replaying the entry bundle → it re-fetches all of those (404 with no backend) → Vue hydration mismatch **WIPES the SSR content** (hero/sections vanish, version badge → "vundefined"; only the static layout navbar/footer survive). Plus React(scaffold)+Vue(bundle) dual-hydrating `#__nuxt` is inherently fragile. The SSR `bodyHTML` already contains the FULL rendered content → serve it verbatim with NO script replay → pixel-perfect static. (Same family as Next-into-Next's two-React and Google devsite's visually-static → no-replay.) A tiny clone-local `nuxt-postprocess.mjs` clears externalScripts/preInline/deferredInline/headInline.
  - **CSS = per-route headCSS, NOT a monolithic globals.css.** `entry.css` (shared Tailwind utils, one `<link>`) PLUS per-route inline `<style>` blocks = Tailwind v4 on-demand `@layer theme/base/properties/utilities` (tokens/icons/component styles), MB-scale total and heavily overlapping. Run `extract-head-css.mjs` → render `route.headCSS` via React 19 `precedence` (link first, inline blocks in doc order); globals.css empty. **No css-descope** — markup-port keeps `data-v-*` so the scoped CSS matches verbatim (and the inline blocks carry 0 `data-v` anyway).
  - **Static dark mode:** set `<html class="dark">` in layout (color-mode preference defaults to dark; its head script is dropped with the bundle) + `suppressHydrationWarning`. `slice-routes` does NOT capture htmlAttrs, so the dark class is otherwise lost → wrong (light) colors.
  - **Assets:** images are ALL absolute (ipx.nuxt.com image CDN, cloudinary, github, shields) → LEAVE on CDN (byte-identical vs original in the gate; `<img>` cross-origin needs no CORS). Localize ONLY root-relative: fonts (`../_fonts/*.woff2` in entry.css `@font-face` → `public/_fonts/`, CORS-safe same-origin), the `/_nuxt/*.css` sheets → `public/_nuxt/`, and any `/assets/*`. (JS graph NOT needed in static mode. If you ever replay: `close-js-graph` MISSES Nuxt's dynamic `import("./hash.js")` — seed `--entry` with every `/_nuxt/*.js` grepped from raw HTML, then loop a recursive grep-closer for the dynamic specifiers.)
  - **Routes:** the sitemap lists ONLY versioned `/docs/4.x/*` + `/blog/*` — NOT home `/`, bare `/blog` (200), `/docs` (307→unversioned tree the sitemap omits), or marketing pages (nav/footer crawl). Keep the versioned docs tree + `next.config` redirects for the 307s. Watch the `sed 's#/$##'` bug that drops the home route (turns `/` into empty).
  - **Gate:** the carbonads ad (`.carbon`/`#carbonads`) is RANDOM 3rd-party content on desktop docs pages → `--hide ".carbon"` (without it, docs flag ~0.005–0.016; with it, pixel-perfect). **Inherent residuals (client-JS/backend, un-reproducible static):** home (contributor-globe canvas + showcase carousel + floating module-icon cloud), `/modules` (floating icons + virtualized list + live counts), `/docs/4.x/examples/*` (inline live-demo playgrounds), `/login` (Turnstile captcha centering offset). Componentize yields ONE coarse `IsolateSection` (single `#__nuxt` shell — the Divi-case limitation) → deliver as replica + on-demand `extract-section`.
- **Wix / Squarespace.** Both SSR the DOM. Wix (`window.wixBiSession`, `static.wixstatic.com`) inlines component CSS as `<style data-href>` in the HTML (never a network request — `css-collector.mjs` catches it); Squarespace (`window.Squarespace`, `static1.squarespace.com`) ships real `<link>` sheets. Neither uses attribute scoping → port the short-hash class names verbatim, do NOT run css-descope. CDN image transforms: Wix encodes them in the path, Squarespace in `?format=` — pass URLs verbatim to download-assets. Keep the `wix-warmup-data` / `data-block-json` JSON islands.
- **Google "devsite" (`devsite-*` custom elements, `gstatic.com/devrel-devsite/.../app_loader.js`).** Powers a HUGE family on one platform — developer.chrome.com, developers.google.com, web.dev, firebase/android docs — so the recipe is reusable. **Proven on developer.chrome.com home (0/2, deltas ≤0.0003).** SSR's the full DOM (header/footer/search in light DOM) + `devsite-*` custom elements; no attribute scoping → do NOT run css-descope. No GSAP/jQuery, visually static → **static markup-port (no script replay)** is the robust path. Gotchas:
  - **Keep `app.css` + fonts on the gstatic / Google-Fonts CDN via `<link>`** (versioned/immutable, ~1.25 MB; its `url(../images/…)` resolve against the CDN). Localizing them would 404 the CSS-internal assets for zero fidelity gain — the ~22 download-assets 404s (`activity-*`, `dynamic-hero-*`, `badge-*`) ARE those, expected, ignore. Download only the ~60 CONTENT images (`/images`, `/static`, `/blog`). (Google HTML/XML is bot-filtered → `curl` returns an empty body; use the browser `fetch` same-origin to capture HTML/sitemap.)
  - **Responsive is keyed on a JS-set body class.** ~77 rules + many of the 208 `@media` blocks depend on `.viewport--mobile/tablet/desktop` (breakpoints **600 / 840**) that devsite's runtime sets — without it the mobile hamburger etc. break. Add a tiny **parse-time inline script** that sets the viewport class on load+resize (and re-sets `--devsite-cookie-bar-height` from the bar's `offsetHeight`); also set the body custom attrs (`template`/`theme`/`appearance`/`layout`) there for DOM parity (they're not in any CSS selector, but keep the TSX `any`-free).
  - **Theme/language pickers are lit shadow DOM that's open but NON-serializable** → `getHTML({serializableShadowRoots:true})` emits ZERO templates for them (refines the shadow-DOM entry above). Capture by hand: read `el.shadowRoot.innerHTML` + each `adoptedStyleSheets` `cssText`, and emit `<template shadowrootmode="open"><style>…</style>…</template>` into the host. The shadow CSS inherits global `--devsite-*` vars + Material Icons, so it renders fully once reconstructed.
  - **i18n via `?hl=` query** (default/canonical = `en`; `lang="…-x-mtfrom-en"` = machine-translated). Force English with `Accept-Language` + `?hl=en`, and gate the original with `--routes "/?hl=en"`. The sitemap is an index where ~41k of 43.6k URLs are `?hl=` locale variants → en-only is ~2.5k pages.
- **WordPress (`meta generator`, `wp-content/`).** The EASIEST markup-port target: PHP renders the full DOM, no scoping, no ESM graph. Run css-collector → concatenate to globals.css directly (do NOT run css-descope — it exits non-zero on no-scoping). **Proven on a Divi clone (0/2 flagged):**
  - **`wp_localize_script` config vars run BEFORE the bundles.** Inline `var et_pb_custom={...}` / `et_animation_data=[...]` blocks (pure assignments, no DOM access) are what the bundles read on init — put them in the route JSON's `preInline[]` (the markup-port runtime runs `preInline` into `<head>` first, then the bundles). Mis-ordering = the bundle reads `undefined` and animations/sliders die.
  - **jQuery chain order:** `jQuery → jquery-migrate → <theme>.min.js → common.js`, then re-fire DOMContentLoaded+load. The `JQMIGRATE` console log is benign (the original logs it too).
  - **Page-builder backgrounds are inline-style `url()`, not `<img>`.** Divi/Elementor heroes/parallax use `style="background-image:url(…)"` with ZERO `<img>` tags — `extract-asset-urls.mjs` now scans inline `url()` too, but cross-check against a live `list_network_requests` for runtime-set backgrounds.
  - **`@font-face` over-declaration:** themes declare whole families (e.g. ~190 Montserrat/Open-Sans woff2) but `unicode-range` means only the few used subsets ever fetch — curate the asset list to what actually downloads, don't mirror all 190.
  - **CSS order matters:** css-collector separates external sheets from head `<style>` blocks; **re-interleave them in original `<head>` document order** before concatenating, or a later inline override lands in the wrong cascade position.
  - **Cloudflare email obfuscation:** `<a class="__cf_email__" data-cfemail="HEX">` renders `[email protected]` unless decoded — decode `data-cfemail` (first hex byte = XOR key, XOR each subsequent byte) into the real `mailto:` at slice time, else the footer email is wrong.
- **i18n / multi-locale.** Fingerprint: sitemap `hreflang`, a shared `/en/`·`/fr/` prefix, `__NEXT_DATA__.locale`. Clone the DEFAULT locale only unless asked for all (pin it via `<html lang>` / sitemap `x-default` / root redirect; filter `routes.txt` to that prefix). All-locales → `app/[locale]/[[...slug]]` + per-locale content dirs. Watch for locale-only sheets (RTL override for `/ar/`, CJK font stacks) absent from the default locale's HTML.
- **Infinite scroll / pagination.** During the sweep, after scrolling to bottom, check `list_network_requests` xhr/fetch for `page=`·`cursor=`·`/graphql`. A clone is a SNAPSHOT: scroll to a cap (≤5 triggers / ~100 items), save each payload, transform to static content + barrel, and **neutralize the IntersectionObserver in the runtime** (don't wire the fetch) while keeping the sentinel node in the verbatim HTML. Log items captured vs truncated.
- **Cookie / consent walls (Cookiebot / OneTrust / CookieYes / Osano).** They block the sweep AND dominate the pixel-diff. Dismiss before any capture: `wait_for` the banner, click accept (`#onetrust-accept-btn-handler`, `.cky-btn-accept`, `#CybotCookiebotDialogBodyButtonAccept`, `.osano-cm-button--save`), or inject consent then re-navigate — Cookiebot/OneTrust read a COOKIE (`document.cookie='CookieConsent=true; path=/'` / `OptanonConsent=...`), CookieYes/Osano read localStorage. Carry the same into the gate (seed those keys via `addInitScript` in qa-diff's `capture()`), or the modal masks every diff.
- **Auth-walled / login-gated content.** **First: only clone content you are authorized to access** (your own account/dashboard, a client engagement you're contracted for, an authenticated pentest). markup-port assumes a publicly-readable DOM; auth changes WHAT the headless browser can see, not the pipeline. Three cases, in order of how much is realistically clonable:
  - **Public/private split (the common ~80% case).** A marketing/docs site that's public + an app behind login. Enumerate routes and bucket them: a gated route 302-redirects to `/login`, returns 401/403, or renders a login `<form>`. **Clone the public bucket normally**, and snapshot the **login page itself** (it's public). Document the boundary in Completion ("routes X,Y require auth — captured the login screen, not the authed app") rather than shipping a broken redirect loop. This needs no credentials.
  - **Authed content you have access to (session injection).** Export your live session from a logged-in browser (DevTools → Application → Cookies, or a `document.cookie` dump / the `Authorization` bearer), store it in an **env var or `~/.config` file — NEVER commit it, never put it in the route JSON**. Inject before capture: Playwright `context.addCookies([...])` (or `addInitScript` to set `localStorage` tokens) in the MCP session AND in qa-diff's `capture()`, then snapshot the **settled, authenticated DOM** per route (same settle-poll as the SPA/Next path) and markup-port that. The clone is a STATIC snapshot of *your* authenticated view.
  - **Clone-side gotchas (no backend exists on the clone):** (1) a client **auth-guard script** ("no token → `location='/login'`") fires on the clone and bounces — neutralize it (drop that inline script, or seed a dummy token in `addInitScript` so the guard passes); (2) **user-data `fetch`/XHR 401s** → freeze the captured JSON behind a Next `middleware.ts` stub returning the recorded response (same pattern as the Webflow commerce csrf stub, #10), or accept the empty/error state and `--hide` it in the gate; (3) **CSRF/refresh tokens, logout, and session-expiry timers are dead** — strip expiry/logout redirects so they don't bounce the static page.
  - **Out of scope (be honest in Completion):** a WORKING login flow, server-personalized LIVE data (the clone freezes one user's snapshot), and anything needing a live session. If the goal is a functional authed app, that's a rebuild, not a clone.

## Principles Behind Every Decision

Whether a clone holds up or only looks close comes down to the points below. Let them shape every choice you make.

### 1. A Builder Should Never Have to Guess

Hand each builder the complete picture: the screenshot, the exact CSS values, the downloaded assets with their local paths, the real text and the component structure. Any value a builder has to invent (a color, a font size, a padding) marks a gap in your extraction. Spending another minute to pull one more property always beats sending a brief with holes in it.

### 2. Narrow Scope Produces Exact Work

Ask an agent to "build the whole features section" and it cuts corners: spacing gets approximated, font sizes get guessed, and the result is near but visibly off. Give it one focused component with exact CSS values and it gets it right every time.

Size up each section before you assign it. A banner holding a heading and one button needs a single agent. A section with three card variants, each with its own hover behavior and inner layout, needs one agent per variant plus one for the wrapper around them. If you are unsure, split further.

**Complexity budget:** once a builder prompt carries more than about 150 lines of spec, the section is too big for one agent and must be broken up. Apply this mechanically; "the parts are all related" is not a reason to skip it.

### 3. Real Content and Real Assets Only

Take the actual text, images, videos and SVGs from the live site; you are producing a clone, not a mockup. Read text with `element.textContent`, download every `<img>` and `<video>`, and turn inline `<svg>` elements into React components. Generate content only when it is obviously produced by the server and differs for every session.

**Watch for stacked assets.** What looks like a single image is often several layers: a watercolor or gradient in the background, a PNG of a UI mockup in front, an icon on top. Go through the whole DOM tree of each container and list every `<img>` and every background image in it, absolutely positioned overlays included. Leave one overlay out and the section looks empty even when its background is right.

### 4. The Foundation Comes First

Nothing else can be built before the groundwork is in place: global CSS carrying the target's design tokens (colors, fonts, spacing), TypeScript types for the content shapes, and the global assets (fonts, favicons). This part runs sequentially, without exception. Everything after it can run in parallel.

### 5. Capture Behavior, Not Just Appearance

A page is not a still image. Its elements move, change, appear and vanish as the visitor scrolls, hovers, clicks, resizes the window, or simply waits. A clone built from each element's static CSS alone matches a screenshot and feels lifeless in use.

So capture two things for every element: its **appearance**, the exact computed CSS from `getComputedStyle()`, and its **behavior**, meaning what changes, what makes it change, and how the change is animated. Record the computed value, never an impression such as "about 16px". Do not settle for "the nav changes when you scroll": record the precise trigger (a scroll offset, an IntersectionObserver threshold, a viewport intersection), the full CSS of the state before and of the state after, and the transition itself (duration, easing, and whether it is a CSS transition, JS-driven, or CSS `animation-timeline`).

Behaviors that come up often are listed below. The list gives examples, not a boundary: whatever else the page does, you are expected to catch as well.
- a navbar that gets smaller, switches background or picks up a shadow once the page scrolls past a threshold
- elements that animate in as they reach the viewport (fade-up, slide-in, staggered delays)
- sections that snap into position while scrolling (`scroll-snap-type`)
- parallax layers moving at a different speed from the scroll
- hover effects that animate rather than just switch (the duration and easing matter)
- dropdowns, modals and accordions with enter and exit animations
- progress indicators or opacity changes tied to scroll position
- carousels that play on their own, or content that rotates by itself
- a theme change between sections, such as dark to light
- **tabs or pills that rotate content**: buttons swapping which set of cards is visible, with a transition
- **tabs or accordions switched by scrolling**: a sidebar whose active entry updates as content passes (IntersectionObserver, NOT click handlers)
- **smooth-scroll libraries** (Lenis, Locomotive Scroll): look for a `.lenis` class or a wrapping scroll container

### 6. Settle the Interaction Model Before Any Build

The costliest error in cloning is building a click-driven UI for something the original drives by scrolling, or the other way round. Before writing a builder prompt for any interactive section, you need a definite answer: **does this section respond to clicks, to scrolling, to hover, to time, or to a mix of these?**

Find out in this order:
1. **Scroll before you click.** Move through the section slowly and watch whether anything changes on its own.
2. If something does, the section is scroll-driven. Work out the mechanism: `IntersectionObserver`, `scroll-snap`, `position: sticky`, `animation-timeline`, or a JS scroll listener.
3. Only if scrolling changes nothing, click and hover to look for click- or hover-driven behavior.
4. Name the model explicitly in the component spec, for example "INTERACTION MODEL: scroll-driven, IntersectionObserver" or "INTERACTION MODEL: click-to-switch, opacity crossfade".

A sticky sidebar next to scrolling content panels and a tab bar that swaps content on click are different builds from the ground up. Choosing the wrong one costs a full rewrite, not a CSS fix.

### 7. Every State, Not Only the First One

Components often have several looks: a tab bar showing different cards on each tab, a header that differs at scroll position 0 and at 100, a card with a hover effect. Extract ALL of them, not just what is visible when the page loads.

Stateful content such as tabs:
- click each tab or button through the browser MCP
- for EACH state, capture what it shows: text, images, card data
- map every piece of that content to the state that displays it
- note how the switch is animated (opacity, slide, fade, and so on)

Elements that depend on scroll position:
- read the computed styles at scroll position 0 (the initial state)
- scroll beyond the trigger threshold and read them again (the scrolled state)
- compare the two to see exactly which CSS properties change
- copy the transition CSS as well: which properties animate, for how long, with which easing
- record the exact threshold (a scroll offset in px, or a viewport intersection ratio)

### 8. The Spec File Is the Contract

Each component gets a spec file in `docs/research/components/` BEFORE any builder is dispatched for it. The file is the agreement between your extraction and the builder's work: its contents go into the builder's prompt inline, and the file stays behind as an auditable record that the user, or you, can check when something comes out wrong.

There is no skipping it and nothing optional about it. A builder dispatched without a spec file receives whatever you happen to recall from the browser MCP session, and it fills the gaps by guessing.

### 9. The Build Always Compiles

No builder finishes until `npx tsc --noEmit` passes. Once worktrees are merged, you confirm that `npm run build` passes. A broken build is unacceptable at any moment, even briefly.

## Phase 1: Reconnaissance (read the live site)

Load the target URL in the browser MCP.

### Reference Screenshots
- Take **full-page** screenshots at desktop and mobile: `take_screenshot({ fullPage: true, filePath: "docs/design-references/<name>-desktop.png" })`, switching size with `emulate` between shots.
- ⚠️ **Chrome DevTools MCP writes files relative to the MCP server's own root (the template repo), NOT the clone workspace.** A relative `filePath: "docs/design-references/…"` lands in the template, not `~/code/study/Websites/<slug>/`. Pass an **absolute** path under the workspace, or capture to the MCP root and `mv` it into the workspace afterward.
- For individual sections/components (later, in Phase 3), prefer per-element capture: `take_snapshot` to get the element `uid`, then `take_screenshot({ uid, filePath: ... })` — cleaner and sharper than scrolling and cropping the viewport.
- These are your master reference — builders receive section-specific shots from `docs/design-references/`.
- **Capture the original as the QA baseline, now.** Web previews (`*.pages.dev`, `*.vercel.app`, staging) can vanish mid-build. Save a full-page screenshot of the original for **every route × {desktop, mobile}** to `docs/design-references/original/<route>-<vp>.png` up front. The Phase 5 gate prefers a live original (for its animation noise floor), but if the site has gone offline these cached references still let the gate validate layout and content.

### Site-Wide Extraction
Before any other work, pull these site-wide details off the page:

**Fonts** — Get the real font *files*, not just family names. Run `list_network_requests({ resourceTypes: ["font"] })` to capture every `.woff2`/`.woff` the page actually loaded, and via `evaluate_script` read the `@font-face` rules plus computed `font-family`/`font-weight`/`font-style` on headings, body, code, and labels. Self-host the exact files with `next/font/local`, or use `next/font/google` when it's a Google font. Match every weight and style — a wrong weight is instantly visible.

**Colors & design tokens** — Modern sites declare their palette as CSS custom properties on `:root`. Capture them directly instead of inferring from scattered computed styles:

```javascript
() => {
  const root = getComputedStyle(document.documentElement);
  const vars = {};
  const isRoot = (sel) => !!sel && sel.split(',').some((s) => {
    s = s.trim();
    return s === ':root' || s === 'html' || s === ':where(:root)' || s === ':host';
  });
  // Recurse into @layer / @media / @supports — Tailwind v4 & Astro wrap :root there,
  // and a flat top-level walk silently returns {} (the real bug this fixes).
  const walk = (rules) => {
    for (const rule of rules || []) {
      if (rule.cssRules) walk(rule.cssRules);
      if (isRoot(rule.selectorText)) {
        for (const name of rule.style || []) {
          if (name.startsWith('--')) vars[name] = root.getPropertyValue(name).trim();
        }
      }
    }
  };
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    walk(rules);
  }
  // Safety net: if nothing was found in rule text, read the custom properties straight
  // off the computed :root (Chromium enumerates --* here).
  if (Object.keys(vars).length === 0) {
    for (const name of root) if (name.startsWith('--')) vars[name] = root.getPropertyValue(name).trim();
  }
  return vars;
}
```

Map these into `src/app/globals.css` `:root` (and `.dark`) — it already uses oklch tokens. For colors not exposed as variables, sample computed `color`/`backgroundColor`/`borderColor` from key elements. Keep the **exact** values — never round oklch/hex.

**Icons and metadata**: save every favicon, apple-touch-icon and OG image, plus the webmanifest, into `public/seo/`, then bring the `layout.tsx` metadata in line with them.

**Site-wide UI patterns**: look for CSS or JS that applies to the whole site, such as hidden custom scrollbars, scroll-snap on the page container, global keyframe animations, backdrop filters, gradients laid over content and, above all, **smooth-scroll libraries** (Lenis or Locomotive Scroll: search for `.lenis`, `.locomotive-scroll`, or a custom scroll-container class). Put what you find into `globals.css` and write down every library that has to be installed.

**Animations (`@keyframes`)** — Extract real keyframe definitions instead of guessing. Via `evaluate_script`, walk `document.styleSheets` and collect every `CSSKeyframesRule` (its `name` and `cssText`), then port them verbatim into `globals.css`:

```javascript
() => {
  const out = [];
  const KF = (typeof CSSRule !== 'undefined') ? CSSRule.KEYFRAMES_RULE : 7;
  // Recurse into @layer / @media / @supports (a flat walk misses keyframes nested there).
  const walk = (rules) => {
    for (const rule of rules || []) {
      if (rule.type === KF) out.push({ name: rule.name, cssText: rule.cssText });
      else if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    walk(rules);
  }
  const seen = new Set(); // dedupe by name (same @keyframes can repeat across pages)
  return out.filter((k) => (seen.has(k.name) ? false : seen.add(k.name)));
}
```

**Library detection** — Run `list_console_messages` and check `window` globals (`evaluate_script` returning e.g. `{ gsap: !!window.gsap, lenis: !!window.Lenis, framer: !!window.__FRAMER__ }`) to confirm which animation/scroll libraries are actually in play before you reimplement their behavior.

### Interaction Sweep (mandatory)

Run this as its own pass, after the screenshots and before anything else. A static screenshot hides most of what a page does; this pass exists to surface all of it.

**Scrolling:** move down the page from the top with the browser MCP, slowly, stopping at every section to check:
- whether the header changes as you go, and at which scroll offset;
- which elements animate in as they enter the viewport, and with what kind of animation;
- whether a sidebar item or tab indicator switches by itself as content passes, and what drives it;
- which containers, if any, have scroll-snap points;
- whether scrolling feels non-native, a sign that a smooth-scroll library is active.

**Clicking:** activate everything that looks interactive (every button, tab, pill, link and card) and write down the result: content swapped, a modal opened, a dropdown shown. For a group of tabs or pills, click EVERY one and record what each state displays.

**Hovering:** move the pointer over anything that could react (buttons, cards, links, images, nav items) and note what changes: color, scale, shadow, underline, opacity.

**Responsive & theme sweep:** Use `emulate` (not a bare resize) so device pixel ratio, touch, and theme are real:
- Desktop: `emulate({ viewport: "1440x900x1" })`
- Tablet: `emulate({ viewport: "768x1024x2,touch" })`
- Mobile: `emulate({ viewport: "390x844x3,mobile,touch" })` — DPR 3 reveals which retina (2x/3x) assets the site serves
- At each width, note which sections change layout (column → stack, sidebar disappears) and the approximate breakpoint.
- **Themes:** if the site has dark/light, capture **both** with `emulate({ colorScheme: "dark" })` and `"light"`, recording each token set so `globals.css` `:root` *and* `.dark` are both correct.

Everything the sweep finds goes into `docs/research/BEHAVIORS.md`. Go back to that file each time you write a component spec.

### Page Topology (section map)
Walk the page from top to bottom and give every distinct section a working name. For each one, record:
- where it sits in the visual order;
- whether it is a fixed or sticky overlay or part of the normal flow;
- how the page as a whole is laid out (scroll container, columns, z-index layers);
- how sections depend on one another (a floating nav drawn over everything else, for instance);
- **its interaction model**: static, click-driven, scroll-driven or time-driven.

Write the result to `docs/research/PAGE_TOPOLOGY.md`. Assembly follows this map.

## Phase 2: Foundation Build (shared groundwork)

Do this part in sequence and by yourself, not through an agent: it touches too many files.

1. Point the fonts in `layout.tsx` at the fonts the target actually uses.
2. Fill `globals.css` with the target's color tokens, spacing values, keyframe animations and utility classes, plus any **scroll behavior that applies globally** (Lenis, smooth-scroll CSS, scroll-snap on the body).
3. Add TypeScript interfaces under `src/types/` describing the content shapes you found.
4. Collect the **SVG icons**: gather every inline `<svg>` on the page, drop duplicates, and export each one as a named React component from `src/components/icons.tsx`, named for what it shows or does (`SearchIcon`, `ArrowRightIcon`, `LogoIcon`, and so on).
5. Fetch the **global assets** by writing and running a Node.js script (`scripts/download-assets.mjs`) that pulls every image, video and other binary file on the page into `public/`, keeping a meaningful folder structure.
6. Check that `npm run build` passes.

### Asset Discovery: Network First, Then DOM

The DOM alone misses fonts, lazy-loaded images, CSS-referenced backgrounds, and `<source>` media. Discover assets in two passes.

> **Static / markup-port sites:** once you've saved every route's raw HTML + the stylesheets to disk, the fastest complete pass is `node scripts/extract-asset-urls.mjs` — a **deterministic grep** of `src=`, `srcset=`, and `url(…)` across the saved HTML + CSS (resolves to absolute via the origin, handles balanced-paren Webflow filenames, dedupes) → `docs/research/asset-urls-all.txt`, exactly the list `sanitize-asset-names.mjs` and `download-assets.mjs` consume. It covers every asset in one shot without a per-page live `list_network_requests`. Reserve the live network passes below for dynamically-loaded assets that only appear at runtime.

**Pass 1 — Network (the authoritative list).** After the page is fully loaded and you've scrolled top-to-bottom (to trigger lazy-loading), enumerate everything the browser actually fetched:

```
list_network_requests({ resourceTypes: ["font", "image", "media", "stylesheet"] })
```

This returns absolute URLs for every font (`.woff2`), image, video, and stylesheet — including assets referenced only from CSS. Add `"xhr"` / `"fetch"` if you want to spot APIs/GraphQL. **This is the complete set to download.**

**Pass 2 — DOM (layout & layering context).** Run via `evaluate_script` to learn how those assets are *used* (layering, alt text, intrinsic sizes) — it complements, not replaces, the network list:

```javascript
() => {
  const cs = (el, p) => getComputedStyle(el)[p];
  return {
    images: Array.from(document.querySelectorAll('img'), (img) => ({
      src: img.currentSrc || img.src,
      alt: img.getAttribute('alt') ?? '',
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      parentClasses: img.parentElement?.className?.toString(),
      imagesInParent: img.parentElement?.getElementsByTagName('img').length ?? 0,
      position: cs(img, 'position'),
      zIndex: cs(img, 'zIndex'),
    })),
    videos: Array.from(document.querySelectorAll('video'), (v) => ({
      src: v.src || (v.querySelector('source') ?? {}).src,
      poster: v.poster, autoplay: v.autoplay, loop: v.loop, muted: v.muted,
    })),
    backgroundImages: [...document.querySelectorAll('*')]
      .filter(el => { const b = getComputedStyle(el).backgroundImage; return b && b !== 'none'; })
      .map(el => ({ url: getComputedStyle(el).backgroundImage, element: el.tagName + '.' + (el.className?.toString().split(' ')[0] || '') })),
    svgCount: document.getElementsByTagName('svg').length,
    favicons: Array.from(document.querySelectorAll('link[rel*="icon"]'), (link) => ({ href: link.href, sizes: String(link.sizes ?? '') })),
  };
}
```

Then download the **network-discovered URLs** (the complete set) with the committed script — pass the URL list as JSON on stdin:

```bash
# $urls = the JSON array of absolute asset URLs from list_network_requests
printf '%s' "$urls" | node scripts/download-assets.mjs --out public
```

It mirrors each asset to `public/` preserving the **origin path verbatim** (so ported markup keeps resolving), sends a real browser User-Agent, skips Google Fonts (handled by `next/font/google`), is idempotent (skips files already present), batches 16 with one retry, and writes `docs/research/asset-manifest-result.json` as an auditable receipt of what was fetched vs intended. **Hotlink-protected sites** (premium agency CDNs often referer-check and 403 ~half the assets): add `--referer https://<original-site-origin>/` so cross-origin asset fetches pass — cheap insurance, harmless when not needed. **Fallback:** if the script fails, hand-write a one-off downloader following the same full-path-mirror rule.

## Phase 3: Specify Components, Then Dispatch Builders

Everything in this phase repeats once per section, following the topology from the top of the page down. Each section goes through THREE steps in a fixed order: **extract** it, **write its spec file**, and only then **dispatch its builders**.

### Step 1: Extract the Section

Pull everything the section contains out of the live page with the browser MCP:

> **If you chose to port the real compiled CSS (Decision 2)** — the usual case for framework sites — the per-component CSS extraction below is **not** for rebuilding styles; the ported stylesheet already nails them. Use these steps to capture **markup, content, assets, states, and behaviors**, and skip the exhaustive `getComputedStyle` spec-writing. Do the full spec-driven extraction only when rebuilding hand-written CSS or a single simple page.

1. **Capture the section on its own**: scroll it into view and take a viewport screenshot, saved under `docs/design-references/`.

2. **Pull the CSS** of every element in the section with the script below instead of measuring properties one at a time. Run it once for each component container and keep its complete output:

```javascript
// Per-component extraction — run via evaluate_script.
// Pass the element uid from take_snapshot as an arg, or hard-code a selector string.
(selector) => {
  const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!el) return { error: 'Element not found' };
  const props = [  // every computed property a spec may need
    // typography and color
    'fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','color','textTransform','textDecoration',
    'backgroundColor','background',
    // box model and sizing
    'paddingTop','paddingRight','paddingBottom','paddingLeft','padding',
    'marginTop','marginRight','marginBottom','marginLeft','margin',
    'width','minWidth','maxWidth','height','minHeight','maxHeight',
    // flex and grid
    'display','flexDirection','justifyContent','alignItems','gap','gridTemplateColumns','gridTemplateRows',
    // borders, shadow and overflow
    'border','borderTop','borderRight','borderBottom','borderLeft','borderRadius','boxShadow',
    'overflow','overflowX','overflowY',
    // positioning
    'position','zIndex','top','right','bottom','left',
    'opacity','transform','transition','animation','cursor',
    'animationTimeline','animationRange','viewTimelineName',  // scroll-driven animations (animation-timeline: scroll()/view())
    'mixBlendMode','filter','backdropFilter','objectFit','objectPosition',
    'fontVariationSettings','fontFeatureSettings','fontVariantNumeric','fontVariantLigatures',  // variable-font axes + tabular numerals + ligatures
    'whiteSpace','WebkitLineClamp','textOverflow'
  ];
  const clean = (csObj) => {
    const styles = {};  // only values that differ from the browser defaults are kept
    props.forEach(p => { const v = csObj[p]; if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') styles[p] = v; });
    return styles;
  };
  // Pseudo-elements often hold icons, dividers, and decorations — capture them too.
  const pseudo = (element, sel) => {
    const cs = getComputedStyle(element, sel);
    if (!cs.content || cs.content === 'none' || cs.content === 'normal') return null;
    return { content: cs.content, ...clean(cs) };
  };
  const walk = (element, depth) => {
    if (depth >= 5) return null;  // the container plus at most four levels below it
    const kids = Array.from(element.children);
    const classNames = element.className?.toString().split(' ');
    const onlyText = element.childNodes.length === 1 && element.firstChild.nodeType === Node.TEXT_NODE;
    return {
      tag: element.nodeName.toLowerCase(),
      classes: classNames?.slice(0, 5).join(' '),
      text: onlyText ? element.textContent.trim().slice(0, 200) : null,
      styles: clean(getComputedStyle(element)),
      before: pseudo(element, '::before'),
      after: pseudo(element, '::after'),
      image: element.tagName === 'IMG' ? { src: element.currentSrc || element.src, alt: element.alt, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight } : null,
      childCount: kids.length,
      children: kids.slice(0, 20).map((kid) => walk(kid, depth + 1)).filter(Boolean)
    };
  };
  return walk(el, 0);
}
```

`evaluate_script` returns this object as JSON directly — no `JSON.stringify`. Pass the component's `uid` (from `take_snapshot`) via `args`, or replace `selector` with a hard-coded CSS string.

3. **Record both sides of every state change.** When an element has more than one state (scroll-triggered, hover, active tab), capture it BOTH before and after:

```javascript
// 1. Run the extraction script on the element as it is right now (say, at scroll offset 0): state A.
// 2. Cause the change through the browser MCP (scroll, click or hover).
// 3. Run the same script on the same element again: state B.
// Whatever differs between A and B is the behavior you have to specify.
```

Write every difference down in full, in the form "`<property>` goes from `<value A>` to `<value B>` when `<trigger>`, with transition `<transition CSS>`".

4. **Copy the real content**: every piece of text, plus alt attributes, aria labels and placeholder text, read with `element.textContent` for each text node. Where content depends on state (tabs and the like), **click through every tab and extract what each one shows**.

5. **Map the section's assets**: which downloaded images and videos in `public/` it uses, and which icon components from `icons.tsx`. Look specifically for **stacked images**, meaning several `<img>` elements or background images layered in one container.

6. **Count the sub-components** the section is made of. One counts as distinct when it has styling, structure and behavior of its own, as a card, a navigation item or a search panel usually does.

### Step 2: Write the Spec File

Every section gets a spec file in `docs/research/components/`, and so does every sub-component when you split a section up. This is NOT optional: no builder is dispatched without its own spec file.

**Location:** `docs/research/components/<component-name>.spec.md`

**Structure to follow:**

```markdown
# <ComponentName> Spec

## Overview
- **Output file:** `src/components/<ComponentName>.tsx`
- **Reference screenshot:** `docs/design-references/<screenshot-name>.png`
- **Interaction model:** one of <static | click-driven | scroll-driven | time-driven>

## DOM Structure
<The element tree: which elements sit inside which>

## Computed Styles (copied from getComputedStyle, never estimated)

### Container
- display: <value>
- padding: <value>
- maxWidth: <value>
- (each relevant property, with its exact value)

### <First child element>
- fontSize: <value>
- color: <value>
- (each relevant property)

### <Last child element>
(same pattern)

## States & Behaviors

### <Name of the behavior, e.g. "Header condenses after scrolling">
- **Trigger:** <the precise mechanism: scrollY past 80px, IntersectionObserver with rootMargin "-40% 0px", click on .toggle, hover>
- **State A (before):** height: 96px, backgroundColor: transparent, backdropFilter: none
- **State B (after):** height: 64px, backgroundColor: rgba(255,255,255,0.85), backdropFilter: blur(12px)
- **Transition:** transition: height 0.25s ease-out, background-color 0.25s ease-out
- **Implementation approach:** <scroll listener + CSS transition | IntersectionObserver | CSS animation-timeline | other>

### Hover states
- **<Element>:** <property> goes <before> → <after> (transition: <value>)

## Per-State Content (only for components with states)

### State: "Monthly"
- Heading: "..."
- Price note: "..."
- Card list: [{ title, description, image, link }, ...]

### State: "Yearly"
- Heading: "..."
- Card list: [...]

## Assets
- Background layer: `public/images/<file>.webp`
- Overlay layer: `public/images/<file>.png`
- Icons: <ArrowIcon>, <SearchIcon> from icons.tsx

## Text Content (verbatim)
<Every string, copied exactly from the live site>

## Responsive Behavior
- **Desktop (1440px):** <how it is laid out>
- **Tablet (768px):** <what changes, e.g. "still two columns, gap drops to 16px">
- **Mobile (390px):** <what changes, e.g. "one column, images span the full width">
- **Breakpoint:** the layout switches at about <N>px
```

Complete every heading. Where one really does not apply (a static footer has no states, say), write "N/A" there, but be wary of doing that for States & Behaviors: even footer links usually carry hover styles.

### Step 3: Dispatch the Builders

How many builders a section gets depends on the complexity you counted in Step 1. Each one runs in its own worktree.

**1 or 2 sub-components (simple):** a single builder takes the whole section.

**3 or more distinct sub-components (complex):** split it. Each sub-component gets its own builder, and one more builder writes the section wrapper that imports them. Dispatch the sub-component builders first, because the wrapper depends on them.

**Every builder prompt contains:**
- the complete text of its spec file, pasted into the prompt (never a pointer telling it to go read the file)
- the path of the section screenshot under `docs/design-references/`
- the shared pieces it should import (`icons.tsx`, `cn()`, shadcn primitives)
- the file it has to create (for example `src/components/HeroSection.tsx`)
- an instruction to get `npx tsc --noEmit` passing before it reports done
- for responsive behavior, the exact breakpoint values and what changes at each

**Keep moving.** Once a section's builders are dispatched, start extracting the next section straight away; the builders work in parallel in their worktrees while you continue.

### Step 4: Merge the Results

Whenever a builder finishes:
- Merge its worktree branch into main.
- Resolve any conflicts yourself: you know what every builder was asked to do and what it produced, so you can settle them intelligently.
- After each **intermediate** merge, validate with `npx tsc --noEmit` (~5s — it catches the real risk, missing imports / type errors); run the full `npm run build` once after the **final** merge (see Speed & Concurrency)
- Fix any type error a merge brings in right away.

Repeat extract, spec, dispatch and merge for each section until every one is built.

## Phase 4: Assemble the Page

With every section built and merged, bring them together in `src/app/page.tsx`:

- Import each section component.
- Reproduce the page-level layout described in the topology file: scroll containers, columns, sticky positioning, z-index layers.
- Feed the real content in through component props.
- Add the behaviors that belong to the page rather than to a section: scroll snapping, scroll-driven animation, dark-to-light transitions, intersection observers, smooth scrolling (Lenis or similar).
- Confirm `npm run build` passes cleanly.

## Phase 5: Objective QA Gate (pixel-diff, not eyeballing)

Eyeballing screenshots lets "close enough" through and misses a 16px shift that cascades down a whole page. The clone is NOT complete until an **automated pixel-diff** says so, for EVERY route at desktop AND mobile.

> **Which browser tool when:** use the **Chrome DevTools MCP** for interactive exploration and extraction (Phases 1–3 — navigating, snapshotting, `evaluate_script`). Use a **headless Playwright** script for this gate: capturing N routes × 2 viewports, running pixelmatch, and looping is a programmatic batch job, not something to drive by hand through the MCP.

Serve the clone, then run the committed gate. **Start the server with the survivor pattern and run the gate as a SEPARATE task** — a `next start` (an infinite process) launched as a `run_in_background` task gets reaped by the harness mid-gate (exit 144), and every still-pending route then diffs as `ERR_CONNECTION_REFUSED` (now classified `infraError`, but you still lose the run). Orphan the server so it outlives the multi-minute gate, then poll readiness and exit:

```bash
# wrapper call: start server, wait until it answers, then EXIT (the orphan persists)
nohup npx next start -p <port> > /tmp/clone-server.log 2>&1 & disown
until curl -fsS "http://localhost:<port>/" >/dev/null 2>&1; do sleep 0.5; done
```

Never bundle `build → start → gate` in one task (killing it takes the server down). Then run the gate:

```bash
node scripts/qa-diff.mjs --clone http://localhost:<port> --original <original-url> --manifest src/generated/manifest.json --routes /
# --manifest unions EVERY route from the markup-port manifest (whole-site coverage — the
# gate can't silently skip a route you forgot to list); add extra --routes for pages not
# in it. original offline? diff against the Phase 1 baselines instead:
node scripts/qa-diff.mjs --clone http://localhost:<port> --baseline docs/design-references/original --manifest src/generated/manifest.json --routes /
```

It lazy-installs Playwright + pixelmatch into the shared cache (NOT the clone), captures every route × {1440×900, 390×844} for clone and original, measures the animation **noise floor** (original captured twice), writes per-pair diff PNGs + `docs/research/qa/qa-report.json`, and exits non-zero on any route whose `signal − noise` exceeds the threshold **or whose page returned a 4xx/5xx** (an error page can't diff as a valid screenshot and slip through). It launches one shared Chromium for the whole run (not one per capture); if that browser **crashes/OOMs mid-run** it relaunches once and retries the affected route, and a route that still can't be captured is reported as `infraError` (exit code **3**), **not** a pixel flag — so one crash never masks a real regression nor inflates the count (a Nextra clone hit this: a mid-run death poisoned 24 routes as "flagged" with `signal:null`, hiding the one true regression). **Read the exit code, not just the count:** `1` = real pixel regressions (fix the clone); `3` = infra-only (just re-run the printed `--routes a,b`); `0` = clean. When a run reports `infraError` rows, re-diff exactly those routes before concluding anything — never treat a browser-death `null` as a regression. Opt-in flags: `--dark` (also diff each viewport in OS dark mode), `--dpr2` (add a retina desktop), `--accept-cookies` (seed Cookiebot/OneTrust/CookieYes/Osano consent so a GDPR modal can't dominate the diff), `--capture-original` (save the live original's screenshots to `--baseline` as Phase-1 fallbacks — no clone, no diff), `--hide "<sel>,<sel>"` (display:none those selectors on BOTH sides — for 3rd-party preview chrome / live-chat widgets / a banner `--accept-cookies` doesn't cover that would otherwise flag as a real diff). Tracker-heavy originals can flake `networkidle` (60s timeout) — when that happens, promote a good capture to `docs/design-references/original/` and run `--baseline` mode for a stable, repeatable gate. **`--hide` caveat in `--baseline` mode:** it only restyles the freshly-captured CLONE, NOT the already-on-disk baseline PNG — so to drop transient chrome from a baseline (a stray toast, `.crisp-client`), strip it when you CAPTURE the baseline (`--capture-original` with the page pre-styled), not via `--hide` at diff time.

> **Editing mode (regression against YOURSELF, not the original).** Once the user starts customizing a clone (re-brand, new sections), the live original stops being the reference — diff against the clone's own last-good state instead: **before** an editing round, snapshot it (`node scripts/qa-diff.mjs --capture-original --original http://localhost:<port> --baseline docs/design-references/self/<tag> --manifest src/generated/manifest.json`); **after** the edits, diff against that snapshot (`--clone http://localhost:<port> --baseline docs/design-references/self/<tag> --manifest …`). Flagged routes show exactly what the edit changed beyond its intent — layout breakage from a token change shows up instantly, intended changes read as expected diffs.

**Fallback** (if the script can't run): hand-roll the harness below. The mechanics it automates, for reference:

1. Load the page, then **`await document.fonts.ready`** — this is critical: capturing before web fonts load makes text wrap to extra lines and reports large *false* diffs. Then scroll top→bottom (fire `once:true` reveals + counters), scroll back to top, settle ~1.5s.
2. Capture the **original twice** (~600ms apart) to measure the **animation noise floor** `noise = diff(origA, origB)` — canvas/halftone/marquees/counters animate and would otherwise read as differences. **If the original is offline** (ephemeral previews die mid-build), fall back to the per-route baseline screenshots you saved in Phase 1: diff against them with a small fixed noise allowance and flag in the report that the gate ran against a cached baseline.
3. Capture the **clone once**; compute `signal = diff(clone, origA)` (crop both to the min width×height for pixelmatch).
4. Flag a route only when `signal − noise` exceeds a few percent — that is a *real* layout/content/style difference, not animation.

**For every flagged route, find the ROOT.** Diff images show *where* (ghosted/doubled text below a point = a vertical shift starting there). Then a small Playwright "measure" script comparing `getBoundingClientRect` + `getComputedStyle` of the diverging element on clone vs original pins the exact px/style. Common real causes: a missing/extra element, a wrong spacing token, a dropped CSS rule, a missing srcset variant, an unported interaction. Fix, then re-diff **only the flagged routes** (`--routes /a,/b`; `tsc --noEmit` for types) — NOT the whole `--manifest` each pass — until they clear; run the full `--manifest` gate + one `npm run build` at the very end to confirm nothing regressed.

Also, on every distinct template: exercise each interaction (tabs, accordions, switchers, forms, hovers, pinned scroll) and confirm a **clean browser console** — zero errors AND zero warnings.

The completion proof is the per-route `signal`/`noise`/`delta` table. Do not declare 1:1 from screenshots alone, and do not claim "100%" you have not measured — report desktop and mobile separately and name any residual.

## Checklist Before Any Dispatch

No builder goes out until every item below is true. If one is not, return to extraction and fill the gap.

- [ ] `docs/research/components/<name>.spec.md` exists and every one of its sections is filled in
- [ ] Each CSS value in the spec came from `getComputedStyle()`; nothing is estimated
- [ ] The interaction model (static, click, scroll or time) is identified and written down
- [ ] Stateful components: the content and the styles of every state are captured
- [ ] Scroll-driven components: the trigger threshold, the styles before and after, and the transition are on record
- [ ] Hover states: the values before and after and the transition timing are on record
- [ ] Every image in the section is accounted for, overlays and layered compositions included
- [ ] Responsive behavior is described for desktop and mobile at the very least
- [ ] The text is copied word for word from the site, never paraphrased
- [ ] The builder prompt stays under roughly 150 lines of spec; anything longer means the section must be split

## Mistakes to Avoid

Each item here comes from an earlier clone that went wrong and took hours of rework to recover:

- **Never build click-driven tabs for something the original drives by scrolling, or the reverse.** Settle the interaction model FIRST, and scroll before you click. This is the costliest mistake on the list, because the fix is a full rewrite rather than a CSS adjustment.
- **Never stop at the default state.** If a tab row opens on "Monthly", switch to "Yearly" and "Lifetime" as well and extract the cards and content of each. If the header changes on scroll, capture its styles at position 0 AND again at 100 or more.
- **Never overlook stacked images.** A gradient backdrop with a product screenshot on top is two images, not one. Search each container's DOM tree for multiple `<img>` elements and for positioned overlays.
- **Never hand-build an HTML imitation of something that is really a video or an animation.** Check whether the section uses `<video>`, Lottie or a canvas before investing in an elaborate mockup of what it shows.
- **Never guess a CSS class from appearance.** A heading may look like `text-lg` (`18px/28px`) while its computed size is `18px` and its line-height is `24px`, which makes that class wrong. Use the exact computed values.
- **Never ship everything as one big commit.** The pipeline exists to make progress in small increments, each with a verified build.
- **Never point a builder at documentation.** The CSS spec goes inside the builder's prompt; a line such as "colors are in DESIGN_TOKENS.md" is not acceptable. A builder should never need to open an outside doc.
- **Never skip the assets.** Without the real images, videos and fonts, a clone looks fake no matter how accurate its CSS is.
- **Never overload a single builder.** A builder prompt that keeps growing because the section is complicated is telling you to split the work into smaller tasks.
- **Never give one agent two unrelated sections.** A CTA block and a footer have different designs and belong to different components; handing both to one builder and hoping is not a plan.
- **Never extract at desktop width only.** A clone inspected only on desktop breaks on tablets and phones. Inspect at 1440, 768 and 390 while extracting.
- **Never miss a smooth-scroll library.** Look for Lenis (the `.lenis` class), Locomotive Scroll and similar tools. Native scrolling feels clearly different, and the user will notice at once.
- **Never dispatch a builder without its spec file.** Writing the spec is what forces a complete extraction and leaves an artifact to audit; without it the builder only gets whatever you can recall and fit into the prompt.
- **Don't hand-rebuild styles when the site ships compiled CSS.** Port the real stylesheets de-scoped (see "Choose Your Strategy"). Rebuilding Tailwind/scoped CSS from `getComputedStyle` specs always drifts; the real CSS is pixel-perfect for free.
- **Don't substitute a generic reveal for bespoke animation.** Port each section's real script 1:1. A generic fade-up where the original has a pinned card-stack / tabbed switcher / count-up is an instant, obvious tell.
- **Don't strip data islands when slicing markup.** Keep `<script type="application/json">` / `data-*-data` — interactive widgets read their config from them; without it the widget freezes on its first state.
- **Don't forget to re-init canvases in injected HTML.** `dangerouslySetInnerHTML` won't run the drawing JS — a runtime must re-render every `[data-halftone]`/canvas/Lottie, or you ship blank boxes where the signature visual was.
- **Don't leak home-only FOUC classes onto subpages.** A `hero-pre-anim` (or `is-loading`) that hides a shared element on a route with nothing to remove it leaves the navbar/section invisible.
- **Don't eyeball QA or claim "100%" unmeasured.** Pixel-diff every route at desktop+mobile with a noise floor, and `await document.fonts.ready` before every capture (font-load timing alone produces 5% false diffs). Report what you measured.
- **Don't only clone the entry URL when the user wants the site.** Check the sitemap and build every route; group repeated layouts into `[slug]` templates.

## Phase 6: Structure Pass (deliver a STRUCTURED clone, not a hardcoded one)

Run AFTER the Phase-5 gate passes — the clone must be proven pixel-perfect before being restructured, and re-proven after. Both steps are deterministic (zero tokens):

1. **Tokenize the stylesheet:** `node scripts/tokenize-css.mjs` rewrites `globals.css` replacing every repeated hardcoded color / font-stack / shadow with `var(--token)`, declaring the tokens in one `:root` block (existing site tokens are reused when unambiguous; conditional `@media`-scoped or multi-valued names are never reused). It carries a **built-in equivalence proof** — expanding the tokens back must reproduce the original byte-for-byte, or it refuses to write (backup kept either way). This is the re-brand lever: change one token, the whole site follows.
2. **Distill the design system:** `node scripts/extract-design-system.mjs` writes `docs/research/DESIGN.md` + `design-tokens.json` — the frequency-ranked palette, type scale, spacing, radii, shadows, breakpoints and keyframes the site ACTUALLY uses. Fill its one generative section (the "Design feel" paragraph). This file is the design context for building NEW sections that look native.
3. **Re-prove:** run the full `--manifest` qa-diff gate once more — it must stay 0-flagged (tokenization is equivalence-proven, but the gate is the last word).

## Phase 7: Componentize (deliver a real React project, not just a replica)

The user's default expectation is that the clone IS a componentized website project. After Phase 6, run the deterministic componentizer:

```bash
node scripts/componentize-routes.mjs        # all routes; --routes a,b and --dry-run available
```

It turns every route into a composed page of real React components: one component per section (`src/components/sections/<slug>/`), byte-identical sections deduped across routes into `src/components/sections/shared/` (footer, style embeds, repeated navbars), per-route compositions in `src/components/pages/<Slug>Page.tsx`, and `src/generated/pages-map.tsx`. **DOM-exactness rule:** each section component's host IS the section's own element (real tag + exact attrs, innerHTML injected) and page shells (page-wrapper/`<main>`) are re-emitted with their exact attrs — the rendered DOM is byte-identical to the blob (proven by reconstruction across 211 real sections), so styling, child selectors, and the replayed scripts behave identically.

Then: adapt `app/[[...slug]]/page.tsx` per `src/generated/page.componentized.example.tsx` (render `PAGES[key]` with the blob as fallback; keep `generateStaticParams`/metadata/`MarkupPortRuntime` untouched — the route JSON still feeds metadata + the script replay), `npm run build`, and **re-run the full qa-diff gate** (must stay non-regressive; live-animated regions keep their known noise). Navbars that differ only by active-link state are emitted per-route by design — unifying them behind an `activePath` prop is a small optional follow-up.

**Section granularity depends on the source's DOM shape.** The componentizer walks to the first meaningful section boundary; a clean semantic site (Webflow's flat `main > section` list) yields many fine-grained components, but a page-builder that wraps everything in one outer shell (Divi's single `#page-container` / `#et-main-area`) yields ONE coarse Section holding the whole page — DOM-exact and editable, but not pre-split into hero/features/footer. That's a known limitation, not a bug: re-split on demand with `extract-section.mjs` against the inner `.et_pb_section` boundaries when the user wants finer components. Say so in Completion rather than implying the page came out neatly sectioned.

**Hydration hazard (learned in production):** replayed scripts must run **post-hydration** (the `MarkupPortRuntime` injects them in `useEffect` — keep it that way). Module scripts that mutate the DOM before React 19 hydrates cause a SILENT client re-render (no console error in prod) that replaces the very nodes GSAP is animating — frozen loaders, dead counters. Two corollaries: (1) keep internal links as plain `<a>` (full page load re-runs the bundles); swapping to `<Link>` SPA-navigates to a page with dead animations. (2) Components host the section's REAL element as JSX (never an extra `display:contents` div) — preserves `main > section` child selectors and GSAP pinning.

The final deliverable of a clone is therefore: **pixel-perfect (gate-proven) + tokenized CSS + DESIGN.md + a fully componentized React project.**

## Phase 8: Production Output (make the deliverable VyndHub-quality, not a frozen scaffold)

A raw clone gives the *correct topology* but opaque `--c-1` tokens and innerHTML-blob sections — a "better blank canvas". Phase 8 closes most of the gap to a real production codebase (the structural work a human would otherwise do by hand — measured against a real Vaultix→VyndHub rebrand). **Honest ceiling:** Phase 8 automates the *structural scaffold* (~70-80%); the *creative layer* stays human — novel components, idiomatic rewrites of complex sections, and the actual content/brand rebrand. Run after the gate passes; re-run the gate after.

- **Semantic tokens + Tailwind `@theme`:** `node scripts/tokenize-css.mjs --semantic-names --with-theme --rename-hints`. Instead of `--c-1`, it infers role names from each value's CSS-property/selector context — `--color-accent` (color+glow on interactive/cta selectors), the `--color-background`/`--color-surface-sunken`/`--color-surface-raised` luminance ladder, `--color-border`, the `--color-foreground`/`--color-muted` opacity ladder, `--font-mono`/`--font-sans` — and emits an `@theme inline{…}` block so they become utilities (`bg-accent`, `border-border`, `bg-surface-raised`). The **equivalence proof is unchanged** (names don't affect values; the `@theme` block only references `:root`). Genuinely-ambiguous names (the middle surface levels — `header`/`input`/`icon` are human-semantic, not derivable) are written to `docs/research/TOKEN_RENAME.md` flagged MEDIUM/LOW for a one-pass human rename.
- **C2 componentization (editable JSX, not blobs):** `componentize-routes.mjs` now emits each section as real JSX (`htmlToJsx`) UNLESS it's JS-driven — `classifySection` keeps a section C1 (verbatim innerHTML) when it's >30 KB, has high inline-style density, an interactive ARIA role (tablist/dialog/…), >5 `data-*-state/idx` hooks, or >30 repeated generated siblings (matches the ~4 sections a human keeps C1). It **errs toward C1** (a wrong C2 silently breaks a replayed animation; a wrong C1 is just less editable). The run reports `N C2 / M C1 — X% editable`.
- **C2 transpile fidelity (3 non-obvious invariants — all caught by the gate, not typecheck):** (1) **whitespace** — the browser collapses any whitespace run to one space (`white-space:normal`), but JSX *removes* a run that spans a newline, so source `Monitor pipelines,\n   optimize` renders as `pipelines,optimize` (no space) → text re-wraps on narrow viewports (mobile reflows, desktop has slack and hides it). `jsxText` pre-collapses `\s+`→one space to match the browser; a whitespace-only text node *between* two inline elements (`<a>…</a> <a>…</a>`) is emitted as `{' '}`. (2) **`<pre>`** — whitespace IS significant there, so `<pre>`/descendants emit text verbatim via `{JSON.stringify(text)}` (the collapse is skipped). (3) **`<textarea>`** — React forbids `dangerouslySetInnerHTML` on it (SSG prerender error), so its content becomes `defaultValue={…}`. These are caught by the **content-fidelity gate**, not typecheck — `node scripts/verify-content-fidelity.mjs --base <running-url>` serves nothing itself (you build+serve, like qa-diff's `--clone`), fetches each route's rendered HTML, strips tags quote-aware to the visible text-token stream, and asserts byte-identity with `docs/research/raw-html/<slug>.html` (entity decode is symmetric so `&#8217;` vs a UTF-8 `’` isn't a false diff). It exits non-zero on any divergence and is **more decisive than pixels on animation-heavy sites** where the qa-diff noise floor (measured 7–36/42 on Vaultix) swamps a real text regression. Proven 19/19 (rosalia, incl. a 574-token checkout) + 7/7 (Vaultix) + a negative-control (corrupt one word → flags that route, exits 1).
- **Navbar `activePath`:** the navbar is unified into ONE shared C2 component taking `activePath`; each link's active state is driven by an `href` match → `aria-current="page"` (CSS keyed off `[aria-current=page]` — best practice — styles it automatically). Pages render `<Navbar activePath="/slug/" />`.
- **Rebrand checklist:** `node scripts/extract-design-system.mjs --rebrand-checklist` writes `docs/research/REBRAND_CHECKLIST.md` — the values tokenization can't fold (alpha-hex glow `box-shadow`s, `data-*` color attributes read by JS) + the `grep` commands to find them, so the re-brander knows exactly what's left after the accent swap.

After Phase 8, run BOTH gates (each catches a different regression class — neither alone is enough): (1) `npm run build`, then serve and run `node scripts/verify-content-fidelity.mjs --base <url>` — **the decisive one for C2** (catches a dropped word / collapsed space / lost block that the pixel gate misses under animation noise); (2) re-run the FULL qa-diff pixel gate (must stay non-regressive — C2 promotion can't break visual layout). Both green → the deliverable is an editable, semantically-tokenized, Tailwind-themed React project, the scaffold a human starts a rebrand *from*, not a frozen blob.

## Completion

Close the run with a report covering:
- Total routes cloned (for a whole-site clone: list them, and which `[slug]` template serves which slugs)
- Total sections / components / spec files written (specs should match components)
- Total assets downloaded (images incl. every srcset variant, videos, SVGs, fonts)
- Build status (`npm run build` result — must be clean: TypeScript + ESLint + static generation)
- **Pixel-diff QA table** — per route × {desktop, mobile}: `signal` / `noise` / `delta`. State desktop and mobile fidelity separately; never claim "100%" you didn't measure. Name any residual and what it maps to.
- Console status per template (should be zero errors AND zero warnings)
- Any known gaps or limitations, stated honestly
