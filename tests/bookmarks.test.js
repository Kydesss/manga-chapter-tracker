// tests/bookmarks.test.js
// Bookmark import: the tree walk (bookmarks.js) and what the import does to a
// library (storage.js planBulkUpsert / previewBulkUpsert / bulkUpsert).

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { collectBookmarks } from "../bookmarks.js";
import { planBulkUpsert, previewBulkUpsert, bulkUpsert } from "../storage.js";
import { resolveConflict } from "../merge.js";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const T = (iso) => Date.parse(iso);

function folder(title, children) {
  return { id: title, title, children };
}
function mark(url, over = {}) {
  return { id: url, title: "x", url, dateAdded: T("2026-10-01T00:00:00.000Z"), ...over };
}
const chapterUrl = (slug, n) => `https://www.manganami.com/manga/${slug}/chapter-${n}`;
const seriesUrl = (slug) => `https://www.mangaread.org/manga/${slug}/`;

// --- The tree walk -----------------------------------------------------------

test("walks nested folders and keeps only supported chapter and series pages", () => {
  const tree = [
    folder("root", [
      folder("Bookmarks bar", [
        mark(chapterUrl("solo-leveling", 12)),
        folder("Manga", [
          mark(seriesUrl("omniscient-reader")),
          folder("Deep", [mark(chapterUrl("solo-leveling", 40))]),
          { id: "sep", title: "", type: "separator" },
        ]),
        mark("https://example.com/manga/foo/chapter-3"),
        mark("https://www.manganami.com/genre/action"),
      ]),
      folder("Other bookmarks", []),
    ]),
  ];
  const { records, scanned, unsupported } = collectBookmarks(tree, { now: NOW });
  assert.equal(scanned, 5);
  assert.equal(unsupported, 2);
  assert.deepEqual(records.map((r) => `${r.id}@${r.chapter}`).sort(), [
    "mangaread.org:omniscient-reader@null",
    "natomanga.com:solo-leveling@12",
    "natomanga.com:solo-leveling@40",
  ]);
});

test("a chapter bookmark's read and set times come from the bookmark, not the import", () => {
  const { records } = collectBookmarks(
    [mark(chapterUrl("a", 5), { dateAdded: T("2026-03-01T00:00:00.000Z"), dateLastUsed: T("2026-06-01T00:00:00.000Z") })],
    { now: NOW }
  );
  assert.equal(records[0].lastReadAt, "2026-06-01T00:00:00.000Z", "the later of added and last opened");
  assert.equal(records[0].progressAt, "2026-06-01T00:00:00.000Z");
});

test("bookmark dates in the future are capped at now; a bookmark with no dates has unknown times", () => {
  const { records } = collectBookmarks(
    [mark(chapterUrl("a", 5), { dateAdded: T("2030-01-01T00:00:00.000Z") }), mark(chapterUrl("b", 5), { dateAdded: undefined })],
    { now: NOW }
  );
  const byId = Object.fromEntries(records.map((r) => [r.slug, r]));
  assert.equal(byId.a.progressAt, new Date(NOW).toISOString());
  assert.equal(byId.b.progressAt, null);
  assert.equal(byId.b.lastReadAt, null);
});

test("a series bookmark is Plan to read with no reading time", () => {
  const { records } = collectBookmarks([mark(seriesUrl("x"), { dateLastUsed: NOW })], { now: NOW });
  assert.equal(records[0].chapter, null);
  assert.equal(records[0].status, "plan");
  assert.equal(records[0].lastReadAt, null);
  assert.equal(records[0].progressAt, null);
});

test("old natomanga.com bookmarks are read as manganami.com", () => {
  const { records } = collectBookmarks([mark("https://natomanga.com/manga/abc/chapter-7")], { now: NOW });
  assert.equal(records[0].id, "natomanga.com:abc");
  assert.equal(records[0].chapterUrl, "https://www.manganami.com/manga/abc/chapter-7");
});

test("an empty or odd tree yields nothing", () => {
  assert.deepEqual(collectBookmarks([], { now: NOW }), { records: [], scanned: 0, unsupported: 0 });
  assert.deepEqual(collectBookmarks(null, { now: NOW }), { records: [], scanned: 0, unsupported: 0 });
  assert.deepEqual(collectBookmarks([null, 5, { children: "no" }], { now: NOW }), { records: [], scanned: 0, unsupported: 0 });
});

// --- What the import does -----------------------------------------------------

function saved(slug, over = {}) {
  return {
    id: `natomanga.com:${slug}`,
    site: "natomanga.com",
    siteName: "NatoManga",
    slug,
    title: slug,
    seriesUrl: `https://www.manganami.com/manga/${slug}`,
    status: "reading",
    chapter: "10",
    chapterUrl: chapterUrl(slug, 10),
    lastReadAt: "2026-09-01T00:00:00.000Z",
    progressAt: "2026-09-01T00:00:00.000Z",
    progressResetAt: null,
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
const imported = (slug, n, at = "2026-10-01T00:00:00.000Z") =>
  collectBookmarks([mark(chapterUrl(slug, n), { dateAdded: T(at) })], { now: NOW }).records[0];
const TIMESTAMP = "2026-11-12T12:00:00.000Z";
const outcomeOf = (plan, slug) => plan.items.find((i) => i.id === `natomanga.com:${slug}`)?.outcome;

test("each outcome in the preview table", () => {
  const map = {
    "natomanga.com:behind": saved("behind", { chapter: "50", chapterUrl: chapterUrl("behind", 50) }),
    "natomanga.com:same": saved("same"),
    "natomanga.com:forward": saved("forward"),
    "natomanga.com:gone": saved("gone", { deleted: true }),
    "natomanga.com:reset": saved("reset", { chapter: "3", chapterUrl: chapterUrl("reset", 3), progressAt: "2026-10-15T00:00:00.000Z", progressResetAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" }),
  };
  const records = [
    imported("new", 4),
    collectBookmarks([mark("https://www.manganami.com/manga/planned")], { now: NOW }).records[0],
    imported("behind", 20),
    imported("same", 10),
    imported("forward", 12),
    imported("gone", 99),
    imported("reset", 40, "2026-10-01T00:00:00.000Z"),
  ];
  const plan = planBulkUpsert(map, records, { timestamp: TIMESTAMP });
  assert.equal(outcomeOf(plan, "new"), "added-reading");
  assert.equal(outcomeOf(plan, "planned"), "added-plan");
  assert.equal(outcomeOf(plan, "behind"), "unchanged");
  assert.equal(outcomeOf(plan, "same"), "unchanged");
  assert.equal(outcomeOf(plan, "forward"), "advanced");
  assert.equal(outcomeOf(plan, "gone"), "removed");
  assert.equal(outcomeOf(plan, "reset"), "before-reset");
  const fwd = plan.items.find((i) => i.outcome === "advanced");
  assert.equal(fwd.from, "10");
  assert.equal(fwd.chapter, "12");
  assert.equal(plan.next["natomanga.com:reset"].chapter, "3", "a pre-reset bookmark doesn't undo the move back");
  assert.equal(plan.next["natomanga.com:gone"].deleted, true);
  assert.equal(map["natomanga.com:forward"].chapter, "10", "planning doesn't touch the map it was given");
});

test("a bookmark from after the move back does advance the series", () => {
  const map = {
    "natomanga.com:reset": saved("reset", { chapter: "3", chapterUrl: chapterUrl("reset", 3), progressAt: "2026-10-15T00:00:00.000Z", progressResetAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" }),
  };
  const plan = planBulkUpsert(map, [imported("reset", 5, "2026-10-20T00:00:00.000Z")], { timestamp: TIMESTAMP });
  assert.equal(outcomeOf(plan, "reset"), "advanced");
  assert.equal(plan.next["natomanga.com:reset"].chapter, "5");
  // The advance carries the bookmark's time, not the import's: against a move
  // back made elsewhere after the bookmark, it must lose.
  assert.equal(plan.next["natomanga.com:reset"].progressAt, "2026-10-20T00:00:00.000Z");
  const movedBackLater = saved("reset", { chapter: "2", chapterUrl: chapterUrl("reset", 2), progressAt: "2026-11-01T00:00:00.000Z", progressResetAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
  assert.equal(resolveConflict(plan.next["natomanga.com:reset"], movedBackLater).chapter, "2");
});

test("an imported chapter keeps the bookmark's times, so it merges correctly against a reset elsewhere", () => {
  const plan = planBulkUpsert({}, [imported("a", 40, "2026-09-01T00:00:00.000Z")], { timestamp: TIMESTAMP });
  const rec = plan.next["natomanga.com:a"];
  assert.equal(rec.progressAt, "2026-09-01T00:00:00.000Z");
  assert.equal(rec.lastReadAt, "2026-09-01T00:00:00.000Z");
  assert.equal(rec.updatedAt, TIMESTAMP);
  // Another device moved this series back to chapter 3 in October.
  const movedBack = saved("a", { chapter: "3", chapterUrl: chapterUrl("a", 3), progressAt: "2026-10-15T00:00:00.000Z", progressResetAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" });
  assert.equal(resolveConflict(rec, movedBack).chapter, "3");
});

test("a bookmark with no dates uses the import time, as before", () => {
  const rec = collectBookmarks([mark(chapterUrl("a", 4), { dateAdded: undefined })], { now: NOW }).records[0];
  const plan = planBulkUpsert({}, [rec], { timestamp: TIMESTAMP });
  assert.equal(plan.next["natomanga.com:a"].progressAt, TIMESTAMP);
  assert.equal(plan.next["natomanga.com:a"].lastReadAt, null, "an import isn't a read");
});

test("many bookmarks for one series collapse to the furthest, with that bookmark's times", () => {
  const records = [imported("a", 3, "2026-02-01T00:00:00.000Z"), imported("a", 30, "2026-05-01T00:00:00.000Z"), imported("a", 12, "2026-08-01T00:00:00.000Z")];
  const plan = planBulkUpsert({}, records, { timestamp: TIMESTAMP });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.next["natomanga.com:a"].chapter, "30");
  assert.equal(plan.next["natomanga.com:a"].progressAt, "2026-05-01T00:00:00.000Z");
});

// --- Preview and write against chrome.storage --------------------------------

let data;
beforeEach(() => {
  data = { schemaVersion: 7, series: { "natomanga.com:forward": saved("forward") }, libraryEpoch: "e1" };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return structuredClone({ [key]: data[key] });
          if (Array.isArray(key)) return structuredClone(Object.fromEntries(key.map((k) => [k, data[k]])));
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
});

test("the preview writes nothing, and the import does what the preview said", async () => {
  const records = [imported("forward", 12), imported("new", 4)];
  const before = structuredClone(data);
  const preview = await previewBulkUpsert(records, { timestamp: TIMESTAMP });
  assert.deepEqual(data, before, "previewing changed storage");
  assert.equal(preview.epoch, "e1");
  const result = await bulkUpsert(records, { timestamp: TIMESTAMP, epoch: preview.epoch });
  assert.deepEqual(result.items, preview.items);
  assert.equal(data.series["natomanga.com:forward"].chapter, "12");
  assert.equal(data.series["natomanga.com:new"].chapter, "4");
  assert.equal(data.series["natomanga.com:new"].dirty, true, "queued for sync");
});

test("an import planned against a library that was switched since writes nothing", async () => {
  const records = [imported("forward", 12)];
  const preview = await previewBulkUpsert(records);
  data.libraryEpoch = "e2"; // another account's library took over
  const before = structuredClone(data);
  assert.deepEqual(await bulkUpsert(records, { epoch: preview.epoch }), { stale: true });
  assert.deepEqual(data, before);
});

test("importing twice changes nothing the second time", async () => {
  const records = [imported("forward", 12), imported("new", 4)];
  await bulkUpsert(records, { timestamp: TIMESTAMP });
  const after = structuredClone(data);
  const again = await bulkUpsert(records, { timestamp: "2026-11-13T00:00:00.000Z" });
  assert.equal(again.added + again.advanced + again.enriched, 0);
  assert.deepEqual(data, after);
});

// --- Codex review, round 1 ----------------------------------------------------

test("an older bookmark doesn't replace a newer saved chapter, which could then lose to an unseen reset", () => {
  // Saved chapter 10 on Oct 20; another device (not yet pulled) moved back to
  // 3 on Oct 15; the bookmark for 40 is from Oct 1.
  const map = { "natomanga.com:a": saved("a", { progressAt: "2026-10-20T00:00:00.000Z", lastReadAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" }) };
  const plan = planBulkUpsert(map, [imported("a", 40, "2026-10-01T00:00:00.000Z")], { timestamp: TIMESTAMP });
  assert.equal(outcomeOf(plan, "a"), "older-bookmark");
  assert.equal(plan.next["natomanga.com:a"].chapter, "10");
  const unseenReset = saved("a", { chapter: "3", chapterUrl: chapterUrl("a", 3), progressAt: "2026-10-15T00:00:00.000Z", progressResetAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" });
  assert.equal(resolveConflict(plan.next["natomanga.com:a"], unseenReset).chapter, "10", "chapter 10 survives the sync");
});

test("duplicates are checked against the reset before the furthest is picked", () => {
  const map = { "natomanga.com:a": saved("a", { chapter: "3", chapterUrl: chapterUrl("a", 3), progressAt: "2026-10-15T00:00:00.000Z", progressResetAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" }) };
  const plan = planBulkUpsert(map, [imported("a", 40, "2026-10-01T00:00:00.000Z"), imported("a", 12, "2026-10-20T00:00:00.000Z")], { timestamp: TIMESTAMP });
  assert.equal(outcomeOf(plan, "a"), "advanced");
  assert.equal(plan.next["natomanga.com:a"].chapter, "12");
  assert.equal(plan.next["natomanga.com:a"].progressAt, "2026-10-20T00:00:00.000Z");
});

test("equal-chapter duplicates resolve the same way in any order", () => {
  const map = { "natomanga.com:a": saved("a", { chapter: "3", chapterUrl: chapterUrl("a", 3), progressAt: "2026-10-15T00:00:00.000Z", progressResetAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" }) };
  const early = imported("a", 12, "2026-10-01T00:00:00.000Z");
  const late = imported("a", 12, "2026-10-20T00:00:00.000Z");
  for (const order of [[early, late], [late, early]]) {
    const plan = planBulkUpsert(map, order, { timestamp: TIMESTAMP });
    assert.equal(outcomeOf(plan, "a"), "advanced");
    assert.equal(plan.next["natomanga.com:a"].progressAt, "2026-10-20T00:00:00.000Z");
  }
  const fresh = [imported("b", 5, "2026-03-01T00:00:00.000Z"), imported("b", 5, "2026-04-01T00:00:00.000Z")];
  for (const order of [fresh, [...fresh].reverse()]) {
    assert.equal(planBulkUpsert({}, order, { timestamp: TIMESTAMP }).next["natomanga.com:b"].progressAt, "2026-04-01T00:00:00.000Z");
  }
});

test("a folder with a huge number of bookmarks doesn't overflow the stack", () => {
  const children = Array.from({ length: 200000 }, (_, i) => ({ id: String(i), title: "x", url: `https://example.com/${i}` }));
  const { scanned, unsupported } = collectBookmarks([{ id: "0", children: [{ id: "f", title: "big", children }] }], { now: NOW });
  assert.equal(scanned, 200000);
  assert.equal(unsupported, 200000);
});

test("an undated bookmark is checked against a reset with the time it will be written at", () => {
  // Another device's clock is a day ahead: its reset is stamped Nov 13, while
  // this device imports on Nov 12. The write stamps after the record it
  // replaces, so the check must use that time too (as before this change).
  const map = { "natomanga.com:a": saved("a", { chapter: "3", chapterUrl: chapterUrl("a", 3), progressAt: "2026-11-13T00:00:00.000Z", progressResetAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z" }) };
  const undated = collectBookmarks([mark(chapterUrl("a", 5), { dateAdded: undefined })], { now: NOW }).records[0];
  const plan = planBulkUpsert(map, [undated], { timestamp: TIMESTAMP });
  assert.equal(outcomeOf(plan, "a"), "advanced");
  assert.ok(plan.next["natomanga.com:a"].progressAt > "2026-11-13T00:00:00.000Z");
});

test("an import can't bring back a removal's old chapter when the removal hadn't reached this device", () => {
  // The cloud has an Oct 15 removal this device never pulled; the import on
  // Nov 12 adds the series from an Oct 1 bookmark.
  const plan = planBulkUpsert({}, [imported("a", 40, "2026-10-01T00:00:00.000Z")], { timestamp: TIMESTAMP });
  const tombstone = saved("a", { chapter: "40", chapterUrl: chapterUrl("a", 40), deleted: true, progressResetAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" });
  for (const [a, b] of [[plan.next["natomanga.com:a"], tombstone], [tombstone, plan.next["natomanga.com:a"]]]) {
    const m = resolveConflict(a, b);
    assert.equal(m.deleted, false, "the newer import still brings the series back");
    assert.equal(m.chapter, null, "but only as Plan to read");
    assert.equal(m.status, "plan");
  }
  // A save made after the removal keeps its chapter, as before.
  const save = saved("a", { chapter: "2", chapterUrl: chapterUrl("a", 2), progressAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" });
  assert.equal(resolveConflict(save, tombstone).chapter, "2");
});
