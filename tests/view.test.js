import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterSeries,
  sortSeries,
  viewSeries,
  summarize,
  sitesIn,
  safeUrl,
  relativeTime,
  compareChapters,
  isPlan,
  escapeHtml,
  siteLabel,
  createResultGate,
} from "../view.js";

function rec(over = {}) {
  return {
    id: `natomanga.com:${over.slug || "a"}`,
    site: "natomanga.com",
    siteName: "NatoManga",
    slug: "a",
    title: "Alpha",
    chapter: "10",
    chapterUrl: "https://www.manganami.com/manga/a/chapter-10",
    seriesUrl: "https://www.manganami.com/manga/a",
    lastReadAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    deleted: false,
    ...over,
  };
}

const library = [
  rec({ slug: "a", title: "Alpha", lastReadAt: "2026-09-03T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }),
  rec({ slug: "b", title: "bravo", chapter: null, chapterUrl: null, lastReadAt: null, createdAt: "2026-03-01T00:00:00.000Z" }),
  rec({
    slug: "c",
    title: "Charlie",
    site: "mangaread.org",
    siteName: "MangaRead",
    lastReadAt: "2026-09-05T00:00:00.000Z",
    createdAt: "2026-02-01T00:00:00.000Z",
  }),
  rec({ slug: "d", title: "Delta", deleted: true }),
  rec({ slug: "e", title: "Echo", chapter: null, chapterUrl: null, lastReadAt: null, site: "mangaread.org", siteName: "MangaRead", createdAt: "2026-04-01T00:00:00.000Z" }),
];
const titles = (list) => list.map((r) => r.title);

test("isPlan: no chapter (or an empty one) is Plan to read", () => {
  assert.equal(isPlan(rec({ chapter: null })), true);
  assert.equal(isPlan(rec({ chapter: "" })), true);
  assert.equal(isPlan(rec({ chapter: "3" })), false);
});

test("filterSeries hides tombstones and filters by status, site, and title", () => {
  assert.deepEqual(titles(filterSeries(library)), ["Alpha", "bravo", "Charlie", "Echo"]);
  assert.deepEqual(titles(filterSeries(library, { status: "reading" })), ["Alpha", "Charlie"]);
  assert.deepEqual(titles(filterSeries(library, { status: "plan" })), ["bravo", "Echo"]);
  assert.deepEqual(titles(filterSeries(library, { site: "mangaread.org" })), ["Charlie", "Echo"]);
  assert.deepEqual(titles(filterSeries(library, { query: "  BRA " })), ["bravo"]);
  assert.deepEqual(
    titles(filterSeries(library, { status: "plan", site: "mangaread.org", query: "ech" })),
    ["Echo"]
  );
  assert.deepEqual(filterSeries(library, { query: "zulu" }), []);
});

test("sortSeries: recent puts read series first, then unread ones A-Z", () => {
  assert.deepEqual(titles(sortSeries(filterSeries(library), "recent")), [
    "Charlie",
    "Alpha",
    "bravo",
    "Echo",
  ]);
});

test("sortSeries: title is A-Z regardless of case; added is newest first", () => {
  assert.deepEqual(titles(sortSeries(filterSeries(library), "title")), [
    "Alpha",
    "bravo",
    "Charlie",
    "Echo",
  ]);
  assert.deepEqual(titles(sortSeries(filterSeries(library), "added")), [
    "Echo",
    "bravo",
    "Charlie",
    "Alpha",
  ]);
});

test("sortSeries doesn't mutate its input, and viewSeries combines filter and sort", () => {
  const input = filterSeries(library);
  const before = titles(input);
  sortSeries(input, "title");
  assert.deepEqual(titles(input), before);
  assert.deepEqual(titles(viewSeries(library, { status: "reading", sort: "title" })), ["Alpha", "Charlie"]);
});

test("a series without a title doesn't break search or sorting", () => {
  const odd = [rec({ slug: "x", title: undefined }), rec({ slug: "y", title: "Yankee" })];
  assert.deepEqual(titles(filterSeries(odd, { query: "yan" })), ["Yankee"]);
  assert.equal(sortSeries(odd, "title").length, 2);
});

test("summarize counts reading and plan, ignoring tombstones", () => {
  assert.deepEqual(summarize(library), { total: 4, reading: 2, plan: 2 });
  assert.deepEqual(summarize([]), { total: 0, reading: 0, plan: 0 });
});

test("sitesIn lists the sites present, by name, skipping tombstones", () => {
  assert.deepEqual(sitesIn(library), [
    { id: "mangaread.org", name: "MangaRead" },
    { id: "natomanga.com", name: "NatoManga" },
  ]);
  assert.deepEqual(sitesIn([rec({ deleted: true })]), []);
});

test("safeUrl only passes http(s) links", () => {
  assert.equal(safeUrl("https://www.manganami.com/manga/a"), "https://www.manganami.com/manga/a");
  assert.equal(safeUrl("http://x.test/"), "http://x.test/");
  for (const bad of ["javascript:alert(1)", "data:text/html,hi", "not a url", "", null, undefined, 42]) {
    assert.equal(safeUrl(bad), null, String(bad));
  }
});

test("relativeTime formats compact ages and ignores junk", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(ago(10_000), now), "just now");
  assert.equal(relativeTime(ago(5 * 60_000), now), "5m ago");
  assert.equal(relativeTime(ago(3 * 3_600_000), now), "3h ago");
  assert.equal(relativeTime(ago(2 * 86_400_000), now), "2d ago");
  assert.equal(relativeTime(ago(14 * 86_400_000), now), "2w ago");
  assert.equal(relativeTime(ago(400 * 86_400_000), now), "1y ago");
  assert.equal(relativeTime(null, now), "");
  assert.equal(relativeTime("garbage", now), "");
});

test("compareChapters ranks numbers and refuses to rank labels", () => {
  assert.equal(compareChapters("83.2", "83"), 1);
  assert.equal(compareChapters("9", "10"), -1);
  assert.equal(compareChapters("5", "5"), 0);
  assert.ok(Number.isNaN(compareChapters("Extra", "5")));
  assert.equal(compareChapters("Extra", "Extra"), 0);
});

test("escapeHtml escapes markup characters", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("malformed optional fields from a JSON import never break filtering, sorting, or sites", () => {
  const odd = [
    rec({ slug: "m1", title: "Mike", siteName: 123, createdAt: 5, lastReadAt: 7 }),
    rec({ slug: "m2", title: 42, site: "mangaread.org", siteName: { x: 1 }, lastReadAt: "not a date" }),
    rec({ slug: "m3", title: "November", site: 9 }),
  ];
  for (const sort of ["recent", "title", "added"]) {
    assert.equal(viewSeries(odd, { sort, query: "" }).length, 3, sort);
  }
  assert.deepEqual(titles(filterSeries(odd, { query: "mik" })), ["Mike"]);
  assert.deepEqual(sitesIn(odd), [
    { id: "mangaread.org", name: "mangaread.org" },
    { id: "natomanga.com", name: "natomanga.com" },
  ]);
  assert.equal(relativeTime(12345), "");
  // A junk read time sorts like an unknown one: after real ones.
  const mixed = [rec({ slug: "j", title: "Junk", lastReadAt: "garbage" }), rec({ slug: "r", title: "Real" })];
  assert.deepEqual(titles(sortSeries(mixed, "recent")), ["Real", "Junk"]);
});

test("relativeTime never says 0mo or 0y around the month and year boundaries", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const days = (n) => new Date(now - n * 86_400_000).toISOString();
  assert.equal(relativeTime(days(34), now), "4w ago");
  assert.equal(relativeTime(days(35), now), "1mo ago");
  for (const n of [360, 362, 364]) assert.equal(relativeTime(days(n), now), "12mo ago", String(n));
  assert.equal(relativeTime(days(365), now), "1y ago");
});

test("siteLabel shows a string site name, else the site id, never throwing", () => {
  assert.equal(siteLabel(rec()), "NatoManga");
  assert.equal(siteLabel(rec({ siteName: { toString: null } })), "natomanga.com");
  assert.equal(siteLabel(rec({ siteName: 7, site: 9 })), "");
  assert.equal(siteLabel(null), "");
});

test("result gate: an older sync result never replaces a newer one, even arriving late", () => {
  const gate = createResultGate();
  const remove = gate.begin();
  const undo = gate.begin();

  // The older pass finishes first, while the newer one is still running.
  gate.end(remove);
  assert.equal(gate.accept(remove), false, "newer work still pending");

  // Codex's case: the newer one fails and reports first...
  gate.end(undo);
  assert.equal(gate.accept(undo), true);
  gate.shown(undo);
  // ...then the older success arrives late (a delayed session read).
  assert.equal(gate.accept(remove), false, "must not overwrite the newer result");
  assert.equal(gate.idle(), true);
});

test("result gate: a lone request reports, and a later one can report after it", () => {
  const gate = createResultGate();
  const a = gate.begin();
  gate.end(a);
  assert.equal(gate.accept(a), true);
  gate.shown(a);
  const b = gate.begin();
  assert.equal(gate.idle(), false);
  gate.end(b);
  assert.equal(gate.accept(b), true);
});

test("result gate: a sign-out shown by a newer call can't be undone by an older late success", () => {
  const gate = createResultGate();
  const olderSync = gate.begin(); // signed in; its final session read is slow
  gate.end(olderSync);
  const signOut = gate.begin(); // runs after sign-out: no session, reports at once
  gate.end(signOut);
  assert.equal(gate.accept(signOut), true);
  gate.shown(signOut);
  assert.equal(gate.accept(olderSync), false, "the stale 'Synced' must not come back");
});
