#!/usr/bin/env node

/**
 * gen-content-barrel.mjs — generate the slug→HTML content barrel (index.ts) for
 * a dynamic [slug] route. Replaces the per-run "write index.ts by hand" step,
 * which is a pure file-listing-to-template transform with zero judgment (the
 * Vaultix fixture had three identical instances: blog/, team/, features/).
 *
 * Reads every *.html.json in --content-dir (non-recursive), sorts alphabetically
 * (explicit, not filesystem order), and emits:
 *
 *   // Auto-generated: maps slug -> exact original <main> HTML for the [slug] route.
 *   import c0 from "./<file0>.html.json";
 *   ...
 *
 *   export const <name>Content: Record<string, string> = {
 *     "<slug0>": c0,
 *     ...
 *   };
 *
 * The export name defaults to "<dirname>Content" (e.g. blog -> blogContent) so a
 * caller cannot supply a wrong name that breaks the [slug]/page.tsx import.
 *
 * Usage:
 *   node scripts/gen-content-barrel.mjs --content-dir src/content/blog
 *   node scripts/gen-content-barrel.mjs --content-dir src/content/team --export-name teamContent
 *
 * Writes <content-dir>/index.ts. Idempotent. Exit 1 if --content-dir is missing
 * (never silently writes to a nonexistent path). Exit 0 on an empty directory
 * (writes an empty Record).
 */

import { readdir, writeFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const getFlag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const DIR = getFlag('--content-dir', null);
if (!DIR) {
  console.error('gen-content-barrel: --content-dir is required');
  process.exit(2);
}

let st;
try { st = await stat(DIR); } catch {
  console.error(`gen-content-barrel: directory not found: ${DIR}`);
  process.exit(1);
}
if (!st.isDirectory()) {
  console.error(`gen-content-barrel: not a directory: ${DIR}`);
  process.exit(1);
}

// Sanitize the dir name into a valid JS identifier: hyphens/spaces → camelCase, drop other
// invalid chars, prefix a leading digit. `blog-posts` → `blogPostsContent` (not the invalid
// `blog-postsContent` that broke tsc), `123-news` → `_123NewsContent`.
const toIdent = (s) => {
  let id = s.replace(/[-\s]+([a-z0-9])/gi, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9_$]/g, '');
  if (/^[0-9]/.test(id)) id = '_' + id;
  return id || 'content';
};
const exportName = getFlag('--export-name', `${toIdent(basename(DIR))}Content`);

const entries = (await readdir(DIR))
  .filter((f) => f.endsWith('.html.json'))
  .sort(); // explicit alphabetical, not filesystem order

const imports = entries.map((f, i) => `import c${i} from "./${f}";`).join('\n');
const slugs = entries.map((f, i) => {
  const slug = f.slice(0, -'.html.json'.length);
  return `  ${JSON.stringify(slug)}: c${i},`;
}).join('\n');

const body =
  `// Auto-generated: maps slug -> exact original <main> HTML for the [slug] route.\n` +
  (imports ? imports + '\n' : '') +
  `\n` +
  `export const ${exportName}: Record<string, string> = {\n` +
  (slugs ? slugs + '\n' : '') +
  `};\n`;

const outPath = join(DIR, 'index.ts');
await writeFile(outPath, body, 'utf8');
process.stderr.write(`gen-content-barrel: ${entries.length} slug(s) → ${outPath} (export ${exportName})\n`);
