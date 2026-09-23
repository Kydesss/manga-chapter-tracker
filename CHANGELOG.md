---
tags:
  - development
---

# Changelog

All notable changes to this project are documented here. Versions follow the
extension's `manifest.json` version field.

## [Unreleased]

Jonah's `autoscraper` branch, targeting 0.4.0. It's not released yet: `manifest.json`
stays at 0.3.3 until the import has been tested live with a signed-in NatoManga
account. The design, phased plan, and pre-merge review are in
[docs/natomanga-bookmark-import-plan.md](./docs/natomanga-bookmark-import-plan.md).

### Added
- **NatoManga bookmark import ("Save bookmarks").** On any natomanga.com page, the popup
  shows a **Save bookmarks** button. One press imports every page of your NatoManga
  bookmarks into the library, using the NatoManga session already signed in on that tab.
  Shiori never asks for, sees, or stores NatoManga credentials. A bookmark is saved at
  the chapter its "Viewed" entry links to; one without becomes **Plan to read**. The
  newest-chapter link on the card is never used as your progress.
  The import runs in the service worker, so closing the popup doesn't cancel it, and its
  progress ("Importing page 3 of 18 · 42 found") and result show the next time the popup
  opens. Each page is saved as soon as it's read. If the import stops partway, because
  NatoManga signs you out or the tab closes or leaves NatoManga, the pages it finished
  stay saved, and the popup says where it stopped. Pages are fetched one at a time with
  a 15-second timeout. Timeouts and 429/5xx responses get up to three attempts with
  backoff. A page that fails is reported, and the other pages are still imported.
- **Plan to read.** You can now track a series before reading any of it
  (`status: "plan"`). It shows as "Plan to read" in the library, and clicking it opens
  the series page. On any of its chapters, the save area offers **Start reading**.
  Export and Import (JSON) keep Plan-to-read series.
- **Bulk import storage (`bulkUpsert`).** Merges an import page in one read and one
  write, removes duplicates, and reports how many series were added, advanced, enriched,
  unchanged, or skipped. Reading position only moves forward: an import can advance a
  series but never move it back, and an unread bookmark never replaces a series you're
  reading.
- **Real titles stick.** Imported series use NatoManga's real title instead of one built
  from the URL slug. Saving a chapter, re-importing, and syncing all keep it, along with
  any cover or latest-chapter details already collected.

### Changed
- **Storage schema v3 and v4.** Every record gets a `status` and fields reserved for
  upcoming covers and update tracking: `lastReadAt`, `coverUrl`, `latestChapter`,
  `latestChapterUrl`, `latestPublishedAt`, and `metadataCheckedAt`. The metadata fields
  are all `null` for now. A one-time migration fills them in on existing records
  without touching their chapters. It also sets each record's `lastReadAt` from its
  last save, and running it twice changes nothing.
- **"Last read" now means last read.** A library row shows when your reading position
  last changed (`lastReadAt`), not when the record last changed, and **Recently read**
  sorts by it. An import can't tell when you read a chapter, so imported series show no
  time and sort after the ones you've read.
- **JSON Import resolves conflicts the way sync does.** The furthest chapter wins, and a
  chapter beats Plan to read. Before, the newer record won, so restoring an old backup
  could move you back.
- **Sync: a chapter always beats no chapter.** A Plan-to-read record never replaces a
  chapter from another device, even if it's newer. And a title built from the URL slug
  never replaces a real one.
- **New `scripting` permission.** It lets the bookmark-page requests run inside your
  NatoManga tab, which is how they use your existing NatoManga session. Access to the tab
  still comes from `activeTab`, which Chrome grants when you click the toolbar icon. No
  new host permissions.
- **Sync keeps the new data local for now.** The cloud table requires a chapter, so
  Plan-to-read records stay on the device they were imported on. The new metadata fields
  are kept during sync conflict resolution but not uploaded. A Supabase migration will
  follow.

### Fixed
- **Migrations now run for local-only users.** Before, the schema migration ran only
  during a sync, which never happens when you're signed out. The popup now runs it when
  it opens, before any reads or syncing.
- **A save made while a sync was uploading could skip the cloud.** If you saved a
  series again while a sync was pushing it, the newer save could be marked as synced
  and never uploaded. It now stays queued for the next sync.

### Internal
- `natomanga.js`: a NatoManga bookmark-page parser with no dependencies. Its pure
  functions turn HTML strings into records, keep the selectors and labels in one place,
  and report a diagnostic for each card they can't read. Tested against saved fixture
  pages.
- **One writer at a time.** The popup and the service worker both write the library, so
  every read-modify-write in `storage.js` now runs under one Web Lock
  (`navigator.locks`). Sync merges through a locked `updateMap`.
- Tests: 12 → 51. New coverage:
  - NatoManga parsing: label-based last-viewed matching, pagination, login detection,
    and malformed input.
  - Storage: the schema migration, bulk-import rules, JSON import round trips, and
    concurrent writes.
  - Sync: the conflict rules for Plan to read and titles.
  - The background import job: partial sign-out and a closed tab.

### Docs
- Pre-merge review of the branch added to the NatoManga plan. All four blockers and the
  follow-up bugs are fixed. New
  [MangaRead import plan](./docs/mangaread-bookmark-import-plan.md) (planning only).
  Roadmap, README, CONTRIBUTING, sync design, and process log updated for site bookmark
  import.

## [0.3.3] - 2026-09-08

### Added
- **"Go to chapter X" in the save area.** When the tab you're on is a *different* chapter
  of a series you already track, the save area now shows a second, secondary button that
  takes you to your saved chapter. It deliberately does **not** save, so a mismatch
  finally has a way out that leaves your reading position alone — previously the only
  action available was the one that overwrote it. Shown in both directions (behind *and*
  ahead of your bookmark, since overshooting is as easy as falling behind), and hidden
  when the saved chapter is the one you're already on. It navigates the current tab
  rather than opening a second tab of the same series; Back returns you.

### Fixed
- **Non-comparable chapter labels no longer claim a direction.** A saved chapter whose
  label doesn't parse as a number (reachable through JSON import or a record from another
  client, never from our own parser) fell through to the "this would move you back"
  warning. It now states the saved position plainly instead.
- **Stored chapter links are validated before use.** A record's `chapterUrl` is untrusted
  input — it can arrive from a hand-edited import or another device, and older records
  may not have one at all. Opening a series now checks the URL parses and is `http(s)`
  first, and reports a missing link instead of failing silently.

### Docs
- README corrected: it still claimed the extension had no background service worker, which
  stopped being true in v0.2.3 when the OAuth flow moved into one. Documented `auth.js`,
  `background.js`, `config.js`, `sync.js`, `merge.js`, and `tokens.css`; added the sync
  data-flow diagram; fixed the test instructions to `npm test`.

## [0.3.2] - 2026-06-18

### Changed
- **Pinned footer / no more scrolling.** The popup is now a fixed-height flex column:
  header, save area, and controls stay at the top, the library list scrolls internally,
  and the footer (sync status, sign in/out, export, import) stays pinned and visible at
  a glance.
- **More breathing room** in the footer area (padding, gaps, larger button hit areas).

### Internal
- **Design tokens formalized** into `tokens.css` (colours, type scale, spacing, radius,
  elevation) as the single source of truth, shared by the popup and the future full-page
  app; documented in `docs/design-tokens.md`. No visual change.

## [0.3.1] - 2026-06-18

Continued brand and design-system work (Theme 1).

### Added
- **Shiori logo and icon set.** New indigo icon (Concept A: a bookmark with an "S" in
  the negative space) at 16/32/48/128, plus a scalable `icons/logo.svg` shown in the README.
- **Welcoming empty / first-run state** in the popup (the Shiori mark, a heading, and a
  one-line how-it-works).

### Changed
- **Library row hierarchy.** Title is primary; the chapter is emphasized on a secondary
  line, with site and last-read as muted tertiary text. The chapter is no longer a small
  side badge. Emphasis uses weight/colour (not indigo text) to keep WCAG AA contrast in
  both themes.

## [0.3.0] - 2026-06-17

Start of the brand and design-system theme.

### Changed
- **Renamed to Shiori** (栞, Japanese for bookmark). Brand promise: never lose your place.
  Updated the extension name, popup header, and description. The extension ID is unchanged
  (it comes from the manifest `key`), so sign-in and sync are unaffected.
- **Shiori palette.** Reworked the popup color tokens to the indigo-led Shiori palette
  (calm, reading-first), in both dark and light themes.

## [0.2.4] - 2026-06-17

### Added
- **Relative "last read" time** on each library row (for example "Site · 2d ago").
- **Light theme.** The popup now follows the OS appearance via `prefers-color-scheme`;
  an explicit override will arrive with the full-page app's settings.

### Docs
- Roadmap reorganized: added a full-page library + settings app, user-added custom sites,
  save reminders, distribution + freemium monetization, and a dual-store (Chrome + Firefox)
  1.0 definition. Added `CONTRIBUTING.md`. Process journal updated.

## [0.2.3] - 2026-06-17

### Fixed
- **Sign-in now completes reliably.** The Google OAuth flow runs in a background
  service worker instead of the popup. Previously the auth window took focus and
  Chrome closed the popup mid-flow, destroying its JavaScript before the session
  was stored, so sign-in silently failed (reproducibly on macOS). Found during
  cross-device live testing.

### Added
- A background service worker (`background.js`) that handles sign-in/sign-out on
  behalf of the popup.

## [0.2.2] - 2026-06-17

### Added
- **Sync status indicator** in the popup footer: a coloured dot plus label showing
  "Sign in to sync", "Syncing...", "Synced" (with account email), or
  "Offline, will sync later". Status is announced for screen readers.

### Changed
- Sign-in/out and sync now drive a single, consistent status state instead of a
  transient "Syncing..." string.

### Fixed
- Deleting a series now triggers a sync immediately, so the tombstone propagates to
  the cloud (and other devices) instead of waiting for the next sync trigger. Found
  during live testing.

## [0.2.1] - 2026-06-17

Cloud accounts and cross-device sync. Local-first is unchanged: the extension
still works fully offline and without an account. See `docs/cloud-sync-design.md`
for the full design.

### Added
- **Google sign-in** via `chrome.identity.launchWebAuthFlow`, exchanged for a
  Supabase session (`auth.js`, `config.js`).
- **Sync engine** (`sync.js`): pull, merge, push over PostgREST, triggered on
  save and on popup open (throttled). Batched push and paged pull for large
  libraries; one-at-a-time with coalescing; server-timestamp cursor.
- **Conflict resolution** (`merge.js`, pure and unit-tested): reading progress
  is monotonic (furthest chapter wins); deletions and cosmetic fields resolve by
  recency. Absence in a pull never deletes local data.
- **Soft deletes (tombstones)** so deletions propagate across devices.
- **Safety snapshot** written before the first-ever sync.
- One-time **migration** that backfills sync fields on pre-0.2 records.

### Changed
- `remove` is now a soft delete; the UI hides tombstones.
- Import marks records dirty so they propagate to the cloud.

## [0.1.2] - 2026-06-17

Polish pass on the v1 MVP, focused on data safety, scale, and accessibility.

### Added
- **Export / Import.** One-click JSON backup of the whole library, and import
  that merges records with last-write-wins conflict resolution (the same rule
  the planned cloud sync will use).
- **Already-saved awareness.** The save area now shows what's already stored for
  the current series and whether saving will advance, repeat, or move you back a
  chapter. The button relabels to "Update chapter" / "Save again" accordingly.
- **Keyboard and screen-reader support.** List rows are focusable and open with
  Enter/Space; icon buttons and controls have accessible labels; toast messages
  announce via an `aria-live` region.

### Changed
- **Virtualized library list.** Only the rows in view are rendered (with a small
  overscan), so the popup stays responsive with thousands of saved series. Search
  input is debounced.

## [0.1.1] - 2026-06-17

### Added
- Bookmark icon set (16/32/48/128) wired into the manifest and toolbar action.

## [0.1.0] - 2026-06-17

Initial MVP (Phase 0 + 1).

### Added
- Manifest V3 Chrome extension scaffold.
- URL parser for mangaread.org and natomanga.com, handling decimal chapters.
- `chrome.storage.local` persistence with one-record-per-series upsert.
- Popup UI: manual save, searchable/sortable library, click-to-open, delete.
