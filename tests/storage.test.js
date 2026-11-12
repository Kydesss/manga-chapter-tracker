import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  adoptLibrary,
  bulkUpsert,
  getAll,
  importRecords,
  markSynced,
  migrate,
  remove,
  restore,
  updateMap,
  upsert,
} from "../storage.js";
import { parseChapterUrl, parseSeriesUrl } from "../parser.js";
import { resolveConflict } from "../merge.js";

let data;

beforeEach(() => {
  data = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          // Copies, like Chrome: callers never hold references into storage.
          if (typeof key === "string") return structuredClone({ [key]: data[key] });
          return structuredClone(data);
        },
        async set(values) {
          Object.assign(data, structuredClone(values));
        },
      },
    },
  };
});

test("schema migration preserves legacy data, adds v3 fields, and backfills lastReadAt", async () => {
  const legacy = {
    id: "natomanga.com:blue-lock",
    site: "natomanga.com",
    siteName: "NatoManga",
    slug: "blue-lock",
    title: "Blue Lock",
    chapter: "348.5",
    chapterUrl: "https://www.natomanga.com/manga/blue-lock/chapter-348-5",
    seriesUrl: "https://www.natomanga.com/manga/blue-lock",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deleted: false,
    dirty: false,
  };
  data.schemaVersion = 2;
  data.series = { [legacy.id]: structuredClone(legacy) };

  const result = await migrate();
  const migrated = data.series[legacy.id];

  assert.deepEqual(result, { migrated: 1 });
  assert.equal(data.schemaVersion, 7);
  for (const [key, value] of Object.entries(legacy)) {
    if (key === "chapterUrl" || key === "seriesUrl") continue; // v5 moves the domain
    assert.deepEqual(migrated[key], value, `${key} should be preserved`);
  }
  assert.equal(migrated.chapterUrl, "https://www.manganami.com/manga/blue-lock/chapter-348-5");
  assert.equal(migrated.seriesUrl, "https://www.manganami.com/manga/blue-lock");
  assert.equal(migrated.status, "reading");
  // A legacy record was last read when it was last saved.
  assert.equal(migrated.lastReadAt, legacy.updatedAt);
  assert.equal(migrated.coverUrl, null);
  assert.equal(migrated.latestChapter, null);
  assert.equal(migrated.latestChapterUrl, null);
  assert.equal(migrated.latestPublishedAt, null);
  assert.equal(migrated.metadataCheckedAt, null);
});

test("schema migration is idempotent", async () => {
  data.schemaVersion = 2;
  data.series = {
    "natomanga.com:unread": {
      id: "natomanga.com:unread",
      chapter: null,
      title: "Unread",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  };

  assert.deepEqual(await migrate(), { migrated: 1 });
  const afterFirst = structuredClone(data);
  assert.equal(data.series["natomanga.com:unread"].status, "plan");

  assert.deepEqual(await migrate(), { migrated: 0 });
  assert.deepEqual(data, afterFirst);
});

test("saving a chapter preserves previously collected series metadata", async () => {
  data.schemaVersion = 3;
  data.series = {
    "natomanga.com:blue-lock": {
      id: "natomanga.com:blue-lock",
      title: "Blue Lock",
      chapter: null,
      chapterUrl: null,
      status: "plan",
      coverUrl: "https://img.example/blue-lock.jpg",
      latestChapter: "350",
      updatedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      deleted: false,
      dirty: false,
    },
  };

  const saved = await upsert({
    id: "natomanga.com:blue-lock",
    title: "Blue Lock",
    chapter: "348",
    chapterUrl: "https://www.natomanga.com/manga/blue-lock/chapter-348",
    updatedAt: "2026-09-22T12:00:00.000Z",
    lastReadAt: "2026-09-22T12:00:00.000Z",
  });

  assert.equal(saved.status, "reading");
  assert.equal(saved.coverUrl, "https://img.example/blue-lock.jpg");
  assert.equal(saved.latestChapter, "350");
  assert.equal(saved.createdAt, "2026-08-01T00:00:00.000Z");
  assert.equal(saved.dirty, true);
});

function stored(over = {}) {
  return {
    id: "natomanga.com:witch-and-mercenary",
    site: "natomanga.com",
    siteName: "NatoManga",
    slug: "witch-and-mercenary",
    title: "Witch & Mercenary",
    seriesUrl: "https://www.manganami.com/manga/witch-and-mercenary",
    status: "reading",
    chapter: "3",
    chapterUrl: "https://www.manganami.com/manga/witch-and-mercenary/chapter-3",
    lastReadAt: "2026-09-01T00:00:00.000Z",
    progressAt: "2026-09-01T00:00:00.000Z",
    progressResetAt: null,
    coverUrl: null,
    latestChapter: null,
    latestChapterUrl: null,
    latestPublishedAt: null,
    metadataCheckedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deleted: false,
    dirty: false,
    ...over,
  };
}

test("saving a parsed chapter keeps the imported title and metadata", async () => {
  data.schemaVersion = 4;
  const existing = stored({
    coverUrl: "https://img.example/wm.jpg",
    latestChapter: "12",
    latestChapterUrl: "https://www.natomanga.com/manga/witch-and-mercenary/chapter-12",
  });
  data.series = { [existing.id]: existing };

  // Exactly what the popup saves: the parser's record, whose title comes from
  // the slug and whose metadata fields are all null.
  const pending = parseChapterUrl(
    "https://www.natomanga.com/manga/witch-and-mercenary/chapter-4"
  );
  const saved = await upsert({ ...pending, updatedAt: "2026-09-23T00:00:00.000Z" });

  assert.equal(saved.chapter, "4");
  assert.equal(saved.status, "reading");
  assert.equal(saved.title, "Witch & Mercenary");
  assert.equal(saved.coverUrl, "https://img.example/wm.jpg");
  assert.equal(saved.latestChapter, "12");
  assert.match(saved.latestChapterUrl, /chapter-12$/);
  assert.equal(saved.dirty, true);
});

test("a first save uses the slug-derived title", async () => {
  data.schemaVersion = 4;
  data.series = {};
  const pending = parseChapterUrl(
    "https://www.natomanga.com/manga/witch-and-mercenary/chapter-4"
  );
  const saved = await upsert({ ...pending, updatedAt: "2026-09-23T00:00:00.000Z" });
  assert.equal(saved.title, "Witch And Mercenary");
});

test("JSON export then import keeps plan-to-read records", async () => {
  data.schemaVersion = 4;
  const reading = stored();
  const plan = stored({
    id: "natomanga.com:unread",
    slug: "unread",
    title: "Unread",
    seriesUrl: "https://www.natomanga.com/manga/unread",
    status: "plan",
    chapter: null,
    chapterUrl: null,
    lastReadAt: null,
  });
  data.series = { [reading.id]: reading, [plan.id]: plan };

  const exported = JSON.parse(JSON.stringify(await getAll()));
  data.series = {};
  const result = await importRecords(exported);

  assert.equal(result.added, 2);
  assert.equal(result.skipped, 0);
  assert.equal(data.series[plan.id].status, "plan");
  assert.equal(data.series[plan.id].chapter, null);
  assert.equal(data.series[reading.id].chapter, "3");
});

test("JSON import can't move progress back, but can move it forward", async () => {
  data.schemaVersion = 4;
  const existing = stored({ chapter: "30", chapterUrl: "https://x.test/c30", updatedAt: "2026-09-10T00:00:00.000Z" });
  data.series = { [existing.id]: existing };

  // A newer plan-to-read entry and a newer lower chapter both lose.
  await importRecords([
    stored({ chapter: null, chapterUrl: null, status: "plan", updatedAt: "2026-09-20T00:00:00.000Z" }),
  ]);
  assert.equal(data.series[existing.id].chapter, "30");
  await importRecords([
    stored({ chapter: "25", chapterUrl: "https://x.test/c25", updatedAt: "2026-09-21T00:00:00.000Z" }),
  ]);
  assert.equal(data.series[existing.id].chapter, "30");

  // An older backup that is further along wins: furthest chapter, as in sync.
  const result = await importRecords([
    stored({ chapter: "35", chapterUrl: "https://x.test/c35", updatedAt: "2026-08-01T00:00:00.000Z" }),
  ]);
  assert.equal(result.updated, 1);
  assert.equal(data.series[existing.id].chapter, "35");
  assert.equal(data.series[existing.id].chapterUrl, "https://x.test/c35");
  assert.equal(data.series[existing.id].dirty, true);
});

test("JSON import brings a legacy (v0.3) export up to the current shape", async () => {
  data.schemaVersion = 4;
  data.series = {};
  const legacy = {
    id: "mangaread.org:blue-lock",
    site: "mangaread.org",
    siteName: "MangaRead",
    slug: "blue-lock",
    title: "Blue Lock",
    chapter: "350",
    chapterUrl: "https://www.mangaread.org/manga/blue-lock/chapter-350/",
    seriesUrl: "https://www.mangaread.org/manga/blue-lock",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    deleted: false,
    dirty: false,
  };
  await importRecords([legacy]);
  const imported = data.series[legacy.id];
  assert.equal(imported.status, "reading");
  assert.equal(imported.lastReadAt, legacy.updatedAt);
  assert.equal(imported.coverUrl, null);
  assert.equal(imported.dirty, true);
});

test("v4 migration backfills lastReadAt only where it was never recorded", async () => {
  data.schemaVersion = 3;
  const legacy = stored({ id: "a", lastReadAt: null, updatedAt: "2026-07-01T00:00:00.000Z" });
  const imported = stored({ id: "b", lastReadAt: "2026-09-22T12:00:00.000Z" });
  const plan = stored({ id: "c", chapter: null, chapterUrl: null, status: "plan", lastReadAt: null });
  data.series = { a: legacy, b: imported, c: plan };

  assert.deepEqual(await migrate(), { migrated: 1 });
  assert.equal(data.schemaVersion, 7);
  assert.equal(data.series.a.lastReadAt, "2026-07-01T00:00:00.000Z");
  assert.equal(data.series.b.lastReadAt, "2026-09-22T12:00:00.000Z");
  assert.equal(data.series.c.lastReadAt, null);
});

test("v5 migration moves NatoManga links to manganami.com without touching anything else", async () => {
  data.schemaVersion = 4;
  const old = stored({
    id: "old",
    chapter: "12.5",
    chapterUrl: "https://www.natomanga.com/manga/witch-and-mercenary/chapter-12-5?x=1#p3",
    seriesUrl: "https://natomanga.com/manga/witch-and-mercenary",
    latestChapterUrl: "http://www.natomanga.com/manga/witch-and-mercenary/chapter-20",
    updatedAt: "2026-08-01T00:00:00.000Z",
    dirty: false,
  });
  const other = stored({
    id: "mangaread.org:x",
    site: "mangaread.org",
    chapterUrl: "https://www.mangaread.org/manga/x/chapter-1/",
    seriesUrl: "https://www.mangaread.org/manga/x",
  });
  const plan = stored({ id: "plan", chapter: null, chapterUrl: null, status: "plan", seriesUrl: "https://www.natomanga.com/manga/p" });
  data.series = { old: structuredClone(old), [other.id]: structuredClone(other), plan: structuredClone(plan) };

  assert.deepEqual(await migrate(), { migrated: 2 });
  const m = data.series.old;
  assert.equal(m.chapterUrl, "https://www.manganami.com/manga/witch-and-mercenary/chapter-12-5?x=1#p3");
  assert.equal(m.seriesUrl, "https://www.manganami.com/manga/witch-and-mercenary");
  assert.equal(m.latestChapterUrl, "https://www.manganami.com/manga/witch-and-mercenary/chapter-20");
  assert.equal(m.chapter, "12.5");
  assert.equal(m.updatedAt, old.updatedAt); // not a user edit
  assert.equal(m.dirty, false); // nothing to push
  assert.equal(m.id, old.id); // the stable key never changes
  assert.deepEqual(data.series[other.id], other);
  assert.equal(data.series.plan.seriesUrl, "https://www.manganami.com/manga/p");
  assert.equal(data.series.plan.chapterUrl, null);
});

test("a JSON backup with old NatoManga links restores them on manganami.com", async () => {
  data.schemaVersion = 5;
  const current = stored({ chapter: "3" });
  data.series = { [current.id]: structuredClone(current) };

  const result = await importRecords([
    stored({
      chapter: "3",
      chapterUrl: "https://www.natomanga.com/manga/witch-and-mercenary/chapter-3",
      seriesUrl: "https://www.natomanga.com/manga/witch-and-mercenary",
    }),
  ]);

  assert.equal(result.updated, 0); // same series, same place: nothing changed
  assert.equal(data.series[current.id].chapterUrl, current.chapterUrl);
});

test("an up-to-date schema leaves an import's unknown read time alone", async () => {
  data.schemaVersion = 7;
  data.series = { a: stored({ id: "a", lastReadAt: null }) };
  assert.deepEqual(await migrate(), { migrated: 0 });
  assert.equal(data.series.a.lastReadAt, null);
});

test("concurrent writes don't overwrite each other", async () => {
  // Slow storage, so read-modify-writes that weren't serialized would interleave
  // (all three read the empty map before any of them writes).
  const { get, set } = chrome.storage.local;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  chrome.storage.local.get = async (key) => {
    await pause();
    return get(key);
  };
  chrome.storage.local.set = async (values) => {
    await pause();
    return set(values);
  };
  data.schemaVersion = 4;
  data.series = {};

  await Promise.all([
    upsert(stored({ id: "saved" })),
    importRecords([stored({ id: "imported" })]),
    bulkUpsert([stored({ id: "bulk" })], { timestamp: "2026-09-23T00:00:00.000Z" }),
    updateMap((map) => ({ ...map, synced: stored({ id: "synced" }) })),
  ]);

  assert.deepEqual(Object.keys(data.series).sort(), ["bulk", "imported", "saved", "synced"]);
});

test("markSynced keeps a record dirty if it changed while being pushed", async () => {
  data.schemaVersion = 4;
  data.series = {
    a: stored({ id: "a", dirty: true }),
    b: stored({ id: "b", dirty: true }),
  };
  const pushed = structuredClone(Object.values(data.series));

  // "a" is saved again while the push is in flight.
  data.series.a = { ...data.series.a, chapter: "4", updatedAt: "2026-09-23T00:00:00.000Z" };
  await markSynced(pushed);

  assert.equal(data.series.a.dirty, true);
  assert.equal(data.series.b.dirty, false);
});

// --- Plan to read from a series page ---------------------------------------

test("planning a new series from its series page saves it as Plan to read", async () => {
  data.schemaVersion = 4;
  const plan = parseSeriesUrl("https://www.natomanga.com/manga/witch-and-mercenary");

  const saved = await upsert(plan);

  assert.equal(saved.status, "plan");
  assert.equal(saved.chapter, null);
  assert.equal(saved.lastReadAt, null);
  assert.equal(saved.dirty, true);
});

test("planning a series you're already reading never erases your chapter", async () => {
  data.schemaVersion = 4;
  const reading = stored({ chapter: "40", dirty: false });
  data.series = { [reading.id]: structuredClone(reading) };

  const result = await upsert(parseSeriesUrl(reading.seriesUrl));

  assert.deepEqual(data.series[reading.id], reading); // untouched, not even dirtied
  assert.equal(result.chapter, "40");
});

test("planning a removed series brings it back fresh, as Plan to read", async () => {
  data.schemaVersion = 4;
  const removed = stored({ chapter: "40", deleted: true });
  data.series = { [removed.id]: structuredClone(removed) };

  const saved = await upsert(parseSeriesUrl(removed.seriesUrl));

  assert.equal(saved.deleted, false);
  assert.equal(saved.status, "plan");
  assert.equal(saved.chapter, null);
  assert.equal(saved.chapterUrl, null);
  assert.equal(saved.createdAt, removed.createdAt);
});

test("a chapter save upgrades a planned series to reading", async () => {
  data.schemaVersion = 4;
  await upsert(parseSeriesUrl("https://www.natomanga.com/manga/witch-and-mercenary"));

  const saved = await upsert(
    parseChapterUrl("https://www.natomanga.com/manga/witch-and-mercenary/chapter-1")
  );

  assert.equal(saved.status, "reading");
  assert.equal(saved.chapter, "1");
});

// --- bulkUpsert: the shared forward-only bulk write ------------------------

const T = "2026-09-22T12:00:00.000Z";

test("bulk import adds new series and never moves an existing one back", async () => {
  data.schemaVersion = 4;
  const existing = stored({ id: "a", slug: "a", chapter: "20" });
  data.series = { a: structuredClone(existing) };

  const result = await bulkUpsert(
    [
      stored({ id: "a", slug: "a", title: "A (Official Title)", chapter: "18" }),
      stored({ id: "b", slug: "b", chapter: null, chapterUrl: null, status: "plan" }),
    ],
    { timestamp: T }
  );

  const { items, ...counts } = result;
  assert.deepEqual(counts, {
    added: 1,
    advanced: 0,
    enriched: 1,
    unchanged: 0,
    removed: 0,
    beforeReset: 0,
    olderBookmark: 0,
    skipped: 0,
    processed: 2,
    total: 2,
  });
  assert.equal(items.length, 2);
  assert.equal(data.series.a.chapter, "20");
  assert.equal(data.series.a.chapterUrl, existing.chapterUrl);
  assert.equal(data.series.a.title, "A (Official Title)");
  assert.equal(data.series.b.status, "plan");
  assert.equal(data.series.b.chapter, null);
  assert.equal(data.series.b.lastReadAt, null);
});

test("bulk import dedupes to the furthest chapter and doesn't invent a read time", async () => {
  data.schemaVersion = 4;
  data.series = {};

  const result = await bulkUpsert(
    [
      stored({ lastReadAt: null, chapter: "8", chapterUrl: "https://x.test/c8" }),
      stored({ lastReadAt: null, chapter: null, chapterUrl: null }),
      stored({ lastReadAt: null, chapter: "10", chapterUrl: "https://x.test/c10" }),
    ],
    { timestamp: T }
  );

  const rec = Object.values(data.series)[0];
  assert.equal(result.processed, 1);
  assert.equal(result.added, 1);
  assert.equal(rec.chapter, "10");
  assert.equal(rec.chapterUrl, "https://x.test/c10");
  assert.equal(rec.lastReadAt, null);
  assert.equal(rec.dirty, true);
});

test("bulk import dedupe keeps the furthest chapter and every duplicate's known details", async () => {
  data.schemaVersion = 4;
  data.series = {};

  await bulkUpsert(
    [
      stored({
        title: "Witch & Mercenary (Official)",
        chapter: "8",
        chapterUrl: "https://x.test/c8",
        coverUrl: "https://cdn.example/cover.jpg",
      }),
      stored({ title: "Witch And Mercenary", chapter: "10", chapterUrl: "https://x.test/c10", coverUrl: null }),
    ],
    { timestamp: T }
  );

  const rec = Object.values(data.series)[0];
  assert.equal(rec.chapter, "10");
  assert.equal(rec.chapterUrl, "https://x.test/c10");
  assert.equal(rec.title, "Witch & Mercenary (Official)");
  assert.equal(rec.coverUrl, "https://cdn.example/cover.jpg");
});

test("bulk import advances a series but keeps its last known read time", async () => {
  data.schemaVersion = 4;
  const existing = stored({ chapter: "20", lastReadAt: "2026-08-01T00:00:00.000Z" });
  data.series = { [existing.id]: structuredClone(existing) };

  const result = await bulkUpsert(
    [stored({ chapter: "22.5", chapterUrl: "https://x.test/c22.5", lastReadAt: null })],
    { timestamp: T }
  );

  const rec = data.series[existing.id];
  assert.equal(result.advanced, 1);
  assert.equal(rec.chapter, "22.5");
  assert.equal(rec.chapterUrl, "https://x.test/c22.5");
  assert.equal(rec.lastReadAt, "2026-08-01T00:00:00.000Z");
  assert.equal(rec.updatedAt, T);
  assert.equal(rec.dirty, true);
});

test("bulk import starts reading a planned series", async () => {
  data.schemaVersion = 4;
  const planned = stored({ chapter: null, chapterUrl: null, status: "plan", lastReadAt: null });
  data.series = { [planned.id]: structuredClone(planned) };

  const result = await bulkUpsert([stored({ chapter: "1", chapterUrl: "https://x.test/c1" })], { timestamp: T });

  assert.equal(result.advanced, 1);
  assert.equal(data.series[planned.id].status, "reading");
  assert.equal(data.series[planned.id].chapter, "1");
});

test("bulk import never advances from or to a chapter label it can't rank", async () => {
  data.schemaVersion = 4;
  data.series = {
    x: stored({ id: "x", chapter: "Extra" }),
    n: stored({ id: "n", chapter: "5" }),
  };

  await bulkUpsert(
    [stored({ id: "x", chapter: "9" }), stored({ id: "n", chapter: "Omake" })],
    { timestamp: T }
  );

  assert.equal(data.series.x.chapter, "Extra");
  assert.equal(data.series.n.chapter, "5");
});

test("bulk import leaves removed series removed unless asked to restore them", async () => {
  data.schemaVersion = 4;
  const removed = stored({ deleted: true, chapter: "3" });
  data.series = { [removed.id]: structuredClone(removed) };

  const skipped = await bulkUpsert([stored({ chapter: "5" })], { timestamp: T });
  assert.equal(skipped.removed, 1);
  assert.equal(skipped.added, 0);
  assert.equal(data.series[removed.id].deleted, true);
  assert.equal(data.series[removed.id].chapter, "3");

  const restored = await bulkUpsert([stored({ chapter: "5" })], {
    timestamp: T,
    restoreDeleted: true,
  });
  assert.equal(restored.added, 1);
  assert.equal(data.series[removed.id].deleted, false);
  assert.equal(data.series[removed.id].chapter, "5");
  assert.equal(data.series[removed.id].createdAt, removed.createdAt);
});

test("bulk import stores metadata without creating a cloud-dirty change", async () => {
  data.schemaVersion = 4;
  const existing = stored({ dirty: false });
  data.series = { [existing.id]: structuredClone(existing) };

  const result = await bulkUpsert(
    [
      stored({
        coverUrl: "https://cdn.example/cover.jpg",
        latestChapter: "10",
        latestChapterUrl: "https://x.test/c10",
      }),
    ],
    { timestamp: T }
  );

  const rec = data.series[existing.id];
  assert.equal(result.enriched, 1);
  assert.equal(rec.coverUrl, "https://cdn.example/cover.jpg");
  assert.equal(rec.latestChapter, "10");
  assert.equal(rec.dirty, false);
  assert.equal(rec.updatedAt, existing.updatedAt);
});

test("bulk import never replaces a working chapter link with a missing or unsafe one", async () => {
  data.schemaVersion = 4;
  const existing = stored({ id: "a", chapter: "40" });
  data.series = { a: structuredClone(existing) };

  for (const chapterUrl of [
    null,
    undefined,
    "",
    "javascript:alert(1)",
    "not a url",
    "ftp://natomanga.com/manga/witch-and-mercenary/chapter-41", // old domain, wrong protocol
  ]) {
    await bulkUpsert([stored({ id: "a", chapter: "41", chapterUrl })], { timestamp: T });
    assert.equal(data.series.a.chapter, "40", `chapterUrl ${String(chapterUrl)}`);
    assert.equal(data.series.a.chapterUrl, existing.chapterUrl);
  }
});

test("a new series whose chapter has no usable link arrives as Plan to read", async () => {
  data.schemaVersion = 4;
  data.series = {};

  await bulkUpsert([stored({ chapter: "12", chapterUrl: null })], { timestamp: T });

  const rec = Object.values(data.series)[0];
  assert.equal(rec.status, "plan");
  assert.equal(rec.chapter, null);
  assert.equal(rec.chapterUrl, null);
  assert.equal(rec.lastReadAt, null);
});

test("an unrankable label never starts reading a planned series", async () => {
  data.schemaVersion = 4;
  const planned = stored({ chapter: null, chapterUrl: null, status: "plan", lastReadAt: null });
  data.series = { [planned.id]: structuredClone(planned) };

  await bulkUpsert([stored({ chapter: "Extra" })], { timestamp: T });
  assert.equal(data.series[planned.id].status, "plan");
  assert.equal(data.series[planned.id].chapter, null);

  // And a later numbered import still can.
  await bulkUpsert([stored({ chapter: "10" })], { timestamp: T });
  assert.equal(data.series[planned.id].status, "reading");
  assert.equal(data.series[planned.id].chapter, "10");
});

test("a new or restored series at an unrankable label arrives as Plan to read, and can still advance", async () => {
  data.schemaVersion = 4;
  const removed = stored({ id: "r", chapter: "3", deleted: true });
  data.series = { r: structuredClone(removed) };

  await bulkUpsert(
    [stored({ id: "n", chapter: "Extra" }), stored({ id: "r", chapter: "Omake" })],
    { timestamp: T, restoreDeleted: true }
  );
  for (const id of ["n", "r"]) {
    assert.equal(data.series[id].status, "plan", id);
    assert.equal(data.series[id].chapter, null, id);
    assert.equal(data.series[id].deleted, false, id);
  }

  await bulkUpsert([stored({ id: "n", chapter: "10" })], { timestamp: T });
  assert.equal(data.series.n.status, "reading");
  assert.equal(data.series.n.chapter, "10");
});

test("bulk import dedupe prefers a numbered chapter over an unrankable label", async () => {
  data.schemaVersion = 4;
  const planned = stored({ chapter: null, chapterUrl: null, status: "plan", lastReadAt: null });
  data.series = { [planned.id]: structuredClone(planned) };

  await bulkUpsert(
    [
      stored({ chapter: "Extra", chapterUrl: "https://x.test/extra" }),
      stored({ chapter: "10", chapterUrl: "https://x.test/c10" }),
    ],
    { timestamp: T }
  );

  assert.equal(data.series[planned.id].chapter, "10");
  assert.equal(data.series[planned.id].chapterUrl, "https://x.test/c10");
});

test("bulk import reports unchanged and invalid records, and rejects non-arrays", async () => {
  data.schemaVersion = 4;
  const existing = stored();
  data.series = { [existing.id]: structuredClone(existing) };

  const result = await bulkUpsert([stored(), { id: 42 }, null], { timestamp: T });

  assert.equal(result.unchanged, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(data.series[existing.id], existing);
  await assert.rejects(bulkUpsert("nope"), /must be an array/);
});

// --- restore: Undo for Remove ------------------------------------------------

test("restore brings a removed series back with its chapter, newer than the tombstone", async () => {
  data.schemaVersion = 5;
  const original = stored({ chapter: "40", dirty: false });
  data.series = { [original.id]: structuredClone(original) };

  await remove(original.id);
  const tombstone = structuredClone(data.series[original.id]);
  assert.equal(tombstone.deleted, true);

  const restored = await restore(original.id);

  assert.equal(restored.deleted, false);
  assert.equal(restored.chapter, "40");
  assert.equal(restored.chapterUrl, original.chapterUrl);
  assert.equal(restored.dirty, true);
  assert.ok(restored.updatedAt >= tombstone.updatedAt);
  assert.equal((await getAll()).length, 1);

  // Wherever the tombstone synced, the restore wins and keeps the chapter.
  const older = { ...tombstone, updatedAt: "2026-01-01T00:00:00.000Z" };
  const merged = resolveConflict(restored, older);
  assert.equal(merged.deleted, false);
  assert.equal(merged.chapter, "40");
});

test("restore keeps a Plan-to-read series as Plan to read", async () => {
  data.schemaVersion = 5;
  const plan = stored({ chapter: null, chapterUrl: null, status: "plan", lastReadAt: null });
  data.series = { [plan.id]: structuredClone(plan) };

  await remove(plan.id);
  const restored = await restore(plan.id);

  assert.equal(restored.deleted, false);
  assert.equal(restored.chapter, null);
  assert.equal(restored.status, "plan");
});

test("restore does nothing for a series that isn't removed, or doesn't exist", async () => {
  data.schemaVersion = 5;
  const live = stored({ dirty: false });
  data.series = { [live.id]: structuredClone(live) };

  assert.equal(await restore(live.id), null);
  assert.deepEqual(data.series[live.id], live);
  assert.equal(await restore("nope"), null);
});

test("remove returns the series as it was, for Undo", async () => {
  data.schemaVersion = 5;
  const original = stored({ chapter: "40" });
  data.series = { [original.id]: structuredClone(original) };

  const previous = await remove(original.id);
  assert.deepEqual(previous, original);
  assert.equal(await remove("nope"), null);
});

test("Undo restores the removed chapter even if a sync rewrote the tombstone lower", async () => {
  data.schemaVersion = 5;
  const original = stored({ chapter: "40" });
  data.series = { [original.id]: structuredClone(original) };
  const previous = await remove(original.id);

  // A stale device's newer deletion, at chapter 10, merges into the tombstone.
  data.series[original.id] = {
    ...data.series[original.id],
    chapter: "10",
    chapterUrl: "https://www.manganami.com/manga/witch-and-mercenary/chapter-10",
    updatedAt: "2099-01-01T00:00:00.000Z",
  };

  const restored = await restore(original.id, previous);
  assert.equal(restored.deleted, false);
  assert.equal(restored.chapter, "40");
  assert.equal(restored.chapterUrl, original.chapterUrl);
});

test("Undo keeps further progress the tombstone picked up, never moving back", async () => {
  data.schemaVersion = 5;
  const original = stored({ chapter: "40" });
  data.series = { [original.id]: structuredClone(original) };
  const previous = await remove(original.id);
  data.series[original.id] = { ...data.series[original.id], chapter: "55", chapterUrl: "https://x.test/c55" };

  const restored = await restore(original.id, previous);
  assert.equal(restored.chapter, "55");
});

test("Undo's timestamp is strictly newer than the tombstone, even with clock skew", async () => {
  data.schemaVersion = 5;
  const original = stored({ chapter: "40" });
  data.series = { [original.id]: structuredClone(original) };
  const previous = await remove(original.id);
  // The tombstone carries a time from a device whose clock runs ahead.
  const future = "2099-01-01T00:00:00.000Z";
  data.series[original.id] = { ...data.series[original.id], updatedAt: future };

  const restored = await restore(original.id, previous);
  assert.ok(restored.updatedAt > future, restored.updatedAt);
  // ...so the restore wins against that tombstone in a merge.
  const merged = resolveConflict(restored, { ...data.series[original.id], deleted: true, updatedAt: future });
  assert.equal(merged.deleted, false);
  assert.equal(merged.chapter, "40");
});

test("Undo after the series was saved again at a lower chapter brings back the further one", async () => {
  data.schemaVersion = 5;
  const original = stored({ chapter: "40" });
  data.series = { [original.id]: structuredClone(original) };
  const previous = await remove(original.id);

  // A save from the popup resurrects it at chapter 10 before Undo is pressed.
  const resaved = await upsert(
    parseChapterUrl("https://www.manganami.com/manga/witch-and-mercenary/chapter-10")
  );
  assert.equal(resaved.chapter, "10");

  const restored = await restore(original.id, previous);
  assert.equal(restored.deleted, false);
  assert.equal(restored.chapter, "40");
  assert.ok(restored.updatedAt > resaved.updatedAt);
  assert.equal(restored.dirty, true);
});

test("Undo leaves a series alone if it was saved again further along", async () => {
  data.schemaVersion = 5;
  const original = stored({ chapter: "40" });
  data.series = { [original.id]: structuredClone(original) };
  const previous = await remove(original.id);
  await upsert(parseChapterUrl("https://www.manganami.com/manga/witch-and-mercenary/chapter-41"));
  const before = structuredClone(data.series[original.id]);

  const result = await restore(original.id, previous);
  assert.equal(result.chapter, "41");
  assert.deepEqual(data.series[original.id], before); // no write, nothing re-pushed
});

test("Remove after a future-stamped Undo still sorts after it", async () => {
  data.schemaVersion = 5;
  const original = stored({ chapter: "40" });
  data.series = { [original.id]: structuredClone(original) };
  const previous = await remove(original.id);
  data.series[original.id] = { ...data.series[original.id], updatedAt: "2099-01-01T00:00:00.000Z" };
  const restored = await restore(original.id, previous);

  await remove(original.id);
  const tomb = data.series[original.id];
  assert.ok(tomb.updatedAt > restored.updatedAt, `${tomb.updatedAt} vs ${restored.updatedAt}`);
  assert.equal(resolveConflict(tomb, restored).deleted, true);
});

// --- Clock skew: saves never sort before the record they replace ----------

test("a popup save is stamped after a record dated ahead of this device's clock", async () => {
  data.schemaVersion = 5;
  const ahead = stored({ chapter: "40", updatedAt: "2099-01-01T00:00:00.000Z" });
  data.series = { [ahead.id]: structuredClone(ahead) };

  const saved = await upsert(
    parseChapterUrl("https://www.manganami.com/manga/witch-and-mercenary/chapter-41")
  );
  assert.ok(saved.updatedAt > ahead.updatedAt, saved.updatedAt);

  // A first save (nothing to replace) keeps the caller's timestamp.
  data.series = {};
  const fresh = parseChapterUrl("https://www.manganami.com/manga/witch-and-mercenary/chapter-1");
  assert.equal((await upsert(fresh)).updatedAt, fresh.updatedAt);
});

for (const [resave, expected] of [["10", "40"], ["41", "41"]]) {
  test(`skewed delete, popup re-save at ${resave}, then Undo: survives the synced tombstone at ${expected}`, async () => {
    data.schemaVersion = 5;
    const original = stored({ chapter: "40", updatedAt: "2099-01-01T00:00:00.000Z" });
    data.series = { [original.id]: structuredClone(original) };

    const previous = await remove(original.id);
    const cloudTombstone = structuredClone(data.series[original.id]); // what synced
    await upsert(
      parseChapterUrl(`https://www.manganami.com/manga/witch-and-mercenary/chapter-${resave}`)
    );
    const restored = await restore(original.id, previous);

    assert.equal(restored.chapter, expected);
    const merged = resolveConflict(restored, cloudTombstone);
    assert.equal(merged.deleted, false);
    assert.equal(merged.chapter, expected);
  });
}

test("a JSON import drops optional fields that aren't strings instead of storing them", async () => {
  data.schemaVersion = 5;
  data.series = {};
  const crafted = { ...stored(), siteName: { toString: null }, lastReadAt: 5, coverUrl: ["x"], createdAt: {} };

  const result = await importRecords([crafted]);
  const rec = data.series[crafted.id];
  assert.equal(result.added, 1);
  assert.equal(rec.siteName, null);
  assert.equal(rec.coverUrl, null);
  assert.equal(typeof (rec.createdAt ?? ""), "string");
  assert.ok(rec.lastReadAt === null || typeof rec.lastReadAt === "string");
});

// --- progressResetAt and schema v7 (cloud schema v2) ------------------------

test("removing a series stamps its reset marker with the removal time", async () => {
  data.schemaVersion = 7;
  data.series = { [stored().id]: stored({ updatedAt: "2026-09-01T00:00:00.000Z" }) };
  await remove(stored().id);
  const r = data.series[stored().id];
  assert.equal(r.deleted, true);
  assert.equal(r.progressResetAt, r.updatedAt);
});

test("Undo after a removal keeps the marker, and the restored chapter beats the cloud's tombstone", async () => {
  data.schemaVersion = 7;
  const id = stored().id;
  data.series = { [id]: stored({ chapter: "40", chapterUrl: "https://x.test/40", updatedAt: "2026-09-01T00:00:00.000Z" }) };
  const previous = await remove(id);
  const tombstone = structuredClone(data.series[id]); // what the cloud now holds
  const restored = await restore(id, previous);
  assert.equal(restored.chapter, "40");
  assert.equal(restored.progressResetAt, tombstone.progressResetAt);
  // Merging with the tombstone (as a later sync would) keeps chapter 40.
  const merged = resolveConflict(restored, { ...tombstone });
  assert.equal(merged.deleted, false);
  assert.equal(merged.chapter, "40");
});

test("a confirmed move back stamps the marker; an ordinary save keeps the old one", async () => {
  data.schemaVersion = 7;
  const id = stored().id;
  data.series = { [id]: stored({ chapter: "40", progressResetAt: null, updatedAt: "2026-09-01T00:00:00.000Z" }) };

  const back = await upsert(
    { ...stored(), chapter: "3", chapterUrl: "https://x.test/3", updatedAt: "2026-10-01T00:00:00.000Z" },
    { resetProgress: true }
  );
  assert.equal(back.chapter, "3");
  assert.equal(back.progressResetAt, back.updatedAt);

  const forward = await upsert({ ...stored(), chapter: "4", chapterUrl: "https://x.test/4", updatedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(forward.progressResetAt, back.progressResetAt, "a normal save doesn't move the marker");
  assert.ok(forward.updatedAt >= forward.progressResetAt);
});

test("a Plan-to-read save never sets a reset marker", async () => {
  data.schemaVersion = 7;
  data.series = {};
  const planned = await upsert(
    { ...stored(), chapter: null, chapterUrl: null, status: "plan", updatedAt: "2026-10-01T00:00:00.000Z" },
    { resetProgress: true }
  );
  assert.equal(planned.progressResetAt, null);
});

test("imports never set a reset marker, and restoring a removed series keeps the removal's", async () => {
  data.schemaVersion = 7;
  const id = stored().id;
  data.series = { [id]: stored({ chapter: "40", updatedAt: "2026-09-01T00:00:00.000Z" }) };
  await remove(id);
  const marker = data.series[id].progressResetAt;

  await bulkUpsert(
    [{ ...stored(), chapter: "2", chapterUrl: "https://x.test/2", progressResetAt: "2030-01-01T00:00:00.000Z" }],
    { restoreDeleted: true, timestamp: "2026-01-01T00:00:00.000Z" } // a device clock far behind
  );
  const r = data.series[id];
  assert.equal(r.deleted, false);
  assert.equal(r.progressResetAt, marker, "the import's own marker is ignored");
  assert.ok(r.updatedAt > marker, "stamped after the tombstone, so its chapter counts");

  data.series.other = stored({ id: "natomanga.com:other", slug: "other" });
  await bulkUpsert([{ ...stored({ id: "natomanga.com:new", slug: "new" }), progressResetAt: "2030-01-01T00:00:00.000Z" }]);
  assert.equal(data.series["natomanga.com:new"].progressResetAt, null);
});

test("v7 migration adds the marker and restarts set cursors from the beginning", async () => {
  data.schemaVersion = 6;
  data.lastSyncCursor = "2026-09-01T00:00:00.000Z";
  data.parkedLibraries = {
    b: { owner: { id: "b" }, series: {}, cursor: "2026-08-01T00:00:00.000Z", parkedAt: "2026-10-01T00:00:00.000Z" },
    c: { owner: { id: "c" }, series: {}, cursor: null, parkedAt: "2026-10-01T00:00:00.000Z" },
  };
  const r = stored();
  delete r.progressResetAt;
  data.series = { [r.id]: r };

  await migrate();
  assert.equal(data.schemaVersion, 7);
  assert.equal(data.series[r.id].progressResetAt, null);
  assert.equal(data.series[r.id].dirty, false, "a migration is not an edit");
  assert.equal(data.lastSyncCursor, "1970-01-01T00:00:00.000Z", "still counts as synced before");
  assert.equal(data.parkedLibraries.b.cursor, "1970-01-01T00:00:00.000Z");
  assert.equal(data.parkedLibraries.c.cursor, null, "a never-synced library stays never-synced");
});

test("v7 migration leaves a device that never synced without a cursor", async () => {
  data.schemaVersion = 6;
  delete data.lastSyncCursor;
  data.series = {};
  await migrate();
  assert.equal(data.lastSyncCursor, undefined);
});

test("a JSON backup carries the reset marker, and a malformed one is dropped", async () => {
  data.schemaVersion = 7;
  data.series = {};
  await importRecords([
    stored({ progressResetAt: "2026-10-01T00:00:00.000Z" }),
    stored({ id: "natomanga.com:bad", slug: "bad", progressResetAt: 12345 }),
  ]);
  assert.equal(data.series[stored().id].progressResetAt, "2026-10-01T00:00:00.000Z");
  assert.equal(data.series["natomanga.com:bad"].progressResetAt, null);
});

test("v7 takes progressAt from lastReadAt, not from an updatedAt a merge refreshed", async () => {
  data.schemaVersion = 6;
  const r = stored({ chapter: "40", lastReadAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" });
  delete r.progressAt;
  delete r.progressResetAt;
  data.series = { [r.id]: r };
  await migrate();
  assert.equal(data.series[r.id].progressAt, "2026-09-01T00:00:00.000Z");
});

test("v7 normalizes Postgres-format timestamps, here and in parked libraries", async () => {
  data.schemaVersion = 6;
  const pg = (iso) => iso.replace("Z", "+00:00");
  const r = stored({ lastReadAt: pg("2026-09-01T00:00:00.000Z"), updatedAt: pg("2026-09-01T00:00:00.000Z"), createdAt: pg("2026-01-01T00:00:00.000Z") });
  delete r.progressAt;
  data.series = { [r.id]: r };
  data.parkedLibraries = { b: { owner: { id: "b" }, cursor: null, series: { [r.id]: structuredClone(r) } } };
  await migrate();
  for (const rec of [data.series[r.id], data.parkedLibraries.b.series[r.id]]) {
    assert.equal(rec.lastReadAt, "2026-09-01T00:00:00.000Z");
    assert.equal(rec.updatedAt, "2026-09-01T00:00:00.000Z");
    assert.equal(rec.createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(rec.progressAt, "2026-09-01T00:00:00.000Z");
    assert.equal(rec.progressResetAt, null);
  }
});

test("Merge doesn't carry the other account's reset markers into this account's progress", async () => {
  // Codex review, round 1: A restarted the series at chapter 3 in October; B
  // had read to chapter 100 in September. Merging A into B keeps B's 100.
  data.schemaVersion = 7;
  const id = stored().id;
  data.libraryOwner = { id: "a", email: "a@example.test" };
  data.series = {
    [id]: stored({ chapter: "3", chapterUrl: "https://x.test/3", progressAt: "2026-10-02T00:00:00.000Z", progressResetAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }),
  };
  data.parkedLibraries = {
    b: { owner: { id: "b" }, cursor: "2026-09-30T00:00:00.000Z", series: { [id]: stored({ chapter: "100", chapterUrl: "https://x.test/100", progressAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z" }) } },
  };
  await adoptLibrary({ id: "b", email: "b@example.test" });
  assert.equal(data.series[id].chapter, "100");
  assert.equal(data.series[id].progressResetAt, null);
});

test("a JSON backup in Postgres timestamp format is normalized", async () => {
  data.schemaVersion = 7;
  data.series = {};
  await importRecords([stored({ updatedAt: "2026-09-01T00:00:00.000+00:00", lastReadAt: "2026-09-01T00:00:00+00:00" })]);
  const r = data.series[stored().id];
  assert.equal(r.updatedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(r.lastReadAt, "2026-09-01T00:00:00.000Z");
  assert.equal(r.progressAt, "2026-09-01T00:00:00.000Z");
});

test("v7 leaves progressAt unknown when there's no read time, never using updatedAt", async () => {
  data.schemaVersion = 6;
  const r = stored({ chapter: "40", lastReadAt: null, updatedAt: "2026-10-02T00:00:00.000Z" });
  delete r.progressAt;
  data.series = { [r.id]: r };
  await migrate();
  assert.equal(data.series[r.id].progressAt, null);
});

test("a backup's unknown read time stays unknown, so a stale chapter in it can't beat a reset", async () => {
  // Codex review, round 3.
  data.schemaVersion = 7;
  const id = stored().id;
  data.series = { [id]: stored({ chapter: "3", chapterUrl: "https://x.test/3", progressAt: "2026-10-02T00:00:00.000Z", progressResetAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }) };
  const backup = stored({ chapter: "40", chapterUrl: "https://x.test/40", updatedAt: "2026-10-03T00:00:00.000Z" });
  delete backup.lastReadAt;
  delete backup.progressAt;
  await importRecords([backup]);
  assert.equal(data.series[id].chapter, "3");
});

test("an unknown set time survives export and re-import, so the stale chapter still can't beat a reset", async () => {
  // Codex review, round 4: import a legacy record (unknown times), export it,
  // then import the export into a library restarted after a reset.
  data.schemaVersion = 7;
  data.series = {};
  const id = stored().id;
  const legacy = stored({ chapter: "40", chapterUrl: "https://x.test/40", updatedAt: "2026-10-03T00:00:00.000Z" });
  delete legacy.lastReadAt;
  delete legacy.progressAt;
  await importRecords([legacy]);
  assert.equal(data.series[id].progressAt, null);
  const exported = JSON.parse(JSON.stringify(await getAll())); // what Export writes

  data.series = { [id]: stored({ chapter: "3", chapterUrl: "https://x.test/3", progressAt: "2026-10-02T00:00:00.000Z", progressResetAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }) };
  await importRecords(exported);
  assert.equal(data.series[id].chapter, "3");
});

test("upgrading straight from v0.3 (schema 2) doesn't turn the v4 read-time guess into a set time", async () => {
  // Codex review, round 5: v0.3 records have no lastReadAt. The v4 step
  // guesses it from updatedAt for display; v7 must not count that guess.
  data.schemaVersion = 2;
  data.series = {
    a: { id: "a", site: "natomanga.com", slug: "a", title: "A", chapter: "40", chapterUrl: "https://x.test/40", seriesUrl: "https://x.test/a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", deleted: false, dirty: false },
  };
  await migrate();
  assert.equal(data.series.a.lastReadAt, "2026-10-03T00:00:00.000Z", "still shown as last read");
  assert.equal(data.series.a.progressAt, null, "but its set time is unknown");
});

test("an upgrade interrupted partway leaves nothing half-done, so the retry doesn't count the read-time guess", async () => {
  // Codex review, round 6.
  data.schemaVersion = 2;
  data.series = {
    a: { id: "a", site: "natomanga.com", slug: "a", title: "A", chapter: "40", chapterUrl: "https://x.test/40", seriesUrl: "https://x.test/a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", deleted: false, dirty: false },
  };
  const realSet = chrome.storage.local.set;
  let calls = 0;
  chrome.storage.local.set = async (values) => {
    if (calls++ === 0) {
      await realSet(values); // the first write lands...
      throw new Error("extension reloaded"); // ...and the upgrade stops
    }
    return realSet(values);
  };
  await assert.rejects(migrate());
  chrome.storage.local.set = realSet;
  if (data.schemaVersion !== 7) await migrate(); // only retried if it isn't done
  assert.equal(data.schemaVersion, 7);
  assert.equal(data.series.a.progressAt, null);
});

test("an unreadable stored read time doesn't block the upgrade", async () => {
  // Codex review, round 6: older backup imports accepted any string.
  data.schemaVersion = 6;
  const r = stored({ lastReadAt: "unknown" });
  delete r.progressAt;
  data.series = { [r.id]: r };
  data.parkedLibraries = { b: { owner: { id: "b" }, cursor: null, series: { [r.id]: structuredClone(r) } } };
  await migrate();
  assert.equal(data.schemaVersion, 7);
  assert.equal(data.series[r.id].progressAt, null);
  assert.equal(data.parkedLibraries.b.series[r.id].progressAt, null);
});

test("a backup with an unreadable timestamp imports it as unknown", async () => {
  data.schemaVersion = 7;
  data.series = {};
  await importRecords([stored({ lastReadAt: "unknown", progressResetAt: "soon" })]);
  const r = data.series[stored().id];
  // Treated like a missing read time: shown as the usual estimate, never stored as "unknown".
  assert.equal(r.lastReadAt, r.updatedAt);
  assert.equal(r.progressResetAt, null);
});
