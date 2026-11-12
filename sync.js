// sync.js
// The sync engine: reconciles local storage with Supabase. Talks to PostgREST
// over fetch (no supabase-js). Pure conflict logic lives in merge.js; this file
// handles I/O, ordering, batching, the lock, and the cursor.
//
// Order of a pass is PULL -> MERGE -> PUSH. Pulling first means we incorporate
// remote progress (furthest chapter) before sending anything, so we never blindly
// overwrite a further chapter that another device wrote.

import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { getSession, refreshSession } from "./auth.js";
import { SITES, upgradeSiteUrl } from "./parser.js";
import { mergeRemoteIntoLocal } from "./merge.js";
import {
  migrate,
  getAllRaw,
  updateMap,
  markSynced,
  getCursor,
  setCursor,
  hasSyncedBefore,
  writeSafetySnapshot,
} from "./storage.js";

const REST = `${SUPABASE_URL}/rest/v1/series`;
const PUSH_BATCH = 500;
const PULL_PAGE = 1000;
const THROTTLE_MS = 30000;

// Concurrency control. The popup and the library page each import this module,
// so each has its own copy of this state. Within one context, requests that
// arrive mid-pass coalesce into a single follow-up pass. Across contexts, a
// Web Lock (shared by every page of the extension) runs whole passes one at a
// time; otherwise a stalled push from one context could land after another
// context had already pushed a newer change, overwriting it in the cloud.
// The storage lock (storage.js) stays separate, so saves never wait on the network.
const SYNC_LOCK = "shiori-sync";
let inFlight = null; // this context's running pass
let trailing = null; // the follow-up pass queued behind it
let lastRunAt = 0;

function withSyncLock(fn) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(SYNC_LOCK, () => fn()) : fn();
}

const SITE_NAME = Object.fromEntries(SITES.map((s) => [s.id, s.name]));

// --- Field mapping (local camelCase <-> table snake_case) ------------------

function toRow(rec, userId) {
  return {
    user_id: userId,
    id: rec.id,
    site: rec.site,
    slug: rec.slug,
    title: rec.title,
    chapter: rec.chapter,
    chapter_url: rec.chapterUrl,
    series_url: rec.seriesUrl,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    deleted: !!rec.deleted,
  };
}

// Links on a site's old domain (rows pushed before the site moved, or by a
// device on an older version) are read as the current domain, the same way
// the v5 migration rewrote local records, so both sides compare equal.
export function fromRow(row) {
  return {
    id: row.id,
    site: row.site,
    slug: row.slug,
    title: row.title,
    chapter: row.chapter,
    chapterUrl: upgradeSiteUrl(row.chapter_url),
    seriesUrl: upgradeSiteUrl(row.series_url),
    siteName: SITE_NAME[row.site] || row.site,
    status: row.chapter == null ? "plan" : "reading",
    // Before the dedicated cloud column exists, updated_at is the best
    // available approximation for when this synced chapter was saved.
    lastReadAt: row.chapter == null ? null : row.updated_at,
    coverUrl: null,
    latestChapter: null,
    latestChapterUrl: null,
    latestPublishedAt: null,
    metadataCheckedAt: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: !!row.deleted,
  };
}

// The current Supabase schema requires a chapter and chapter URL. Plan-to-read
// records remain local and dirty until the later nullable-column migration.
function isCloudCompatible(rec) {
  return typeof rec.chapter === "string" && typeof rec.chapterUrl === "string";
}

// --- Authenticated fetch (refreshes the token once on 401) ----------------

async function authedFetch(url, opts = {}, allowRetry = true) {
  const session = await getSession();
  if (!session) throw new Error("Not signed in.");
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  if (res.status === 401 && allowRetry) {
    const refreshed = await refreshSession();
    if (refreshed) return authedFetch(url, opts, false);
  }
  return res;
}

// --- Pull / Push ----------------------------------------------------------

async function pull(cursor) {
  const rows = [];
  let offset = 0;
  for (;;) {
    let url = `${REST}?select=*&order=updated_at.asc&limit=${PULL_PAGE}&offset=${offset}`;
    if (cursor) url += `&updated_at=gt.${encodeURIComponent(cursor)}`;
    const res = await authedFetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`Pull failed (${res.status}): ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PULL_PAGE) break;
    offset += PULL_PAGE;
  }
  return rows;
}

async function push(records, userId) {
  const ids = [];
  for (let i = 0; i < records.length; i += PUSH_BATCH) {
    const batch = records.slice(i, i + PUSH_BATCH).map((r) => toRow(r, userId));
    const res = await authedFetch(`${REST}?on_conflict=user_id,id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`Push failed (${res.status}): ${await res.text()}`);
    for (const row of batch) ids.push(row.id);
  }
  return ids;
}

// --- The pass -------------------------------------------------------------

// Trigger a sync. Returns a small status object. Safe to call often; it
// no-ops when signed out and throttles the popup-open trigger. A call that
// arrives while a pass is running waits for one follow-up pass and gets that
// pass's result, so a caller only hears "ok" once its change was pushed.
export async function syncNow({ throttle = false } = {}) {
  const session = await getSession();
  if (!session) return { skipped: "signed-out" };

  if (throttle && Date.now() - lastRunAt < THROTTLE_MS) {
    return { skipped: "throttled" };
  }
  if (inFlight) {
    trailing ??= inFlight.then(() => {
      trailing = null;
      return runPass();
    });
    return trailing;
  }
  return runPass();
}

function runPass() {
  lastRunAt = Date.now();
  const pass = withSyncLock(passOnce).finally(() => {
    if (inFlight === pass) inFlight = null;
  });
  inFlight = pass;
  return pass;
}

// One pull -> merge -> push pass, run under the cross-context sync lock.
async function passOnce() {
  // Re-read the session: it may have changed while this pass waited its turn.
  const session = await getSession();
  if (!session) return { skipped: "signed-out" };
  try {
    await migrate();
    const userId = session.user.id;
    const firstTime = !(await hasSyncedBefore());
    if (firstTime) await writeSafetySnapshot();

    // 1. PULL remote changes since our cursor.
    const cursor = await getCursor();
    const rows = await pull(cursor);
    const remoteRecords = rows.map(fromRow);

    // 2. MERGE into local (never deletes on absence; sets dirty where we differ).
    //    One locked read-merge-write, so a save or import page can't be lost.
    const next = await updateMap(
      (localMap) => mergeRemoteIntoLocal(localMap, remoteRecords).next
    );

    // 3. PUSH. On the very first sync, push everything so an empty (or partial)
    //    cloud receives the full local library. Afterwards, push only dirty.
    const all = Object.values(next);
    const pushRecords = (firstTime ? all : all.filter((r) => r.dirty)).filter(
      isCloudCompatible
    );
    const pushedIds = await push(pushRecords, userId);
    // Records edited while the push was in flight stay dirty for the next pass.
    await markSynced(pushRecords);

    // 4. Advance the cursor. Known gap: these updated_at values are client edit
    //    times (pushed by devices), not a server change order, so a record
    //    stamped ahead of real time can hide later changes from incremental
    //    pulls. Fixing it needs a server-assigned change column; see the
    //    roadmap's Sync hardening.
    const newCursor = maxTimestamp([
      cursor,
      ...rows.map((r) => r.updated_at),
      ...pushRecords.map((r) => r.updatedAt),
    ]);
    if (newCursor) await setCursor(newCursor);

    return {
      ok: true,
      pulled: rows.length,
      pushed: pushedIds.length,
      total: all.filter((r) => !r.deleted).length,
    };
  } catch (err) {
    // Leave dirty flags and cursor untouched so the next pass retries cleanly.
    return { ok: false, error: err?.message || String(err) };
  }
}

function maxTimestamp(values) {
  let max = null;
  for (const v of values) {
    if (v && (max === null || v > max)) max = v;
  }
  return max;
}
