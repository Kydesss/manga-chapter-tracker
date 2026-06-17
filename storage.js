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
