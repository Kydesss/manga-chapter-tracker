// tests/sync.test.js
// Sync passes from two extension contexts (the popup and the library page each
// import sync.js, so each has its own engine) against one shared storage and a
// mock Supabase. Node provides a real navigator.locks, shared by both engines,
// like the extension's pages share one origin.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { remove, restore, importRecords } from "../storage.js";

const ID = "natomanga.com:witch-and-mercenary";
let data; // chrome.storage.local
let cloud; // Map of id -> row
let gate; // when set, POSTs wait on it
let postStarted;

function row(over = {}) {
  return {
    user_id: "u1",
    id: ID,
    site: "natomanga.com",
    slug: "witch-and-mercenary",
    title: "Witch & Mercenary",
    chapter: "40",
    chapter_url: "https://www.manganami.com/manga/witch-and-mercenary/chapter-40",
    series_url: "https://www.manganami.com/manga/witch-and-mercenary",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    deleted: false,
    ...over,
  };
}

beforeEach(() => {
  const r = row();
  cloud = new Map([[ID, r]]);
  gate = null;
  postStarted = null;
  data = {
    schemaVersion: 5,
    lastSyncCursor: r.updated_at,
    supabase_session: { access_token: "t", user: { id: "u1", email: "u1@example.test" } },
    series: {
      [ID]: {
        id: ID,
        site: r.site,
        siteName: "NatoManga",
        slug: r.slug,
        title: r.title,
        chapter: r.chapter,
        chapterUrl: r.chapter_url,
        seriesUrl: r.series_url,
        status: "reading",
        lastReadAt: r.updated_at,
        coverUrl: null,
        latestChapter: null,
        latestChapterUrl: null,
        latestPublishedAt: null,
        metadataCheckedAt: null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deleted: false,
        dirty: false,
      },
    },
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return structuredClone({ [key]: data[key] });
          return structuredClone(data);
        },
        async set(values) {
          Object.assign(data, structuredClone(values));
        },
        async remove(key) {
          delete data[key];
        },
      },
    },
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if ((opts.method || "GET") === "GET") {
      const gt = u.searchParams.get("updated_at")?.replace(/^gt\./, "");
      const rows = [...cloud.values()]
        .filter((x) => !gt || x.updated_at > gt)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return { ok: true, status: 200, json: async () => structuredClone(rows), text: async () => "" };
    }
    const batch = JSON.parse(opts.body); // snapshot taken when the request is sent
    if (gate) {
      postStarted?.();
      await gate;
    }
    for (const r of batch) cloud.set(r.id, r);
    return { ok: true, status: 201, json: async () => null, text: async () => "" };
  };
});

// Fresh module instances: separate engines, like separate extension pages.
let n = 0;
const engine = () => import(`../sync.js?engine=${n++}`);

test("a stalled push from one context can't overwrite a newer change pushed by another", async () => {
  const library = await engine();
  const popup = await engine();

  // Remove in the library; its pass stalls while uploading the tombstone.
  const previous = await remove(ID);
  let release;
  gate = new Promise((r) => (release = r));
  const started = new Promise((r) => (postStarted = r));
  const libraryPass = library.syncNow();
  await started;

  // Undo while that upload hangs, then the popup syncs. Give the popup's pass
  // every chance to push first: without a cross-context lock it finishes now;
  // with one it waits its turn (so the race times out instead).
  await restore(ID, previous);
  gate = null;
  const popupPass = popup.syncNow();
  await Promise.race([popupPass, new Promise((r) => setTimeout(r, 100))]);

  // Only now does the stalled tombstone upload land.
  release();
  await Promise.all([libraryPass, popupPass]);

  assert.equal(cloud.get(ID).deleted, false, "the Undo must win in the cloud");
  assert.equal(cloud.get(ID).chapter, "40");
  assert.equal(data.series[ID].deleted, false);
  assert.equal(data.series[ID].dirty, false);
});

test("a sync requested mid-pass reports the follow-up pass's result, not a skip", async () => {
  const library = await engine();

  const previous = await remove(ID);
  let release;
  gate = new Promise((r) => (release = r));
  const started = new Promise((r) => (postStarted = r));
  const first = library.syncNow();
  await started;

  await restore(ID, previous);
  gate = null;
  const second = library.syncNow(); // arrives mid-pass
  release();

  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.skipped, undefined);
  assert.equal(cloud.get(ID).deleted, false);
  assert.equal(data.series[ID].dirty, false);
});

test("signed out, sync is skipped without touching the cloud", async () => {
  const library = await engine();
  delete data.supabase_session;
  assert.deepEqual(await library.syncNow(), { skipped: "signed-out" });
});

test("an import that raises the chapter during an upload still gets pushed", async () => {
  const library = await engine();
  // A local save at chapter 10 is waiting to be pushed.
  const t = "2026-10-01T00:00:00.000Z";
  data.series[ID] = {
    ...data.series[ID],
    chapter: "10",
    chapterUrl: "https://www.manganami.com/manga/witch-and-mercenary/chapter-10",
    updatedAt: t,
    dirty: true,
  };
  // The cloud still has an older chapter (already pulled; nothing new to pull).
  cloud.set(ID, row({ chapter: "5" }));

  let release;
  gate = new Promise((r) => (release = r));
  const started = new Promise((r) => (postStarted = r));
  const pass = library.syncNow();
  await started; // chapter 10 is in flight

  // An older backup with chapter 20 is imported meanwhile. The merge keeps
  // chapter 20 (further) and the newer timestamp, t: same updatedAt as in flight.
  const backup = { ...data.series[ID], chapter: "20", chapterUrl: "https://x.test/c20", updatedAt: "2026-01-01T00:00:00.000Z", dirty: undefined };
  await importRecords([backup]);
  assert.equal(data.series[ID].chapter, "20");
  assert.equal(data.series[ID].updatedAt, t);

  gate = null;
  release();
  await pass;
  assert.equal(data.series[ID].dirty, true, "chapter 20 was never pushed, so it must stay dirty");

  await library.syncNow();
  assert.equal(cloud.get(ID).chapter, "20");
  assert.equal(data.series[ID].dirty, false);
});
