---
tags:
  - development
  - planning
  - ux-design
---

# Plan: Full-page Library (Bundle A, part 1)

**Status:** draft, 2026-11-12, with v1 being built from it on `feature/library-page`.
First half of Bundle A in
[ROADMAP.md](../ROADMAP.md). Settings, browser-bookmark import, and covers come later
and build on this page.

## Goal

A library you can actually manage. The popup is built for one job, saving and
resuming the chapter in front of you, and it stays that way. Its 360px list has
title-only search and two sorts. Now that a library holds two kinds of series
(reading and Plan to read) across two sites, and can reach the thousands, it needs a
real page: filter by status and site, see what you have at a glance, and act on a
series without hunting for it.

The decision filter still applies: **does this help Shiori remember the reader's
place?** The page is for finding your place and getting back to it. It is not a
second inbox: no badges, no counts that demand attention, nothing that nags.

## Scope

### In v1

- **`library.html`**, an extension page opened in a tab. It's also the extension's
  options page (`options_ui`, `open_in_tab`), so right-click > Options lands here.
- **Opening it:** a **Library** link in the popup footer, via
  `chrome.runtime.openOptionsPage()`, which focuses the tab if it's already open
  instead of opening a second one.
- **Summary line:** total series, reading, plan to read. Plain numbers, no progress bars
  (the "no faked progress" rule: we don't know latest chapters yet).
- **Filters:** status tabs (All / Reading / Plan to read), a site filter (All sites plus
  each site present in the library), search, and sort (Recently read, Title A-Z,
  Recently added).
- **Rows** (a list, see below): title; "Chapter N" or "Plan to read"; site; last read.
  Actions per row:
  - **Continue** (reading) or **Start** (plan): opens the saved chapter, or the series
    page for a plan. The same read-only jump as the popup's "Go to chapter X": it never
    changes a position.
  - **Series**: opens the series page.
  - **Remove**, with **Undo** in the confirmation toast (the "Delete undo" item from the
    polish backlog). Undo restores the series exactly as it was, chapter included.
- **Stays current:** the page re-renders when the library changes in storage (a save
  from the popup, a sync pass), so an open tab is never stale.
- **Sync:** the page runs the same migration on load, shows the sync state read-only,
  and triggers a sync pass after Remove/Undo when signed in. Signing in and out stays
  in the popup for now; it moves to Settings later.
- **Empty and no-results states**, light and dark themes from `tokens.css`, keyboard
  and screen-reader support.

### Not in v1

- **Settings area.** Next part of Bundle A, on this page.
- **Browser-bookmark import.** Needs this page for its preview step; builds on
  `bulkUpsert`.
- **Covers, latest chapters, `+N`.** Bundle C. The row layout leaves room for a cover.
- **Bulk actions** (multi-select remove, change status). Wait for real demand.
- **`completed` / `dropped` statuses.** Need sync support for `status` first (below).
- **Set current chapter.** Deferred; see the next section.

## Why "Set current chapter" is deferred

The roadmap asks this page for a counterpart to the popup's reversible-action pattern:
a way to fix a series saved at the wrong chapter. Building it surfaced a constraint.

Sync resolves progress by **furthest chapter wins** (`merge.js`). So a deliberate move
*backward*, from 40 to 12, survives only on a device that never syncs: the next sync
pass sees 40 in the cloud and brings it back. This already applies to the popup today.
Saving an earlier chapter while signed in looks like it worked, then reverts.

Making a backward move stick needs the cloud to know it was intentional. That's the same
shape as the deferred **deletion boundary** in Sync hardening (a device that missed a
delete can revive the old chapter). One field can solve both:

- **`progressResetAt`**: the time progress was last deliberately reset. A delete sets
  it; so does Set current chapter. In the merge, progress from a version older than the
  other side's `progressResetAt` doesn't compete under furthest-chapter-wins.
- It needs a cloud column, so it belongs with the planned "Plan to read in the cloud"
  migration, which already adds columns.

Until then, v1 offers the read-only half (Continue / Start), and the page shouldn't offer
a control that sync will silently undo. The roadmap's Sync hardening section records the
`progressResetAt` proposal.

## Decisions on Bundle A's open questions

- **Grid vs list: list.** There are no covers yet, so a grid would be cards of text with
  wasted space. A list is denser and scans faster at thousands of rows. Rows are
  virtualized like the popup's. When covers arrive (Bundle C), rows gain a thumbnail;
  a grid view can be an option then.
- **How much management in v1:** single-series actions only (above). No bulk ops.
- **Options page: yes.** One page for Library and (later) Settings, reachable the
  standard way.
- **Folder scoping for import:** not relevant until browser-bookmark import.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ [logo] Shiori · Library                       ● Synced: …    │
│ 128 series · 97 reading · 31 plan to read                    │
├──────────────────────────────────────────────────────────────┤
│ [All] [Reading] [Plan to read]   [All sites ▾] [Search…] [Sort ▾] │
├──────────────────────────────────────────────────────────────┤
│ Blue Lock                                                    │
│ Chapter 348.5 · NatoManga · 3d ago     [Continue] [Series] × │
│ Solo Leveling                                                │
│ Plan to read · MangaRead               [Start]    [Series] × │
└──────────────────────────────────────────────────────────────┘
```

Content is capped at about 960px wide and centered. Below about 640px, row actions
collapse under the text.

## Build

- **`library.html` / `library.css` / `library.js`**: the page. Reuses `tokens.css`,
  `storage.js`, `sync.js`, `auth.js`, and the parser's `SITES`.
- **`view.js`**: the shared, pure view logic: filtering, sorting, the summary counts,
  relative time, and safe-URL checks. Both the popup and the page use it, and it's
  unit-tested (no `chrome.*`). The popup's own copies of `relativeTime` and `safeUrl`
  move here.
- **`storage.js`**: `remove(id)` returns the series as it was (read under the storage
  lock), and `restore(id, previous)` is Undo. The record may have changed in between: a
  sync can rewrite the tombstone with a stale device's older chapter, or a popup save can
  bring the series back at another chapter. So restore merges `previous` with whatever is
  there now, as two live records: the further chapter wins, and Undo never leaves a
  series lower than when it was removed. Restores and removes are stamped strictly later
  than the record they replace (device clocks drift), so each wins wherever the record
  it replaces had synced. (Found in Codex review.)
- **`manifest.json`**: `options_ui: { page: "library.html", open_in_tab: true }`. No new
  permissions.
- **Live updates**: `chrome.storage.onChanged` on the `series` key.

## Tests

- `view.js`: each filter alone and combined, each sort (including series with no read
  time), summary counts ignoring tombstones, relative time, and the safe-URL check.
- `storage.js`: `restore` brings back a removed series with its chapter, wins over the
  tombstone in a merge, and does nothing for a series that isn't removed.
- Manual: open from the popup and from Options (one tab, not two); filters and search;
  Continue/Start/Series open the right pages; Remove then Undo; a save from the popup
  appears in an open library tab; light and dark; keyboard only.

## Open questions

- Should the popup's own Remove get the same Undo? (Cheap once `restore` exists; leave
  it out of v1 to keep the popup change to one link.)
- Does the summary line earn its place, or is it noise? Keep it quiet and revisit after
  living with it.
