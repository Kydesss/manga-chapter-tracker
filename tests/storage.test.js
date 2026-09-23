import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { migrate, upsert } from "../storage.js";

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
