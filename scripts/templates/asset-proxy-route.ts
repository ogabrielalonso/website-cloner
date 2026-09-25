/**
 * asset-proxy-route.ts — TEMPLATE for a same-origin proxy of a hotlink-protected
 * agency asset CDN. NOT a live route in this template repo — copy it into the clone:
 *
 *   cp scripts/templates/asset-proxy-route.ts src/app/<seg>/[...path]/route.ts
 *
 * then (1) edit HOSTS + REFERER below, (2) rewrite the obfuscated bundle's few
 * base-URL string constants to `/<seg>/<key>` (e.g. `/ob/lando`), (3) add the
 * CACHE_DIR name to .gitignore. IMPORTANT: <seg> must NOT start with `_` — Next
 * treats `app/_seg/` as a private (non-routable) folder, so the handler would 404.
 *
 * Why a proxy and not `download-assets.mjs`? When the app is one obfuscated bundle
 * that builds its `.glb/.riv/.hdr/.wasm/msdf` URLs internally, you can't enumerate
 * the asset graph to mirror it — and the CDN 403s every cross-origin request by
 * Referer. This handler re-fetches upstream WITH the right Referer and disk-caches
 * the bytes, so each asset is fetched once and the clone survives the CDN going down.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// EDIT: map each url-segment → upstream origin. The bundle's base-URL constants
// get rewritten to `/<seg>/<key>` (e.g. `https://assets.example.io` → `/ob/assets`).
const HOSTS: Record<string, string> = {
  lando: "https://lando.itsoffbrand.io",
  assets: "https://assets.itsoffbrand.io",
};

// EDIT: the ORIGINAL site origin the CDN expects in the Referer header.
const REFERER = "https://example.com/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// EDIT (optional): the disk cache dir — add this name to .gitignore.
const CACHE_DIR = path.join(process.cwd(), ".asset-proxy-cache");

const MIME: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".riv": "application/octet-stream",
  ".hdr": "image/vnd.radiance",
  ".exr": "image/x-exr",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ktx2": "image/ktx2",
  ".bin": "application/octet-stream",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export async function GET(
  request: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path: segs } = await ctx.params;
  const [hostKey, ...rest] = segs ?? [];
  const base = HOSTS[hostKey];
  if (!base || rest.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const search = new URL(request.url).search;
  const upstream = `${base}/${rest.join("/")}${search}`;
  const ext = path.extname(rest[rest.length - 1] || "").toLowerCase();
  const fallbackType = MIME[ext] || "application/octet-stream";

  const cacheKey =
    crypto.createHash("sha1").update(upstream).digest("hex") + ext;
  const cacheFile = path.join(CACHE_DIR, cacheKey);

  // Cache hit
  try {
    const buf = await fs.readFile(cacheFile);
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": fallbackType,
        "cache-control": "public, max-age=31536000, immutable",
        "x-proxy-cache": "hit",
      },
    });
  } catch {
    /* miss */
  }

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: { Referer: REFERER, "User-Agent": UA },
      redirect: "follow",
    });
  } catch (e) {
    return new Response(`Upstream fetch error: ${(e as Error).message}`, {
      status: 502,
    });
  }
  if (!res.ok) {
    return new Response(`Upstream ${res.status}`, { status: res.status });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(cacheFile, buf);
  } catch {
    /* cache write best-effort */
  }

  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": res.headers.get("content-type") || fallbackType,
      "cache-control": "public, max-age=31536000, immutable",
      "x-proxy-cache": "miss",
    },
  });
}
