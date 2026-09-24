// storage.js
// A thin wrapper over chrome.storage.local. All series live in a single object
// keyed by record id, which makes "save" a clean upsert and lookups instant.
// chrome.storage.local plus "unlimitedStorage" handles thousands of small
// records. If it ever outgrows this, the swap to IndexedDB is isolated here.
//
// Sync bookkeeping (added in v0.2.x):
//   deleted  - tombstone flag; UI hides these, sync propagates them.
//   dirty    - local change not yet pushed to the cloud. LOCAL ONLY, never sent.

const KEY = "series"; // { [id]: record }
const SCHEMA_KEY = "schemaVersion";
const CURSOR_KEY = "lastSyncCursor"; // server timestamp of the last pulled change
const SNAPSHOT_KEY = "preSyncSnapshot"; // safety backup before first-ever sync

const CURRENT_SCHEMA = 3; // 2 = sync fields; 3 = status + series metadata fields

const SERIES_DEFAULTS = {
  status: "reading",
  lastReadAt: null,
  coverUrl: null,
  latestChapter: null,
  latestChapterUrl: null,
  latestPublishedAt: null,
  metadataCheckedAt: null,
};

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

// --- Migration ------------------------------------------------------------

// Backfill sync fields on records created before v0.2.x and metadata fields on
// records created before v0.4.x. Runs once, guarded by the stored schema
// version. Must run before any sync path is reachable.
export async function migrate() {
  const { [SCHEMA_KEY]: version } = await chrome.storage.local.get(SCHEMA_KEY);
  if (version === CURRENT_SCHEMA) return { migrated: 0 };

  const map = await readMap();
  let migrated = 0;
  for (const id of Object.keys(map)) {
    const r = map[id];
    const needsMigration =
      r.deleted === undefined ||
      r.dirty === undefined ||
      r.status === undefined ||
      r.lastReadAt === undefined ||
      r.coverUrl === undefined ||
      r.latestChapter === undefined ||
      r.latestChapterUrl === undefined ||
      r.latestPublishedAt === undefined ||
      r.metadataCheckedAt === undefined;

    if (needsMigration) {
      // Defaults first, then spread the record so any existing values win.
      // Legacy records all contain a chapter and therefore become "reading".
      map[id] = {
        deleted: false,
        dirty: false,
        ...SERIES_DEFAULTS,
        status: r.chapter == null ? "plan" : "reading",
        ...r,
      };
      migrated++;
    }
  }
  await writeMap(map);
  await chrome.storage.local.set({ [SCHEMA_KEY]: CURRENT_SCHEMA });
  return { migrated };
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

// The raw id -> record object. Used by the sync engine's merge step.
export async function getMap() {
  return readMap();
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
// resurrects a previously deleted series) and marks the record dirty.
export async function upsert(record) {
  const map = await readMap();
  const existing = map[record.id];
  map[record.id] = {
    ...SERIES_DEFAULTS,
    ...existing,
    ...record,
    status: record.chapter == null ? record.status || "plan" : "reading",
    deleted: false,
    dirty: true,
    createdAt: existing?.createdAt || record.updatedAt,
  };
  await writeMap(map);
  return map[record.id];
}

// Merge many imported records with a single read and write. Reading position
// is monotonic: a bulk import may advance a series, but never move it backward.
// Null metadata from a scraper never erases metadata we already know.
export async function bulkUpsert(records, { timestamp = nowISO() } = {}) {
  if (!Array.isArray(records)) {
    throw new Error("Bulk import data must be an array of series records.");
  }

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
      title: incoming.title || existing.title,
      seriesUrl: incoming.seriesUrl || existing.seriesUrl,
      coverUrl: incoming.coverUrl ?? existing.coverUrl ?? null,
      latestChapter: incoming.latestChapter ?? existing.latestChapter ?? null,
      latestChapterUrl: incoming.latestChapterUrl ?? existing.latestChapterUrl ?? null,
      latestPublishedAt: incoming.latestPublishedAt ?? existing.latestPublishedAt ?? null,
      metadataCheckedAt: incoming.metadataCheckedAt ?? existing.metadataCheckedAt ?? null,
      deleted: false,
    };

    if (shouldAdvance) {
      merged.status = "reading";
      merged.chapter = incoming.chapter;
      merged.chapterUrl = incoming.chapterUrl;
      merged.lastReadAt = incoming.lastReadAt || timestamp;
    }

    if (sameImportContent(existing, merged)) {
      unchanged++;
      continue;
    }

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
    lastReadAt: record.chapter == null ? null : record.lastReadAt || timestamp,
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
  const map = await readMap();
  const existing = map[id];
  if (!existing) return;
  map[id] = { ...existing, deleted: true, dirty: true, updatedAt: nowISO() };
  await writeMap(map);
}

// Replace the entire map (used by the sync engine after a merge).
export async function writeAll(map) {
  await writeMap(map);
}

// Clear the dirty flag on the given ids after a confirmed push.
export async function markSynced(ids) {
  if (!ids?.length) return;
  const map = await readMap();
  for (const id of ids) {
    if (map[id]) map[id] = { ...map[id], dirty: false };
  }
  await writeMap(map);
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
// Conflicts resolve last-write-wins by updatedAt. Imported records are marked
// dirty so they propagate to the cloud on the next sync.
export async function importRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error("Import data must be an array of series records.");
  }
  const map = await readMap();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const rec of records) {
    if (!rec || typeof rec.id !== "string" || typeof rec.chapter !== "string") {
      skipped++;
      continue;
    }
    const existing = map[rec.id];
    if (!existing) {
      map[rec.id] = {
        deleted: false,
        ...rec,
        createdAt: rec.createdAt || rec.updatedAt,
        dirty: true,
      };
      added++;
    } else if ((rec.updatedAt || "") >= (existing.updatedAt || "")) {
      map[rec.id] = {
        ...existing,
        ...rec,
        createdAt: existing.createdAt,
        dirty: true,
      };
      updated++;
    } else {
      skipped++;
    }
  }

  await writeMap(map);
  return { added, updated, skipped, total: Object.values(map).filter((r) => !r.deleted).length };
}
