---
tags:
  - development
---

# Plan: import browser bookmarks (Bundle A)

Status: **in progress** on `feat/bookmark-import`. Not yet reviewed.

Turn the manga bookmarks someone already has in Chrome into a Shiori library in one
step, with a preview before anything is written. It's the first caller of `bulkUpsert`,
the shared forward-only bulk write (see its comment in `storage.js`).

## The flow

1. **Import bookmarks** on the library page (toolbar). Nothing happens until it's
   clicked.
2. Chrome asks for the `bookmarks` permission (see Permission below). Declined: a toast
   says nothing was imported.
3. Shiori reads the bookmark tree and keeps bookmarks whose links are pages on a
   supported site: a chapter page becomes reading progress, a series page becomes
   Plan to read. Anything else is counted, not shown.
4. **Preview** (a dialog): what would happen to the library, grouped, with counts.
   Nothing is written yet.
5. **Import** writes it through `bulkUpsert` in one locked step, shows a summary
   toast, and syncs. **Cancel** changes nothing.

Running it again is harmless: anything already imported shows as up to date.

## The preview is computed by the same code that writes

`bulkUpsert` is split into a pure `planBulkUpsert(map, records, options)` that returns
the next library plus a per-series outcome, and the locked read-plan-write around it.
The preview runs the plan against the current library without writing; Import runs
the same plan again under the lock. If the library changed in between (a sync, a save
in the popup), the import applies to what's there then, and the summary toast reports
what actually happened.

Outcomes per series (one bookmark per series after duplicates collapse):

| Outcome | Meaning |
| --- | --- |
| New, reading | not in the library; added at the bookmark's chapter |
| New, plan to read | not in the library; a series page, or a chapter that can't be used (see below) |
| Moves forward | in the library; the bookmark's chapter is further along (shown as `12 → 40`) |
| Up to date | in the library at the same or a later chapter, nothing new |
| Removed | you removed it; it stays removed |
| Before a reset | the bookmark's chapter is further, but from before you moved back or restarted the series |
| Older than your saved place | the bookmark's chapter is further, but the chapter you saved was set after the bookmark was made |

`bulkUpsert` already makes a chapter count only if it's a number with an http(s) link.
Duplicates collapse to the furthest chapter **after** each bookmark is checked against
the series, so a usable bookmark isn't lost behind a further one that's skipped, and
equal chapters go to the more recent bookmark whatever order they arrive in (Codex
review).

**Why "older than your saved place" is skipped** (Codex review). Replacing a chapter
saved on Oct 20 with an Oct 1 bookmark for a further chapter would swap newer progress
for older evidence. If another device moved the series back on Oct 15 and this device
hasn't pulled that yet, the next sync drops the imported chapter (older than the
reset) and the Oct 20 chapter is gone too. Keeping the saved chapter loses nothing:
it would also win any sync where the bookmark's chapter would.

## Times: what a bookmark says about when you read

Chrome records when a bookmark was added (`dateAdded`) and, in recent versions, when it
was last opened (`dateLastUsed`). For a chapter bookmark, the later of the two is the
best evidence of when you were at that chapter. Shiori uses it as:

- **`progressAt`**, when the chapter was set. This matters for resets (cloud schema v2,
  merge rule 5): a chapter only counts if it was set at or after the series' reset
  marker.
- **`lastReadAt`**, so the imported library sorts sensibly by "Recently read" instead
  of every series looking unread (or freshly read, if the import time were used).

Times in the future (a skewed clock) are clamped to the import time. A series bookmark
carries no reading time.

**Resets are respected.** Today `bulkUpsert` advances a series whenever the incoming
chapter is further, and stamps `progressAt` with the import time. Importing an old
bookmark for chapter 40 would undo a deliberate move back to chapter 3, and sync would
keep it. Now an advance needs the incoming chapter's time to be at or after the
series' `progressResetAt`; otherwise the outcome is *Before a reset*. A record with no
time (a bookmark Chrome recorded no dates for) is checked and stamped with the time the
write uses (after the record it replaces), as before.

**A removal this device hasn't pulled yet** (Codex review; also affected popup saves
before, but old bookmarks make it likely). An import is newer than that removal, so it
brings the series back on sync, which is right: you imported it. Its chapter, though,
is from before the removal. The merge now keeps a resurrecting record's chapter only if
it was set after the removal's reset marker; otherwise the series comes back as Plan to
read (`merge.js`).

## Decisions

- **Permission: optional, requested on click.** `bookmarks` goes under
  `optional_permissions`, and the library page calls `chrome.permissions.request` from
  the button's click. Existing installs see no new warning when they update, and
  someone who never imports never grants it. It stays granted afterwards (Chrome lists
  it in the extension's details); there's no in-app revoke in v1.
- **All bookmarks, no folder picker in v1.** The preview shows what was found; a picker
  can come later if libraries mix in bookmarks people don't want imported. Bookmarks on
  unsupported sites are only counted.
- **No per-item checkboxes in v1.** The preview is for confidence, with Cancel as the
  way out. Unchecking rows can come later.
- **Removed series stay removed** (`bulkUpsert`'s default). They're listed so it isn't
  a mystery.
- **Titles stay slug-derived** (as for a popup save) unless the library already knows
  a real one; bookmark titles are often "Chapter 40 - Site Name" and aren't reliable.

## Out of scope

Importing another browser's bookmark file, a folder picker, per-item selection,
revoking the permission from Shiori, and the library's Set current chapter button.

## Verification

- Unit tests: the bookmark tree walk (nested folders, separators, unsupported links,
  old natomanga.com links, `dateLastUsed` missing, future dates); `planBulkUpsert`
  outcomes for each row in the table; resets (an old bookmark doesn't advance past a
  move back, a newer one does); the imported chapter's times; the preview and the write
  agreeing.
- Headless Chrome: the dialog with sample data in light and dark, phone width, keyboard
  (focus moves into the dialog, Esc cancels, focus returns to the button), and a double
  click on the button (one import at a time; a cancelled preview stays closed).
- Codex review in a Herdr pane until a pass finds nothing.
- Manual, in the real extension: the permission prompt, a real bookmark tree, and the
  synced result on a second device.
