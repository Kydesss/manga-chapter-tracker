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

const CURRENT_SCHEMA = 2; // 1 = pre-sync records (no deleted/dirty fields)

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

// Backfill sync fields on records created before v0.2.x. Runs once, guarded by
// the stored schema version. Must run before any sync path is reachable.
export async function migrate() {
  const { [SCHEMA_KEY]: version } = await chrome.storage.local.get(SCHEMA_KEY);
  if (version === CURRENT_SCHEMA) return { migrated: 0 };

  const map = await readMap();
  let migrated = 0;
  for (const id of Object.keys(map)) {
    const r = map[id];
    if (r.deleted === undefined || r.dirty === undefined) {
      // Defaults first, then spread the record so any existing values win.
      map[id] = { deleted: false, dirty: false, ...r };
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
    ...record,
    deleted: false,
    dirty: true,
    createdAt: existing?.createdAt || record.updatedAt,
  };
  await writeMap(map);
  return map[record.id];
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
