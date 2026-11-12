// merge.js
// Pure conflict-resolution logic. No chrome, no network, no storage. Everything
// here is deterministic and unit-tested (see tests/merge.test.js). The sync
// engine (sync.js) calls these functions; keeping them pure is what lets the
// data-safety rules be verified in isolation.
//
// Conflict rule (single source of truth, mirrors docs/cloud-sync-design.md):
//   1. Deletion resolves first, by recency (newer updatedAt wins). When a newer
//      save resurrects a deleted series, the series restarts from that save:
//      the tombstone's old chapter doesn't count toward rule 2.
//   2. Reading position is monotonic: the FURTHEST chapter wins, independent of
//      which side was written more recently. A stale device can never move you
//      back. A record with a chapter always beats one without ("reading
//      supersedes plan"), so a newer plan-to-read record can't blank out progress.
//   3. Cosmetic fields (title, seriesUrl) take the more recent value, except that
//      a real title is never replaced by the slug-derived fallback.
//   4. createdAt keeps the earliest; updatedAt keeps the max.
//   5. progressResetAt (when the series' reading history last restarted: a
//      removal, or a deliberate move back) keeps the later of the two. A side's
//      chapter only competes in rules 1-2 if its progressAt (when that chapter
//      was set) is at or after it, so progress from before a reset never comes
//      back. progressAt travels with the chapter; merges never refresh it,
//      unlike updatedAt (which an older client's merge can bump on a stale
//      chapter).

import { isSlugTitle } from "./parser.js";

// Parse a chapter label ("83.2", "246") to a number, or null if not parseable.
export function chapterToNumber(label) {
  const n = parseFloat(label);
  return Number.isNaN(n) ? null : n;
}

// Plan-to-read records have no chapter. An empty label counts as none too.
export function hasChapter(label) {
  return label != null && label !== "";
}

// Title for a merged record: `preferred`'s, unless it's only the slug-derived
// fallback and `other` has a real one. Shared with storage.js so saves, imports,
// and sync all keep a real title once any of them has seen it.
export function pickTitle(preferred, other) {
  if (!preferred?.title) return other?.title;
  if (
    other?.title &&
    isSlugTitle(preferred.title, preferred.slug) &&
    !isSlugTitle(other.title, other.slug)
  ) {
    return other.title;
  }
  return preferred.title;
}

// Fields that determine whether two records are "the same" for sync purposes.
const SYNC_FIELDS = [
  "site",
  "slug",
  "title",
  "chapter",
  "chapterUrl",
  "seriesUrl",
  "lastReadAt",
  "progressAt",
  "progressResetAt",
  "deleted",
  "updatedAt",
];

// When a record's chapter was set. Unknown ("") counts as before any reset,
// so a chapter of unknown age can't come back after one. Deliberately no
// fallback: updatedAt is refreshed by merges on stale chapters, and lastReadAt
// may be a display estimate (a backup's or v4's guess from updatedAt). Every
// path that sets a chapter or upgrades an old record fills progressAt itself,
// from a real read time at most (storage.js toV7, normalizeBackupRecord).
export function progressTime(rec) {
  return rec.progressAt || "";
}

// Of two records at the same chapter: the one set (then read) more recently,
// else the local one.
function laterSet(local, remote) {
  for (const field of ["progressAt", "lastReadAt"]) {
    const l = local[field] || "";
    const r = remote[field] || "";
    if (l !== r) return r > l ? remote : local;
  }
  return local;
}

// The chapter fields of a series with no usable progress (Plan to read).
const PLAN = { chapter: null, chapterUrl: null, status: "plan", lastReadAt: null, progressAt: null };

// The later of two ISO timestamps (either may be missing).
function laterOf(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return b > a ? b : a;
}

export function sameSyncContent(a, b) {
  if (!a || !b) return false;
  return SYNC_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
}

// Resolve a single series that exists on both sides. Returns the winning record
// (without a `dirty` flag; the caller decides dirtiness).
export function resolveConflict(local, remote) {
  const lU = local.updatedAt || "";
  const rU = remote.updatedAt || "";
  const newer = rU > lU ? remote : local; // tie -> local, deterministic
  const older = newer === local ? remote : local;
  const updatedAt = rU > lU ? rU : lU;

  // createdAt: earliest of the two.
  const createds = [local.createdAt, remote.createdAt].filter(Boolean).sort();
  const createdAt = createds[0] || newer.createdAt;

  // 1. Deletion by recency.
  const deleted = newer.deleted === true;

  // 5. Progress from before the latest reset doesn't count.
  const progressResetAt = laterOf(local.progressResetAt, remote.progressResetAt);
  const counts = (side) =>
    hasChapter(side.chapter) && (!progressResetAt || progressTime(side) >= progressResetAt);

  // 2. Furthest chapter wins (only meaningful if not deleted).
  let chapterSource = newer;
  if (!deleted && older.deleted === true) {
    // A newer save brought a deleted series back. The deletion ended the old
    // reading history, so the tombstone's chapter doesn't compete: the series
    // restarts from the resurrecting save (which may be Plan to read). That
    // save's chapter still has to be from after the removal: an import of an
    // old bookmark is newer than a removal this device hadn't seen, but its
    // chapter isn't, so the series comes back as Plan to read (Codex review).
    chapterSource = counts(newer) || !hasChapter(newer.chapter) ? newer : PLAN;
  } else if (!deleted) {
    const lCounts = counts(local);
    const rCounts = counts(remote);
    if (lCounts !== rCounts) {
      // Reading supersedes plan, regardless of which side is newer. A chapter
      // from before the reset counts as no chapter here.
      chapterSource = lCounts ? local : remote;
    } else if (!lCounts) {
      // Neither counts. A chapter from before the reset never beats Plan to
      // read; between two plans (or, only with bad clocks, two pre-reset
      // chapters) the newer record wins.
      const lHas = hasChapter(local.chapter);
      const rHas = hasChapter(remote.chapter);
      chapterSource = lHas !== rHas ? (lHas ? remote : local) : newer;
    } else {
      const ln = chapterToNumber(local.chapter);
      const rn = chapterToNumber(remote.chapter);
      if (ln === null || rn === null) {
        chapterSource = newer; // bad data: fall back to recency
      } else if (ln !== rn) {
        chapterSource = ln > rn ? local : remote;
      } else {
        // The same chapter on both sides: the one set more recently, then
        // read more recently. Both devices pick the same side, so their read
        // and set times converge instead of being uploaded back and forth.
        chapterSource = laterSet(local, remote);
      }
    }
  }

  return {
    id: newer.id,
    site: newer.site,
    slug: newer.slug,
    // 3. Cosmetic fields from the newer record (a real title beats a slug one).
    title: pickTitle(newer, older),
    seriesUrl: newer.seriesUrl,
    siteName: newer.siteName,
    // chapter and its URL travel together from whichever side is furthest.
    chapter: chapterSource.chapter,
    chapterUrl: chapterSource.chapterUrl,
    // Phase 1 metadata remains local-only until the cloud schema is expanded.
    // Preserve it through sync conflict resolution instead of dropping it.
    status: chapterSource.status || (chapterSource.chapter == null ? "plan" : "reading"),
    lastReadAt: chapterSource.lastReadAt ?? null,
    progressAt: hasChapter(chapterSource.chapter) ? chapterSource.progressAt ?? null : null,
    coverUrl: local.coverUrl ?? remote.coverUrl ?? null,
    latestChapter: local.latestChapter ?? remote.latestChapter ?? null,
    latestChapterUrl: local.latestChapterUrl ?? remote.latestChapterUrl ?? null,
    latestPublishedAt: local.latestPublishedAt ?? remote.latestPublishedAt ?? null,
    metadataCheckedAt: local.metadataCheckedAt ?? remote.metadataCheckedAt ?? null,
    progressResetAt,
    createdAt,
    updatedAt,
    deleted,
  };
}

// Merge pulled remote records into a local map (id -> record). Pure: returns a
// new map and the list of ids whose LOCAL value changed.
//
// Invariant 1 (absence is never deletion) holds structurally: we only ever
// iterate the remote records we were given and upsert by id. Local records not
// present in `remoteRecords` are never touched, so an empty pull changes nothing.
//
// `dirty` is set when the resolved record differs from what the cloud holds, so
// the merged value gets pushed back on the next pass. A record taken verbatim
// from the cloud is left clean.
export function mergeRemoteIntoLocal(localMap, remoteRecords) {
  const next = { ...localMap };
  const changedIds = [];

  for (const remote of remoteRecords) {
    const local = next[remote.id];

    if (!local) {
      // New from cloud: take as-is, already in sync so not dirty.
      next[remote.id] = { ...remote, dirty: false };
      changedIds.push(remote.id);
      continue;
    }

    const merged = resolveConflict(local, remote);
    merged.dirty = !sameSyncContent(merged, remote); // cloud needs it?

    // Only record a change if the local value actually moved.
    if (!sameSyncContent(merged, local) || merged.dirty !== (local.dirty === true)) {
      next[remote.id] = merged;
      changedIds.push(remote.id);
    }
  }

  return { next, changedIds };
}
