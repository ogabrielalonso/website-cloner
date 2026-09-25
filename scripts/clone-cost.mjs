#!/usr/bin/env node

/**
 * clone-cost.mjs — compute the REAL token cost of a clone session from its
 * Claude Code transcript (.jsonl). "You can't optimize what you can't measure":
 * this turns the ad-hoc transcript tally into a durable, repeatable tool so every
 * clone has a one-command cost, and the orchestrator-model A/B (Opus vs Sonnet 4.6) is
 * a trivial comparison.
 *
 * It sums input / output / cache-write / cache-read tokens per message, prices each
 * by THAT message's model (a session can mix), and reports a per-model + total $.
 * It also counts Task/Agent sub-dispatches and whether any asked for sonnet/haiku —
 * the signal that tells you if the model-tiers actually fired (on markup-port clones
 * they don't: the orchestrator runs inline, 0 sub-dispatches).
 *
 * Usage:
 *   node scripts/clone-cost.mjs <transcript.jsonl> [<transcript2.jsonl> ...]
 *   node scripts/clone-cost.mjs --session <id>           # search ~/.claude/projects/**
 *   node scripts/clone-cost.mjs --json a.jsonl b.jsonl   # machine-readable, + A/B delta
 *
 * Pricing is $/M tokens (Anthropic public list, 2026-06). Cache-write = 1.25× base
 * input (5-min TTL), cache-read = 0.1× base. Update PRICING if rates change.
 *
 * Pure Node built-ins. Zero new dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// $/M tokens. Keyed by a substring matched against message.model.
const PRICING = {
  opus:   { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  sonnet: { in: 3,  out: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  haiku:  { in: 1,  out: 5,  cacheWrite: 1.25, cacheRead: 0.10 },
};

function priceFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('sonnet')) return PRICING.sonnet;
  if (m.includes('haiku')) return PRICING.haiku;
  return null; // unknown / <synthetic> — not priced
}

// cache_creation can be a flat number or an object of ephemeral_* buckets.
function cacheCreation(u) {
  if (typeof u.cache_creation_input_tokens === 'number') return u.cache_creation_input_tokens;
  const cc = u.cache_creation;
  if (cc && typeof cc === 'object') return Object.values(cc).reduce((a, b) => a + (Number(b) || 0), 0);
  return 0;
}

/** Tally one transcript → { models, totals, cost, tasks, tierHits } */
export function tallyTranscript(file) {
  const byModel = {};
  let tasks = 0, sonnetTasks = 0, haikuTasks = 0, opusTasks = 0;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const msg = o?.message;
    if (!msg) continue;
    const u = msg.usage;
    if (u) {
      const model = msg.model || 'unknown';
      const t = (byModel[model] ||= { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 });
      t.in += u.input_tokens || 0;
      t.out += u.output_tokens || 0;
      t.cacheWrite += cacheCreation(u);
      t.cacheRead += u.cache_read_input_tokens || 0;
      t.msgs++;
    }
    // sub-agent dispatch detection (Task/Agent tool_use) + requested model
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_use' && (c.name === 'Task' || c.name === 'Agent')) {
          tasks++;
          const blob = JSON.stringify(c.input || '');
          if (/\bsonnet\b/i.test(blob)) sonnetTasks++;
          else if (/\bhaiku\b/i.test(blob)) haikuTasks++;
          else opusTasks++; // no explicit model → inherits session (usually Opus)
        }
      }
    }
  }

  const totals = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 };
  let cost = 0;
  for (const [model, t] of Object.entries(byModel)) {
    for (const k of ['in', 'out', 'cacheWrite', 'cacheRead', 'msgs']) totals[k] += t[k];
    const p = priceFor(model);
    if (p) cost += (t.in * p.in + t.out * p.out + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1e6;
  }
  return {
    file,
    models: Object.keys(byModel),
    byModel,
    totals,
    cost,
    tasks,
    tierHits: { sonnet: sonnetTasks, haiku: haikuTasks, opusOrInherited: opusTasks },
  };
}

function findSession(id) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return null;
  for (const proj of fs.readdirSync(root)) {
    const dir = path.join(root, proj);
    let entries; try { entries = fs.readdirSync(dir); } catch { continue; }
    const hit = entries.find((f) => f.startsWith(id) && f.endsWith('.jsonl'));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

const fmtM = (n) => (n / 1e6).toFixed(2) + 'M';

function printReport(results) {
  for (const r of results) {
    const T = r.totals;
    process.stdout.write(`\n▸ ${path.basename(r.file)}\n`);
    process.stdout.write(`  models: ${r.models.join(', ') || '?'}\n`);
    process.stdout.write(`  tokens: in=${fmtM(T.in)} out=${fmtM(T.out)} cache-write=${fmtM(T.cacheWrite)} cache-read=${fmtM(T.cacheRead)} (${T.msgs} msgs)\n`);
    process.stdout.write(`  sub-dispatches: Task/Agent=${r.tasks} (sonnet=${r.tierHits.sonnet} haiku=${r.tierHits.haiku} opus/inherited=${r.tierHits.opusOrInherited})\n`);
    process.stdout.write(`  COST: ~$${r.cost.toFixed(2)}\n`);
  }
  if (results.length >= 2) {
    const sorted = [...results].sort((a, b) => a.cost - b.cost);
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const pct = hi.cost > 0 ? ((1 - lo.cost / hi.cost) * 100).toFixed(0) : '0';
    process.stdout.write(`\nA/B: cheapest $${lo.cost.toFixed(2)} (${lo.models.join('/')}) vs $${hi.cost.toFixed(2)} (${hi.models.join('/')}) → ${pct}% cheaper\n`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session') {
      const f = findSession(args[++i]);
      if (f) files.push(f); else process.stderr.write(`clone-cost: no transcript for session ${args[i]}\n`);
    } else if (args[i] !== '--json') {
      files.push(args[i]);
    }
  }
  if (files.length === 0) {
    process.stderr.write('clone-cost: pass one or more <transcript.jsonl> or --session <id>\n');
    process.exit(2);
  }
  const results = files
    .filter((f) => { const ok = fs.existsSync(f); if (!ok) process.stderr.write(`clone-cost: not found: ${f}\n`); return ok; })
    .map(tallyTranscript);
  if (asJson) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  else printReport(results);
}

// isMain guard so tallyTranscript can be imported in a fixture test without running.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
