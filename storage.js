// storage.js
// A thin wrapper over chrome.storage.local. We keep all series in a single
// object keyed by record id, which makes "save" a clean upsert and lookups
// instant. chrome.storage.local plus the "unlimitedStorage" permission handles
// thousands of small records comfortably. If the dataset ever outgrows this,
// the swap to IndexedDB is isolated to this one file.

const KEY = "series"; // the single storage bucket: { [id]: record }

// Read the whole map. Returns {} if nothing saved yet.
async function readMap() {
  const result = await chrome.storage.local.get(KEY);
  return result[KEY] || {};
}

async function writeMap(map) {
  await chrome.storage.local.set({ [KEY]: map });
}

// All saved series as an array.
export async function getAll() {
  const map = await readMap();
  return Object.values(map);
}

// Look up a single series by id (used to show "already saved" state).
export async function getOne(id) {
  const map = await readMap();
  return map[id] || null;
}

// Insert a new series or update an existing one in place (matched by id).
// If the series already exists we preserve its original createdAt.
export async function upsert(record) {
  const map = await readMap();
  const existing = map[record.id];
  map[record.id] = {
    ...record,
    createdAt: existing?.createdAt || record.updatedAt,
  };
  await writeMap(map);
  return map[record.id];
}

// Remove a series by id.
export async function remove(id) {
  const map = await readMap();
  delete map[id];
  await writeMap(map);
}

// Total count, handy for the UI header.
export async function count() {
  const map = await readMap();
  return Object.keys(map).length;
}

// Merge an array of records into storage. Used by Import.
// Conflicts resolve last-write-wins by updatedAt, which is the same rule the
// planned cloud sync will use, so this code carries forward into Phase 3.
// Returns a small summary for user feedback.
export async function importRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error("Import data must be an array of series records.");
  }
  const map = await readMap();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const rec of records) {
    // Validate the minimum shape so a bad file can't poison the store.
    if (!rec || typeof rec.id !== "string" || typeof rec.chapter !== "string") {
      skipped++;
      continue;
    }
    const existing = map[rec.id];
    if (!existing) {
      map[rec.id] = { ...rec, createdAt: rec.createdAt || rec.updatedAt };
      added++;
    } else if ((rec.updatedAt || "") >= (existing.updatedAt || "")) {
      // Incoming record is newer (or equal): take it, keep original createdAt.
      map[rec.id] = { ...existing, ...rec, createdAt: existing.createdAt };
      updated++;
    } else {
      skipped++; // existing copy is newer, leave it
    }
  }

  await writeMap(map);
  return { added, updated, skipped, total: Object.keys(map).length };
}
