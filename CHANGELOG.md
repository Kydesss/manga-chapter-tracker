# Changelog

All notable changes to this project are documented here. Versions follow the
extension's `manifest.json` version field.

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
