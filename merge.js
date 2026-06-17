// merge.js
// Pure conflict-resolution logic. No chrome, no network, no storage. Everything
// here is deterministic and unit-tested (see tests/merge.test.js). The sync
// engine (sync.js) calls these functions; keeping them pure is what lets the
// data-safety rules be verified in isolation.
//
// Conflict rule (single source of truth, mirrors docs/cloud-sync-design.md):
//   1. Deletion resolves first, by recency (newer updatedAt wins).
//   2. Reading position is monotonic: the FURTHEST chapter wins, independent of
//      which side was written more recently. A stale device can never move you
//      back.
//   3. Cosmetic fields (title, seriesUrl) take the more recent value.
//   4. createdAt keeps the earliest; updatedAt keeps the max.

// Parse a chapter label ("83.2", "246") to a number, or null if not parseable.
export function chapterToNumber(label) {
  const n = parseFloat(label);
  return Number.isNaN(n) ? null : n;
}

// Fields that determine whether two records are "the same" for sync purposes.
const SYNC_FIELDS = [
  "site",
  "slug",
  "title",
  "chapter",
  "chapterUrl",
  "seriesUrl",
  "deleted",
  "updatedAt",
];

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
  const updatedAt = rU > lU ? rU : lU;

  // createdAt: earliest of the two.
  const createds = [local.createdAt, remote.createdAt].filter(Boolean).sort();
  const createdAt = createds[0] || newer.createdAt;

  // 1. Deletion by recency.
  const deleted = newer.deleted === true;

  // 2. Furthest chapter wins (only meaningful if not deleted).
  let chapterSource = newer;
  if (!deleted) {
    const ln = chapterToNumber(local.chapter);
    const rn = chapterToNumber(remote.chapter);
    if (ln === null || rn === null) {
      chapterSource = newer; // fall back to recency on bad data
    } else {
      chapterSource = ln >= rn ? local : remote;
    }
  }

  return {
    id: newer.id,
    site: newer.site,
    slug: newer.slug,
    // 3. Cosmetic fields from the newer record.
    title: newer.title,
    seriesUrl: newer.seriesUrl,
    siteName: newer.siteName,
    // chapter and its URL travel together from whichever side is furthest.
    chapter: chapterSource.chapter,
    chapterUrl: chapterSource.chapterUrl,
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
