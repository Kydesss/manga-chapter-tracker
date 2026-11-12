// tests/sync.test.js
// Sync passes from two extension contexts (the popup and the library page each
// import sync.js, so each has its own engine) against one shared storage and a
// mock Supabase. Node provides a real navigator.locks, shared by both engines,
// like the extension's pages share one origin.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { remove, restore, importRecords } from "../storage.js";
import { createFakeSeries, response } from "./fake-postgrest.js";

const ID = "natomanga.com:witch-and-mercenary";
let data; // chrome.storage.local
let cloud; // Map of id -> row
let fake; // the server's behavior for those rows
let gate; // when set, POSTs wait on it
let onGet; // when set, called after each GET is answered (with its 1-based count)
let gets;
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
  fake = createFakeSeries();
  onGet = null;
  gets = 0;
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
      const rows = fake.select(cloud, u.href); // the snapshot this request sees
      await onGet?.(++gets);
      return response(200, rows);
    }
    const batch = JSON.parse(opts.body); // snapshot taken when the request is sent
    if (gate) {
      postStarted?.();
      await gate;
    }
    const error = fake.upsert(cloud, batch);
    return error ? response(400, error) : response(201, null);
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

// --- Cloud schema v2 --------------------------------------------------------

const PLAN_ID = "mangaread.org:solo-farming";

test("Plan-to-read records sync, with the schema marker and the new columns", async () => {
  const library = await engine();
  data.series[PLAN_ID] = {
    ...data.series[ID],
    id: PLAN_ID,
    site: "mangaread.org",
    siteName: "MangaRead",
    slug: "solo-farming",
    title: "Solo Farming",
    seriesUrl: "https://www.mangaread.org/manga/solo-farming",
    chapter: null,
    chapterUrl: null,
    status: "plan",
    lastReadAt: null,
    updatedAt: "2026-10-05T00:00:00.000Z",
    dirty: true,
  };
  const res = await library.syncNow();
  assert.equal(res.ok, true, JSON.stringify(res));
  const pushed = cloud.get(PLAN_ID);
  assert.equal(pushed.chapter, null);
  assert.equal(pushed.chapter_url, null);
  assert.equal(pushed.client_schema, 2);
  assert.equal(data.series[PLAN_ID].dirty, false);
});

test("a record with a chapter but no link stays local instead of failing the batch", async () => {
  const library = await engine();
  data.series[ID] = { ...data.series[ID], chapter: "41", chapterUrl: null, updatedAt: "2026-10-05T00:00:00.000Z", dirty: true };
  data.series[PLAN_ID] = {
    ...data.series[ID], id: PLAN_ID, slug: "solo-farming", chapter: null, chapterUrl: null, status: "plan", dirty: true,
  };
  const res = await library.syncNow();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(cloud.has(PLAN_ID), "the rest of the batch went up");
  assert.equal(data.series[ID].dirty, true);
});

test("a stale device adopts a restart instead of reviving the old chapter", async () => {
  const library = await engine();
  // Another device removed the series and restarted it at chapter 3.
  cloud.set(ID, row({
    chapter: "3",
    chapter_url: "https://www.manganami.com/manga/witch-and-mercenary/chapter-3",
    progress_reset_at: "2026-10-01T00:00:00.000Z",
    last_read_at: "2026-10-02T00:00:00.000Z",
    updated_at: "2026-10-02T00:00:00.000Z",
    client_schema: 2,
    synced_at: undefined,
  }));
  // This device still holds chapter 40 from September (beforeEach).
  const res = await library.syncNow();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(data.series[ID].chapter, "3");
  assert.equal(data.series[ID].progressResetAt, "2026-10-01T00:00:00.000Z");
  assert.equal(cloud.get(ID).chapter, "3", "chapter 40 never reaches the cloud");
});

test("a row stamped far in the future doesn't hide later changes from other devices", async () => {
  const library = await engine();
  await library.syncNow();
  // A device with a fast clock writes a row dated 2030.
  assert.equal(fake.upsert(cloud, [{ ...row({ id: "natomanga.com:fast", slug: "fast", updated_at: "2030-01-01T00:00:00.000Z" }), client_schema: 2 }]), null);
  await library.syncNow();
  // Then another device, with a correct clock, saves a further chapter.
  assert.equal(fake.upsert(cloud, [{ ...cloud.get(ID), chapter: "41", chapter_url: "https://www.manganami.com/manga/witch-and-mercenary/chapter-41", updated_at: "2026-10-10T00:00:00.000Z", client_schema: 2 }]), null);
  await library.syncNow();
  assert.equal(data.series[ID].chapter, "41");
});

test("a pass with nothing new pushes nothing, even though it re-reads recent rows", async () => {
  const library = await engine();
  const first = await library.syncNow();
  assert.equal(first.ok, true, JSON.stringify(first));
  for (let i = 0; i < 3; i++) {
    const again = await library.syncNow();
    assert.equal(again.ok, true);
    assert.equal(again.pushed, 0, `pass ${i + 2} re-uploaded rows it had just pulled`);
  }
});

test("pulls page by (synced_at, id) and don't skip rows that share a timestamp", async () => {
  const library = await engine();
  await library.syncNow();
  const at = fake.stamp();
  for (let i = 0; i < 2500; i++) {
    const id = `natomanga.com:s${String(i).padStart(4, "0")}`;
    cloud.set(id, { ...row({ id, slug: `s${i}` }), client_schema: 2, synced_at: i < 1500 ? at : fake.stamp() });
  }
  const res = await library.syncNow();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(Object.keys(data.series).length, 2501);
});

test("an upgraded device pulls everything once, then follows the server's change order", async () => {
  const library = await engine();
  assert.equal(data.lastSyncCursor, "2026-09-01T00:00:00.000Z"); // a v5-era cursor
  await library.syncNow();
  assert.match(data.lastSyncCursor, /\+00:00$/, "the cursor is now a server synced_at");
  assert.equal(data.series[ID].dirty, false);
});

test("a slow pull doesn't let a later write move the cursor past a row that commits late", async () => {
  // Codex review, round 1. 1,500 rows written within a few seconds.
  const library = await engine();
  await library.syncNow();
  const t0 = Date.parse("2026-11-20T10:00:00.000Z");
  const at = (ms) => new Date(t0 + ms).toISOString().replace("Z", "+00:00");
  for (let i = 0; i < 1500; i++) {
    const id = `natomanga.com:s${String(i).padStart(4, "0")}`;
    cloud.set(id, { ...row({ id, slug: `s${i}` }), client_schema: 2, synced_at: at(i * 10) });
  }
  // After the first page is read: a short transaction stamped behind the page
  // key (row A) commits, and minutes later another device writes row B.
  const A = "natomanga.com:late";
  onGet = (n) => {
    if (n !== 2) return; // 1 = the watermark read, 2 = the first page
    assert.equal(fake.upsert(cloud, [{ ...row({ id: A, slug: "late" }), client_schema: 2 }], { at: at(9005) }), null);
    assert.equal(fake.upsert(cloud, [{ ...row({ id: "natomanga.com:b", slug: "b" }), client_schema: 2 }], { at: at(15000 + 5 * 60 * 1000) }), null);
  };
  await library.syncNow();
  onGet = null;
  await library.syncNow();
  assert.ok(data.series[A], "the late row was pulled on the next pass");
  assert.ok(data.series["natomanga.com:b"]);
});

test("a record with an unknown read time doesn't re-upload on every pass", async () => {
  // Codex review, round 1: imports leave lastReadAt null on purpose.
  const library = await engine();
  data.series[ID] = { ...data.series[ID], chapter: "41", chapterUrl: "https://www.manganami.com/manga/witch-and-mercenary/chapter-41", lastReadAt: null, progressAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", dirty: true };
  assert.equal((await library.syncNow()).pushed, 1);
  for (let i = 0; i < 3; i++) { const r = await library.syncNow(); assert.equal(r.pushed, 0, JSON.stringify(r)); }
  assert.equal(data.series[ID].lastReadAt, null);
});

test("read times an older version stored in Postgres format don't re-upload forever", async () => {
  // Codex review, round 1: master's fromRow kept "+00:00" in local records.
  const library = await engine();
  const pg = (iso) => iso.replace("Z", "+00:00");
  data.series[ID] = { ...data.series[ID], lastReadAt: pg(data.series[ID].lastReadAt), updatedAt: pg(data.series[ID].updatedAt) };
  await library.syncNow();
  for (let i = 0; i < 3; i++) { const r = await library.syncNow(); assert.equal(r.pushed, 0, JSON.stringify(r)); }
});

test("two devices at the same chapter with different read times settle instead of ping-ponging", async () => {
  // Codex review, round 2. This device read chapter 40 in September; another
  // device saved chapter 40 again in October.
  const library = await engine();
  await library.syncNow();
  assert.equal(fake.upsert(cloud, [{
    ...cloud.get(ID),
    last_read_at: "2026-10-01T00:00:00.000Z",
    progress_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    client_schema: 2,
  }]), null);
  const res = await library.syncNow();
  assert.equal(res.pushed, 0, "the cloud already has the newer read time");
  assert.equal(data.series[ID].lastReadAt, "2026-10-01T00:00:00.000Z");
  for (let i = 0; i < 3; i++) assert.equal((await library.syncNow()).pushed, 0);
});

test("an unreadable stored read time doesn't block uploads after the upgrade", async () => {
  // Codex review, round 7: older backup imports accepted any string.
  const library = await engine();
  cloud.clear(); // an empty cloud: everything goes up
  data.series[ID] = { ...data.series[ID], lastReadAt: "unknown", dirty: true };
  const res = await library.syncNow();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(cloud.get(ID).last_read_at, null);
  assert.equal(data.series[ID].dirty, false);
});

test("a bulk import with an unreadable read time settles after one upload", async () => {
  // Codex review, round 8.
  const { bulkUpsert } = await import("../storage.js");
  const library = await engine();
  await library.syncNow();
  await bulkUpsert([{ ...data.series[ID], id: PLAN_ID, slug: "solo-farming", chapter: "40", chapterUrl: "https://x.test/40", lastReadAt: "unknown", progressAt: undefined, progressResetAt: undefined }]);
  assert.equal(data.series[PLAN_ID].lastReadAt, null);
  assert.equal((await library.syncNow()).pushed, 1);
  for (let i = 0; i < 3; i++) assert.equal((await library.syncNow()).pushed, 0);
});
