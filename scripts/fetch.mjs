// Fetches every feed in feeds.json and writes site/data/news.json.
// Run with: npm run fetch

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const DAY = 86_400_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
});

// ---------- small helpers ----------

const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Text content of a parsed XML node (string, number, or {#text}). */
export function text(v) {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text(v["#text"]);
  return String(v);
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

export function stripHtml(s) {
  // Block-level tags become spaces; inline tags (links, bold, italics) vanish so "word<i>,</i>" stays tidy.
  const block = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|figure|figcaption)\b[^>]*>/gi;
  return decodeEntities(decodeEntities(s).replace(block, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").replace(/\s+([,.;:!?)])/g, "$1").replace(/\(\s+/g, "(").trim();
}

export function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n).replace(/\s+\S*$/, "");
  return cut.replace(/[.,;:!?\-–—]+$/, "") + "…";
}

function absoluteUrl(u, base) {
  if (!u || !String(u).trim()) return "";
  try {
    const url = new URL(decodeEntities(u).trim(), base);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

const normTitle = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const STOP = new Set("the a an and or of to in on for with is are was by at from as its it this that his her their how why what who".split(" "));
/** Significant words of a title, ignoring a trailing "| Outlet" / "- Outlet" credit. */
export function titleTokens(t) {
  const core = t.replace(/\s+[|\u2013\u2014-]\s+[^|\u2013\u2014-]{2,40}$/, "");
  const words = new Set(normTitle(core).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
  return Object.assign(words, { norm: normTitle(t) });
}
/** True when two headlines are probably the same story (shared-word overlap). */
export function similarTitles(a, b) {
  if (a.norm === b.norm) return true;
  if (a.size < 3 || b.size < 3) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size) >= 0.7;
}

function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) x.searchParams.delete(k);
    return x.href.replace(/\/$/, "");
  } catch {
    return u;
  }
}

// ---------- image extraction ----------

function looksLikeImage(url, type = "", medium = "") {
  if (!url) return false;
  if (/^image\//.test(type) || medium === "image") return true;
  return /\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(url);
}

function isJunkImage(url) {
  return /(^data:)|pixel|tracking|spacer|1x1|feedburner|\/ads?\/|gravatar|emoji/i.test(url);
}

export function extractImage(item, base) {
  const candidates = [];
  for (const m of [...arr(item["media:content"]), ...arr(item["media:group"]?.["media:content"])]) {
    const url = m?.["@_url"];
    if (looksLikeImage(url, m?.["@_type"], m?.["@_medium"])) candidates.push({ url, w: Number(m["@_width"]) || 0 });
  }
  for (const m of [...arr(item["media:thumbnail"]), ...arr(item["media:group"]?.["media:thumbnail"])]) {
    if (m?.["@_url"]) candidates.push({ url: m["@_url"], w: Number(m["@_width"]) || 0 });
  }
  for (const e of arr(item.enclosure)) {
    if (looksLikeImage(e?.["@_url"], e?.["@_type"])) candidates.push({ url: e["@_url"], w: 0 });
  }
  const itunes = item["itunes:image"]?.["@_href"];
  if (itunes) candidates.push({ url: itunes, w: 0 });

  // Prefer the widest declared image, otherwise the first.
  candidates.sort((a, b) => b.w - a.w);
  for (const c of candidates) {
    const u = absoluteUrl(c.url, base);
    if (u && !isJunkImage(u)) return u;
  }

  // Fall back to the first <img> inside the post HTML.
  const html = [text(item["content:encoded"]), text(item.content), text(item.description), text(item.summary)].join(" ");
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = absoluteUrl(m[1], base);
    if (u && !isJunkImage(u)) return u;
  }
  return "";
}

// ---------- feed parsing ----------

/** Parse RSS 2.0 / RSS 1.0 / Atom XML into normalised items. */
export function parseFeed(xml, feedUrl = "", feedName = "") {
  const doc = parser.parse(xml);
  let channelTitle = "";
  let rawItems = [];

  if (doc.rss) {
    const ch = arr(doc.rss.channel)[0] ?? {};
    channelTitle = text(ch.title);
    rawItems = arr(ch.item);
  } else if (doc.feed) {
    channelTitle = text(doc.feed.title);
    rawItems = arr(doc.feed.entry);
  } else if (doc["rdf:RDF"]) {
    channelTitle = text(doc["rdf:RDF"].channel?.title);
    rawItems = arr(doc["rdf:RDF"].item);
  } else {
    throw new Error("Not an RSS or Atom feed");
  }

  const isGoogleNews = /news\.google\./.test(feedUrl);
  const out = [];

  for (const it of rawItems) {
    let title = stripHtml(text(it.title));
    let link = text(it.link);
    if (!link && it.link) {
      const links = arr(it.link);
      const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
      link = alt?.["@_href"] ?? "";
    }
    if (!link) link = text(it.guid);
    link = absoluteUrl(link, feedUrl);
    if (!title || !link) continue;

    let source = feedName || stripHtml(channelTitle);
    let summary = "";

    if (isGoogleNews) {
      // Google News titles look like "Headline - Publisher"; the description is just a list of related links.
      const pub = stripHtml(text(it.source));
      if (pub) {
        source = pub;
        const suffix = " - " + pub;
        if (title.endsWith(suffix)) title = title.slice(0, -suffix.length);
      }
    } else {
      summary = truncate(stripHtml(text(it.description) || text(it.summary) || text(it["content:encoded"]) || text(it.content)), 240);
      // Drop WordPress boilerplate like "The post X appeared first on Site."
      summary = summary.replace(/\s*The post .{0,200}? appeared first on .*$/i, "").trim();
      if (normTitle(summary) === normTitle(title)) summary = "";
    }

    const dateStr = text(it.pubDate) || text(it["dc:date"]) || text(it.published) || text(it.updated) || text(it["a10:updated"]);
    const t = Date.parse(dateStr);

    out.push({
      title,
      url: link,
      source,
      published: Number.isNaN(t) ? null : new Date(t).toISOString(),
      summary,
      image: isGoogleNews ? "" : extractImage(it, link),
    });
  }
  return out;
}

// ---------- fetching ----------

async function fetchText(url, attempts = 2, userAgent = UA) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": userAgent, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

/** Run async tasks with a concurrency limit. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}


// ---------- photo of the day (Wikimedia Commons) ----------

const POTD_URL = "https://commons.wikimedia.org/w/api.php?action=featuredfeed&feed=potd&feedformat=atom&language=en";
const COMMONS_UA = "PersonalHomepage/1.0 (personal news page; https://github.com)";
const TRAVEL_WORDS = /\b(mountains?|peaks?|lakes?|islands?|coast(al)?|beach(es)?|sunsets?|sunrise|dawn|dusk|castles?|temples?|cathedrals?|bridges?|harbou?rs?|glaciers?|waterfalls?|deserts?|forests?|fjords?|lochs?|canyons?|valleys?|villages?|town|city|skyline|panorama(ic)?|volcano(es)?|cliffs?|river|ruins?|monastery|palace|aerial|landscape|hills?|dunes?|bay|sea|ocean|streets?)\b/i;

/** Parse Wikimedia's picture-of-the-day Atom feed into candidates. */
export function parsePotd(xml) {
  const doc = parser.parse(xml);
  const out = [];
  for (const e of arr(doc.feed?.entry)) {
    const html = text(e.summary);
    const file = /href="\/wiki\/File:([^"]+)"/.exec(html)?.[1];
    const thumb = /<img[^>]+src="(https:\/\/upload\.wikimedia\.org[^"]+|https:\/\/thumb\.wikimedia\.org[^"]+)"/.exec(html)?.[1];
    const width = Number(/data-file-width="(\d+)"/.exec(html)?.[1]);
    const height = Number(/data-file-height="(\d+)"/.exec(html)?.[1]);
    const desc = /class="description en"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    if (!file || !thumb || !width || !height) continue;
    const caption = stripHtml(desc);
    out.push({ file: decodeURIComponent(file), thumb, width, height, caption, date: text(e.updated) });
  }
  return out;
}

/** Wikimedia thumbnails only come in standard widths; swap the size in a feed thumbnail URL. */
export function thumbAt(thumbUrl, px) {
  return thumbUrl.replace(/\/\d+px-/, `/${px}px-`).replace(/\?.*$/, "");
}

const NOT_TRAVEL = /\b(birds?|owls?|eagles?|hoopoes?|insects?|butterfl(y|ies)|moths?|beetles?|bees?|spiders?|species|mammals?|monkeys?|frogs?|fish|portraits?|paintings?|drawings?|engravings?|manuscripts?|maps?|coins?|stamps?|locomotives?|aircraft|cars?|ships?|flowers?|fungus|mushrooms?|lizards?|snakes?|cats?|dogs?)\b/i;
const LATIN_NAME = /\([A-Z][a-z]+ [a-z]+\)/; // e.g. (Upupa epops): a species, not a place

/** Choose the most recent landscape-oriented picture that looks like travel/landscape photography. */
export function pickHero(candidates) {
  const usable = candidates
    .filter((c) => c.width >= 2400 && c.width / c.height >= 1.3 && c.caption)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return usable.find((c) => TRAVEL_WORDS.test(c.caption) && !NOT_TRAVEL.test(c.caption) && !LATIN_NAME.test(c.caption)) ?? null;
}

function heroText(caption) {
  // Protect abbreviations like "St." / "Mt." so they don't end a sentence.
  const guarded = caption.replace(/\s+/g, " ").replace(/\b(St|Mt|Mr|Mrs|Dr|Ft|Sr|Jr|No|Vs|Fr)\./g, "$1\u0000");
  const sentences = (guarded.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [guarded]).map((x) => x.replaceAll("\u0000", ".").trim());
  const useful = sentences.filter((x) => !/\b(today|this day|anniversary)\b/i.test(x));
  const [first = caption, ...rest] = useful.length ? useful : sentences;
  const title = truncate(first.replace(/[.]+$/, ""), 110);
  return { title, dek: rest.join(" ").slice(0, 220) };
}

/** If no Commons picture suits, use the best photography story that has an image. */
export function fallbackHero(topics) {
  const item = topics.find((t) => t.id === "photography")?.items.find((i) => i.image);
  if (!item) return null;
  return { title: item.title, dek: item.summary, image: item.image, imageSmall: item.image, width: 0, height: 0, url: item.url, credit: item.source, license: "", date: item.published };
}

export async function buildHero({ fetcher = fetchText, log = console } = {}) {
  try {
    const xml = await fetcher(POTD_URL, 2, COMMONS_UA);
    const pick = pickHero(parsePotd(xml));
    if (!pick) return null;
    const { title, dek } = heroText(pick.caption);
    const hero = {
      title,
      dek,
      image: thumbAt(pick.thumb, 1920),
      imageSmall: thumbAt(pick.thumb, 1280),
      width: pick.width,
      height: pick.height,
      url: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(pick.file.replace(/ /g, "_"))}`,
      credit: "Wikimedia Commons",
      license: "",
      date: pick.date,
    };
    // Attribution details (photographer, licence). Optional: the page still works without them.
    try {
      const api = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent("File:" + pick.file)}&prop=imageinfo&iiprop=extmetadata&format=json&formatversion=2`;
      const meta = JSON.parse(await fetcher(api, 2, COMMONS_UA))?.query?.pages?.[0]?.imageinfo?.[0]?.extmetadata ?? {};
      const artist = stripHtml(meta.Artist?.value ?? "");
      if (artist) hero.credit = truncate(artist, 80);
      hero.license = stripHtml(meta.LicenseShortName?.value ?? "");
    } catch (e) {
      log.error?.(`Hero attribution lookup failed: ${e.message}`);
    }
    return hero;
  } catch (e) {
    log.error?.(`Hero image unavailable: ${e.message}`);
    return null;
  }
}

// ---------- topic assembly ----------

function compileFilter(pattern) {
  return pattern ? new RegExp(pattern, "i") : null;
}

/** Filter, de-duplicate, cap per source, and sort one topic's items (newest first). */
export function assembleTopic(items, opts, seen = new Set(), now = Date.now()) {
  const { limit, perSource, perFeed = perSource, maxAgeDays } = opts;
  const cutoff = now - maxAgeDays * DAY;

  const fresh = items
    .map((i) => ({ ...i, _t: i.published ? Date.parse(i.published) : now - DAY }))
    .filter((i) => i._t >= cutoff && i._t <= now + DAY)
    .sort((a, b) => b._t - a._t);

  const perSourceCount = new Map();
  const perFeedCount = new Map();
  const picked = [];
  const localTitles = [];
  const localUrls = new Set();
  const seenTitles = (seen.titles ??= []);

  for (const item of fresh) {
    if (picked.length >= limit) break;
    const key = normUrl(item.url);
    const tkey = titleTokens(item.title);
    if (seen.has(key) || localUrls.has(key)) continue;
    if (localTitles.some((t) => similarTitles(t, tkey)) || seenTitles.some((t) => similarTitles(t, tkey))) continue;
    const n = perSourceCount.get(item.source) ?? 0;
    const f = perFeedCount.get(item.feedKey) ?? 0;
    // Cap per publisher, and per feed so a high-volume aggregator can't crowd out curated feeds.
    if (n >= perSource || f >= perFeed) continue;
    perSourceCount.set(item.source, n + 1);
    perFeedCount.set(item.feedKey, f + 1);
    localTitles.push(tkey);
    localUrls.add(key);
    picked.push(item);
  }
  for (const p of picked) { seen.add(normUrl(p.url)); seenTitles.push(titleTokens(p.title)); }
  return picked.map(({ _t, feedKey, ...rest }) => rest);
}

export async function build(config, options = {}) {
  const { fetcher = fetchText, now = Date.now(), log = console } = options;
  const defaults = config.defaults ?? {};
  const feedStatus = [];
  const cache = new Map(); // url -> Promise<parsed items>, so a feed used by two topics is fetched once

  const load = (feed) => {
    if (!cache.has(feed.url)) {
      cache.set(
        feed.url,
        (async () => {
          try {
            const xml = await fetcher(feed.url);
            return { items: parseFeed(xml, feed.url, feed.name), error: null };
          } catch (e) {
            return { items: [], error: e.message };
          }
        })(),
      );
    }
    return cache.get(feed.url);
  };

  // Kick off all fetches with limited concurrency.
  const uniqueFeeds = [...new Map(config.topics.flatMap((t) => t.feeds).map((f) => [f.url, f])).values()];
  await pool(uniqueFeeds.map((f) => () => load(f)), 8);

  const seen = new Set();
  const topics = [];

  for (const topic of config.topics) {
    const opts = { ...defaults, ...topic };
    const collected = [];
    for (const feed of topic.feeds) {
      const { items, error } = await load(feed);
      const inc = compileFilter(feed.include);
      const exc = compileFilter(feed.exclude);
      const kept = items.filter((i) => {
        const hay = `${i.title} ${i.summary}`;
        return (!inc || inc.test(hay)) && (!exc || !exc.test(hay));
      });
      collected.push(...kept.map((i) => ({ ...i, feedKey: feed.url, source: feed.name && !/news\.google\./.test(feed.url) ? feed.name : i.source })));
      feedStatus.push({ topic: topic.id, feed: feed.name ?? feed.url, url: feed.url, ok: !error, error, fetched: items.length, matched: kept.length });
    }
    topics.push({
      id: topic.id,
      title: topic.title,
      blurb: topic.blurb ?? "",
      color: topic.color ?? "",
      items: assembleTopic(collected, opts, seen, now),
    });
  }

  const hero = options.hero === false ? null : (await buildHero({ fetcher, log })) ?? fallbackHero(topics);
  return { generatedAt: new Date(now).toISOString(), hero, topics, feedStatus };
}

// ---------- CLI ----------

async function main() {
  const config = JSON.parse(await readFile(resolve(ROOT, "feeds.json"), "utf8"));
  const data = await build(config);

  const total = data.topics.reduce((n, t) => n + t.items.length, 0);
  for (const s of data.feedStatus.filter((s) => !s.ok)) {
    const msg = `Feed failed: ${s.feed} (${s.url}): ${s.error}`;
    console.error(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
  }
  for (const t of data.topics) {
    if (t.items.length === 0) {
      const msg = `Topic "${t.title}" has no items`;
      console.error(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
    }
  }

  if (!data.hero) {
    const msg = "No hero image today (the page falls back to a story image)";
    console.error(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
  }

  if (total === 0) {
    console.error("No items fetched at all; leaving existing data untouched.");
    process.exit(1);
  }

  const outFile = resolve(ROOT, "site/data/news.json");
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(data, null, 1) + "\n");
  console.log(`Wrote ${total} items across ${data.topics.length} topics to ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
