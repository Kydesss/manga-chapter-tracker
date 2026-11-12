---
tags:
  - development
---

# Changelog

All notable changes to this project are documented here. Versions follow the
extension's `manifest.json` version field.

## [Unreleased]

Jonah's `autoscraper` branch, targeting 0.4.0. It's not released yet: `manifest.json`
stays at 0.3.3. The NatoManga bookmark scraper this branch added has since been removed
again, before any release; see **Removed before release** below. The entries after it
record what the branch built. What remains from them is Plan to read, real titles
through saves and sync, storage schema v3/v4, the storage lock, the sync and merge
fixes, and the JSON import fixes. The importer's design and pre-merge review stay in
[docs/natomanga-bookmark-import-plan.md](./docs/natomanga-bookmark-import-plan.md) for
reference.

### Added since the removal
- **Plan to read from a series page.** Open a series' main page on MangaRead or
  NatoManga (`/manga/{slug}`) and the save area offers **Plan to read**. The series
  joins the library with no chapter, and the first chapter you save from it flips it to
  reading. On a series you're already reading, the save area shows your saved chapter
  with **Go to chapter X** instead. A plan save never erases a chapter: `upsert` leaves
  a series you're reading untouched. Planning a series you removed adds it back fresh,
  as Plan to read. New parser entry points: `parseSeriesUrl` and `parsePageUrl`.
- **`bulkUpsert` is back, without a site attached.** The shared forward-only bulk write,
  for browser-bookmark import (Bundle A) or a future site importer. One locked read and
  write; duplicates collapse to the furthest chapter; a series only moves forward, and
  labels that can't be ranked ("Extra") never advance one; unknown metadata never erases
  known metadata; metadata-only changes don't queue a sync. New: series the user removed
  stay removed unless the caller passes `restoreDeleted: true`, and are counted as
  `removed`. When duplicates collapse, the furthest chapter wins but a real title and
  known metadata are kept from any duplicate, and a numbered chapter beats a label like
  "Extra". An imported chapter only counts if it's a number with a usable http(s) link;
  anything else ("Extra", a missing or unsafe link) counts as no chapter. It never
  replaces a working link or advances a series, and a new or restored series sent that
  way arrives as Plan to read, so it can still advance later. Nothing calls it yet.
- Tests: 31 → 62 (series parsing, the plan-save guard, `bulkUpsert`, resurrection, and the manganami.com move).

### Changed since the removal
- **NatoManga moved to manganami.com.** natomanga.com now permanently redirects to
  `www.manganami.com` with the same paths, so saved NatoManga links went through a
  redirect. Saving now works on manganami.com, and old natomanga.com links still parse.
  Storage schema v5 rewrites saved links (chapter, series, latest chapter) to
  manganami.com. Ids (`natomanga.com:{slug}`), chapters, `updatedAt`, and sync state are
  untouched, so nothing is re-pushed. Cloud rows, JSON backups, and bulk imports with old
  links are rewritten the same way on the way in, so devices still on an older version
  converge. Only http(s) links are rewritten, so the import link checks still apply.
  The library still shows the site as "NatoManga". Reviewed with Codex.
- **Merge rule: a resurrection restarts the series.** When a newer save brings back a
  deleted series, the tombstone's old chapter no longer wins under "furthest chapter".
  Without this, planning a removed series while signed in would turn back into Reading
  at the old chapter once sync pulled the tombstone. Found in Codex review. Known gap: a
  device that never saw the deletion can still revive the old chapter; the fix needs a
  synced deletion boundary (see the roadmap's Sync hardening).
- **The MangaRead importer is off the roadmap.** Site bookmark import is paused with no
  site planned. The research stays in `docs/mangaread-bookmark-import-plan.md`.

### Removed before release
- **The NatoManga scraper.** Gone: **Save bookmarks**, **Refresh updates**, the
  series-page metadata pass, and the service worker's import job (`background.js` is back
  to running sign-in only). `natomanga.js`, its fixtures, and its tests are deleted.
  Saving a chapter from a NatoManga chapter page still works, exactly as in 0.3.3.
- **Covers and update badges** in the library, which only the scraper filled in. Rows
  are back to 56px. The schema keeps the `coverUrl` and `latestChapter*` fields, so
  libraries already migrated to v4 keep working, and those fields are simply unused.
- **`bulkUpsert`**, the scraper's storage write path. The JSON backup import is
  unchanged.
- **Permissions:** `scripting`, `declarativeNetRequestWithHostAccess`, the
  `*.2xstorage.com` host permission, and the cover-image referrer rule. The manifest
  matches 0.3.3 again.
- A leftover import job in `chrome.storage.local` is cleared on install or update.
- Tests: 58 → 31 (the scraper, import-job, manifest-rule, and bulk-import tests).

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
- **Covers and update badges.** Library rows show each series' cover, lazy-loaded, with
  the Shiori mark when there isn't one or it won't load. When a newer chapter is out, the
  row shows a `+N` badge (or "NEW" when the chapter labels can't be compared) and a
  "Latest N (3h ago)" line. Covers and latest chapters come from the bookmark cards. For
  series still missing either, each import also checks up to 20 series pages.
- **Refresh updates.** A second NatoManga button reruns the import to pick up new
  chapters and fill in missing covers. It's manual on purpose. Scheduled background
  checks wait until the parser has been validated on the live site.

### Changed
- **Storage schema v3 and v4.** Every record gets a `status` and fields for covers and
  update tracking: `lastReadAt`, `coverUrl`, `latestChapter`, `latestChapterUrl`,
  `latestPublishedAt`, and `metadataCheckedAt`. A one-time migration fills them in on
  existing records without touching their chapters. It also sets each record's
  `lastReadAt` from its last save, and running it twice changes nothing.
- **Taller library rows** (72px, up from 56px) to fit the cover.
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
- **New permissions.**
  - `scripting` lets the bookmark-page requests run inside your NatoManga tab, which is
    how they use your existing NatoManga session. Access to the tab still comes from
    `activeTab`, which Chrome grants when you click the toolbar icon.
  - `declarativeNetRequestWithHostAccess` and host access to `*.2xstorage.com` let
    covers load. NatoManga serves covers from that host and refuses requests without a
    NatoManga referrer, so one rule (`rules/natomanga-image-referer.json`) sets that
    header on image requests to that host only. Chrome shows a new permission warning
    for the host access.
- **Sync keeps the new data local for now.** The cloud table requires a chapter, so
  Plan-to-read records stay on the device they were imported on. The new metadata fields
  are kept during sync conflict resolution but not uploaded. A change to only a cover or
  latest chapter doesn't bump a record's `updatedAt` or queue a sync. A Supabase
  migration will follow.

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
  and report a diagnostic for each card they can't read. It also reads covers, latest
  chapters, and dates from bookmark cards and series pages (`parseNatoSeriesPage`),
  including NatoManga's date formats (`parseNatoDate`). Tested against saved fixture
  pages.
- **One writer at a time.** The popup and the service worker both write the library, so
  every read-modify-write in `storage.js` now runs under one Web Lock
  (`navigator.locks`). Sync merges through a locked `updateMap`.
- Chrome's generated `_metadata/` folder is no longer tracked, and is gitignored.
- Tests: 12 → 58. New coverage:
  - NatoManga parsing: label-based last-viewed matching, covers and latest chapters,
    series pages, date formats, pagination, login detection, and malformed input.
  - Storage: the schema migration, bulk-import rules, metadata-only refreshes, JSON
    import round trips, and concurrent writes.
  - Sync: the conflict rules for Plan to read and titles.
  - The background import job: the series-page phase, partial sign-out, and a closed
    tab.
  - The manifest's cover-image referrer rule.

### Docs
- Pre-merge review of the branch added to the NatoManga plan. All four blockers and the
  follow-up bugs are fixed, and post-merge notes cover Jonah's covers, badges, and
  Refresh updates work. New
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
