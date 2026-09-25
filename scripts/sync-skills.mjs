#!/usr/bin/env node
// Keeps the Codex copy of the skill identical to the Claude Code original.
//
// The single source is .claude/skills/website-cloner/SKILL.md. Claude Code reads it in place;
// Codex only looks under .codex/skills/, so this script writes a byte-for-byte copy there
// (line endings normalised to LF). Run it after every edit to the skill:
//
//   node scripts/sync-skills.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = ["skills", "website-cloner", "SKILL.md"];
const from = join(repo, ".claude", ...skillPath);
const to = join(repo, ".codex", ...skillPath);

let text;
try {
  text = readFileSync(from, "utf8").replace(/\r\n/g, "\n");
} catch {
  console.error(`sync-skills: cannot read ${from}`);
  process.exit(1);
}

mkdirSync(dirname(to), { recursive: true });
writeFileSync(to, text, "utf8");
console.log(`sync-skills: wrote .codex/${skillPath.join("/")} from the Claude Code original`);
