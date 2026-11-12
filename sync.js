// sync.js
// The sync engine: reconciles local storage with Supabase. Talks to PostgREST
// over fetch (no supabase-js). Pure conflict logic lives in merge.js; this file
// handles I/O, ordering, batching, the lock, and the cursor.
//
// Order of a pass is PULL -> MERGE -> PUSH. Pulling first means we incorporate
// remote progress (furthest chapter) before sending anything, so we never blindly
// overwrite a further chapter that another device wrote.

import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { getSession, getUserEmail, refreshSession } from "./auth.js";
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
  ownerStatus,
  ensureOwner,
  switchLibrary,
  adoptLibrary,
} from "./storage.js";

const REST = `${SUPABASE_URL}/rest/v1/series`;
const PUSH_BATCH = 500;
const PULL_PAGE = 1000;
const THROTTLE_MS = 30000;
// The cloud schema this build writes. Rows without it are rejected by the
// table (see supabase/migrations), so builds from before it can't push.
const CLIENT_SCHEMA = 2;
// Each pull re-reads this far behind the cursor: a row's synced_at is taken
// when it's written but becomes visible at commit, so a slow write can appear
// just behind rows already pulled. Rows read twice merge to the same result.
const PULL_OVERLAP_MS = 2 * 60 * 1000;

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
    chapter: rec.chapter ?? null,
    chapter_url: rec.chapterUrl ?? null,
    series_url: rec.seriesUrl,
    last_read_at: timestampOrNull(rec.lastReadAt),
    progress_at: timestampOrNull(rec.progressAt),
    progress_reset_at: timestampOrNull(rec.progressResetAt),
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    deleted: !!rec.deleted,
    client_schema: CLIENT_SCHEMA,
  };
}

// An optional timestamp Postgres will accept, or null. A value that doesn't
// parse would fail the whole upload batch, every pass. (Storage clears these
// on upgrade and import; this is the backstop.)
function timestampOrNull(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

// Postgres returns "...123+00:00" where the extension writes "...123Z". The
// merge compares timestamps as strings, so the same moment must read the same
// or every pulled row looks changed and is pushed back. Clients only write
// millisecond precision, so this loses nothing. (synced_at is left as the
// server sent it: it's only ever handed back to the server.)
function iso(value) {
  if (value == null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
}

// Links on a site's old domain (rows pushed before the site moved, or by a
// device on an older version) are read as the current domain, the same way
// the v5 migration rewrote local records, so both sides compare equal.
export function fromRow(row) {
  const updatedAt = iso(row.updated_at);
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
    // Taken as stored: null means unknown (an import), and must round-trip as
    // null or the record would look changed on every pass. The migration
    // filled both for rows written before these columns existed.
    lastReadAt: row.chapter == null ? null : iso(row.last_read_at),
    progressAt: row.chapter == null ? null : iso(row.progress_at),
    progressResetAt: iso(row.progress_reset_at),
    coverUrl: null,
    latestChapter: null,
    latestChapterUrl: null,
    latestPublishedAt: null,
    metadataCheckedAt: null,
    createdAt: iso(row.created_at),
    updatedAt,
    deleted: !!row.deleted,
  };
}

// The table keeps a chapter and its link together (both set, or both null for
// Plan to read). A record that breaks that (only possible from an old backup)
// would fail its whole batch, so it stays local and dirty instead.
function isCloudCompatible(rec) {
  const chapter = rec.chapter ?? null;
  const url = rec.chapterUrl ?? null;
  if (chapter === null) return url === null;
  return typeof chapter === "string" && typeof url === "string";
}

// --- Authenticated fetch (refreshes the token once on 401) ----------------

// Thrown when the signed-in account changes while a pass runs. The pass stops
// before it can merge one account's cloud into the other's library or push.
class AccountChanged extends Error {}

function userOf(session) {
  return { id: session.user.id, email: getUserEmail(session) };
}

// Every request in a pass is pinned to the account the pass started with.
async function authedFetch(url, opts, userId, allowRetry = true) {
  const session = await getSession();
  if (!session) throw new AccountChanged("Signed out during sync.");
  if (session.user?.id !== userId) throw new AccountChanged("Account changed during sync.");
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
    if (refreshed) return authedFetch(url, opts, userId, false);
  }
  return res;
}

// --- Pull / Push ----------------------------------------------------------

// Rows changed since `cursor` (a server synced_at), oldest first.
//   - Starts a little behind the cursor (PULL_OVERLAP_MS): a row's synced_at
//     is taken when it's written but becomes visible at commit.
//   - Stops at a watermark: the newest synced_at visible when the pull starts.
//     Rows written while a slow pull runs wait for the next pass, so they
//     can't move the cursor past an earlier-stamped row that commits late.
//   - Pages by (synced_at, id), so rows changing mid-pull can't shift a page.
// Returns { rows, watermark }; watermark is null when there's nothing to pull.
async function pull(cursor, userId) {
  const since = cursor ? new Date(Date.parse(cursor) - PULL_OVERLAP_MS).toISOString() : null;
  const sinceFilter = since ? `synced_at.gt.${JSON.stringify(since)}` : null;

  const top = await getRows(
    `select=synced_at&order=synced_at.desc&limit=1` + andFilter([sinceFilter]),
    userId
  );
  if (!top.length) return { rows: [], watermark: null };
  const watermark = top[0].synced_at;
  const upTo = `synced_at.lte.${JSON.stringify(watermark)}`;

  const rows = [];
  let last = null;
  for (;;) {
    const after = last
      ? `or(synced_at.gt.${JSON.stringify(last.synced_at)},and(synced_at.eq.${JSON.stringify(
          last.synced_at
        )},id.gt.${JSON.stringify(last.id)}))`
      : sinceFilter;
    const page = await getRows(
      `select=*&order=synced_at.asc,id.asc&limit=${PULL_PAGE}` + andFilter([upTo, after]),
      userId
    );
    rows.push(...page);
    if (page.length < PULL_PAGE) break;
    last = page[page.length - 1];
  }
  return { rows, watermark };
}

// PostgREST's logical filter: &and=(a,b,...), values JSON-quoted (safe for
// the "+" and ":" in timestamps once URL-encoded).
function andFilter(parts) {
  const present = parts.filter(Boolean);
  return present.length ? `&and=${encodeURIComponent(`(${present.join(",")})`)}` : "";
}

async function getRows(query, userId) {
  const res = await authedFetch(`${REST}?${query}`, { method: "GET" }, userId);
  if (!res.ok) throw new Error(`Pull failed (${res.status}): ${await res.text()}`);
  return res.json();
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
    }, userId);
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
// A library that belongs to another account is never synced: the result is
// { skipped: "account-mismatch", owner, user } until resolveAccount() runs.
export async function syncNow({ throttle = false } = {}) {
  const session = await getSession();
  if (!session) return { skipped: "signed-out" };

  // Checked before the throttle, so a paused library always reads as paused.
  await migrate();
  const user = userOf(session);
  const access = await ownerStatus(user);
  if (access.status === "mismatch") {
    return { skipped: "account-mismatch", owner: access.owner, user, epoch: access.epoch };
  }

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
    const user = userOf(session);
    const userId = user.id;
    // Before anything touches the cloud: is this library this account's?
    const access = await ensureOwner(user);
    if (!access.ok) {
      return { skipped: "account-mismatch", owner: access.owner, user, epoch: access.epoch };
    }
    const firstTime = !(await hasSyncedBefore());
    if (firstTime) await writeSafetySnapshot();

    // 1. PULL remote changes since our cursor.
    const cursor = await getCursor();
    const { rows, watermark } = await pull(cursor, userId);
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

    // 4. Advance the cursor to the pull's watermark. synced_at is set by the
    //    server, so a device's clock can't move it. Our own pushes don't move
    //    it: the next pull re-reads them and finds nothing to change.
    const newCursor = laterTimestamp(cursor, watermark);
    if (newCursor && newCursor !== cursor) await setCursor(newCursor);

    return {
      ok: true,
      pulled: rows.length,
      pushed: pushedIds.length,
      total: all.filter((r) => !r.deleted).length,
    };
  } catch (err) {
    // The pass that the account change triggers reports instead.
    if (err instanceof AccountChanged) return { skipped: "account-changed" };
    // Leave dirty flags and cursor untouched so the next pass retries cleanly.
    return { ok: false, error: err?.message || String(err) };
  }
}

// The user's answer to an account mismatch, run between passes (under the sync
// lock):
//   "separate" - set this library aside for its account and load this one's.
//   "merge"    - add this library to this account (its next sync merges both).
// `asked` is what the prompt showed: { userId, epoch } from the mismatch
// result. If the signed-in account or the library changed while the choice
// waited for the lock, nothing happens and the result says { stale: true }, so
// the user is asked again about what's actually there. Then call syncNow(). A
// no-op if the mismatch was already resolved elsewhere.
export async function resolveAccount(choice, asked = {}) {
  if (choice !== "separate" && choice !== "merge") {
    throw new Error(`Unknown choice: ${choice}`);
  }
  return withSyncLock(async () => {
    const session = await getSession();
    if (!session) throw new Error("Not signed in.");
    await migrate();
    const user = userOf(session);
    if (asked.userId !== undefined && asked.userId !== user.id) return { resolved: false, stale: true };
    const access = await ownerStatus(user);
    if (access.status !== "mismatch") return { resolved: false };
    if (asked.epoch !== undefined && asked.epoch !== access.epoch) return { resolved: false, stale: true };
    const result =
      choice === "separate"
        ? await switchLibrary(user, { epoch: asked.epoch })
        : await adoptLibrary(user, { epoch: asked.epoch });
    if (result.stale) return { resolved: false, stale: true };
    return { resolved: true };
  });
}

// The later of two server timestamps, compared as instants (the cursor may be
// in a different format from the rows, e.g. the schema v7 restart value).
function laterTimestamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Date.parse(b) >= Date.parse(a) ? b : a;
}
