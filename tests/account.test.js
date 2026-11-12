// tests/account.test.js
// Account isolation: a library syncs with one account, and signing in as a
// different one never pushes it there by accident. The mock Supabase keeps
// each account's rows apart and rejects rows for another account, like RLS.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { migrate, getOwner, remove, restore, getLibrary } from "../storage.js";
import { createFakeSeries, response } from "./fake-postgrest.js";

const A = { id: "user-a", email: "a@example.test" };
const B = { id: "user-b", email: "b@example.test" };

let data; // chrome.storage.local
let clouds; // { [userId]: Map of id -> row }
let posts; // [{ user, rows }]
let fake; // the server's behavior for those rows
let getGate; // when set, GETs wait on it
let getStarted;

function rec(id, over = {}) {
  return {
    id,
    site: "natomanga.com",
    siteName: "NatoManga",
    slug: id.split(":")[1],
    title: id,
    chapter: "10",
    chapterUrl: `https://www.manganami.com/manga/${id.split(":")[1]}/chapter-10`,
    seriesUrl: `https://www.manganami.com/manga/${id.split(":")[1]}`,
    status: "reading",
    lastReadAt: "2026-09-01T00:00:00.000Z",
    coverUrl: null,
    latestChapter: null,
    latestChapterUrl: null,
    latestPublishedAt: null,
    metadataCheckedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deleted: false,
    dirty: false,
    ...over,
  };
}

function cloudRow(user, id, over = {}) {
  const r = rec(id, over);
  return {
    user_id: user.id,
    id: r.id,
    site: r.site,
    slug: r.slug,
    title: r.title,
    chapter: r.chapter,
    chapter_url: r.chapterUrl,
    series_url: r.seriesUrl,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    deleted: r.deleted,
  };
}

const session = (user) => ({ access_token: `token-${user.id}`, user: { id: user.id, email: user.email } });
const signIn = (user) => (data.supabase_session = session(user));
const signOut = () => delete data.supabase_session;

const A_SERIES = "natomanga.com:a-series";
const B_SERIES = "natomanga.com:b-series";

beforeEach(() => {
  getGate = null;
  getStarted = null;
  posts = [];
  fake = createFakeSeries();
  clouds = {
    [A.id]: new Map([[A_SERIES, cloudRow(A, A_SERIES)]]),
    [B.id]: new Map([[B_SERIES, cloudRow(B, B_SERIES, { chapter: "3" })]]),
  };
  // A device that has synced with account A, now signed out.
  data = {
    schemaVersion: 7,
    lastSyncCursor: "2026-09-01T00:00:00.000Z",
    libraryOwner: { id: A.id, email: A.email },
    series: { [A_SERIES]: rec(A_SERIES) },
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return structuredClone({ [key]: data[key] });
          if (Array.isArray(key)) {
            return structuredClone(Object.fromEntries(key.map((k) => [k, data[k]])));
          }
          return structuredClone(data);
        },
        async set(values) {
          Object.assign(data, structuredClone(values));
        },
        async remove(key) {
          for (const k of [].concat(key)) delete data[k];
        },
      },
    },
  };
  globalThis.fetch = async (url, opts = {}) => {
    const user = opts.headers.Authorization.replace("Bearer token-", "");
    const cloud = (clouds[user] ??= new Map());
    if ((opts.method || "GET") === "GET") {
      if (getGate) {
        getStarted?.();
        await getGate;
      }
      return response(200, fake.select(cloud, url));
    }
    const body = JSON.parse(opts.body);
    if (new URL(url).pathname.endsWith("/rpc/push_series")) {
      // push_series writes as auth.uid(): the token's account, never one the
      // client names.
      posts.push({ user, rows: body.rows.map((r) => ({ ...r, user_id: user })) });
      const out = fake.pushSeries(cloud, body.rows, { userId: user });
      return out.error ? response(400, out.error) : response(200, out.accepted);
    }
    const rows = body;
    posts.push({ user, rows });
    if (rows.some((r) => r.user_id !== user)) return response(403, "RLS");
    const error = fake.upsert(cloud, rows);
    return error ? response(400, error) : response(201, null);
  };
});

let n = 0;
const engine = () => import(`../sync.js?account=${n++}`);

test("signing in as a different account pauses sync instead of pushing the library there", async () => {
  const sync = await engine();
  signIn(B);
  const res = await sync.syncNow();
  assert.equal(res.skipped, "account-mismatch");
  assert.deepEqual(res.owner, { id: A.id, email: A.email });
  assert.deepEqual(res.user, B);
  assert.equal(posts.length, 0, "nothing may be pushed to B's cloud");
  assert.equal(clouds[B.id].has(A_SERIES), false);
  assert.deepEqual(Object.keys(data.series), [A_SERIES], "the local library is untouched");
  // Throttled or not, it stays paused.
  assert.equal((await sync.syncNow({ throttle: true })).skipped, "account-mismatch");
});

test("keep separate sets A's library aside, loads B's, and brings A's back on switching back", async () => {
  const sync = await engine();
  // An unpushed change of A's.
  data.series[A_SERIES] = rec(A_SERIES, {
    chapter: "11",
    chapterUrl: "https://www.manganami.com/manga/a-series/chapter-11",
    updatedAt: "2026-09-02T00:00:00.000Z",
    dirty: true,
  });
  signIn(B);
  assert.equal((await sync.syncNow()).skipped, "account-mismatch");

  assert.deepEqual(await sync.resolveAccount("separate"), { resolved: true });
  assert.deepEqual(await getOwner(), { id: B.id, email: B.email });
  assert.deepEqual(data.series, {});
  assert.equal(data.lastSyncCursor, null, "B's first sync pulls B's whole cloud");

  const res = await sync.syncNow();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(Object.keys(data.series), [B_SERIES]);
  assert.equal(clouds[B.id].has(A_SERIES), false);

  // A signs back in on this device: A's library (and its pending change) returns.
  signIn(A);
  assert.equal((await sync.syncNow()).skipped, "account-mismatch");
  await sync.resolveAccount("separate");
  assert.deepEqual(Object.keys(data.series), [A_SERIES]);
  assert.equal(data.series[A_SERIES].dirty, true);
  assert.equal(data.lastSyncCursor, "2026-09-01T00:00:00.000Z", "A's cursor came back with it");
  assert.deepEqual(Object.keys(data.parkedLibraries), [B.id]);

  const again = await sync.syncNow();
  assert.equal(again.ok, true);
  assert.equal(again.pushed, 1, "A's pending change reaches A's cloud");
  assert.equal(clouds[B.id].has(A_SERIES), false);
});

test("merge adds the library to the new account on a full first sync, without its removals", async () => {
  const sync = await engine();
  data.series["natomanga.com:gone"] = rec("natomanga.com:gone", { deleted: true });
  clouds[B.id].set("natomanga.com:gone", cloudRow(B, "natomanga.com:gone"));
  signIn(B);
  await sync.resolveAccount("merge");
  assert.deepEqual(await getOwner(), { id: B.id, email: B.email });

  const res = await sync.syncNow();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(clouds[B.id].get(A_SERIES).user_id, B.id);
  assert.equal(clouds[B.id].get("natomanga.com:gone").deleted, false, "A's removal isn't replayed on B");
  assert.deepEqual(Object.keys(data.series).sort(), [A_SERIES, B_SERIES, "natomanga.com:gone"].sort());
});

test("resolving is a no-op once the library already matches the account", async () => {
  const sync = await engine();
  signIn(A);
  assert.deepEqual(await sync.resolveAccount("merge"), { resolved: false });
  assert.equal(data.lastSyncCursor, "2026-09-01T00:00:00.000Z");
  await assert.rejects(sync.resolveAccount("wipe"), /Unknown choice/);
});

test("an unknown owner can be merged but not set aside", async () => {
  const sync = await engine();
  data.libraryOwner = { unknown: true };
  signIn(B);
  const res = await sync.syncNow();
  assert.equal(res.skipped, "account-mismatch");
  assert.deepEqual(res.owner, { unknown: true });
  await assert.rejects(sync.resolveAccount("separate"), /unknown/);
  assert.deepEqual(Object.keys(data.series), [A_SERIES]);

  await sync.resolveAccount("merge");
  assert.equal((await sync.syncNow()).ok, true);
  assert.equal(clouds[B.id].has(A_SERIES), true);
});

test("a library with no series switches to the new account without asking", async () => {
  const sync = await engine();
  data.series = { [A_SERIES]: rec(A_SERIES, { deleted: true, dirty: true }) };
  signIn(B);
  const res = await sync.syncNow();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(clouds[B.id].get(B_SERIES).deleted, false);
  assert.equal(posts.some((p) => p.rows.some((r) => r.id === A_SERIES)), false, "A's removal isn't pushed to B");
  assert.deepEqual(Object.keys(data.series), [B_SERIES]);
  assert.equal(data.parkedLibraries[A.id].series[A_SERIES].deleted, true, "kept for A");
});

test("a library that has never synced is claimed by the first account (a merge)", async () => {
  const sync = await engine();
  delete data.libraryOwner;
  delete data.lastSyncCursor;
  signIn(B);
  const res = await sync.syncNow();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(await getOwner(), { id: B.id, email: B.email });
  assert.equal(clouds[B.id].get(A_SERIES).user_id, B.id);
  assert.deepEqual(Object.keys(data.series).sort(), [A_SERIES, B_SERIES].sort());
});

test("upgrading records the signed-in account as the owner, or unknown when signed out", async () => {
  delete data.libraryOwner;
  data.schemaVersion = 5;
  signIn(A);
  await migrate();
  assert.deepEqual(await getOwner(), { id: A.id, email: A.email });

  delete data.libraryOwner;
  data.schemaVersion = 5;
  signOut();
  await migrate();
  assert.deepEqual(await getOwner(), { unknown: true });

  // A device that never synced has no owner until its first sync.
  delete data.libraryOwner;
  delete data.lastSyncCursor;
  data.schemaVersion = 5;
  await migrate();
  assert.equal(await getOwner(), null);
});

test("an account change during a pass stops it before it pushes anything", async () => {
  const sync = await engine();
  signIn(A);
  data.series[A_SERIES] = rec(A_SERIES, { chapter: "12", dirty: true, updatedAt: "2026-10-01T00:00:00.000Z" });
  let release;
  getGate = new Promise((r) => (release = r));
  const started = new Promise((r) => (getStarted = r));
  const pass = sync.syncNow();
  await started; // pulling A's cloud

  signOut();
  signIn(B); // switched accounts mid-pass
  getGate = null;
  release();

  assert.deepEqual(await pass, { skipped: "account-changed" });
  assert.equal(posts.length, 0);
  assert.equal(data.series[A_SERIES].dirty, true, "still pending for A");
  // The next pass, for B, pauses on the mismatch.
  assert.equal((await sync.syncNow()).skipped, "account-mismatch");
});

test("an Undo held across a switch can't put A's series into B's library", async () => {
  const sync = await engine();
  clouds[B.id].set(A_SERIES, cloudRow(B, A_SERIES, { chapter: "3" }));
  const previous = await remove(A_SERIES); // A's chapter 10, Undo still on screen
  signIn(B);
  await sync.resolveAccount("separate");
  await sync.syncNow();
  assert.equal(data.series[A_SERIES].chapter, "3", "B tracks it at chapter 3");

  assert.equal(await restore(A_SERIES, previous), false);
  assert.equal(data.series[A_SERIES].chapter, "3");
  await sync.syncNow();
  assert.equal(clouds[B.id].get(A_SERIES).chapter, "3", "A's chapter 10 never reaches B");
});

test("a switch that fails partway changes nothing", async () => {
  const sync = await engine();
  signIn(B);
  const before = structuredClone(data);
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async (values) => {
    if ("parkedLibraries" in values) throw new Error("disk full");
    return set(values);
  };
  await assert.rejects(sync.resolveAccount("separate"), /disk full/);
  chrome.storage.local.set = set;
  assert.deepEqual(data, before, "A's library, owner and cursor are untouched");
});

test("merge folds in the account's own parked library, so its unsynced changes aren't stranded", async () => {
  const sync = await engine();
  data.parkedLibraries = {
    [B.id]: {
      owner: B,
      series: { [B_SERIES]: rec(B_SERIES, { chapter: "50", dirty: true, updatedAt: "2026-10-01T00:00:00.000Z" }) },
      cursor: "2026-09-01T00:00:00.000Z",
      parkedAt: "2026-10-01T00:00:00.000Z",
    },
  };
  signIn(B);
  await sync.resolveAccount("merge");
  assert.equal(data.parkedLibraries[B.id], undefined);
  assert.deepEqual(Object.keys(data.series).sort(), [A_SERIES, B_SERIES].sort());

  assert.equal((await sync.syncNow()).ok, true);
  assert.equal(clouds[B.id].get(B_SERIES).chapter, "50");
  assert.equal(clouds[B.id].get(A_SERIES).user_id, B.id);
});

test("a choice made for one account isn't applied after another account signs in", async () => {
  const sync = await engine();
  const C = { id: "user-c", email: "c@example.test" };
  signIn(B);
  const res = await sync.syncNow();
  const asked = { userId: res.user.id, epoch: res.epoch };

  signIn(C); // another window, before the Merge got its turn
  assert.deepEqual(await sync.resolveAccount("merge", asked), { resolved: false, stale: true });
  assert.deepEqual(await getOwner(), { id: A.id, email: A.email });
  assert.equal((await sync.syncNow()).skipped, "account-mismatch");
  assert.equal(clouds[C.id]?.size ?? 0, 0, "nothing reaches C");
});

test("a choice about a library that has since been switched out is refused", async () => {
  const sync = await engine();
  signIn(B);
  const res = await sync.syncNow();
  const asked = { userId: res.user.id, epoch: res.epoch };
  await sync.resolveAccount("separate", asked); // e.g. chosen in another window
  await sync.syncNow(); // B's library now active, with B's series

  // B's library is B's, so a late Merge of the old prompt finds no mismatch.
  assert.deepEqual(await sync.resolveAccount("merge", asked), { resolved: false });
  // And a mismatch about a different library refuses an outdated epoch.
  signIn(A);
  assert.deepEqual(await sync.resolveAccount("merge", asked), { resolved: false, stale: true });
  assert.equal(clouds[A.id].has(B_SERIES), false);
});

test("a row still on screen from before a switch can't remove the new library's series", async () => {
  const sync = await engine();
  clouds[B.id].set(A_SERIES, cloudRow(B, A_SERIES, { chapter: "3" }));
  const { epoch: shown } = await getLibrary(); // the page is showing A's library
  signIn(B);
  await sync.resolveAccount("separate");
  await sync.syncNow();

  assert.equal(await remove(A_SERIES, { epoch: shown }), false);
  assert.equal(data.series[A_SERIES].deleted, false, "B's copy is untouched");
  await sync.syncNow();
  assert.equal(clouds[B.id].get(A_SERIES).deleted, false);
});
