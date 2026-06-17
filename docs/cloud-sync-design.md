# Design: Cloud Accounts and Sync (v0.2.0)

A design blueprint for adding optional accounts and cross-device sync to Manga Chapter Tracker. This is the planning artifact agreed before implementation.

## Decisions

- **Backend:** Supabase (Postgres + Auth + row-level security).
- **Sign-in:** Google OAuth, via `chrome.identity.launchWebAuthFlow` to obtain a Google **ID token** (see Authentication for why not `getAuthToken`).
- **Sync trigger:** on save, and on popup open (throttled, see Sync engine).
- **Transport:** direct PostgREST calls over `fetch`. No `supabase-js`, so the project keeps its current no-build, dependency-free setup.
- **Conflict rule:** reading progress is monotonic, furthest chapter wins (defined once under Conflict resolution).

## Goals

- The library follows a signed-in user across devices.
- The extension stays fully usable offline and without an account. Sign-in is purely additive.
- No data loss on first sign-in, on conflicts, or when offline edits are made on multiple devices.

## Non-goals (for v0.2.0)

- Realtime/live sync. We sync at defined moments, not continuously.
- Sharing libraries between users.
- Server-side business logic beyond table policies.
- Telemetry or analytics.

## Deferred to a later version

Cut from v0.2.0 to keep the first sync release focused. None of these block the core feature.

- **Tombstone purge.** At a few thousand records, tombstone growth is negligible. We keep tombstones and add purging later.
- **Multi-account handling.** v0.2.0 supports one account. Signing into a *different* account than the one whose data is local is treated as a later concern (the safety guard below still prevents silent cross-account merging).
- **"Resolved N differences" indicator.** Sync resolves silently in v0.2.0. The conflict-count indicator can be added afterward.
- **"Set current chapter" override.** The escape hatch for intentionally moving backward (see Conflict resolution) is a later addition.

## Architecture overview

```
        Extension (per device)                         Supabase
  +-------------------------------+            +-------------------------+
  |  popup.js / service worker    |            |  Auth (Google OAuth)    |
  |                               |            |                         |
  |  auth.js  --- ID token --->   | signIn     |  issues session (JWT)   |
  |                               | <--------- |                         |
  |  sync.js  --- push dirty -->  | PostgREST  |  series table           |
  |           <-- pull changes -- |  (fetch)   |  (row-level security    |
  |                               |            |   scoped to user_id)    |
  |  storage.js (chrome.storage)  |            |                         |
  +-------------------------------+            +-------------------------+
```

Local storage remains the source of truth the UI reads from. Sync reconciles it with the cloud in the background. The UI never blocks on the network.

## Data model

### Local record (extends the current shape)

The current record gains sync bookkeeping fields:

```jsonc
{
  "id": "natomanga.com:call-of-the-spear",
  "site": "natomanga.com",
  "slug": "call-of-the-spear",
  "title": "Call of the Spear",
  "chapter": "246",
  "chapterUrl": "https://www.natomanga.com/manga/call-of-the-spear/chapter-246",
  "seriesUrl": "https://www.natomanga.com/manga/call-of-the-spear",
  "createdAt": "2026-06-10T00:00:00Z",
  "updatedAt": "2026-06-17T00:00:00Z",
  "deleted": false,        // tombstone flag (see Deletions)
  "dirty": true            // changed locally, not yet pushed; LOCAL ONLY
}
```

`dirty` is local bookkeeping only. It is **stripped before pushing** to the cloud and is not a table column. Do not add it to the schema.

### Migration from v0.1.x

Records created before v0.2.0 have no `deleted` or `dirty` fields. On first run of v0.2.0, a one-time local migration backfills defaults (`deleted: false`, `dirty: false`) for every existing record, guarded by a stored `schemaVersion` so it runs once. Without this, the first sync would behave unpredictably on legacy records. This is the first thing that runs, before any sync path is reachable.

### Supabase table

```sql
create table public.series (
  user_id     uuid not null references auth.users (id) on delete cascade,
  id          text not null,            -- "site:slug", unique per user
  site        text not null,
  slug        text not null,
  title       text not null,
  chapter     text not null,
  chapter_url text not null,
  series_url  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null,
  deleted     boolean not null default false,
  primary key (user_id, id)
);

-- Speeds up the incremental pull query (records changed since a cursor).
create index series_user_updated_idx on public.series (user_id, updated_at);

alter table public.series enable row level security;

-- Each user can only see and modify their own rows.
create policy "own rows: select" on public.series
  for select using (auth.uid() = user_id);
create policy "own rows: insert" on public.series
  for insert with check (auth.uid() = user_id);
create policy "own rows: update" on public.series
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows: delete" on public.series
  for delete using (auth.uid() = user_id);
```

The composite primary key `(user_id, id)` means a user's records are unique by series, and the same series tracked by two different users are independent rows.

## Authentication (Google OAuth in Manifest V3)

### Token type: why `launchWebAuthFlow`, not `getAuthToken`

Supabase's `signInWithIdToken({ provider: "google", token })` requires a Google **ID token** (a JWT, ideally with a nonce). `chrome.identity.getAuthToken` returns an OAuth **access token**, which is the wrong type and cannot be exchanged this way. Therefore we use `chrome.identity.launchWebAuthFlow` against Google's OAuth endpoint requesting `response_type=id_token` with a nonce, which returns an ID token we can hand to Supabase. Choosing this up front avoids rebuilding the auth path later.

### Flow

1. `manifest.json` declares the `identity` permission, `host_permissions` for the Supabase project URL, and the Supabase anon key as a config constant.
2. `auth.js` runs `chrome.identity.launchWebAuthFlow` to obtain a Google ID token (with nonce).
3. We exchange it via `supabase.auth.signInWithIdToken` (called as a plain PostgREST/GoTrue REST request) for a Supabase session.
4. The session (access + refresh token) is stored in `chrome.storage.local` and rehydrated by the service worker on demand, since the popup and worker are short-lived in MV3. Access tokens are refreshed with the refresh token when expired; if refresh fails, we sign out gracefully and fall back to local-only.

### Setup prerequisites (one-time)

- A Google Cloud OAuth client and a **stable extension ID**. For an unpacked dev build, add a `key` to the manifest so the ID does not change between loads, and register the matching redirect URL (`https://<extension-id>.chromiumapp.org/`).
- Google enabled as an auth provider in the Supabase project.
- **Privacy policy and OAuth consent verification.** Because sign-in reads the account email, Google's consent screen may require a published privacy policy and app verification before users outside the test list can sign in. This can gate real-world sign-in, so it is tracked as a prerequisite even though publishing is later.

## Sync engine

State per record is tracked by `updatedAt` plus the `dirty` and `deleted` flags.

A sync pass (triggered on save, and on popup open, only when signed in):

1. **Acquire the sync lock.** If a pass is already running, coalesce (set a "run again after" flag) instead of starting a second one. This prevents the save-trigger and the popup-open-trigger from racing into overlapping passes.
2. **Push:** send all local records where `dirty === true` (including tombstones) to Supabase via upsert, **in batches** (for example 500 rows per request) so a large first sync does not exceed payload or rate limits. `dirty` is stripped from the payload.
3. **Pull:** fetch remote records changed since the cursor (`updated_at > lastSyncCursor`), **paged** for large result sets.
4. **Merge:** for each record present on both sides, apply the conflict rule below; for records present on only one side, take them as-is (never delete on absence).
5. **Advance the cursor and clear flags:** set `lastSyncCursor` to the **maximum `updated_at` actually returned by the server** (not the local clock, to avoid clock-skew gaps), and mark pushed records clean.
6. **Release the lock**, and if a "run again" was requested during the pass, run once more.

Throttling: the popup-open trigger is throttled to at most once per short interval (for example 30 seconds) so repeatedly opening the popup does not spam syncs.

Offline behavior: every local change sets `dirty = true`. If a sync fails (offline or error), flags persist, the cursor is not advanced, and the next successful pass catches up with exponential backoff between retries. No edits are lost.

### Conflict resolution

This is the single source of truth for how conflicts resolve. Reading progress is treated as special: it is **monotonic and only ever moves forward**. This prevents a stale device from sending you backward and losing your place in a long series.

When the same `id` exists on both sides, resolve field by field:

- **Deletion (`deleted`): most recent action wins, by `updatedAt`.** Resolved first. Deletion is explicit and intentional, so recency is the right signal. A newer delete sticks; a newer re-save resurrects the series. If the winning state is deleted, the record is a tombstone and the chapter is moot.
- **`chapter` (reading position): furthest chapter wins.** Parse both labels to numbers (handles decimals like `83.2`) and keep the higher one, independent of which record was written more recently. Example: local `120` updated three weeks ago beats cloud `100` updated yesterday, so you are never moved back. If a label cannot be parsed (should not happen given the parser), fall back to `updatedAt` so a bad value cannot blank out progress.
- **Other fields (title, URLs): newer by `updatedAt` wins.** Cosmetic, recency is fine.
- **`createdAt`: keep the earliest.**
- **Result timestamp:** the merged record's `updatedAt` is the max of the two, and it is marked `dirty` if the merge changed the local value, so the resolved value propagates outward.

**Known limitation (accepted):** because progress is forward-only, a normal save cannot move you to an *earlier* chapter (a reread, or a renumbered site). This is rare; the "set current chapter" override is deferred (see Deferred section).

### First sign-in merge

A user has local data and signs into an account that may already hold data (or may be empty).

- Treat both sides as inputs to the same conflict rule above: push all local records as dirty, pull all remote records, reconcile (deletion by recency, furthest chapter, cosmetic by recency).
- Net effect: the union of both libraries, with furthest reading progress preserved per series. Neither side is wiped.

## Data-safety invariants (the part that must not break)

These rules make local-to-cloud transitions seamless and prevent an empty or stale cloud from destroying local data. They are non-negotiable and must be covered by tests.

**Invariant 1: Absence is never deletion.** A pull applies only the records the cloud actually returns. It never deletes a local record just because the cloud response did not include it. The only thing that removes a record is an explicit tombstone (`deleted: true`). Consequence: an empty cloud cannot delete anything. This single rule defeats the "empty cloud overwrites local" scenario.

**Invariant 2: First sync is a merge, never a replace.** There is no code path that does "make local mirror the cloud" or "make the cloud mirror local." Both directions only ever upsert by `id` under the conflict rule. A first sign-in with local data and an empty cloud results in: push everything up, pull nothing, local unchanged, cloud now populated.

**Invariant 3: Push before clearing dirty.** Local `dirty` flags are cleared only after the cloud confirms the write. A failed or interrupted sync leaves the data intact and simply retries next time. Upserts are idempotent, so retries are safe.

**Invariant 4: Safety snapshot before first sync.** Immediately before a user's first-ever cloud sync, the extension writes an automatic local backup (the same JSON the Export feature produces) into `chrome.storage.local`. If anything goes wrong, the pre-sync library is recoverable. Cheap insurance for the highest-risk moment.

**Invariant 5: Account identity is checked.** The id of the signed-in user is recorded. If a different account signs in later, local data from the previous account is not silently merged into the new one (multi-account handling itself is deferred, but this guard ships).

### Local-to-cloud edge cases

| Scenario | Behavior | Why it is safe |
| --- | --- | --- |
| Offline user signs in, cloud is empty | All local records pushed up; nothing pulled; local untouched | Invariants 1 and 2: empty cloud has no records and no tombstones |
| Offline user signs in, cloud already has data | Union of both, resolved by the conflict rule per series | Merge, never replace; no side wiped |
| Same series, different chapters on each side | Furthest chapter kept, regardless of which was saved more recently | Progress is monotonic forward |
| Sync fails partway (network drops) | Pushed-but-unconfirmed records stay `dirty`; cursor not advanced; retried with backoff | Invariant 3 |
| User deletes a series on device A | Tombstone syncs; device B hides it on next pull | Deletion is explicit, not inferred from absence |
| User signs out | Local library stays as-is, usable offline; sync just stops | Local is always the UI's source of truth |
| User signs into a *different* account | Previous account's local data is not merged into the new account | Invariant 5 |
| Cloud returns a stale/partial response | Only returned rows are upserted; missing rows left alone | Invariant 1 |
| Two sync passes triggered at once | Second coalesces behind the first via the sync lock | No overlapping passes, no double push |

### Recommended first-sync sequence (explicit)

1. User signs in for the first time.
2. Write the safety snapshot (Invariant 4).
3. Acquire the sync lock.
4. Push all local records (all treated as `dirty`) to the cloud via batched upsert.
5. Pull all cloud records for this user (paged).
6. Merge pulled records into local by the conflict rule; never delete on absence.
7. On confirmed success, clear `dirty` flags and set `lastSyncCursor` from the server's max `updated_at`. Release the lock.

If any step fails, stop and retry later. Because nothing is deleted and flags are only cleared on success, a failure is always recoverable.

## Deletions (tombstones)

A hard delete cannot sync, because other devices have no way to learn the row is gone and would re-add it on the next pull.

- `remove(id)` becomes a **soft delete**: set `deleted = true`, bump `updatedAt`, set `dirty = true`. The UI filters out `deleted` records so it looks identical to today.
- Tombstones sync like any other record, so the deletion propagates everywhere.
- Purging old tombstones is **deferred** (see Deferred section); at this scale they are harmless to keep.

## UI changes

- A sign-in / sign-out control (small, in the footer next to Export/Import).
- A subtle sync status line: "Synced", "Syncing...", "Offline, will sync later", or "Sign in to sync".
- No change to the core save-and-browse flow.
- The "resolved N differences" conflict indicator is deferred.

## Security

- The Supabase **anon/publishable key is safe to ship** in the extension; it is designed to be public. Data protection comes from row-level security, not from hiding the key.
- The **service-role key is never** placed in the client.
- Session tokens live in `chrome.storage.local`, scoped to the extension origin.
- All access is constrained server-side by the RLS policies above.

## Milestones

Ordered so the two riskiest, plan-invalidating pieces come first.

1. **Auth spike.** Prove `launchWebAuthFlow` + `signInWithIdToken` end to end (stable extension ID, Google client, Supabase Google provider). This validates the token-type decision before anything is built on top of it.
2. **Local migration.** Backfill `deleted`/`dirty` on legacy records, guarded by `schemaVersion`.
3. **Provision Supabase.** Create the `series` table, index, and RLS policies (can be done directly via the connected Supabase tools).
4. **Storage changes.** Soft-delete `remove`; UI filters tombstones.
5. **Sync engine.** Batched push, paged pull, server-cursor tracking, the sync lock and throttle, conflict resolution, safety snapshot, backoff.
6. **UI.** Sign-in control and sync status.
7. **Testing.** See Verification plan.

## Risks and open questions

- **Auth token type (highest risk).** The whole auth path depends on getting a usable Google ID token from `launchWebAuthFlow`. Validated in Milestone 1 deliberately.
- **MV3 session lifetime.** The service worker can be killed anytime; the session must always be reloadable from storage, and access-token refresh handled when it expires mid-session.
- **OAuth verification.** Google may require privacy policy + app verification before non-test users can sign in.
- **Clock skew.** `updatedAt` is client-generated. The pull cursor uses the server's returned timestamps to avoid skew gaps; chapter conflicts use furthest-wins, not time, so they are immune to skew. If write-time skew ever matters, switch to server-set `updated_at` via a trigger.
- **Conflict granularity.** Resolution is per record (per series), which is right for a single-user tracker. No field-level merges beyond the rule above.

## Verification plan

- **Unit-test the merge, conflict rule, and tombstone logic** in Node with a mocked store (extends the existing Import test). Highest-priority assertions: (a) offline user signs into an empty cloud keeps all local data, and (b) a stale device with a lower chapter never overwrites a higher chapter.
- **Test the migration** backfills legacy records exactly once.
- **Test the sync lock** coalesces concurrent passes (no double push).
- **Test batching** with a synthetic library of several thousand records.
- **Manual two-profile test** in Chrome: sign into the same account in two profiles; confirm saves, edits, and deletions converge after a sync on each side.
