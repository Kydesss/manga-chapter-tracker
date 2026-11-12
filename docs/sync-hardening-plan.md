# Sync hardening (plan)

Status: implemented and locally verified on `fix/sync-hardening` (2026-11-12).
Production dry run and migration application are pending. Three items from the
roadmap's Sync hardening list.

## 1. Saves from a page check what the page showed

**Problem.** The popup decides what a save means (advance, move back, plan)
from the series as it was when the popup drew, then calls `upsert`, which
writes unconditionally. Two gaps:

- An account switch in another window between drawing and clicking puts the
  save into the other account's library.
- A save landing in between (another device's sync, the shortcut, the library
  page) is overwritten by a decision made against the older series. The worst
  case: the popup says "will advance to 45", another device has meanwhile moved
  the series to 50, and the click writes 45 without the reset marker a move
  back needs.

**Fix.** `storage.saveChecked(record, { epoch, seenUpdatedAt, seenRecord, resetProgress })`
writes only if, under the library lock, the library is still the one the page
showed (`epoch`) and the series is still the version it showed
(`seenUpdatedAt`, the series' `updatedAt`, or null for "not saved"), and compares
the displayed sync fields (`seenRecord`). A merge can change progress without
advancing `updatedAt`, so the timestamp alone is insufficient. Otherwise
it returns `{ stale: "library" | "changed" }` and writes nothing; the popup
redraws with the current series and says why. The shortcut already decides
under the lock (`saveIfAllowed`), and Remove/Undo check the epoch.

## 2. Set current chapter (library page)

A **Set chapter** action on each row opens a small dialog: type a chapter
number, or paste the chapter's link.

- **The link.** The cloud keeps a chapter and its link together, so a chapter
  needs one. A pasted link must parse as a chapter of this same series. For a
  number, the link is built from the site's chapter shape: the built-in sites
  (`/manga/{slug}/chapter-{n}`, decimals as `83-2`) and custom sites whose
  chapter pattern has no `*` (whole numbers only, since the decimal style is
  unknown). Otherwise the dialog asks for the link. A built link is checked by
  parsing it back to the same series and chapter.
- **Direction.** Moving forward is an ordinary save. Moving back is spelled out
  ("Moves you back from 45 to 30; your other devices will keep 30") and the
  button says **Move back to 30**; the save sets the reset marker, so sync keeps
  it. A Plan-to-read series starts reading.
- **Safety.** The save goes through `saveChecked` with the row's epoch and
  version, so a change elsewhere while the dialog is open is caught, not
  overwritten.

## 3. Uploads only overwrite what the device last saw

**Problem.** A push is an unconditional upsert. Device A pulls chapter 40,
device B pushes 50, A pushes 41: the cloud holds 41 until B's next pass. It
converges, but other devices can pull the lower chapter in between. The first
sync is worse: it overwrites every cloud row blindly before merging.

**Fix: optimistic concurrency per row.** Each local record remembers
`cloudSyncedAt`, the server's `synced_at` of the cloud version it last merged
or wrote (local only, never compared as content). Pushes go through a new
database function, `push_series(rows jsonb)`, which for each row:

- with a base: updates the row only if its `synced_at` still equals the base;
- without a base, or if the row doesn't exist: inserts only if absent.

It returns each accepted row's new `synced_at`. Rejected rows stay dirty. The
client then fetches those rows by id, merges them with the usual rules, and
pushes again (up to three rounds per pass; anything left waits for the next
pass). Fetching by id, not by cursor, means a wrong or stale base (a restored
backup, an old row) costs one round trip instead of getting stuck.

- **Merge rules stay in one place** (`merge.js`). A server-side merge in SQL was
  the alternative; it would duplicate the reset and progress-time rules in a
  second language.
- **No cutover.** The table stays writable as before, so v0.4/v0.5 installs keep
  syncing (unprotected against this race, as today). A build that finds the
  function missing (migration not applied yet) falls back to the old upsert, so
  the extension and the migration can roll out in either order.
- `security invoker`: row-level security applies exactly as for direct writes,
  and `user_id` is always `auth.uid()`.
- **Rehearsal before applying**, as for schema v2: local Postgres (PGlite), then
  a rolled-back dry run on production. Applying it needs the owner's go-ahead.

Also in this migration: the RLS policies use `(select auth.uid())` (Supabase's
advisor; evaluated once per query instead of per row).

## Tests

Verified on 2026-11-12:
- Node suite includes checked-save regressions (including same-timestamp merges
  and retention of a newly learned cloud base), chapter input/link construction,
  concurrent pushes, first sync, stale bases, missing-function fallback, and the
  three-round retry limit.
- `node scripts/check-sync-ui.mjs` runs headless Chrome with a temporary profile
  and mocked Chrome APIs. Checks narrow-screen layout, initial focus, move-back
  saves and reset markers, same-timestamp stale dialogs, Escape/focus restoration,
  and stale popup redraws. Set `CHROME_PATH` if Chrome is elsewhere.
- The existing PGlite rehearsal passed 21 checks: inserts, accepted/stale updates,
  partial batches, created-time preservation, plan records, table constraints,
  authenticated user isolation, anon denial, and RLS policy expressions.
  It is preserved as `scripts/rehearse-push.mjs`. Run it with three arguments:
  a directory containing `node_modules/@electric-sql/pglite`, the schema-v2 SQL
  path, and the push-series SQL path. It uses an in-memory database only.
- Code review corrected timestamp-only save checks, preservation of current cloud
  bases through page saves, and queued dialog close events after a quick reopen.

Remaining release checks: rolled-back production rehearsal, owner approval before
applying the migration, and a real two-device smoke test after deployment.

- `saveChecked`: stale library, changed series, deleted meanwhile, unchanged.
- Popup flows in headless Chrome: a save after an outside change redraws instead
  of writing.
- Set chapter: link building (built-in, custom, `*`, decimals), pasted links
  (same series, other series, not a chapter), direction and reset marker, stale
  dialog.
- Push: the race above against the fake server (with `push_series` modelled),
  first sync with existing cloud rows, a stale base, the missing-function
  fallback, three-round limit.
