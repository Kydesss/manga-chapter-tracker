# Changelog

All notable changes to this project are documented here. Versions follow the
extension's `manifest.json` version field.

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
