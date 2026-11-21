// Downloads every story/hero image, shrinks it to a small WebP, and points news.json at the local copy.
// Why: hotlinked images can break, get blocked, or leak your visits to third parties, and some hosts
// (such as claude.ai previews) refuse to load remote images at all. Run after fetch.mjs: npm run build

import { readFile, writeFile, mkdir, readdir, rm, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = resolve(ROOT, "site");
const IMG_DIR = resolve(SITE, "img");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MAX_BYTES = 12 * 1024 * 1024;

const id = (url, tag) => createHash("sha1").update(url + tag).digest("hex").slice(0, 14);
const exists = (p) => access(p).then(() => true, () => false);

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "image/*" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/^image\//.test(res.headers.get("content-type") ?? "")) throw new Error("not an image");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("too large");
  return buf;
}

/** Save `url` as img/<hash>-<width>.webp (skips work if it already exists). Returns the site-relative path. */
export async function mirror(url, width, quality, dir = IMG_DIR, fetchImage = download) {
  const name = `${id(url, "")}-${width}.webp`;
  const file = resolve(dir, name);
  if (!(await exists(file))) {
    const buf = await fetchImage(url);
    const out = await sharp(buf).rotate().resize({ width, withoutEnlargement: true }).webp({ quality }).toBuffer();
    await writeFile(file, out);
  }
  return `img/${name}`;
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; await fn(items[n]); }
  }));
}

async function main() {
  const file = resolve(SITE, "data/news.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  await mkdir(IMG_DIR, { recursive: true });

  const jobs = [];
  const keep = new Set();
  for (const t of data.topics) for (const item of t.items) if (item.image) jobs.push({ kind: "card", item });
  if (data.hero?.image) jobs.push({ kind: "hero", hero: data.hero });

  let ok = 0, failed = 0;
  await pool(jobs, 6, async (job) => {
    try {
      if (job.kind === "card") {
        job.item.image = await mirror(job.item.image, 900, 76);
        keep.add(job.item.image.slice(4));
      } else {
        const h = job.hero;
        const small = h.imageSmall || h.image;
        h.image = await mirror(h.image, 1920, 78);
        h.imageSmall = small === h.image ? h.image : await mirror(small, 1280, 76);
        keep.add(h.image.slice(4)); keep.add(h.imageSmall.slice(4));
      }
      ok++;
    } catch (e) {
      failed++;
      if (job.kind === "card") { console.error(`Image skipped (${e.message}): ${job.item.image}`); job.item.image = ""; }
      else { console.error(`Hero image failed (${e.message})`); data.hero = null; }
    }
  });

  // Remove images no longer referenced so the folder doesn't grow forever.
  for (const f of await readdir(IMG_DIR)) if (!keep.has(f)) await rm(resolve(IMG_DIR, f), { force: true });

  await writeFile(file, JSON.stringify(data, null, 1) + "\n");
  console.log(`Mirrored ${ok} images (${failed} skipped) into ${IMG_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
