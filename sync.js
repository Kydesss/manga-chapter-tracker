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
import { SITES } from "./parser.js";
import { mergeRemoteIntoLocal } from "./merge.js";
import {
  migrate,
  getMap,
  getAllRaw,
  writeAll,
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

// Concurrency control: one pass at a time; coalesce a request that arrives mid-pass.
let running = false;
let runAgain = false;
let lastRunAt = 0;

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

function fromRow(row) {
  return {
    id: row.id,
    site: row.site,
    slug: row.slug,
    title: row.title,
    chapter: row.chapter,
    chapterUrl: row.chapter_url,
    seriesUrl: row.series_url,
    siteName: SITE_NAME[row.site] || row.site,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: !!row.deleted,
  };
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
// no-ops when signed out, throttles the popup-open trigger, and coalesces
// overlapping calls behind a single in-flight pass.
export async function syncNow({ throttle = false } = {}) {
  const session = await getSession();
  if (!session) return { skipped: "signed-out" };

  if (throttle && Date.now() - lastRunAt < THROTTLE_MS) {
    return { skipped: "throttled" };
  }
  if (running) {
    runAgain = true;
    return { skipped: "in-progress" };
  }

  running = true;
  lastRunAt = Date.now();
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
    const localMap = await getMap();
    const { next } = mergeRemoteIntoLocal(localMap, remoteRecords);
    await writeAll(next);

    // 3. PUSH. On the very first sync, push everything so an empty (or partial)
    //    cloud receives the full local library. Afterwards, push only dirty.
    const all = Object.values(next);
    const pushRecords = firstTime ? all : all.filter((r) => r.dirty);
    const pushedIds = await push(pushRecords, userId);
    await markSynced(pushedIds);

    // 4. Advance the cursor using server timestamps (avoids clock-skew gaps).
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
  } finally {
    running = false;
    if (runAgain) {
      runAgain = false;
      // Run once more for the request that arrived mid-pass.
      syncNow();
    }
  }
}

function maxTimestamp(values) {
  let max = null;
  for (const v of values) {
    if (v && (max === null || v > max)) max = v;
  }
  return max;
}
