---
tags:
  - development
---

# Plan: cloud schema v2 (Plan to read, server change order, progress resets)

Status: **applied to the live project on 2026-11-12** as migration
`20261112164419 series_schema_v2` (the file in `supabase/migrations/` carries the same
version). Rehearsed first on local Postgres 17 (PGlite) and as a rolled-back dry run on
the live project; see the PR #8 test plan.

One cloud migration for four Sync hardening items on the roadmap. They're done
together because each needs a column on `public.series`, and every migration is a
compatibility event for installs that haven't updated.

| Roadmap item | What it needs in the cloud |
| --- | --- |
| Plan to read syncs | `chapter` and `chapter_url` become nullable |
| Sync cursor stops trusting device clocks (F3, PR #6 review) | a server-assigned `synced_at` |
| A deletion boundary that syncs (PR #3 review) | a synced `progress_reset_at` |
| Set current chapter (move back on purpose) | the same `progress_reset_at` |

## The live table today

Checked read-only on 2026-11-12: `public.series` matches the table in
`docs/cloud-sync-design.md` exactly, with one applied migration
(`20260617090334 create_series_table`). It holds 2,534 rows across 2 accounts (the
table summary's "2 rows" was a stale estimate).

## 1. Plan to read in the cloud

- `chapter` and `chapter_url` drop `not null`. A check constraint keeps them null
  together, so the cloud can never hold a chapter without its link or the reverse.
- **No `status` column yet.** Today the status follows from the chapter: no chapter is
  Plan to read, any chapter is Reading. A stored status could disagree with the chapter
  (an older client writes a chapter but can't update a column it doesn't know), so it
  waits until `completed` / `dropped` exist and status carries information of its own.
- **`last_read_at` syncs**, so "last read" and the library's sort agree across devices.
  The migration fills it from `updated_at` for existing rows with a chapter, so a null
  afterwards always means "unknown" (an import) and round-trips as null.
- **The metadata columns (covers, latest chapters) wait.** Nothing writes them since
  the NatoManga importer was removed, and they need their own merge rules (see the
  sync design addendum). They'll come with whatever source fills them.

## 2. A server change order for the sync cursor

**The problem.** The incremental pull asks for rows with `updated_at` after the
cursor. Devices set `updated_at` from their own clocks, so one row stamped ahead of real
time moves every device's cursor past rows other devices write afterwards, and those
rows are never pulled.

**The fix.** A `synced_at` column that only the server sets: a trigger overwrites it
with `clock_timestamp()` on every insert and update, whatever the client sent.
`updated_at` stays the client's edit time and keeps deciding conflicts.

- The cursor holds a server `synced_at` from now on. Storage schema v7 restarts a set
  cursor from the beginning, so the first pass after updating pulls everything once.
  That's harmless (merges are idempotent): about 2,500 rows today, three pages.
- **Overlap.** Server timestamps are taken when a row is written but become visible at
  commit, so a transaction can commit a row stamped just before a row already pulled.
  Each pull re-reads a 2-minute window behind the cursor. Rows read twice merge to the
  same result. This covers any write whose transaction takes under 2 minutes, which
  PostgREST requests do by a wide margin.
- **Watermark** (Codex review). Each pull first reads the newest visible `synced_at`
  and pages only up to it; the cursor moves to that watermark. Without it, a pull that
  took longer than the window could pick up a row written meanwhile on a later page,
  move the cursor past it, and leave behind an earlier-stamped row that committed after
  its page was read. The window would then not reach back far enough. With the
  watermark, a pull's duration doesn't matter: anything written during it waits for the
  next pass, which starts 2 minutes behind the watermark.
- **Paging** moves from `offset` to keyset (`synced_at`, then `id`), so rows changing
  mid-pull can't shift a page and skip a row. Filters go in one `and=(...)` parameter,
  with values JSON-quoted.
- Pushed rows don't move the cursor any more (their `synced_at` isn't known without
  asking for it back). The next pull re-reads them and finds nothing to change.
- **Timestamps are normalized on the way in.** Postgres returns `...957+00:00`; the
  extension writes `...957Z`. The merge compares timestamps as strings, so the same
  moment never compared equal and every pulled row was re-uploaded once (checked on the
  live rows). With the overlap window that would loop forever: each re-upload bumps
  `synced_at`, which puts the row back in the window. `fromRow` now converts pulled
  timestamps to the extension's format (clients only write milliseconds, so nothing is
  lost). `synced_at` itself is kept as the server sent it, since it's only handed back
  to the server.
- An index on `(user_id, synced_at)` replaces the role of the `updated_at` one, which
  stays for older clients.

## 3. One synced reset marker: `progress_reset_at`

Sync's rule is "the furthest chapter wins," which is what keeps a stale device from
moving you back. It also means a *deliberate* move back is undone by the next sync, and
a device that missed a removal revives the old chapter. Both are the same question:
**which progress counts?**

**The rule.** Each series carries `progressResetAt`: the moment its reading history
last restarted. Progress recorded before it doesn't count.

- The merged marker is the later of the two sides' markers.
- When both sides have a chapter, a side's chapter **competes only if its `progressAt`
  is at or after the marker**. `progressAt` is when that chapter was set: by a save, an
  import that advanced it, or an Undo. It travels with the chapter through merges.
  Among the sides that compete, the furthest wins, as before. A chapter that doesn't
  compete never beats Plan to read (Codex review, round 3). Only if both sides hold
  chapters and neither competes (bad clocks) does the newer side win.
- Everything else is unchanged: deletion by recency, "a chapter beats no chapter,"
  cosmetic fields by recency.

**What sets it.**

- **Removing a series** stamps it with the removal time. A device that never saw the
  removal holds the old chapter with an older `progressAt`, so after the series is
  restarted, that chapter no longer competes. This closes the PR #3 gap.
- **Saving an earlier chapter from the popup.** The popup already warns first ("This
  would move you back to chapter N") and the user confirms with **Update chapter**, so
  this save is deliberate. It stamps the marker with its own time, and sync keeps it.
  This is Set current chapter, using UI that exists.
- **Undo after a removal** reverses it, so between the removed record and what's there
  now, the removal's reset doesn't apply: both count as set at the Undo, and the
  furthest wins (a stale device's removal can carry a further chapter). The marker stays
  on the series, so older progress held only by devices that never saw the removal
  still can't come back.
- Imports (`bulkUpsert`, JSON backups) never set it: an import only moves forward.
- **Merge (account isolation) drops the other account's markers**, along with its
  removals (Codex review). Otherwise account A's restart would disqualify account B's
  own further progress on the same series.

**Why a separate `progressAt`** (Codex review). The first draft compared the marker with
`updatedAt`. But merges set `updatedAt` to the newer of the two records, so an older
install that pulls a restart and keeps its stale chapter 40 (by the old rule) also takes
the restart's newer `updatedAt`. After it updates, chapter 40 would look newer than the
reset and come back. `progressAt` moves only with the chapter. `lastReadAt` isn't used
because an Undo or an import sets a chapter without reading it, and "last read" should
stay honest for display. For records from before it existed, v7 takes `progressAt` from
`lastReadAt` as the record had it before the upgrade began (not the v4 step's guess from
`updatedAt` for v0.3 records, which have none: Codex review, round 5), which merges have
always kept with the chapter, and the migration fills
`progress_at` in the cloud from `updated_at`. **The merge reads `progressAt` only**, with
no fallback, and it is never inferred from `updatedAt` on a device (Codex review, rounds
2 and 3; a backup's `lastReadAt` can itself be a display guess from `updatedAt`, so it
doesn't count either): a record with no read time keeps an unknown
`progressAt`, and an unknown time counts as older than any reset. Only an import made
by the current version can produce one (nothing calls that import yet), and the cost is
that such a chapter loses to a reset made on another device.

**Equal chapters** (Codex review, round 2). When both sides hold the same chapter, the
one set more recently wins (then the one read more recently). Before, the local side
always won a tie, so two devices each kept their own read and set times, and with those
times now synced they uploaded them back and forth forever.

**Clock skew.** The marker comes from one device's clock and `progressAt` from another's.
Saves are already stamped later than the record they replace, so any device that has
pulled the reset stamps its next save after it. A device that hasn't pulled it is, by
definition, saving concurrently with the reset, and losing that save to the reset is an
accepted outcome (it's what the user asked for on the other device).

**Library page action (deferred).** A "Set current chapter" button in the library needs
a chapter link, and building links from patterns isn't safe for every site. For now the
move back happens from the chapter page, where the link is real.

## 4. Older installs: a hard cutover

Once the migration runs, installs that haven't updated would mishandle the new data:
they don't send `progress_reset_at`, and their furthest-chapter merge would re-push an
old chapter on top of a reset, undoing it everywhere.

**So older installs stop pushing.** A `client_schema` column is `not null` with no
default (existing rows get 2). An older client's upsert doesn't include it, Postgres
rejects the row, and that install shows "Sync failed" until it's updated. Nothing is
lost: its changes stay dirty locally and go up after the update. A check constraint
(`client_schema >= 2`) lets a later migration raise the floor the same way.

Older installs can still *pull*. The current `master` code already reads a null chapter
as Plan to read, so nothing breaks for them.

**Order of release:** apply the migration and update the extension together. A new
build talking to the old table fails too (unknown columns), so neither ships alone.

## 5. Local changes

- **Storage schema v7:** adds `progressResetAt: null` and `progressAt` (from
  `lastReadAt`) to existing records, normalizes timestamps an older version stored as
  `+00:00` (otherwise they'd differ from the cloud's forever and re-upload every pass;
  Codex review), and restarts a set cursor from `1970-01-01T00:00:00.000Z`. All of it
  applies to parked libraries too. The whole upgrade is one storage write, so an
  interruption can't leave records half-upgraded for a retry to misread, and a stored
  read time that doesn't parse leaves `progressAt` unknown instead of failing the
  upgrade (Codex review, round 6). Optional timestamps that don't parse become null,
  on upgrade, on backup import, on bulk import (round 8), and again in `toRow`, since Postgres would reject the
  whole upload batch (round 7). Clearing the cursor instead would make the device
  look like it had never synced, which changes the safety snapshot and the account
  check.
- `toRow` / `fromRow` carry `last_read_at`, `progress_at`, `progress_reset_at` and
  `client_schema`. `fromRow` reads a null `last_read_at` as null.
  Plan-to-read records push. The only record held back is one with a chapter but no
  link (possible only from an old backup), which the table's check would reject along
  with the rest of its batch.
- `merge.js` gains the reset rule. `progressAt`, `progressResetAt` and `lastReadAt`
  join the fields that decide whether a record differs from the cloud.
- `remove()` stamps the marker. `upsert()` takes `{ resetProgress: true }` from the
  popup's backward save.
- Backups export and import the marker and `progressAt`; their timestamps are
  normalized on the way in. A `progressAt` of null in a backup means "unknown" and
  stays null; only backups from before the field existed fall back to their stored
  read time (Codex review, round 4: otherwise export then re-import would promote a
  display guess into a set time).

## 6. Verification

- Unit tests for the merge rule: the stale-device revival, a deliberate move back
  surviving a stale device's furthest chapter, Undo after removal, and neither side
  competing.
- Sync tests, against a fake of the migrated table (`tests/fake-postgrest.js`: server
  `synced_at`, merge-only-sent-columns upserts, the `client_schema` and chapter-link
  checks, `+00:00` timestamps, logic filters, rows committed late): Plan-to-read
  records push; a far-future row doesn't hide later changes; a pass with nothing new
  pushes nothing, including records with an unknown read time or old `+00:00` times;
  2,500 rows that share timestamps page without gaps; a slow pull doesn't skip a row
  that commits late; the cursor restarts once on upgrade.
- Each Codex-review fix was also checked by undoing it alone and confirming its test
  fails.
- **Before applying to the live project:** run the migration on a Supabase branch (or
  a local Postgres) and confirm that an upsert without `client_schema` is rejected, the
  trigger overwrites a client-sent `synced_at`, and RLS still scopes rows to their owner.
- **After applying:** one manual two-device pass (Plan to read syncs; remove, restart,
  then sync a stale device; move back from the popup, then sync a stale device).

## Out of scope

Tombstone purge, the "Resolved N differences" indicator, a parked-library viewer,
metadata sync, and the library page's Set current chapter button.
