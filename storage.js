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

import { resolveConflict, pickTitle, hasChapter, chapterToNumber, sameSyncContent } from "./merge.js";
import { upgradeSiteUrl } from "./parser.js";
import { SESSION_KEY } from "./auth.js";

const KEY = "series"; // { [id]: record }
const SCHEMA_KEY = "schemaVersion";
// The largest server-assigned synced_at pulled so far (schema v7; before that
// it held client updated_at values). Set once any sync has run, so it also
// answers "has this device synced before?".
const CURSOR_KEY = "lastSyncCursor";
// Where a pull starts when the cursor has to be rebuilt: everything, once.
const CURSOR_START = "1970-01-01T00:00:00.000Z";
const SNAPSHOT_KEY = "preSyncSnapshot"; // safety backup before first-ever sync
// Whose library this is: { id, email } of the account it syncs with, or
// { unknown: true } for a library that synced before owners were recorded.
// Absent until the first sync claims it. See "Account ownership" below.
export const OWNER_KEY = "libraryOwner";
// Libraries set aside when another account took over this device, by owner id:
// { [id]: { owner, series, cursor, parkedAt } }. Restored when that account
// signs in again.
const PARKED_KEY = "parkedLibraries";
// Changes whenever a switch or merge replaces the active library. remove()
// tags what it returns with it, so an Undo held across a switch can't put one
// account's series into another account's library.
const EPOCH_KEY = "libraryEpoch";
const LIBRARY = Symbol("library");
const LOCK_NAME = "shiori-library";

// 2 = sync fields; 3 = status + series metadata fields; 4 = lastReadAt backfill;
// 5 = links moved off a site's old domain; 6 = library owner recorded;
// 7 = progressResetAt, and the cursor moves to the server's change order
const CURRENT_SCHEMA = 7;

const URL_FIELDS = ["chapterUrl", "seriesUrl", "latestChapterUrl"];

// The record with every link on a site's old domain moved to its current one.
// Returns the same object when nothing changed, so callers can detect a no-op.
export function withUpgradedUrls(record) {
  let next = record;
  for (const field of URL_FIELDS) {
    const upgraded = upgradeSiteUrl(record[field]);
    if (upgraded !== record[field]) {
      if (next === record) next = { ...record };
      next[field] = upgraded;
    }
  }
  return next;
}

const SERIES_DEFAULTS = {
  status: "reading",
  lastReadAt: null,
  // When the current chapter was set (a save, an advancing import, an Undo),
  // and when the series' reading history last restarted (a removal or a
  // deliberate move back). Both synced; see merge.js rule 5.
  progressAt: null,
  progressResetAt: null,
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
//   v5: links on a site's old domain move to its current one (natomanga.com ->
//       www.manganami.com). Same paths, so the chapter is unchanged. Not a
//       user edit: updatedAt and dirty stay as they were, and sync rewrites
//       old links it pulls the same way (sync.js fromRow).
//   v6: record the owner of a library that has synced before. Signed in at
//       upgrade: that account (switching accounts takes a sign-out and a
//       sign-in, so the current session is the one that has been syncing).
//       Signed out: unknown, and the next sign-in asks before syncing.
//   v7: progressResetAt (null) and progressAt on every record, here and in
//       parked libraries. progressAt comes from lastReadAt, which merges have
//       always kept with the chapter (updatedAt can't be used: a merge by an
//       older version bumps it on a stale chapter). Timestamps that older
//       versions stored in Postgres's "+00:00" form become "Z", so they match
//       what sync now reads. The cursor now holds the server's synced_at
//       instead of client edit times, so a set cursor (here and in parked
//       libraries) restarts from CURSOR_START: still "synced before", and the
//       next pull fetches everything once.
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
      if (from < 5) r = withUpgradedUrls(r);
      // progressAt comes from the read time the record had before this
      // upgrade, not the v4 guess above (Codex review, round 5).
      if (from < 7) r = toV7(r, original.lastReadAt);
      if (r !== original) {
        map[id] = r;
        migrated++;
      }
    }
    // One write for everything (chrome.storage applies a set call as a unit).
    // An interrupted upgrade then leaves nothing half-done: a retry starts
    // from the original records, not from ones the v4 step already guessed a
    // read time for (Codex review, round 6).
    await chrome.storage.local.set({
      [KEY]: map,
      ...(from < 6 ? await legacyOwnerUpdate() : {}),
      ...(from < 7 ? await parkedAndCursorUpdate() : {}),
      [SCHEMA_KEY]: CURRENT_SCHEMA,
    });
    return { migrated };
  });
}

async function parkedAndCursorUpdate() {
  const r = await chrome.storage.local.get([CURSOR_KEY, PARKED_KEY]);
  const update = {};
  if (r[CURSOR_KEY]) update[CURSOR_KEY] = CURSOR_START;
  if (r[PARKED_KEY]) {
    update[PARKED_KEY] = Object.fromEntries(
      Object.entries(r[PARKED_KEY]).map(([id, lib]) => {
        if (!lib) return [id, lib];
        const series = Object.fromEntries(
          Object.entries(lib.series || {}).map(([sid, rec]) => [sid, toV7({ ...SERIES_DEFAULTS, ...rec }, rec.lastReadAt)])
        );
        return [id, { ...lib, series, cursor: lib.cursor ? CURSOR_START : lib.cursor ?? null }];
      })
    );
  }
  return update;
}

const TIMESTAMP_FIELDS = [
  "createdAt",
  "updatedAt",
  "lastReadAt",
  "progressAt",
  "progressResetAt",
  "latestPublishedAt",
  "metadataCheckedAt",
];

// One format for every stored timestamp ("...123Z"), so the merge's string
// comparisons see the same moment as equal. Returns the same object when
// nothing changed.
export function withNormalTimestamps(record) {
  let next = record;
  for (const field of TIMESTAMP_FIELDS) {
    const v = record[field];
    if (typeof v !== "string") continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) continue;
    const normal = new Date(t).toISOString();
    if (normal !== v) {
      if (next === record) next = { ...record };
      next[field] = normal;
    }
  }
  return next;
}

// Optional timestamps the cloud stores as timestamptz. One that doesn't parse
// (an older backup import accepted any string) becomes null: unknown locally,
// and an upload Postgres would accept instead of rejecting the whole batch.
const NULLABLE_TIMESTAMP_FIELDS = ["lastReadAt", "progressAt", "progressResetAt", "latestPublishedAt", "metadataCheckedAt"];

export function withValidTimestamps(record) {
  let next = record;
  for (const field of NULLABLE_TIMESTAMP_FIELDS) {
    const v = record[field];
    if (v != null && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) {
      if (next === record) next = { ...record };
      next[field] = null;
    }
  }
  return next;
}

// A record brought up to schema v7 (see migrate). Same object if unchanged.
// progressAt comes from `readTime`: the read time the record already had, not
// one an earlier step of the same upgrade guessed from updatedAt (v4), since
// updatedAt may have been refreshed by an older version's merge on a stale
// chapter. With no read time it stays unknown, which a later reset treats as
// older than itself.
function toV7(record, readTime) {
  let r = withValidTimestamps(withNormalTimestamps(record));
  const t = typeof readTime === "string" ? Date.parse(readTime) : NaN;
  // An unreadable stored time (a backup could hold any string) stays unknown.
  if (hasChapter(r.chapter) && !r.progressAt && !Number.isNaN(t)) {
    r = { ...r, progressAt: new Date(t).toISOString() };
  }
  return r;
}

function needsFieldBackfill(r) {
  return (
    r.deleted === undefined ||
    r.dirty === undefined ||
    r.status === undefined ||
    r.lastReadAt === undefined ||
    r.progressAt === undefined ||
    r.progressResetAt === undefined ||
    METADATA_FIELDS.some((field) => r[field] === undefined)
  );
}

// --- Reads ----------------------------------------------------------------

// Visible library: non-deleted records. Used by the UI and Export.
export async function getAll() {
  const map = await readMap();
  return Object.values(map).filter((r) => !r.deleted);
}

// The visible library plus the epoch it belongs to, read together. Pages that
// let you act on a row hand the epoch back (remove), so a row still on screen
// from before a switch can't change the library that replaced it.
export async function getLibrary() {
  const r = await chrome.storage.local.get([KEY, EPOCH_KEY]);
  const records = Object.values(r[KEY] || {}).filter((x) => !x.deleted);
  return { records, epoch: r[EPOCH_KEY] || "initial" };
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
//
// A Plan-to-read save (no chapter) never erases progress: on a series you're
// already reading it changes nothing and returns the record as it was. A
// removed series has no progress to keep, so planning it starts it fresh.
//
// `resetProgress`: this save deliberately moves the series back (the popup
// warned and the user confirmed). It stamps progressResetAt with the save's
// own time, so sync keeps the earlier chapter instead of restoring the
// furthest one (merge.js rule 5).
export async function upsert(record, { resetProgress = false } = {}) {
  return withLibraryLock(async () => {
    const map = await readMap();
    const before = map[record.id];
    const saved = applySave(map, record, { resetProgress });
    if (saved !== before) await writeMap(map); // a real save makes a new record
    return saved;
  });
}

// Decide and save in one locked step: `decide(record, existing)` sees the
// series as it is under the lock (existing: the saved series, or null if
// absent or removed) and returns { action }. Only "save" writes, exactly as
// upsert does. Returns { action, saved } or { action, existing }. The
// keyboard shortcut uses this so a save that lands between its check and its
// write (another device's sync, the popup) can't be overwritten by a stale
// decision, and an account switch can't slip in between (Codex review).
export async function saveIfAllowed(record, decide) {
  return withLibraryLock(async () => {
    const map = await readMap();
    const current = map[record.id];
    const existing = current && !current.deleted ? current : null;
    const decision = decide(record, existing) || {};
    if (decision.action !== "save") return { ...decision, existing };
    const saved = applySave(map, record);
    await writeMap(map);
    return { ...decision, saved };
  });
}

// The body of a save, applied to `map` in place (the caller holds the lock
// and writes). Returns the series as saved, or the existing one unchanged for
// a Plan-to-read save on a series being read.
function applySave(map, record, { resetProgress = false } = {}) {
  const existing = map[record.id];
  if (!hasChapter(record.chapter) && existing && !existing.deleted && hasChapter(existing.chapter)) {
    return existing;
  }
  {
    // Never older than the record it replaces (a tombstone or a save stamped
    // ahead of this device's clock), so the save wins merges on recency.
    const updatedAt = existing ? stampAfter(record.updatedAt, existing.updatedAt) : record.updatedAt;
    map[record.id] = {
      ...SERIES_DEFAULTS,
      ...existing,
      ...record,
      title: pickTitle(record, existing),
      ...keepKnownMetadata(record, existing),
      status: record.chapter == null ? record.status || "plan" : "reading",
      deleted: false,
      dirty: true,
      updatedAt,
      createdAt: existing?.createdAt || record.updatedAt,
      // A save sets the chapter now, so it counts against any earlier reset.
      progressAt: hasChapter(record.chapter) ? updatedAt : null,
      progressResetAt: existing?.progressResetAt ?? null,
    };
    if (resetProgress && hasChapter(record.chapter)) {
      map[record.id].progressResetAt = map[record.id].updatedAt;
    }
    return map[record.id];
  }
}

// Merge many imported records (browser bookmarks today; a site importer if one
// comes back) with a single read and write. Not tied to any site: callers hand
// in parsed records. The rules:
//   - Reading position only moves forward. An import can advance a series or
//     start a Plan-to-read one, never move one back or blank it out.
//   - An imported chapter only counts if it's a number with a usable http(s)
//     link. Anything else ("Extra", a missing or unsafe link) is treated as no
//     chapter: it never replaces a working link or advances a series, and a new
//     or restored series arrives as Plan to read. A stored "Extra" could never
//     be advanced past, and sync can't push a chapter without its link.
//   - Duplicates within one import collapse to the furthest chapter.
//   - A series the user removed stays removed unless `restoreDeleted` is set.
//   - Resets are respected: a chapter only advances a series if it was set at
//     or after the series' progressResetAt (a deliberate move back, or a
//     removal and restart), and no earlier than the chapter already saved.
//     Its set time is the record's own progressAt when the source reports one
//     (a bookmark's date), else the time this write stamps.
//   - Unknown (null) metadata never erases what we already know, and an
//     import isn't a read: lastReadAt is only set when the source reports it.
//   - Metadata-only changes (covers, latest chapters) stay local: they don't
//     bump updatedAt or queue a sync, because the cloud doesn't store them.
//
// `epoch` (from getLibrary or previewBulkUpsert): the library the caller
// planned against. If a switch or merge has replaced it since, nothing is
// written and the result is { stale: true }.
export async function bulkUpsert(records, { timestamp = nowISO(), restoreDeleted = false, epoch } = {}) {
  if (!Array.isArray(records)) {
    throw new Error("Bulk import data must be an array of series records.");
  }

  return withLibraryLock(async () => {
    if (epoch !== undefined && epoch !== (await readEpoch())) return { stale: true };
    const plan = planBulkUpsert(await readMap(), records, { timestamp, restoreDeleted });
    await writeMap(plan.next);
    const { next, ...result } = plan;
    return result;
  });
}

// What bulkUpsert would do to the library right now, without writing: the
// same plan, plus the epoch to hand back to bulkUpsert.
export async function previewBulkUpsert(records, { timestamp = nowISO(), restoreDeleted = false } = {}) {
  if (!Array.isArray(records)) {
    throw new Error("Bulk import data must be an array of series records.");
  }
  const r = await chrome.storage.local.get([KEY, EPOCH_KEY]);
  const { next, ...plan } = planBulkUpsert(r[KEY] || {}, records, { timestamp, restoreDeleted });
  return { ...plan, epoch: r[EPOCH_KEY] || "initial" };
}

// The pure core of bulkUpsert: the next library map (a copy) and what happens
// to each series. `items` holds one entry per series after duplicates
// collapse: { id, title, siteName, outcome, chapter, from }, where outcome is
// one of "added-reading", "added-plan", "advanced", "unchanged", "enriched",
// "removed", "before-reset", or "older-bookmark". `chapter` is the imported
// chapter (for a skip, the furthest one that couldn't be applied); `from` is
// the library's chapter before.
export function planBulkUpsert(map, records, { timestamp = nowISO(), restoreDeleted = false } = {}) {
  const next = { ...map };
  const groups = new Map(); // id -> every usable record for that series
  let skipped = 0;

  for (const raw of records) {
    if (!isImportableRecord(raw)) {
      skipped++;
      continue;
    }
    // Timestamps in one format, and unreadable ones dropped (Codex review,
    // round 8), as for migrations and backups.
    const record = withUsableChapter(withValidTimestamps(withNormalTimestamps(withUpgradedUrls(raw))));
    const list = groups.get(record.id);
    if (list) list.push(record);
    else groups.set(record.id, [record]);
  }

  const counts = { added: 0, advanced: 0, enriched: 0, unchanged: 0, removed: 0, beforeReset: 0, olderBookmark: 0 };
  const items = [];

  for (const [id, candidates] of groups) {
    const existing = next[id];
    const live = existing && !existing.deleted ? existing : null;
    // When a candidate's chapter counts as set: the source's own time, else
    // the time this write will stamp (after the record it replaces).
    const setTime = (rec) =>
      sourceProgressTime(rec, timestamp) || (existing ? stampAfter(timestamp, existing.updatedAt) : timestamp);
    // Why a candidate's chapter can't be applied, or null if it can:
    //   "before-reset": set before the series' reset (merge.js rule 5).
    //   "older-bookmark": set before the chapter already saved here. Taking it
    //     would replace newer progress with older evidence, which can lose to
    //     a reset this device hasn't pulled yet, taking the newer progress
    //     with it (Codex review).
    const blocked = (rec) => {
      if (!existing || !hasChapter(rec.chapter)) return null;
      const at = setTime(rec);
      if (existing.progressResetAt && at < existing.progressResetAt) return "before-reset";
      if (live && hasChapter(live.chapter) && live.progressAt && at < live.progressAt) return "older-bookmark";
      return null;
    };
    // Duplicates collapse only after each one is checked against the series,
    // so a usable bookmark isn't lost behind a further one that isn't. Ties
    // go to the one set more recently, whatever the order they arrived in.
    const chapters = candidates.filter((c) => hasChapter(c.chapter));
    const best = (list) =>
      list.reduce((a, b) => {
        if (!a) return b;
        const c = compareChapterProgress(b.chapter, a.chapter);
        if (c !== 0) return c > 0 ? b : a;
        return setTime(b) > setTime(a) ? b : a;
      }, null);
    const pick = best(chapters.filter((c) => !blocked(c)));
    const furthest = best(chapters);
    // Title and metadata from every duplicate; the chapter (and its times)
    // only from the pick.
    const base = candidates.reduce((a, b) => preferFurtherRecord(a, b));
    const incoming = {
      ...base,
      chapter: pick?.chapter ?? null,
      chapterUrl: pick?.chapterUrl ?? null,
      lastReadAt: pick?.lastReadAt ?? null,
      progressAt: pick?.progressAt ?? null,
    };
    const setAt = sourceProgressTime(incoming, timestamp);
    const item = {
      id,
      title: pickTitle(live || incoming, incoming) || id,
      siteName: incoming.siteName || existing?.siteName || incoming.site,
      chapter: pick?.chapter ?? furthest?.chapter ?? null,
      from: live && hasChapter(live.chapter) ? live.chapter : null,
    };

    if (existing?.deleted && !restoreDeleted) {
      counts.removed++;
      items.push({ ...item, outcome: "removed" });
      continue;
    }
    if (!live) {
      const added = normalizeImportedRecord(incoming, timestamp, existing, setAt);
      next[id] = added;
      counts.added++;
      items.push({ ...item, chapter: added.chapter, outcome: hasChapter(added.chapter) ? "added-reading" : "added-plan" });
      continue;
    }

    const isFurther = (rec) =>
      !!rec && (!hasChapter(live.chapter) || compareChapterProgress(rec.chapter, live.chapter) > 0);
    const shouldAdvance = isFurther(pick);
    // A further chapter that couldn't be applied: say why, rather than
    // calling the series up to date.
    const skipReason = !shouldAdvance && isFurther(furthest) ? blocked(furthest) : null;

    const merged = {
      ...SERIES_DEFAULTS,
      ...live,
      siteName: incoming.siteName || live.siteName,
      title: pickTitle(incoming, live),
      seriesUrl: incoming.seriesUrl || live.seriesUrl,
      ...keepKnownMetadata(incoming, live),
      deleted: false,
    };

    if (shouldAdvance) {
      merged.status = "reading";
      merged.chapter = incoming.chapter;
      merged.chapterUrl = incoming.chapterUrl ?? null;
      // Sources rarely say when a chapter was read. Keep the last known read
      // time instead of stamping the import time, which would make every
      // imported series look freshly read.
      if (incoming.lastReadAt) merged.lastReadAt = incoming.lastReadAt;
    }

    const quietOutcome = skipReason || null;
    if (sameImportContent(live, merged)) {
      bump(counts, quietOutcome || "unchanged");
      items.push({ ...item, chapter: quietOutcome ? furthest.chapter : item.chapter, outcome: quietOutcome || "unchanged" });
      continue;
    }

    const syncRelevantChange = !sameImportSyncContent(live, merged);
    merged.updatedAt = syncRelevantChange ? stampAfter(timestamp, live.updatedAt) : live.updatedAt;
    // When the chapter was set: the source's time if it reported one (already
    // checked against the reset and the saved chapter above), else this write.
    if (shouldAdvance) merged.progressAt = setAt || merged.updatedAt;
    merged.dirty = syncRelevantChange ? true : live.dirty === true;
    next[id] = merged;
    const outcome = shouldAdvance ? "advanced" : quietOutcome || "enriched";
    bump(counts, outcome);
    items.push({ ...item, chapter: quietOutcome ? furthest.chapter : item.chapter, outcome });
  }

  return {
    next,
    ...counts,
    skipped,
    processed: groups.size,
    total: Object.values(next).filter((r) => !r.deleted).length,
    items,
  };
}

const OUTCOME_COUNTS = {
  advanced: "advanced",
  enriched: "enriched",
  unchanged: "unchanged",
  "before-reset": "beforeReset",
  "older-bookmark": "olderBookmark",
};

function bump(counts, outcome) {
  counts[OUTCOME_COUNTS[outcome]]++;
}

// When an imported chapter was set, as the source reports it (a bookmark's
// date): a valid time no later than the import itself, or null if unknown.
function sourceProgressTime(record, timestamp) {
  if (!hasChapter(record.chapter) || typeof record.progressAt !== "string") return null;
  const t = Date.parse(record.progressAt);
  if (Number.isNaN(t)) return null;
  const limit = Date.parse(timestamp);
  return new Date(Number.isNaN(limit) ? t : Math.min(t, limit)).toISOString();
}

// `existing`: a removed series being restored (restoreDeleted), if any. Its
// reset marker is kept, so a device that missed the removal can't bring the
// old chapter back. An import never sets a marker of its own.
function normalizeImportedRecord(record, timestamp, existing, setAt = null) {
  const updatedAt = existing ? stampAfter(timestamp, existing.updatedAt) : timestamp;
  const progressAt = setAt || updatedAt;
  // Restoring a removed series: a chapter from before its reset doesn't count.
  const beforeReset = !!existing?.progressResetAt && progressAt < existing.progressResetAt;
  const chapter = hasChapter(record.chapter) && !beforeReset ? record.chapter : null;
  return {
    ...SERIES_DEFAULTS,
    ...record,
    status: chapter == null ? "plan" : "reading",
    chapter,
    chapterUrl: chapter == null ? null : record.chapterUrl ?? null,
    // Unknown unless the source reported it: an import is not a read.
    lastReadAt: chapter == null ? null : record.lastReadAt ?? null,
    progressAt: chapter == null ? null : progressAt,
    progressResetAt: existing?.progressResetAt ?? null,
    createdAt: existing?.createdAt || record.createdAt || timestamp,
    updatedAt,
    deleted: false,
    dirty: true,
  };
}

// Collapse two imported records for the same series: the furthest chapter and
// its URL travel together, while a real title and any known metadata are kept
// from whichever duplicate had them.
function preferFurtherRecord(a, b) {
  let winner = a;
  if (hasChapter(b.chapter) && (!hasChapter(a.chapter) || compareChapterProgress(b.chapter, a.chapter) > 0)) {
    winner = b;
  }
  const other = winner === a ? b : a;
  return {
    ...winner,
    title: pickTitle(winner, other),
    siteName: winner.siteName || other.siteName,
    lastReadAt: winner.lastReadAt ?? null,
    ...keepKnownMetadata(winner, other),
  };
}

// An imported chapter only counts if we can rank it (a number) and open it (an
// http(s) link, which sync also needs). Otherwise the record is treated as
// having no chapter, so it can only add or enrich a Plan-to-read series.
function withUsableChapter(record) {
  if (chapterToNumber(record.chapter) !== null && isHttpUrl(record.chapterUrl)) return record;
  return { ...record, chapter: null, chapterUrl: null, lastReadAt: null };
}

function isHttpUrl(raw) {
  if (typeof raw !== "string") return false;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Compare two chapter labels: 1 if a is further, -1 if behind, 0 if equal.
// Labels that aren't numbers compare as "behind" unless identical, so they
// never advance a series.
function compareChapterProgress(a, b) {
  const an = Number.parseFloat(a);
  const bn = Number.parseFloat(b);
  if (Number.isNaN(an) || Number.isNaN(bn)) return a === b ? 0 : -1;
  return Math.sign(an - bn);
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
  "progressAt",
  "progressResetAt",
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

// The fields the cloud stores (see sync.js toRow), plus status.
const IMPORT_SYNC_FIELDS = [
  "site",
  "slug",
  "title",
  "seriesUrl",
  "status",
  "chapter",
  "chapterUrl",
  "lastReadAt",
  "progressAt",
  "progressResetAt",
  "deleted",
];

function sameImportSyncContent(a, b) {
  return IMPORT_SYNC_FIELDS.every((field) => (a[field] ?? null) === (b[field] ?? null));
}

// Soft delete: tombstone the record so the deletion can sync. The UI filters
// tombstones out, so this looks like a normal removal. Returns the series as it
// was just before (read under the same lock), so an Undo can bring back exactly
// that; null if there was nothing to remove.
// `epoch` (from getLibrary): the library the caller was showing. If a switch
// or merge has replaced it since, nothing is removed and this returns false.
export async function remove(id, { epoch } = {}) {
  return withLibraryLock(async () => {
    if (epoch !== undefined && epoch !== (await readEpoch())) return false;
    const map = await readMap();
    const existing = map[id];
    if (!existing) return null;
    // Strictly later than the record it replaces: an Undo can stamp ahead of
    // this device's clock, and a remove that sorted before it would lose.
    // The removal also restarts the reading history: once the series comes
    // back, a device that never saw the removal can't revive the old chapter.
    const updatedAt = laterThan(existing.updatedAt);
    map[id] = { ...existing, deleted: true, dirty: true, updatedAt, progressResetAt: updatedAt };
    await writeMap(map);
    // Non-enumerable: invisible to spreads, storage, and comparisons.
    return Object.defineProperty({ ...existing }, LIBRARY, { value: await readEpoch() });
  });
}

async function readEpoch() {
  const { [EPOCH_KEY]: epoch } = await chrome.storage.local.get(EPOCH_KEY);
  return epoch || "initial";
}

function newEpoch() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// `wanted`, unless that would sort at or before `prior`: then just after `prior`.
function stampAfter(wanted, prior) {
  const w = Date.parse(wanted);
  const p = Date.parse(prior);
  if (Number.isNaN(p) || (!Number.isNaN(w) && w > p)) return wanted;
  return new Date(p + 1).toISOString();
}

// A timestamp strictly later than `iso`, and no earlier than now. Device clocks
// drift, so "now" alone can sort before a tombstone written elsewhere.
function laterThan(iso) {
  const now = Date.now();
  const t = Date.parse(iso);
  return new Date(Number.isNaN(t) ? now : Math.max(now, t + 1)).toISOString();
}

// Undo a remove. `previous` is what remove() returned: the series as it was.
// The record may have changed since: a sync can rewrite the tombstone (a stale
// device's deletion carries its own older chapter), or a save can bring the
// series back at another chapter. Either way the restore merges `previous`
// with what's there now, as two live records: the furthest chapter wins, so
// Undo never leaves it lower than when it was removed. The result is stamped
// strictly newer than the current record, so it wins wherever that synced, and
// under the merge rule a resurrecting save restarts from itself.
// Returns the series as it now stands, or null when there's nothing to restore
// (no record, or a live one and no `previous` to merge), or false when the
// active library was switched or merged since the remove: that Undo belongs to
// a library that isn't here any more.
export async function restore(id, previous = null) {
  return withLibraryLock(async () => {
    if (previous?.[LIBRARY] !== undefined && previous[LIBRARY] !== (await readEpoch())) {
      return false;
    }
    const map = await readMap();
    const current = map[id];
    if (!current) return null;
    const usable = previous?.id === id ? previous : null;
    if (!current.deleted && !usable) return null;

    const updatedAt = laterThan(current.updatedAt);
    // Undo reverses the removal, so the removal's reset doesn't apply between
    // these two: both chapters count as set now, and the furthest one wins
    // (a stale device's removal can carry a further chapter than `previous`).
    // The marker itself stays on the series, so progress from before the
    // removal held only by devices that never saw it still can't come back.
    const merged = resolveConflict(
      { ...(usable || current), deleted: false, updatedAt, progressAt: updatedAt },
      { ...current, deleted: false, progressAt: updatedAt }
    );
    // Already live and already at least as far along: nothing to change.
    if (
      !current.deleted &&
      merged.chapter === current.chapter &&
      merged.chapterUrl === current.chapterUrl
    ) {
      return current;
    }
    map[id] = { ...SERIES_DEFAULTS, ...current, ...merged, deleted: false, dirty: true, updatedAt };
    await writeMap(map);
    return map[id];
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

// Clear the dirty flag on records after a confirmed push, but only where the
// record still holds exactly what was pushed. Comparing updatedAt alone isn't
// enough: a JSON import can raise the chapter while keeping the timestamp (the
// merge keeps the newer of the two), and that change must still be pushed.
export async function markSynced(pushed) {
  if (!pushed?.length) return;
  return withLibraryLock(async () => {
    const map = await readMap();
    for (const sent of pushed) {
      const current = map[sent.id];
      if (current && sameSyncContent(current, sent)) {
        map[sent.id] = { ...current, dirty: false };
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

// --- Account ownership ----------------------------------------------------
//
// A library syncs with one account. Signing out keeps it on the device, usable
// offline. Signing in as a different account must never push it into that
// account's cloud by accident: the sync engine checks the owner first
// (ensureOwner) and pauses until the user chooses (switchLibrary or
// adoptLibrary). The callers in sync.js hold the sync lock, so a pass never
// runs halfway through an ownership change.

async function readOwnerState() {
  const r = await chrome.storage.local.get([OWNER_KEY, CURSOR_KEY, EPOCH_KEY]);
  return { owner: r[OWNER_KEY] || null, cursor: r[CURSOR_KEY] || null, epoch: r[EPOCH_KEY] || "initial" };
}

export async function getOwner() {
  return (await readOwnerState()).owner;
}

// The v6 owner record, as part of migrate()'s single write ({} if none).
async function legacyOwnerUpdate() {
  const r = await chrome.storage.local.get([OWNER_KEY, CURSOR_KEY, SESSION_KEY]);
  if (r[OWNER_KEY] || !r[CURSOR_KEY]) return {};
  const user = r[SESSION_KEY]?.user;
  const owner = user?.id ? ownerOf(user) : { unknown: true };
  return { [OWNER_KEY]: owner };
}

// How this library relates to the signed-in user:
//   "match"    - it's theirs.
//   "claim"    - unowned and never synced: the first sync makes it theirs
//                (a merge, never a replace; cloud-sync-design Invariant 2).
//   "switch"   - another account's, but with no series in it: set it aside
//                without asking.
//   "mismatch" - another account's (or an unknown one's) with series in it:
//                ask before syncing anything.
function classifyOwner({ owner, cursor }, map, user) {
  if (owner?.id && owner.id === user.id) return "match";
  if (!owner && !cursor) return "claim";
  const hasSeries = Object.values(map).some((r) => !r.deleted);
  return hasSeries ? "mismatch" : "switch";
}

// Read-only version of the check, for showing status without syncing.
export async function ownerStatus(user) {
  const state = await readOwnerState();
  const status = classifyOwner(state, await readMap(), user);
  return { status, owner: state.owner || { unknown: true }, epoch: state.epoch };
}

// The check a sync pass runs before touching the cloud. Claims an unowned
// library and switches away from an empty one; otherwise reports a mismatch.
// Returns { ok: true } when the pass may continue, or { ok: false, owner }.
export async function ensureOwner(user) {
  return withLibraryLock(async () => {
    const state = await readOwnerState();
    const map = await readMap();
    const status = classifyOwner(state, map, user);
    if (status === "mismatch") {
      return { ok: false, owner: state.owner || { unknown: true }, epoch: state.epoch };
    }
    if (status === "switch") {
      await swapLibrary(state, map, user);
    } else if (status === "claim" || state.owner.email !== (user.email || null)) {
      await chrome.storage.local.set({ [OWNER_KEY]: ownerOf(user) });
    }
    return { ok: true, claimed: status === "claim", switched: status === "switch" };
  });
}

// "Keep separate": set the current library aside under its owner and load the
// signed-in account's (its own set-aside library, or an empty one that the
// next sync fills from its cloud). Not offered for an unknown owner, whose
// set-aside library no sign-in would ever bring back.
// `epoch`: the library the user was asked about; refused if it has changed.
export async function switchLibrary(user, { epoch } = {}) {
  return withLibraryLock(async () => {
    const state = await readOwnerState();
    if (epoch !== undefined && epoch !== state.epoch) return { switched: false, stale: true };
    if (!state.owner?.id) {
      throw new Error("This library's account is unknown, so it can't be set aside.");
    }
    if (state.owner.id === user.id) return { switched: false };
    await swapLibrary(state, await readMap(), user);
    return { switched: true };
  });
}

// "Merge": the user chose to add this library to the signed-in account. The
// cursor resets, so the next sync is a first sync for that account: pull all of
// its cloud, merge, push everything. Removed series are dropped first: merging
// adds what you're reading; it doesn't replay the other account's removals.
// If this account has a library parked on this device, it's folded in too
// (with its own removals), so its unsynced changes aren't stranded.
export async function adoptLibrary(user, { epoch } = {}) {
  return withLibraryLock(async () => {
    if (epoch !== undefined && epoch !== (await readEpoch())) return { adopted: 0, stale: true };
    const map = await readMap();
    // The other account's history stays with it: its removals are dropped,
    // and so are its reset markers, which would otherwise disqualify this
    // account's own further progress on the same series.
    for (const id of Object.keys(map)) {
      if (map[id].deleted) delete map[id];
      else if (map[id].progressResetAt) map[id] = { ...map[id], progressResetAt: null };
    }
    const { [PARKED_KEY]: stored } = await chrome.storage.local.get(PARKED_KEY);
    const parked = { ...(stored || {}) };
    const mine = parked[user.id];
    delete parked[user.id];
    const next = mine ? mergeMaps(mine.series || {}, map) : map;
    // One write, so an interruption can't leave a half-finished merge.
    await chrome.storage.local.set({
      [KEY]: next,
      [PARKED_KEY]: parked,
      [OWNER_KEY]: ownerOf(user),
      [CURSOR_KEY]: null,
      [EPOCH_KEY]: newEpoch(),
    });
    return { adopted: Object.keys(next).length };
  });
}

function ownerOf(user) {
  return { id: user.id, email: user.email || null };
}

// Runs under the library lock. Parks the current library (series and cursor)
// under its owner and brings back the user's parked one, if any.
async function swapLibrary(state, map, user) {
  const { [PARKED_KEY]: stored } = await chrome.storage.local.get(PARKED_KEY);
  const parked = { ...(stored || {}) };
  const key = state.owner?.id || "unknown";
  const previous = parked[key];
  parked[key] = {
    owner: state.owner || { unknown: true },
    // Never overwrite a library already parked under this key: keep both.
    series: previous ? mergeMaps(previous.series || {}, map) : map,
    cursor: previous ? null : state.cursor,
    parkedAt: nowISO(),
  };
  const mine = parked[user.id];
  delete parked[user.id];
  // One write (chrome.storage applies a set call as a unit): an interruption
  // can't erase a library before it's parked, or pair one account's library
  // with another's cursor.
  await chrome.storage.local.set({
    [KEY]: mine?.series || {},
    [PARKED_KEY]: parked,
    [OWNER_KEY]: ownerOf(user),
    [CURSOR_KEY]: mine?.cursor || null,
    [EPOCH_KEY]: newEpoch(),
  });
}

function mergeMaps(a, b) {
  const out = { ...a };
  for (const [id, rec] of Object.entries(b)) {
    out[id] = out[id] ? resolveConflict(out[id], rec) : rec;
  }
  return out;
}

// --- Import ---------------------------------------------------------------

// Optional fields a backup may carry. The importer only validates required
// ones, so anything here that isn't a string is dropped rather than stored,
// where it could break rendering later.
const OPTIONAL_STRING_FIELDS = [
  "siteName",
  "chapterUrl",
  "createdAt",
  "updatedAt",
  "lastReadAt",
  "progressAt",
  "progressResetAt",
  "coverUrl",
  "latestChapter",
  "latestChapterUrl",
  "latestPublishedAt",
  "metadataCheckedAt",
];

function withStringOptionals(rec) {
  const out = { ...rec };
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (out[field] != null && typeof out[field] !== "string") out[field] = null;
  }
  return out;
}

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
// schema v3/v4 fields the same way the migration fills them, and links on a
// site's old domain move to its current one (v5).
function normalizeBackupRecord(raw) {
  const rec = withValidTimestamps(withNormalTimestamps(withUpgradedUrls(withStringOptionals(raw))));
  const chapter = rec.chapter ?? null;
  return {
    ...SERIES_DEFAULTS,
    ...rec,
    chapter,
    chapterUrl: chapter == null ? null : rec.chapterUrl ?? null,
    status: chapter == null ? "plan" : "reading",
    lastReadAt: rec.lastReadAt ?? (chapter == null ? null : rec.updatedAt ?? null),
    // From the backup's own times only. The lastReadAt guess above is for
    // display; if it counted as the set time, a stale chapter in a backup
    // (with a merge-refreshed updatedAt) could beat a reset. A backup made by
    // this version always has the field, and null there means "unknown", which
    // must survive export and re-import; only older backups, without the
    // field, fall back to their stored read time.
    progressAt:
      chapter == null
        ? null
        : rec.progressAt !== undefined
          ? rec.progressAt || null
          : rec.lastReadAt || null,
    deleted: rec.deleted === true,
    createdAt: rec.createdAt || rec.updatedAt,
  };
}
