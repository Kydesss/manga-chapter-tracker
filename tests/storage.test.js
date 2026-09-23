import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { bulkUpsert, migrate, upsert } from "../storage.js";

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

test("schema v3 migration preserves legacy data and adds metadata defaults", async () => {
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
  assert.equal(data.schemaVersion, 3);
  for (const [key, value] of Object.entries(legacy)) {
    assert.deepEqual(migrated[key], value, `${key} should be preserved`);
  }
  assert.equal(migrated.status, "reading");
  assert.equal(migrated.lastReadAt, null);
  assert.equal(migrated.coverUrl, null);
  assert.equal(migrated.latestChapter, null);
  assert.equal(migrated.latestChapterUrl, null);
  assert.equal(migrated.latestPublishedAt, null);
  assert.equal(migrated.metadataCheckedAt, null);
});

test("schema v3 migration is idempotent", async () => {
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
  assert.equal(
    data.series["natomanga.com:advance-me"].lastReadAt,
    "2026-09-22T12:00:00.000Z"
  );
});
