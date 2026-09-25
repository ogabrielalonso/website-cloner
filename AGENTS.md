<!-- BEGIN:nextjs-agent-rules -->
# Heads-up: this Next.js is newer than your training data

Expect APIs, conventions and file layout to differ from what you remember, because this version ships breaking changes. Before you write any code, open the matching guide under `node_modules/next/dist/docs/` and read it, and act on every deprecation notice.
<!-- END:nextjs-agent-rules -->

# Website Cloner: Agent Guide

## About This Repo
A reusable template for reverse-engineering any website into a clean, modern Next.js codebase using AI coding agents. The Next.js + shadcn/ui + Tailwind v4 base is pre-scaffolded — just run `/website-cloner <url1> [<url2> ...]`.

## Stack
- **Framework:** Next.js 16 on the App Router, with React 19 and strict TypeScript
- **Components:** shadcn/ui, built on Radix primitives and Tailwind CSS v4, plus the `cn()` helper
- **Icons:** Lucide React as the starting set; SVGs extracted from the target replace or extend it
- **Styles:** Tailwind CSS v4, with design tokens written in oklch
- **Hosting:** Vercel

## Scripts
- `npm run dev`: development server
- `npm run build`: production build
- `npm run lint`: ESLint
- `npm run typecheck`: TypeScript type check
- `npm run check`: lint, then typecheck, then build

## Coding Conventions
- Strict TypeScript mode; `any` is not allowed
- Use named exports; components in PascalCase, utilities in camelCase
- Style with Tailwind utility classes, never with inline styles
- Indent with 2 spaces
- Build responsive layouts mobile-first

## Cloning Principles
- **Match the target exactly:** spacing, colors and typography identical to the original
- **Keep your own taste out of the emulation phase:** reach 1:1 first, customize afterwards
- **Use the real content:** the target's actual text and assets, never placeholders
- **Visual quality comes first:** no pixel is unimportant

## Layout of the Repo
```
src/
  app/              # App Router routes
  components/       # shared React components
    ui/             # shadcn/ui primitive components
    icons.tsx       # SVGs pulled from the target, as React components
  lib/
    utils.ts        # shadcn cn() helper
  types/            # shared TypeScript interfaces
  hooks/            # custom React hooks
public/
  images/           # images downloaded from the target
  videos/           # videos downloaded from the target
  seo/              # favicons, OG images, web manifest
docs/
  research/         # inspection output: design tokens, components, layout
  design-references/ # screenshots and other visual references
scripts/            # scripts that download assets
```

## Critical Notes
- Agent teams in Claude Code: ALWAYS give every teammate its own worktree branch, and merge all of their work at the end. As the orchestrator you hold the full context (the goals, what each teammate was given and what each delivered), so use it to resolve merge conflicts sensibly.
- `AGENTS.md` is read natively by Claude Code (via `CLAUDE.md`) and Codex, so no generation step is needed.
- After editing `.claude/skills/website-cloner/SKILL.md`, run `node scripts/sync-skills.mjs` to regenerate the Codex copy of the skill (Claude Code uses the source `SKILL.md` directly).

@docs/research/INSPECTION_GUIDE.md
