// storage.js
// A thin wrapper over chrome.storage.local. All series live in a single object
// keyed by record id, which makes "save" a clean upsert and lookups instant.
// chrome.storage.local plus "unlimitedStorage" handles thousands of small
// records. If it ever outgrows this, the swap to IndexedDB is isolated here.
//
// Sync bookkeeping (added in v0.2.x):
//   deleted  - tombstone flag; UI hides these, sync propagates them.
//   dirty    - local change not yet pushed to the cloud. LOCAL ONLY, never sent.
//
// Every read-modify-write of the map runs under one lock (withLibraryLock). The
// popup and the service worker both write the library; without the lock, one
// context's write could silently undo the other's.

import { resolveConflict, pickTitle } from "./merge.js";

const KEY = "series"; // { [id]: record }
const SCHEMA_KEY = "schemaVersion";
const CURSOR_KEY = "lastSyncCursor"; // server timestamp of the last pulled change
const SNAPSHOT_KEY = "preSyncSnapshot"; // safety backup before first-ever sync
const LOCK_NAME = "shiori-library";

// 2 = sync fields; 3 = status + series metadata fields; 4 = lastReadAt backfill
const CURRENT_SCHEMA = 4;

const SERIES_DEFAULTS = {
  status: "reading",
  lastReadAt: null,
  coverUrl: null,
  latestChapter: null,
  latestChapterUrl: null,
  latestPublishedAt: null,
  metadataCheckedAt: null,
};

// Series metadata collected by imports and (later) update checks. A write that
// doesn't know a value (null) never erases one we already have.
const METADATA_FIELDS = [
  "coverUrl",
  "latestChapter",
  "latestChapterUrl",
  "latestPublishedAt",
  "metadataCheckedAt",
];

function nowISO() {
  return new Date().toISOString();
}

async function readMap() {
  const result = await chrome.storage.local.get(KEY);
  return result[KEY] || {};
}

async function writeMap(map) {
  await chrome.storage.local.set({ [KEY]: map });
}

// Run `fn` while holding the library lock. Web Locks are shared by every page
// and worker of the extension's origin, so this serializes the popup against
// the service worker. The promise-chain fallback, for runtimes without
// navigator.locks, only serializes callers within one context.
let localQueue = Promise.resolve();
function withLibraryLock(fn) {
  const locks = globalThis.navigator?.locks;
  if (locks?.request) return locks.request(LOCK_NAME, () => fn());
  const run = localQueue.then(() => fn());
  localQueue = run.catch(() => {});
  return run;
}

function keepKnownMetadata(incoming, existing) {
  const merged = {};
  for (const field of METADATA_FIELDS) {
    merged[field] = incoming?.[field] ?? existing?.[field] ?? null;
  }
  return merged;
}

// --- Migration ------------------------------------------------------------

// Backfill fields that older records lack. Runs once per schema version,
// guarded by the stored version. Must run before any sync path is reachable.
//   v2: sync fields (deleted, dirty).
//   v3: status and series metadata. Legacy records all contain a chapter and
//       therefore become "reading".
//   v4: lastReadAt from updatedAt (their last save) for records saved before
//       lastReadAt existed. Only on upgrades from v3 or older: imports leave
//       lastReadAt null on purpose, because the read time is unknown.
export async function migrate() {
  return withLibraryLock(async () => {
    const { [SCHEMA_KEY]: version } = await chrome.storage.local.get(SCHEMA_KEY);
    if (version === CURRENT_SCHEMA) return { migrated: 0 };
    const from = Number.isInteger(version) ? version : 0;

    const map = await readMap();
    let migrated = 0;
    for (const id of Object.keys(map)) {
      const original = map[id];
      let r = original;
      if (needsFieldBackfill(r)) {
        // Defaults first, then spread the record so any existing values win.
        r = {
          deleted: false,
          dirty: false,
          ...SERIES_DEFAULTS,
          status: r.chapter == null ? "plan" : "reading",
          ...r,
        };
      }
      if (from < 4 && r.chapter != null && r.lastReadAt == null && r.updatedAt) {
        r = { ...r, lastReadAt: r.updatedAt };
      }
      if (r !== original) {
        map[id] = r;
        migrated++;
      }
    }
    await writeMap(map);
    await chrome.storage.local.set({ [SCHEMA_KEY]: CURRENT_SCHEMA });
    return { migrated };
  });
}

function needsFieldBackfill(r) {
  return (
    r.deleted === undefined ||
    r.dirty === undefined ||
    r.status === undefined ||
    r.lastReadAt === undefined ||
    METADATA_FIELDS.some((field) => r[field] === undefined)
  );
}

// --- Reads ----------------------------------------------------------------

// Visible library: non-deleted records. Used by the UI and Export.
export async function getAll() {
  const map = await readMap();
  return Object.values(map).filter((r) => !r.deleted);
}

// Everything including tombstones. Used by the sync engine.
export async function getAllRaw() {
  const map = await readMap();
  return Object.values(map);
}

// A single non-deleted series, or null. A deleted series reads as "not saved",
// so reopening it behaves like a fresh series (and saving resurrects it).
export async function getOne(id) {
  const map = await readMap();
  const r = map[id];
  return r && !r.deleted ? r : null;
}

// Records with unpushed local changes (for the sync push step).
export async function getDirty() {
  const map = await readMap();
  return Object.values(map).filter((r) => r.dirty);
}

export async function count() {
  return (await getAll()).length;
}

// --- Writes ---------------------------------------------------------------

// Save or update a series in place. Saving always clears any tombstone (a save
// resurrects a previously deleted series) and marks the record dirty. A save
// sets the reading position; it never erases what an import or refresh already
// learned about the series (a real title, cover, or latest chapter).
export async function upsert(record) {
  return withLibraryLock(async () => {
    const map = await readMap();
    const existing = map[record.id];
    map[record.id] = {
      ...SERIES_DEFAULTS,
      ...existing,
      ...record,
      title: pickTitle(record, existing),
      ...keepKnownMetadata(record, existing),
      status: record.chapter == null ? record.status || "plan" : "reading",
      deleted: false,
      dirty: true,
      createdAt: existing?.createdAt || record.updatedAt,
    };
    await writeMap(map);
    return map[record.id];
  });
}

// Merge many imported records with a single read and write. Reading position
// is monotonic: a bulk import may advance a series, but never move it backward.
// Null metadata from a scraper never erases metadata we already know.
export async function bulkUpsert(records, { timestamp = nowISO() } = {}) {
  if (!Array.isArray(records)) {
    throw new Error("Bulk import data must be an array of series records.");
  }

  return withLibraryLock(async () => {
    const map = await readMap();
    const deduped = new Map();
    let skipped = 0;

    for (const record of records) {
      if (!isImportableRecord(record)) {
        skipped++;
        continue;
      }
      const previous = deduped.get(record.id);
      deduped.set(record.id, previous ? preferFurtherRecord(previous, record) : record);
    }

    let added = 0;
    let advanced = 0;
    let enriched = 0;
    let unchanged = 0;

    for (const incoming of deduped.values()) {
      const existing = map[incoming.id];
      if (!existing || existing.deleted) {
        map[incoming.id] = normalizeImportedRecord(incoming, timestamp, existing?.createdAt);
        added++;
        continue;
      }

      const comparison = compareChapterProgress(incoming.chapter, existing.chapter);
      const shouldAdvance =
        incoming.chapter != null &&
        (existing.chapter == null || comparison > 0);

      const merged = {
        ...SERIES_DEFAULTS,
        ...existing,
        site: incoming.site,
        siteName: incoming.siteName || existing.siteName,
        slug: incoming.slug,
        title: pickTitle(incoming, existing),
        seriesUrl: incoming.seriesUrl || existing.seriesUrl,
        ...keepKnownMetadata(incoming, existing),
        deleted: false,
      };

      if (shouldAdvance) {
        merged.status = "reading";
        merged.chapter = incoming.chapter;
        merged.chapterUrl = incoming.chapterUrl;
        // Sites rarely say when a chapter was read. Keep the last known read
        // time instead of stamping the import time, which would make every
        // imported series look freshly read.
        if (incoming.lastReadAt) merged.lastReadAt = incoming.lastReadAt;
      }

      if (sameImportContent(existing, merged)) {
        unchanged++;
        continue;
      }

      // Covers and latest chapters stay local for now, so a metadata-only
      // change neither bumps updatedAt nor queues a sync.
      const syncRelevantChange = !sameImportSyncContent(existing, merged);
      merged.updatedAt = syncRelevantChange ? timestamp : existing.updatedAt;
      merged.dirty = syncRelevantChange ? true : existing.dirty === true;
      map[incoming.id] = merged;
      if (shouldAdvance) advanced++;
      else enriched++;
    }

    await writeMap(map);
    return {
      added,
      advanced,
      enriched,
      unchanged,
      skipped,
      processed: deduped.size,
      total: Object.values(map).filter((r) => !r.deleted).length,
    };
  });
}

function isImportableRecord(record) {
  return (
    record &&
    typeof record.id === "string" &&
    typeof record.site === "string" &&
    typeof record.slug === "string" &&
    typeof record.title === "string" &&
    typeof record.seriesUrl === "string" &&
    (record.chapter === null || record.chapter === undefined || typeof record.chapter === "string")
  );
}

function normalizeImportedRecord(record, timestamp, existingCreatedAt) {
  return {
    ...SERIES_DEFAULTS,
    ...record,
    status: record.chapter == null ? "plan" : "reading",
    chapter: record.chapter ?? null,
    chapterUrl: record.chapterUrl ?? null,
    // Unknown unless the site reported it: an import is not a read.
    lastReadAt: record.chapter == null ? null : record.lastReadAt ?? null,
    createdAt: existingCreatedAt || record.createdAt || timestamp,
    updatedAt: timestamp,
    deleted: false,
    dirty: true,
  };
}

function preferFurtherRecord(a, b) {
  const comparison = compareChapterProgress(b.chapter, a.chapter);
  if (comparison > 0 || (a.chapter == null && b.chapter != null)) return b;
  return a;
}

function compareChapterProgress(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const an = Number.parseFloat(a);
  const bn = Number.parseFloat(b);
  if (Number.isNaN(an) || Number.isNaN(bn)) return a === b ? 0 : -1;
  return Math.sign(an - bn);
}

const IMPORT_CONTENT_FIELDS = [
  "site",
  "siteName",
  "slug",
  "title",
  "seriesUrl",
  "status",
  "chapter",
  "chapterUrl",
  "lastReadAt",
  "coverUrl",
  "latestChapter",
  "latestChapterUrl",
  "latestPublishedAt",
  "metadataCheckedAt",
  "deleted",
];

function sameImportContent(a, b) {
  return IMPORT_CONTENT_FIELDS.every((field) => (a[field] ?? null) === (b[field] ?? null));
}

// The subset of fields the cloud stores (see sync.js toRow), plus status.
const IMPORT_SYNC_FIELDS = [
  "site",
  "slug",
  "title",
  "seriesUrl",
  "status",
  "chapter",
  "chapterUrl",
  "deleted",
];

function sameImportSyncContent(a, b) {
  return IMPORT_SYNC_FIELDS.every((field) => (a[field] ?? null) === (b[field] ?? null));
}

// Soft delete: tombstone the record so the deletion can sync. The UI filters
// tombstones out, so this looks like a normal removal.
export async function remove(id) {
  return withLibraryLock(async () => {
    const map = await readMap();
    const existing = map[id];
    if (!existing) return;
    map[id] = { ...existing, deleted: true, dirty: true, updatedAt: nowISO() };
    await writeMap(map);
  });
}

// Read, transform, and write the whole map as one locked step. The sync engine
// merges through this, so a pass can't overwrite a save or an import page that
// lands while it runs.
export async function updateMap(transform) {
  return withLibraryLock(async () => {
    const next = transform(await readMap());
    await writeMap(next);
    return next;
  });
}

// Clear the dirty flag on records after a confirmed push. A record that changed
// again while the push was in flight (a newer updatedAt) stays dirty, so its
// newer value still gets pushed.
export async function markSynced(pushed) {
  if (!pushed?.length) return;
  return withLibraryLock(async () => {
    const map = await readMap();
    for (const { id, updatedAt } of pushed) {
      const current = map[id];
      if (current && current.updatedAt === updatedAt) {
        map[id] = { ...current, dirty: false };
      }
    }
    await writeMap(map);
  });
}

// --- Sync cursor + safety snapshot ---------------------------------------

export async function getCursor() {
  const { [CURSOR_KEY]: c } = await chrome.storage.local.get(CURSOR_KEY);
  return c || null;
}

export async function setCursor(value) {
  await chrome.storage.local.set({ [CURSOR_KEY]: value });
}

// True if a cloud sync has never run on this device (cursor never set).
export async function hasSyncedBefore() {
  return (await getCursor()) !== null;
}

// Write a one-time safety backup of the current library before the first sync.
export async function writeSafetySnapshot() {
  const { [SNAPSHOT_KEY]: existing } = await chrome.storage.local.get(SNAPSHOT_KEY);
  if (existing) return; // only ever take the first one
  const records = await getAllRaw();
  await chrome.storage.local.set({
    [SNAPSHOT_KEY]: { takenAt: nowISO(), records },
  });
}

// --- Import ---------------------------------------------------------------

// Merge an array of records into storage (from the Export/Import feature).
// Conflicts resolve by the same rule as cloud sync (merge.js): the furthest
// chapter wins, a chapter beats Plan to read, and deletions and cosmetic fields
// go by recency. So restoring an old backup can never move you back. Changed
// records are marked dirty so they propagate to the cloud on the next sync.
export async function importRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error("Import data must be an array of series records.");
  }
  return withLibraryLock(async () => {
    const map = await readMap();
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of records) {
      if (!isImportableRecord(raw)) {
        skipped++;
        continue;
      }
      const rec = normalizeBackupRecord(raw);
      const existing = map[rec.id];
      if (!existing) {
        map[rec.id] = { ...rec, dirty: true };
        added++;
        continue;
      }
      const merged = resolveConflict(existing, rec);
      if (sameImportContent(existing, merged)) {
        skipped++;
        continue;
      }
      map[rec.id] = { ...merged, dirty: true };
      updated++;
    }

    await writeMap(map);
    return { added, updated, skipped, total: Object.values(map).filter((r) => !r.deleted).length };
  });
}

// Bring a backup record (possibly from an older version) up to the current
// shape: plan-to-read records keep a null chapter, and legacy records gain the
// schema v3/v4 fields the same way the migration fills them.
function normalizeBackupRecord(rec) {
  const chapter = rec.chapter ?? null;
  return {
    ...SERIES_DEFAULTS,
    ...rec,
    chapter,
    chapterUrl: chapter == null ? null : rec.chapterUrl ?? null,
    status: chapter == null ? "plan" : "reading",
    lastReadAt: rec.lastReadAt ?? (chapter == null ? null : rec.updatedAt ?? null),
    deleted: rec.deleted === true,
    createdAt: rec.createdAt || rec.updatedAt,
  };
}
