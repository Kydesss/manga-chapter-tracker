// tests/merge.test.js
// Run with: npm test   (which runs `node --test`)
// Covers the conflict rule and the data-safety invariants from the design doc.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveConflict,
  mergeRemoteIntoLocal,
  chapterToNumber,
} from "../merge.js";

// Helper to build a record with sensible defaults.
function rec(over = {}) {
  return {
    id: "natomanga.com:foo",
    site: "natomanga.com",
    slug: "foo",
    title: "Foo",
    chapter: "10",
    chapterUrl: "https://natomanga.com/manga/foo/chapter-10",
    seriesUrl: "https://natomanga.com/manga/foo",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    deleted: false,
    ...over,
  };
}

test("chapterToNumber parses decimals and rejects junk", () => {
  assert.equal(chapterToNumber("83.2"), 83.2);
  assert.equal(chapterToNumber("246"), 246);
  assert.equal(chapterToNumber("abc"), null);
});

test("furthest chapter wins even when the lower one was saved more recently", () => {
  // local: ch 120, OLD timestamp. remote: ch 100, NEWER timestamp.
  const local = rec({ chapter: "120", chapterUrl: "u120", updatedAt: "2026-05-01T00:00:00Z" });
  const remote = rec({ chapter: "100", chapterUrl: "u100", updatedAt: "2026-06-01T00:00:00Z" });
  const m = resolveConflict(local, remote);
  assert.equal(m.chapter, "120", "should keep furthest chapter");
  assert.equal(m.chapterUrl, "u120", "chapter URL travels with the chapter");
});

test("remote higher chapter wins", () => {
  const local = rec({ chapter: "100", updatedAt: "2026-06-01T00:00:00Z" });
  const remote = rec({ chapter: "130", updatedAt: "2026-05-01T00:00:00Z" });
  assert.equal(resolveConflict(local, remote).chapter, "130");
});

test("decimal chapters compare numerically (9.5 < 10)", () => {
  const local = rec({ chapter: "9.5" });
  const remote = rec({ chapter: "10" });
  assert.equal(resolveConflict(local, remote).chapter, "10");
});

test("newer deletion wins over older edit", () => {
  const local = rec({ chapter: "50", updatedAt: "2026-05-01T00:00:00Z" });
  const remote = rec({ deleted: true, updatedAt: "2026-06-01T00:00:00Z" });
  assert.equal(resolveConflict(local, remote).deleted, true);
});

test("newer edit resurrects over older deletion", () => {
  const local = rec({ deleted: true, updatedAt: "2026-05-01T00:00:00Z" });
  const remote = rec({ chapter: "60", deleted: false, updatedAt: "2026-06-01T00:00:00Z" });
  const m = resolveConflict(local, remote);
  assert.equal(m.deleted, false);
  assert.equal(m.chapter, "60");
});

test("a resurrecting save restarts the series instead of reviving the tombstone's chapter", () => {
  const tombstone = rec({ chapter: "40", deleted: true, updatedAt: "2026-05-01T00:00:00Z" });
  const plan = rec({
    chapter: null,
    chapterUrl: null,
    status: "plan",
    deleted: false,
    updatedAt: "2026-06-01T00:00:00Z",
  });
  for (const m of [resolveConflict(plan, tombstone), resolveConflict(tombstone, plan)]) {
    assert.equal(m.deleted, false);
    assert.equal(m.chapter, null);
    assert.equal(m.status, "plan");
  }

  const restart = rec({ chapter: "3", updatedAt: "2026-06-01T00:00:00Z" });
  assert.equal(resolveConflict(tombstone, restart).chapter, "3");
});

test("pulling an old tombstone doesn't turn a fresh plan back into reading", () => {
  const local = {
    "natomanga.com:foo": rec({
      chapter: null,
      chapterUrl: null,
      status: "plan",
      updatedAt: "2026-06-01T00:00:00Z",
      dirty: true,
    }),
  };
  const remote = [rec({ chapter: "40", deleted: true, updatedAt: "2026-05-01T00:00:00Z" })];
  const merged = mergeRemoteIntoLocal(local, remote).next["natomanga.com:foo"];
  assert.equal(merged.deleted, false);
  assert.equal(merged.chapter, null);
  assert.equal(merged.status, "plan");
});

test("createdAt keeps the earliest; updatedAt keeps the max", () => {
  const local = rec({ createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" });
  const remote = rec({ createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" });
  const m = resolveConflict(local, remote);
  assert.equal(m.createdAt, "2026-01-01T00:00:00Z");
  assert.equal(m.updatedAt, "2026-06-01T00:00:00Z");
});

// --- mergeRemoteIntoLocal: the safety invariants -------------------------

test("INVARIANT: empty cloud never deletes local data", () => {
  const local = { "s:a": rec({ id: "s:a" }), "s:b": rec({ id: "s:b" }) };
  const { next, changedIds } = mergeRemoteIntoLocal(local, []);
  assert.deepEqual(Object.keys(next).sort(), ["s:a", "s:b"]);
  assert.equal(changedIds.length, 0);
});

test("INVARIANT: absence in a non-empty pull does not delete local-only records", () => {
  const local = { "s:a": rec({ id: "s:a", chapter: "5" }), "s:localOnly": rec({ id: "s:localOnly" }) };
  const remote = [rec({ id: "s:a", chapter: "7", updatedAt: "2026-06-01T00:00:00Z" })];
  const { next } = mergeRemoteIntoLocal(local, remote);
  assert.ok(next["s:localOnly"], "local-only record survives");
  assert.equal(next["s:a"].chapter, "7", "overlapping record advances");
});

test("new-from-cloud record is added but not marked dirty", () => {
  const { next } = mergeRemoteIntoLocal({}, [rec({ id: "s:new" })]);
  assert.ok(next["s:new"]);
  assert.equal(next["s:new"].dirty, false);
});

test("when local chapter wins over a newer remote, result is dirty (push back)", () => {
  const local = { "s:a": rec({ id: "s:a", chapter: "120", updatedAt: "2026-05-01T00:00:00Z" }) };
  const remote = [rec({ id: "s:a", chapter: "100", updatedAt: "2026-06-01T00:00:00Z" })];
  const { next } = mergeRemoteIntoLocal(local, remote);
  assert.equal(next["s:a"].chapter, "120");
  assert.equal(next["s:a"].dirty, true, "cloud has the lower chapter, so we must push the higher one");
});

test("when cloud already matches, nothing is marked dirty or changed", () => {
  const r = rec({ id: "s:a", chapter: "10", updatedAt: "2026-06-01T00:00:00Z" });
  const local = { "s:a": { ...r, dirty: false } };
  const { changedIds } = mergeRemoteIntoLocal(local, [r]);
  assert.equal(changedIds.length, 0);
});

test("local-only metadata survives a cloud conflict", () => {
  const local = rec({
    chapter: "12",
    coverUrl: "https://img.example/cover.jpg",
    latestChapter: "15",
    metadataCheckedAt: "2026-06-01T00:00:00Z",
  });
  const remote = rec({ chapter: "13", updatedAt: "2026-07-01T00:00:00Z" });
  const merged = resolveConflict(local, remote);
  assert.equal(merged.chapter, "13");
  assert.equal(merged.coverUrl, "https://img.example/cover.jpg");
  assert.equal(merged.latestChapter, "15");
  assert.equal(merged.metadataCheckedAt, "2026-06-01T00:00:00Z");
});

test("a chapter always beats a newer plan-to-read record (reading supersedes plan)", () => {
  const plan = rec({
    chapter: null,
    chapterUrl: null,
    status: "plan",
    updatedAt: "2026-09-22T12:00:00Z",
  });
  const reading = rec({
    chapter: "50",
    chapterUrl: "u50",
    status: "reading",
    updatedAt: "2026-08-01T00:00:00Z",
  });
  for (const [local, remote] of [
    [plan, reading],
    [reading, plan],
  ]) {
    const m = resolveConflict(local, remote);
    assert.equal(m.chapter, "50");
    assert.equal(m.chapterUrl, "u50");
    assert.equal(m.status, "reading");
    assert.equal(m.updatedAt, "2026-09-22T12:00:00Z");
  }
});

test("a pull never turns a newer local plan record's cloud chapter into plan", () => {
  // Import made this device's copy "plan to read" after another device read on.
  const local = {
    "natomanga.com:foo": {
      ...rec({ chapter: null, chapterUrl: null, status: "plan", updatedAt: "2026-09-22T12:00:00Z" }),
      dirty: true,
    },
  };
  const remote = rec({ chapter: "50", chapterUrl: "u50", updatedAt: "2026-08-01T00:00:00Z" });
  const { next } = mergeRemoteIntoLocal(local, [remote]);
  assert.equal(next["natomanga.com:foo"].chapter, "50");
  assert.equal(next["natomanga.com:foo"].status, "reading");
  assert.equal(next["natomanga.com:foo"].dirty, true); // newer updatedAt goes back up
});

test("two plan-to-read records still resolve by recency", () => {
  const older = rec({ chapter: null, chapterUrl: null, title: "Old", updatedAt: "2026-08-01T00:00:00Z" });
  const newer = rec({ chapter: null, chapterUrl: null, title: "New", updatedAt: "2026-09-01T00:00:00Z" });
  const m = resolveConflict(older, newer);
  assert.equal(m.chapter, null);
  assert.equal(m.status, "plan");
  assert.equal(m.title, "New");
});

test("a real title beats the slug-derived fallback, whichever side is newer", () => {
  const imported = rec({
    slug: "witch-and-mercenary",
    title: "Witch & Mercenary",
    updatedAt: "2026-09-01T00:00:00Z",
  });
  const savedFromUrl = rec({
    slug: "witch-and-mercenary",
    title: "Witch And Mercenary", // what parser.js derives from the slug
    chapter: "11",
    chapterUrl: "u11",
    updatedAt: "2026-09-20T00:00:00Z",
  });
  assert.equal(resolveConflict(imported, savedFromUrl).title, "Witch & Mercenary");
  assert.equal(resolveConflict(savedFromUrl, imported).title, "Witch & Mercenary");

  // Between two real titles, the newer one still wins.
  const renamed = rec({
    slug: "witch-and-mercenary",
    title: "Witch and Mercenary (Official)",
    updatedAt: "2026-09-21T00:00:00Z",
  });
  assert.equal(resolveConflict(imported, renamed).title, "Witch and Mercenary (Official)");
});

// --- Rule 5: progressResetAt (cloud schema v2) ------------------------------

const RESET = "2026-10-01T00:00:00.000Z";

test("a device that missed a removal can't revive the old chapter after a restart", () => {
  // Device A removed the series (the marker) and restarted it at chapter 3.
  const restarted = rec({ chapter: "3", chapterUrl: "u3", progressAt: "2026-10-02T00:00:00.000Z", progressResetAt: RESET, updatedAt: "2026-10-02T00:00:00.000Z" });
  // Device B never saw the removal: it still holds chapter 40 from before.
  const stale = rec({ chapter: "40", chapterUrl: "u40", progressResetAt: null, updatedAt: "2026-09-01T00:00:00.000Z" });
  for (const [a, b] of [[restarted, stale], [stale, restarted]]) {
    const m = resolveConflict(a, b);
    assert.equal(m.chapter, "3");
    assert.equal(m.chapterUrl, "u3");
    assert.equal(m.progressResetAt, RESET, "the marker survives the merge");
  }
});

test("a deliberate move back survives a stale device's further chapter", () => {
  const movedBack = rec({ chapter: "3", chapterUrl: "u3", progressAt: RESET, progressResetAt: RESET, updatedAt: RESET });
  const stale = rec({ chapter: "40", chapterUrl: "u40", updatedAt: "2026-09-30T23:59:59.000Z" });
  assert.equal(resolveConflict(stale, movedBack).chapter, "3");
  assert.equal(resolveConflict(movedBack, stale).chapter, "3");
});

test("progress saved after a reset still moves forward under the furthest-chapter rule", () => {
  const movedBack = rec({ chapter: "3", chapterUrl: "u3", progressAt: RESET, progressResetAt: RESET, updatedAt: RESET });
  // Another device pulled the reset, then read on: chapter 5, stamped after it.
  const later = rec({ chapter: "5", chapterUrl: "u5", progressAt: "2026-10-03T00:00:00.000Z", progressResetAt: RESET, updatedAt: "2026-10-03T00:00:00.000Z" });
  assert.equal(resolveConflict(movedBack, later).chapter, "5");
  // ...and an older save that is still after the reset competes too.
  const sameMoment = rec({ chapter: "4", chapterUrl: "u4", progressAt: RESET, updatedAt: RESET });
  assert.equal(resolveConflict(movedBack, sameMoment).chapter, "4");
});

test("a series planned after a removal stays planned against a stale chapter", () => {
  const planned = rec({ chapter: null, chapterUrl: null, status: "plan", progressResetAt: RESET, updatedAt: "2026-10-02T00:00:00.000Z" });
  const stale = rec({ chapter: "40", chapterUrl: "u40", updatedAt: "2026-09-01T00:00:00.000Z" });
  const m = resolveConflict(stale, planned);
  assert.equal(m.chapter, null);
  assert.equal(m.status, "plan");
});

test("without a reset, a chapter still beats Plan to read whichever is newer", () => {
  const planned = rec({ chapter: null, chapterUrl: null, status: "plan", updatedAt: "2026-10-02T00:00:00.000Z" });
  const reading = rec({ chapter: "40", chapterUrl: "u40", updatedAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(resolveConflict(planned, reading).chapter, "40");
});

test("when neither chapter is after the reset, the newer record wins", () => {
  // Only reachable with bad clocks: the marker is later than both saves.
  const a = rec({ chapter: "7", chapterUrl: "u7", progressResetAt: RESET, updatedAt: "2026-09-02T00:00:00.000Z" });
  const b = rec({ chapter: "9", chapterUrl: "u9", updatedAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(resolveConflict(a, b).chapter, "7");
});

test("a differing reset marker or read time marks the merged record for upload", () => {
  const local = rec({ progressResetAt: RESET, updatedAt: RESET, lastReadAt: RESET });
  const remote = rec({ progressResetAt: null, updatedAt: RESET, lastReadAt: RESET });
  const { next } = mergeRemoteIntoLocal({ [local.id]: local }, [remote]);
  assert.equal(next[local.id].progressResetAt, RESET);
  assert.equal(next[local.id].dirty, true, "the cloud is missing the marker");
});

test("a stale chapter whose updatedAt an older version's merge refreshed still doesn't count after a reset", () => {
  // Codex review, round 1: an older client pulled the restart, kept chapter 40
  // under its furthest-chapter rule, and took the newer updatedAt. The chapter
  // itself was set in September, which progressAt (or lastReadAt) still says.
  const restarted = rec({ chapter: "3", chapterUrl: "u3", progressAt: "2026-10-02T00:00:00.000Z", progressResetAt: RESET, updatedAt: "2026-10-02T00:00:00.000Z" });
  const oldMerge = rec({ chapter: "40", chapterUrl: "u40", lastReadAt: "2026-09-01T00:00:00.000Z", progressAt: "2026-09-01T00:00:00.000Z", progressResetAt: null, updatedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(resolveConflict(oldMerge, restarted).chapter, "3");
  assert.equal(resolveConflict(restarted, oldMerge).chapter, "3");
});

test("progressAt travels with the chapter, not with the newer record", () => {
  const further = rec({ chapter: "40", chapterUrl: "u40", progressAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
  const newer = rec({ chapter: "30", chapterUrl: "u30", progressAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
  const m = resolveConflict(further, newer);
  assert.equal(m.chapter, "40");
  assert.equal(m.progressAt, "2026-09-01T00:00:00.000Z");
  assert.equal(m.updatedAt, "2026-10-01T00:00:00.000Z");
});

test("a legacy chapter with no read time counts as older than any reset", () => {
  // Codex review, round 2: an older version's merge kept this chapter 40 (with
  // no known read time) but took the restart's newer updatedAt.
  const restarted = rec({ chapter: "3", chapterUrl: "u3", progressAt: "2026-10-02T00:00:00.000Z", progressResetAt: RESET, updatedAt: "2026-10-02T00:00:00.000Z" });
  const legacy = rec({ chapter: "40", chapterUrl: "u40", lastReadAt: null, updatedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(resolveConflict(legacy, restarted).chapter, "3");
  assert.equal(resolveConflict(restarted, legacy).chapter, "3");
});

test("the same chapter on both sides takes the more recently set one, whichever side it's on", () => {
  // Codex review, round 2: otherwise each device keeps its own times and they
  // upload them back and forth forever.
  const sept = rec({ chapter: "40", chapterUrl: "u40", progressAt: "2026-09-01T00:00:00.000Z", lastReadAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
  const oct = rec({ chapter: "40", chapterUrl: "u40b", progressAt: "2026-10-01T00:00:00.000Z", lastReadAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
  for (const [a, b] of [[sept, oct], [oct, sept]]) {
    const m = resolveConflict(a, b);
    assert.equal(m.progressAt, oct.progressAt);
    assert.equal(m.lastReadAt, oct.lastReadAt);
    assert.equal(m.chapterUrl, "u40b");
  }
});

test("a chapter from before a reset never beats Plan to read, in either order", () => {
  // Codex review, round 3: an older version's merge kept chapter 40 (read in
  // September) but took the plan's newer updatedAt.
  const plan = rec({ chapter: null, chapterUrl: null, status: "plan", progressResetAt: RESET, updatedAt: "2026-10-02T00:00:00.000Z" });
  const stale = rec({ chapter: "40", chapterUrl: "u40", lastReadAt: "2026-09-01T00:00:00.000Z", progressAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(resolveConflict(stale, plan).chapter, null);
  assert.equal(resolveConflict(plan, stale).chapter, null);
});
