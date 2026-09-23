import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  bulkUpsert,
  getAll,
  importRecords,
  markSynced,
  migrate,
  updateMap,
  upsert,
} from "../storage.js";
import { parseChapterUrl } from "../parser.js";

let data;

beforeEach(() => {
  data = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: data[key] };
          return { ...data };
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
  assert.equal(data.schemaVersion, 4);
  for (const [key, value] of Object.entries(legacy)) {
    assert.deepEqual(migrated[key], value, `${key} should be preserved`);
  }
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

test("bulk import adds unread records and never moves progress backward", async () => {
  data.schemaVersion = 3;
  data.series = {
    "natomanga.com:existing": {
      id: "natomanga.com:existing",
      site: "natomanga.com",
      siteName: "NatoManga",
      slug: "existing",
      title: "Existing",
      seriesUrl: "https://www.natomanga.com/manga/existing",
      status: "reading",
      chapter: "20",
      chapterUrl: "https://www.natomanga.com/manga/existing/chapter-20",
      lastReadAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      deleted: false,
      dirty: false,
    },
  };

  const result = await bulkUpsert(
    [
      {
        id: "natomanga.com:existing",
        site: "natomanga.com",
        siteName: "NatoManga",
        slug: "existing",
        title: "Existing (Official Title)",
        seriesUrl: "https://www.natomanga.com/manga/existing",
        status: "reading",
        chapter: "18",
        chapterUrl: "https://www.natomanga.com/manga/existing/chapter-18",
      },
      {
        id: "natomanga.com:unread",
        site: "natomanga.com",
        siteName: "NatoManga",
        slug: "unread",
        title: "Unread",
        seriesUrl: "https://www.natomanga.com/manga/unread",
        status: "plan",
        chapter: null,
        chapterUrl: null,
      },
    ],
    { timestamp: "2026-09-22T12:00:00.000Z" }
  );

  assert.deepEqual(result, {
    added: 1,
    advanced: 0,
    enriched: 1,
    unchanged: 0,
    skipped: 0,
    processed: 2,
    total: 2,
  });
  assert.equal(data.series["natomanga.com:existing"].chapter, "20");
  assert.match(data.series["natomanga.com:existing"].chapterUrl, /chapter-20$/);
  assert.equal(data.series["natomanga.com:existing"].title, "Existing (Official Title)");
  assert.equal(data.series["natomanga.com:unread"].status, "plan");
  assert.equal(data.series["natomanga.com:unread"].chapter, null);
});

test("bulk import deduplicates and keeps the furthest imported chapter", async () => {
  data.schemaVersion = 3;
  data.series = {};
  const base = {
    id: "natomanga.com:duplicate",
    site: "natomanga.com",
    siteName: "NatoManga",
    slug: "duplicate",
    title: "Duplicate",
    seriesUrl: "https://www.natomanga.com/manga/duplicate",
    status: "reading",
  };

  const result = await bulkUpsert(
    [
      { ...base, chapter: "8", chapterUrl: `${base.seriesUrl}/chapter-8` },
      { ...base, chapter: "10", chapterUrl: `${base.seriesUrl}/chapter-10` },
    ],
    { timestamp: "2026-09-22T12:00:00.000Z" }
  );

  assert.equal(result.processed, 1);
  assert.equal(result.added, 1);
  assert.equal(data.series[base.id].chapter, "10");
  assert.equal(data.series[base.id].lastReadAt, null); // read time unknown
});

test("bulk import advances an existing series to the latest viewed chapter", async () => {
  data.schemaVersion = 3;
  data.series = {
    "natomanga.com:advance-me": {
      id: "natomanga.com:advance-me",
      site: "natomanga.com",
      siteName: "NatoManga",
      slug: "advance-me",
      title: "Advance Me",
      seriesUrl: "https://www.natomanga.com/manga/advance-me",
      status: "reading",
      chapter: "20",
      chapterUrl: "https://www.natomanga.com/manga/advance-me/chapter-20",
      lastReadAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      deleted: false,
      dirty: false,
    },
  };

  const result = await bulkUpsert(
    [
      {
        id: "natomanga.com:advance-me",
        site: "natomanga.com",
        siteName: "NatoManga",
        slug: "advance-me",
        title: "Advance Me",
        seriesUrl: "https://www.natomanga.com/manga/advance-me",
        status: "reading",
        chapter: "22.5",
        chapterUrl: "https://www.natomanga.com/manga/advance-me/chapter-22-5",
      },
    ],
    { timestamp: "2026-09-22T12:00:00.000Z" }
  );

  assert.equal(result.advanced, 1);
  assert.equal(data.series["natomanga.com:advance-me"].chapter, "22.5");
  assert.match(data.series["natomanga.com:advance-me"].chapterUrl, /chapter-22-5$/);
  // The site didn't say when 22.5 was read, so the last known read time stays
  // rather than the import time making the series look freshly read.
  assert.equal(
    data.series["natomanga.com:advance-me"].lastReadAt,
    "2026-08-01T00:00:00.000Z"
  );
});

// A complete schema v4 record; `over` replaces any field.
function stored(over = {}) {
  return {
    id: "natomanga.com:witch-and-mercenary",
    site: "natomanga.com",
    siteName: "NatoManga",
    slug: "witch-and-mercenary",
    title: "Witch & Mercenary",
    seriesUrl: "https://www.natomanga.com/manga/witch-and-mercenary",
    status: "reading",
    chapter: "3",
    chapterUrl: "https://www.natomanga.com/manga/witch-and-mercenary/chapter-3",
    lastReadAt: "2026-09-01T00:00:00.000Z",
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
  const existing = stored({ chapter: "30", chapterUrl: "u30", updatedAt: "2026-09-10T00:00:00.000Z" });
  data.series = { [existing.id]: existing };

  // A newer plan-to-read entry and a newer lower chapter both lose.
  await importRecords([
    stored({ chapter: null, chapterUrl: null, status: "plan", updatedAt: "2026-09-20T00:00:00.000Z" }),
  ]);
  assert.equal(data.series[existing.id].chapter, "30");
  await importRecords([
    stored({ chapter: "25", chapterUrl: "u25", updatedAt: "2026-09-21T00:00:00.000Z" }),
  ]);
  assert.equal(data.series[existing.id].chapter, "30");

  // An older backup that is further along wins: furthest chapter, as in sync.
  const result = await importRecords([
    stored({ chapter: "35", chapterUrl: "u35", updatedAt: "2026-08-01T00:00:00.000Z" }),
  ]);
  assert.equal(result.updated, 1);
  assert.equal(data.series[existing.id].chapter, "35");
  assert.equal(data.series[existing.id].chapterUrl, "u35");
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
  assert.equal(data.schemaVersion, 4);
  assert.equal(data.series.a.lastReadAt, "2026-07-01T00:00:00.000Z");
  assert.equal(data.series.b.lastReadAt, "2026-09-22T12:00:00.000Z");
  assert.equal(data.series.c.lastReadAt, null);
});

test("an up-to-date schema leaves an import's unknown read time alone", async () => {
  data.schemaVersion = 4;
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
    bulkUpsert([stored({ id: "imported" })], { timestamp: "2026-09-23T00:00:00.000Z" }),
    updateMap((map) => ({ ...map, synced: stored({ id: "synced" }) })),
  ]);

  assert.deepEqual(Object.keys(data.series).sort(), ["imported", "saved", "synced"]);
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
