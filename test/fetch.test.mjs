import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, assembleTopic, build, stripHtml, truncate } from "../scripts/fetch.mjs";

const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Example Blog</title>
<item>
  <title><![CDATA[Selkies &amp; seals: a guide]]></title>
  <link>http://example.com/a?utm_source=x</link>
  <pubDate>Thu, 19 Nov 2026 09:00:00 GMT</pubDate>
  <description><![CDATA[<p>Tales of <b>seal-folk</b> from Orkney.&nbsp;Read more</p>]]></description>
  <media:content url="http://example.com/big.jpg" medium="image" width="1200"/>
  <media:content url="http://example.com/small.jpg" medium="image" width="200"/>
</item>
<item>
  <title>Post with inline image</title>
  <link>https://example.com/b</link>
  <dc:date>2026-11-18T10:00:00Z</dc:date>
  <content:encoded><![CDATA[<p>Hi</p><img src="https://example.com/pixel.gif" width="1"><img src="/img/hero.png">]]></content:encoded>
</item>
<item><title>No link</title></item>
</channel></rss>`;

const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Site</title>
<entry>
  <title>Atom entry</title>
  <link rel="self" href="https://atom.example/self"/>
  <link rel="alternate" href="https://atom.example/post"/>
  <updated>2026-11-17T08:00:00Z</updated>
  <summary>Short summary</summary>
</entry></feed>`;

const gnews = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Google News</title>
<item>
  <title>Indy poll shows shift - The Example Times</title>
  <link>https://news.google.com/rss/articles/abc</link>
  <pubDate>Fri, 20 Nov 2026 07:00:00 GMT</pubDate>
  <description>&lt;ol&gt;&lt;li&gt;related&lt;/li&gt;&lt;/ol&gt;</description>
  <source url="https://example.com">The Example Times</source>
</item></channel></rss>`;

test("parses RSS: decodes entities, upgrades http, strips tracking noise, picks widest image", () => {
  const items = parseFeed(rss, "https://example.com/feed", "Example");
  assert.equal(items.length, 2, "item without a link is dropped");
  assert.equal(items[0].title, "Selkies & seals: a guide");
  assert.equal(items[0].url, "https://example.com/a?utm_source=x");
  assert.equal(items[0].summary, "Tales of seal-folk from Orkney. Read more");
  assert.equal(items[0].image, "https://example.com/big.jpg");
  assert.equal(items[0].published, "2026-11-19T09:00:00.000Z");
  assert.equal(items[1].image, "https://example.com/img/hero.png", "skips tracking pixel, resolves relative URL");
  assert.equal(items[1].published, "2026-11-18T10:00:00.000Z");
  assert.equal(items[0].source, "Example");
});

test("parses Atom and prefers the alternate link", () => {
  const [e] = parseFeed(atom, "https://atom.example/feed.xml", "");
  assert.equal(e.url, "https://atom.example/post");
  assert.equal(e.source, "Atom Site");
  assert.equal(e.summary, "Short summary");
});

test("parses Google News: strips publisher suffix, uses publisher as source, no summary", () => {
  const [e] = parseFeed(gnews, "https://news.google.com/rss/search?q=x", "Google News");
  assert.equal(e.title, "Indy poll shows shift");
  assert.equal(e.source, "The Example Times");
  assert.equal(e.summary, "");
});

test("rejects non-feed responses", () => {
  assert.throws(() => parseFeed("<html><body>Blocked</body></html>"), /Not an RSS/);
});

test("assembleTopic: age cutoff, dedupe, per-source cap, newest first, limit", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const mk = (n, source, daysAgo, url = `https://x.com/${n}`, title = `Title ${n}`) => ({
    title, url, source, feedKey: source, summary: "", image: "", published: new Date(now - daysAgo * 86_400_000).toISOString(),
  });
  const items = [
    mk(1, "A", 1), mk(2, "A", 2), mk(3, "A", 3), mk(4, "A", 0.5), // A has 4, cap is 3
    mk(5, "B", 4), mk(6, "B", 30),                                 // too old
    mk(7, "C", 5, "https://x.com/5", "Dup of 5 by URL"),
    mk(8, "C", 1, "https://x.com/8", "title 1"),                   // dup of 1 by title
  ];
  const seen = new Set();
  const out = assembleTopic(items, { limit: 10, perSource: 3, maxAgeDays: 7 }, seen, now);
  assert.deepEqual(out.map((i) => i.title), ["Title 4", "Title 1", "Title 2", "Title 5"]);
  assert.ok(!out.some((i) => i.title === "Title 3"), "per-source cap drops A's 4th");
  assert.ok(!out.some((i) => i.title === "Title 6"), "old item dropped");
  assert.equal(out.length, 4);
  // A feed with many distinct publishers (like Google News) is capped per feed.
  const agg = Array.from({ length: 6 }, (_, i) => ({ title: `Agg ${i}`, url: `https://a.com/${i}`, source: `Pub ${i}`, feedKey: "gn", summary: "", image: "", published: new Date(now - 3600_000).toISOString() }));
  const own = mk(20, "Curated", 5);
  const mixed = assembleTopic([...agg, own], { limit: 8, perSource: 2, perFeed: 3, maxAgeDays: 7 }, new Set(), now);
  assert.equal(mixed.filter((i) => i.title.startsWith("Agg")).length, 3);
  assert.ok(mixed.some((i) => i.title === "Title 20"), "curated item survives the aggregator");
  const limited = assembleTopic(items, { limit: 2, perSource: 3, maxAgeDays: 7 }, new Set(), now);
  assert.equal(limited.length, 2);
});

test("build: include/exclude filters, shared feeds fetched once, global URL dedupe, failures reported", async () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const calls = [];
  const feedXml = `<rss><channel><title>S</title>
    <item><title>Haunted castle in Fife</title><link>https://s.com/1</link><pubDate>Thu, 19 Nov 2026 09:00:00 GMT</pubDate></item>
    <item><title>Camera deal of the week</title><link>https://s.com/2</link><pubDate>Thu, 19 Nov 2026 09:00:00 GMT</pubDate></item>
    <item><title>Selkie festival</title><link>https://s.com/3</link><pubDate>Thu, 19 Nov 2026 09:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes("broken")) throw new Error("HTTP 403");
    return feedXml;
  };
  const config = {
    defaults: { limit: 8, perSource: 3, maxAgeDays: 14 },
    topics: [
      { id: "spooky", title: "Spooky", feeds: [{ name: "S", url: "https://s.com/feed", include: "haunted" }, { name: "Bad", url: "https://broken.com/feed" }] },
      { id: "folk", title: "Folk", feeds: [{ name: "S", url: "https://s.com/feed", include: "selkie|haunted", exclude: "deal" }] },
    ],
  };
  const data = await build(config, { fetcher, now, log: { error() {} } });
  assert.equal(calls.filter((c) => c === "https://s.com/feed").length, 1, "shared feed fetched once");
  assert.deepEqual(data.topics[0].items.map((i) => i.title), ["Haunted castle in Fife"]);
  assert.deepEqual(data.topics[1].items.map((i) => i.title), ["Selkie festival"], "haunted item already used by first topic");
  const bad = data.feedStatus.find((s) => s.feed === "Bad");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /403/);
});

test("helpers", () => {
  assert.equal(stripHtml("<p>A&nbsp;&amp;&nbsp;B &#8217;</p>"), "A & B ’");
  assert.equal(truncate("one two three four", 9), "one two…");
  assert.equal(truncate("short", 20), "short");
});

// ---------- hero (picture of the day) ----------

const potdEntry = (day, file, w, h, caption) => `<entry><updated>2026-11-${day}T00:00:00Z</updated><summary type="html">&lt;div&gt;&lt;a href=&quot;/wiki/File:${file}&quot;&gt;&lt;img src=&quot;https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${file}/330px-${file}?utm_source=x&quot; data-file-width=&quot;${w}&quot; data-file-height=&quot;${h}&quot; /&gt;&lt;/a&gt;&lt;div class=&quot;description en&quot;&gt;${caption}&lt;/div&gt;&lt;/div&gt;</summary></entry>`;
const potdXml = `<feed xmlns="http://www.w3.org/2005/Atom">${[
  potdEntry(18, "Rome_dusk.jpg", 3780, 2448, "Dusk at St. Peter&#039;s Basilica and the Tiber river in Rome, Italy. The Church celebrates a feast &lt;a href=&quot;x&quot;&gt;today&lt;/a&gt;."),
  potdEntry(19, "Hoopoe.jpg", 3762, 2508, "Eurasian hoopoe (Upupa epops) eating in a national park, India"),
  potdEntry(20, "Portrait_waterfall.jpg", 3000, 4500, "A waterfall in Madeira"),
].join("")}</feed>`;

test("parsePotd extracts file, size, thumbnail and tidy caption", async () => {
  const { parsePotd } = await import("../scripts/fetch.mjs");
  const c = parsePotd(potdXml);
  assert.equal(c.length, 3);
  assert.equal(c[0].file, "Rome_dusk.jpg");
  assert.equal(c[0].width, 3780);
  assert.match(c[0].caption, /^Dusk at St\. Peter's Basilica/);
  assert.ok(!c[0].caption.includes("<"));
});

test("pickHero skips wildlife and portrait-orientation pictures; thumbAt resizes", async () => {
  const { parsePotd, pickHero, thumbAt } = await import("../scripts/fetch.mjs");
  const pick = pickHero(parsePotd(potdXml));
  assert.equal(pick.file, "Rome_dusk.jpg");
  assert.equal(pickHero([{ file: "x", width: 4000, height: 2000, caption: "Eagle over a mountain", date: "2026-11-01T00:00:00Z" }]), null);
  assert.match(thumbAt(pick.thumb, 1920), /\/1920px-Rome_dusk\.jpg$/);
});

test("buildHero degrades gracefully: attribution failure keeps the image, feed failure gives null", async () => {
  const { buildHero } = await import("../scripts/fetch.mjs");
  const quiet = { error() {} };
  const ok = await buildHero({ log: quiet, fetcher: async (url) => { if (url.includes("featuredfeed")) return potdXml; throw new Error("HTTP 429"); } });
  assert.equal(ok.credit, "Wikimedia Commons");
  assert.match(ok.title, /^Dusk at St\. Peter's Basilica/);
  assert.ok(!/today/i.test(ok.title + ok.dek), "feast-day sentence is dropped");
  assert.match(ok.url, /commons\.wikimedia\.org\/wiki\/File:Rome_dusk\.jpg$/);
  const meta = JSON.stringify({ query: { pages: [{ imageinfo: [{ extmetadata: { Artist: { value: '<a href="u">Jane Doe</a>' }, LicenseShortName: { value: "CC BY-SA 4.0" } } }] }] } });
  const withMeta = await buildHero({ log: quiet, fetcher: async (url) => (url.includes("featuredfeed") ? potdXml : meta) });
  assert.equal(withMeta.credit, "Jane Doe");
  assert.equal(withMeta.license, "CC BY-SA 4.0");
  assert.equal(await buildHero({ log: quiet, fetcher: async () => { throw new Error("down"); } }), null);
});

test("stripHtml keeps inline punctuation tidy", () => {
  assert.equal(stripHtml("Eurasian <i>Upupa epops</i> (<b>bird</b>) in Park<span>,</span> India"), "Eurasian Upupa epops (bird) in Park, India");
});

test("near-duplicate headlines from different outlets are collapsed", async () => {
  const { assembleTopic } = await import("../scripts/fetch.mjs");
  const now = Date.now();
  const mk = (title, url, source) => ({ title, url, source, feedKey: source, published: new Date(now - 3600e3).toISOString(), summary: "" });
  const out = assembleTopic(
    [mk("Delhi-based lawyer Sarna pens high-altitude folk horror | Hindustan Times", "https://a.com/1", "A"),
     mk("Delhi-based lawyer Sarna pens high-altitude folk horror", "https://b.com/2", "B"),
     mk("Wicker review: a different story entirely", "https://c.com/3", "C")],
    { limit: 8, perSource: 2, maxAgeDays: 14 }, new Set(), now);
  assert.equal(out.length, 2);
});
