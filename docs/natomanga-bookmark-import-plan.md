---
tags:
  - development
  - planning
  - natomanga
---

# Plan: NatoManga Bookmark Import and Library Expansion

> **Status (2026-09-23):** Phases 1-3 are built on the `autoscraper` branch and were
> reviewed before merge. The review's four blockers and follow-up bugs are fixed
> ([Review before merge](#review-before-merge-2026-09-23), at the end). Phase 4 (covers)
> and the manual half of Phase 5 (latest chapters, update badges, **Refresh updates**)
> came next and were merged with those fixes
> ([Post-merge notes](#post-merge-notes-2026-09-23)). Before merging to `master`, it
> still needs a live test with a signed-in NatoManga account and a real captured
> fixture. MangaRead gets the same feature next:
> [mangaread-bookmark-import-plan.md](./mangaread-bookmark-import-plan.md).

## Goal

Let a user open NatoManga, press a single **Save bookmarks** button in Shiori, and import every manga in their NatoManga bookmark pages into the Shiori library. Extend that foundation with cover thumbnails, latest-chapter and update-date tracking, and a larger searchable bookmarks window.

The implementation must preserve Shiori's existing principles:

- Local-first: importing works without a Shiori account.
- Progress is sacred: importing must never silently move a saved chapter backward.
- One library: imported bookmarks use the same records as manually saved chapters.
- Restraint: update checking is polite and quiet by default.
- No NatoManga credentials are collected or stored. The scraper uses the user's existing signed-in browser session.

## Requested user flow

1. The user opens any page on `natomanga.com` while signed in.
2. Shiori recognizes that the active website is NatoManga.
3. The popup displays a **Save bookmarks** button.
4. One press starts importing `/bookmark` and every `/bookmark?page=N` page.
5. Shiori reports progress and saves all valid bookmarks into its local library.
6. The user can open a full bookmarks window, search the library, and resume any manga.
7. Later phases add covers, latest chapters, update dates, and update indicators.

## Current foundation

Shiori already has:

- Chapter URL detection for NatoManga and MangaRead.
- One-record-per-series storage in `chrome.storage.local`.
- Manual Save/Update chapter behavior.
- A searchable and sortable popup library.
- Virtualized rendering for large libraries.
- JSON export/import.
- Optional Google/Supabase sync.
- Furthest-chapter conflict resolution for cloud synchronization.

Shiori does not yet have:

- A NatoManga bookmark-page scraper.
- A bulk storage operation.
- A representation for bookmarked manga with no chapter read yet.
- Cover images or latest-release metadata.
- Background update checks.
- A full-page library window.

## Phase 1: Data model and parser foundation

**Implementation status:** Complete on 2026-09-22. Schema v3, the extended
record shape, dependency-free NatoManga fixture parser, local-only migration
startup, and automated coverage are implemented. The selectors still require
final validation against the user's authenticated bookmark page when Phase 2
connects the parser to live fetching.

### 1.1 Extend the series record

Add fields needed by imported and unread bookmarks:

```js
{
  status: "plan" | "reading",
  chapter: null | "83.2",
  chapterUrl: null | "https://www.natomanga.com/manga/example/chapter-83-2",
  lastReadAt: null | "ISO timestamp",
  coverUrl: null | "https://...",
  latestChapter: null | "84",
  latestChapterUrl: null | "https://...",
  latestPublishedAt: null | "ISO timestamp",
  metadataCheckedAt: null | "ISO timestamp"
}
```

Keep the meanings of the timestamp fields distinct:

- `updatedAt`: the Shiori record changed.
- `lastReadAt`: the user's reading position changed.
- `latestPublishedAt`: NatoManga's release date for the latest chapter.
- `metadataCheckedAt`: Shiori last checked the site.

### 1.2 Add storage schema version 3

- Migrate existing records to `status: "reading"`.
- Preserve all current chapters and URLs.
- Default new metadata fields to `null`.
- Make the migration idempotent and unit-tested.
- Plan the corresponding nullable fields and metadata columns for Supabase before syncing the new fields.

### 1.3 Add a pure NatoManga parser module

Create `natomanga.js` with functions such as:

- `isNatoMangaUrl(url)`
- `parseNatoBookmarkPage(html, baseUrl)`
- `findLastBookmarkPage(html, baseUrl)`
- `normalizeNatoBookmark(item)`
- `parseSeriesUrl(url)`
- `parseChapterUrl(url)` or reuse the existing parser where applicable

Initial selectors to verify against a current authenticated bookmark page:

- Pagination links: `.group-page a`
- Bookmark detail area: `.user-bookmark-item-right`
- Title: `.bm-title`
- Last-viewed chapter link: `span:nth-of-type(2) a`

Selectors must be centralized, use reasonable fallbacks, and fail with a visible diagnostic instead of silently importing zero records.

### Phase 1 acceptance criteria

- Existing records migrate without data loss.
- Saved HTML fixtures can be parsed without network access.
- Manga with and without a last-read chapter are represented.
- Parser tests cover malformed and incomplete bookmark cards.

## Phase 2: One-press **Save bookmarks** import

**Implementation status:** Implemented on 2026-09-22, pending live validation
against the user's authenticated NatoManga bookmark pages. The popup action,
in-tab authenticated fetching, pagination, progress state, partial-failure
reporting, and local-library refresh are wired up.

### 2.1 Detect NatoManga in the popup

- Read the active tab URL.
- Match only `natomanga.com` and its real subdomains.
- Display **Save bookmarks** when the active tab is on NatoManga.
- Keep **Save chapter** available when the active page is a valid chapter page.
- On another website, hide or disable the import action and explain that NatoManga must be open.

### 2.2 Add the required extension plumbing

- Add the `scripting` permission.
- Use the current `activeTab` grant for the initial manual import if practical.
- Run the long-lived import through `background.js` so closing the popup does not discard the job.
- Inject or message a NatoManga content script that can use the site's existing authenticated session.
- Store import-job state so a reopened popup can show current progress.

Do not request or store the user's NatoManga username, password, cookies, or tokens.

### 2.3 Scrape every bookmark page

Import algorithm:

1. Fetch `/bookmark?page=1`.
2. Detect whether the response redirected to `/login` or contains the login page.
3. Parse all pagination links and determine the maximum valid page number.
4. Fetch pages `1..N` with low concurrency.
5. Parse and normalize every bookmark card.
6. Deduplicate records by normalized `site:slug` id.
7. Pass the completed records to a bulk storage operation.
8. Return a detailed import report.

Networking requirements:

- Limit concurrency to approximately two requests.
- Use timeouts.
- Retry only transient `429` and `5xx` failures.
- Use exponential backoff.
- Preserve successful pages if another page fails.
- Never loop indefinitely because of malformed pagination.

### 2.4 Show progress and useful outcomes

Suggested UI states:

- `Save bookmarks`
- `Checking NatoManga...`
- `Importing page 3 of 18...`
- `Saved 842 bookmarks`
- `Sign in to NatoManga first`
- `Imported 830; 12 need attention`
- `NatoManga's bookmark layout may have changed`

The final report should include:

- Pages completed and failed.
- Bookmarks discovered.
- New records added.
- Existing records advanced.
- Existing records enriched but not advanced.
- Records unchanged.
- Records skipped, with reasons.

### Phase 2 acceptance criteria

- One button imports every accessible bookmark page.
- Closing and reopening the popup does not lose the import state.
- A signed-out user receives clear instructions.
- Partial network failure does not erase successful work.
- The importer never sends NatoManga credentials anywhere.

## Phase 3: Safe and efficient bulk storage

**Implementation status:** Core storage work completed alongside Phase 2 on
2026-09-22. `bulkUpsert` performs one read/write, deduplicates imports, advances
to the furthest viewed chapter, preserves further local progress, and keeps
unread bookmarks local until the cloud schema accepts nullable chapters.

### 3.1 Add `bulkUpsert`

Add a storage operation that:

- Reads the library map once.
- Merges every imported record in memory.
- Writes the map once.
- Marks changed records dirty for later cloud synchronization.
- Returns counts for added, advanced, enriched, unchanged, and skipped records.

Do not call the current single-record `upsert()` thousands of times because it reads and rewrites the complete map on every call.

### 3.2 Define import conflict rules

- If an imported chapter is further ahead, advance the Shiori record.
- If Shiori already has a further chapter, preserve it.
- If chapters are equal, enrich the title and metadata without changing progress.
- If the imported bookmark has no chapter, create or retain a `plan` record.
- An unread import must never replace an existing `reading` record.
- Deduplicate the same series across pages before writing.

### 3.3 Sync behavior

- Trigger one sync pass after the bulk write, not one per record.
- Keep new metadata local until the Supabase schema and merge rules support it.
- Add explicit field-level merge rules before syncing covers or latest-release data.

### Phase 3 acceptance criteria

- A synthetic import of 3,000-4,000 bookmarks completes without repeated full-map writes.
- Existing reading progress cannot move backward.
- Duplicate bookmark entries create only one Shiori record.
- One import triggers at most one immediate sync pass.

## Phase 4: Manga thumbnails

**Implementation status:** Implemented on 2026-09-23, pending live NatoManga
markup validation. Bookmark-card covers are captured when present, missing
covers use a capped series-page fallback (20 per run), and the popup renders
lazy-loaded thumbnails with a Shiori fallback image.

### 4.1 Capture covers during bookmark import

Inspect each bookmark card for its existing thumbnail before fetching individual manga pages.

- Check `src` and common lazy-load attributes such as `data-src`.
- Resolve relative URLs against the bookmark page URL.
- Validate that the result is HTTP or HTTPS.
- Save the remote URL as `coverUrl`.
- Provide a Shiori-branded fallback when no cover is available.

### 4.2 Avoid bloating local storage

- Do not save thousands of base64 images in `chrome.storage.local`.
- Initially render remote image URLs with a fallback.
- If NatoManga blocks hotlinking or URLs are unstable, add a later resized-image cache using Cache Storage or IndexedDB.
- Lazy-load covers in the library UI.

### Phase 4 acceptance criteria

- Imported records display their available cover image.
- Broken or missing images do not break a card.
- Loading a large library does not request every cover at once.

## Phase 5: Latest chapters, updates, and dates

**Implementation status:** Manual update tracking implemented on 2026-09-23,
pending live validation. Bookmark pages now provide latest-chapter metadata and
dates where available, a capped series-page fallback fills gaps, the popup shows
update badges, and **Refresh updates** reruns the metadata pass. Scheduled
`chrome.alarms` checks remain intentionally deferred until the manual parser is
confirmed against the authenticated site.

### 5.1 Prefer bulk metadata from bookmark pages

First determine whether each NatoManga bookmark card includes:

- Latest available chapter.
- Latest chapter URL.
- Latest update or publication date.
- The user's last-viewed chapter.

If available, parse this information while refreshing the paginated bookmark list. This is strongly preferred over issuing one request for every series.

### 5.2 Series-page fallback

Only when bookmark pages lack required metadata, fetch individual series pages in small batches and parse:

- Canonical title.
- Cover image.
- Latest chapter.
- Latest chapter URL.
- Latest publication date.

Keep NatoManga selectors centralized and covered by fixtures.

### 5.3 Calculate update state

- Compare `latestChapter` with the saved `chapter` only when both are rankable.
- Show an update badge such as `+3` when the difference is meaningful.
- Show a simple `New chapter` state when labels cannot be safely ranked.
- Never treat a scrape failure as "no updates."
- Preserve the last known successful metadata when a refresh fails.

### 5.4 Start with manual refresh

Add a **Refresh updates** action before enabling scheduled background checks.

After manual refresh is reliable:

- Add `chrome.alarms`.
- Request optional NatoManga host permission.
- Check in small, staggered batches with jitter.
- Back off on errors and rate limits.
- Add global and per-series update-check toggles.
- Remain quiet when nothing changed.
- Keep operating-system notifications off by default.

### Phase 5 acceptance criteria

- The library distinguishes the saved chapter from the latest chapter.
- Update dates do not overwrite reading dates.
- Failed refreshes retain previous valid metadata.
- Large libraries do not generate thousands of simultaneous requests.

## Phase 6: Full current-bookmarks window

### 6.1 Preserve the popup's role

Keep the popup compact and optimized for:

- Saving the current chapter.
- Importing NatoManga bookmarks.
- Quickly resuming a recently read manga.
- Opening the full library.

Add a clear **Library** or **View all bookmarks** button.

### 6.2 Create the full-page library

Add:

- `library.html`
- `library.css`
- `library.js`

Open it with:

```js
chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
```

Reuse `tokens.css`, `storage.js`, and the existing URL-safety helpers.

### 6.3 Library features

- Debounced search bar.
- Grid and/or list layout with cover thumbnails.
- Virtualized rendering for thousands of entries.
- Filters: All, Updates, Reading, Plan to read.
- Site filter.
- Sort by title, recently read, and recently updated.
- Saved chapter and latest chapter displayed separately.
- Latest update date.
- `+N` or `New chapter` indicator.
- **Resume reading** action.
- **Open latest chapter** action.
- Remove and edit actions.
- Import and update-refresh status.
- Empty, loading, partial-failure, and offline states.

### Phase 6 acceptance criteria

- A user can quickly find a manga in a 3,000-4,000-entry library.
- Clicking Resume opens the saved reading position.
- Opening the latest chapter does not silently change the saved position.
- Search, filtering, and sorting remain responsive.

## Verification plan

### Automated fixtures and tests

Add tests for:

- A one-page bookmark list.
- A multi-page bookmark list.
- Pagination containing Previous and Next links.
- Login redirects and login HTML.
- An empty account.
- A bookmark with no last-viewed chapter.
- Decimal chapter numbers.
- Duplicate entries across pages.
- Missing titles, URLs, dates, and images.
- Changed or missing selectors.
- `429`, `500`, timeout, and partial-page failure.
- Storage schema migration from version 2.
- Bulk import preserving the furthest chapter.
- An unread bookmark not replacing a reading record.
- A synthetic 3,000-4,000-record import.
- Import interruption and restart.

### Manual browser verification

- Signed-in NatoManga session.
- Signed-out NatoManga session.
- Import started from a chapter page.
- Import started from `/bookmark`.
- Popup closed during import and reopened.
- A library containing both manual and imported records.
- A second import after bookmarks or reading positions change.
- Cloud-signed-in and local-only Shiori states.
- Dark and light themes.

## Expected files to change

- `manifest.json`: permissions and full-page library declaration if needed.
- `background.js`: import-job orchestration and progress messages.
- `popup.html`: Save bookmarks and Library actions.
- `popup.js`: site detection, import controls, and job progress.
- `popup.css`: import progress and new actions.
- `parser.js`: reusable series URL normalization where appropriate.
- `storage.js`: schema version 3 and `bulkUpsert`.
- `merge.js`: metadata/status conflict rules when cloud sync is extended.
- `sync.js`: new cloud fields after the backend migration.
- `natomanga.js`: bookmark and metadata parsing.
- `library.html`, `library.css`, `library.js`: full-page bookmarks window.
- `tests/`: parser, migration, bulk import, and fixture coverage.
- `docs/`: selector notes and any cloud-schema migration design.

## Delivery order

1. Data model migration and fixture-tested NatoManga parser.
2. NatoManga detection and the **Save bookmarks** button.
3. Authenticated multi-page scraping with progress and recovery.
4. Safe, efficient bulk storage and one-pass sync triggering.
5. Thumbnail capture and display.
6. Full-page searchable bookmarks window.
7. Manual latest-chapter and date refresh.
8. Polite scheduled update checking.
9. Supabase metadata migration and cross-device metadata sync.

## Definition of done

The feature set is complete when a signed-in NatoManga user can press **Save bookmarks** once, import every accessible bookmark without losing existing Shiori progress, browse the resulting library with search and cover thumbnails, see saved versus latest chapter information and update dates, and safely resume the desired manga from a responsive full-page library.

## Review before merge (2026-09-23)

Reviewed at `7a0acbf` (29 tests passing). The structure is sound: the parser is pure and
fixture-tested, its selectors are in one place, the bulk write is one read and one write
and only moves progress forward, NatoManga credentials are never touched, and the job
survives the popup closing. Most problems come from the new "no chapter yet" state
reaching code that was written when every record had a chapter. Items marked
*reproduced* were confirmed by running the branch's own modules.

**Resolution (same day).** Everything under "Fix before merge", "Should fix", and "Minor"
is fixed, and each fix has a regression test. The suite went from 29 to 51 tests, and the
new tests fail on `7a0acbf`. The popup changes were also smoke-tested in a browser
against a mocked `chrome` API. Only the "Decide" items and the real captured fixture
remain.

### Fix before merge

- [x] **Sync can undo cloud progress on this device** (reproduced).
      `resolveConflict` in `merge.js` falls back to recency when a chapter doesn't parse,
      and `null` doesn't parse. So a newer local plan record beats an older cloud record
      at chapter 50, and the local result is `chapter: null`. The cloud keeps chapter 50,
      but the pull cursor has already moved past that row, so this device won't recover
      it until the series changes elsewhere. It happens on a first sign-in
      after an import, or when another device read the series since the last pull. The
      fix is the ROADMAP's rule "reading supersedes plan": a real chapter always beats no
      chapter. Add a merge test for it.
      **Fixed:** `resolveConflict` applies that rule before comparing chapters. Two
      plan-to-read records still resolve by recency.
- [x] **Saving a chapter resets imported data** (reproduced). The popup saves
      `{ ...parseChapterUrl(url) }`, which has a slug-derived `title` and all metadata
      fields set to `null`, and `upsert` spreads that over the stored record. An imported
      "Witch & Mercenary" becomes "Witch And Mercenary" after one save. Covers and latest
      chapters will be wiped the same way once Phases 4-5 collect them. The storage test
      for this passes only because it calls `upsert` with a hand-made record instead of
      the parser's output.
      **Fixed:** `upsert` keeps known metadata when the new value is `null`. A shared
      `pickTitle` rule (`merge.js`) means a slug-derived title never replaces a real one,
      whether the change comes from a save, an import, or a sync. The new test uses the
      parser's actual output.
- [x] **JSON Import drops Plan-to-read records** (reproduced). `importRecords` skips any
      record whose chapter isn't a string, so an Export followed by an Import silently
      loses every unread bookmark. For a local-only library, Export is the only backup.
      **Fixed:** Import accepts Plan-to-read records and brings older exports up to the
      current record shape. It now resolves conflicts with the same `resolveConflict`
      as sync, so the furthest chapter wins and a chapter beats Plan to read. Before,
      the newer record won, so restoring a backup could move you back.
- [x] **The last-viewed chapter is found by position.** The parser takes the first link
      in the card's second `<span>`, and the count includes nested spans.
      `NATOMANGA_SELECTORS.lastViewed` is declared but not used. If NatoManga reorders
      the card, the *latest* chapter is imported as progress. Progress only moves
      forward, so a later import can't undo that. Find the span by its "Viewed" label
      instead, and add a sanitized capture of a real signed-in bookmark page as a
      fixture. The current fixtures are hand-written.
      **Fixed:** The span is now found by its label (`lastViewedLabel`). Spans labelled
      as the newest chapter are skipped, and the link must be a chapter of the same
      series. A card that has no matching span imports as Plan to read, with a
      diagnostic. **Still open:** the real captured fixture, which needs a signed-in
      session. If NatoManga's label isn't matched, every card will report
      `missing-last-viewed-label`. Check the diagnostics on the first live import.

### Should fix (all fixed)

- **The login check overrides found bookmarks** (reproduced). Any `<form>` with "login"
  in its class or action marks the whole page as signed out, even when bookmark cards are
  on it. Treat a page as signed out only when it has no cards.
  **Fixed:** the login check now runs only when a page has no cards.
- **One bad character entity fails the page** (reproduced). `&#x110000;` is outside the
  Unicode range, and `decodeEntities` throws a `RangeError` on it, so that page is
  recorded as failed. Check the code-point range before decoding.
  **Fixed:** invalid code points decode to U+FFFD, as browsers do.
- **Nothing is saved until the last page.** If NatoManga signs the user out partway
  through, or the service worker restarts, every page fetched so far is lost. If the tab
  closes, each remaining page still makes three attempts before failing. Save after each
  page (or checkpoint), and stop once the tab is gone. This also covers the unwritten
  "import interruption and restart" test from the verification plan.
  **Fixed:** each page is saved with `bulkUpsert` as it arrives. That's one write per
  page, not per record, so this is a deliberate trade against Phase 3's "no repeated
  full-map writes." A sign-out, a closed tab, or a tab that leaves NatoManga now stops
  the import right away (no retries), and the message says which page it stopped on and
  how many bookmarks were saved.
- **Every imported row shows "just now".** `lastReadAt` is set to the import time, so
  imported series all show "just now" and move to the top of the Recent sort. Use the
  card's viewed date if it has one; otherwise consider `null`.
  **Fixed:** imports leave `lastReadAt` unknown (`null`). An advanced series keeps its
  last known read time. Recently read sorts by `lastReadAt` and puts unknown times last.
  Schema v4 backfills `lastReadAt` from `updatedAt` on older records, so they still show
  a time.
- **Two writers with no lock.** The service worker now writes the library while the
  popup can save or sync at the same time. The read-modify-writes in `storage.js` aren't
  serialized, so a sync's `writeAll` that lands at the same moment as the import's final
  write can undo it. This is rare today but will be common once background update checks
  exist. `navigator.locks` works across both the popup and the worker.
  **Fixed:** every read-modify-write in `storage.js` runs under one Web Lock, and sync
  merges through a locked `updateMap`. Fixing this turned up a related race:
  `markSynced` could mark a record synced even though it was saved again while the push
  was in flight. It now clears `dirty` only when `updatedAt` hasn't changed since the
  push.

### Decide (still open)

- **Re-importing restores removed series.** `bulkUpsert` treats a deleted record like a
  missing one. Anything removed from Shiori but still bookmarked on NatoManga comes back
  on the next import, and the restore syncs to other devices. Options: skip deleted
  series and report them as "removed in Shiori", or ask the user.
- **Plan-to-read records don't sync.** This is intended until the Supabase migration
  (sketched in [cloud-sync-design.md](./cloud-sync-design.md)). Meanwhile these records
  stay `dirty` forever and never reach other devices. Either say so in the UI, or ship
  the migration with this feature.

### Minor (fixed)

- The popup's first progress poll can read the previous job's record. It then briefly
  shows the old result and re-enables the button while the new import runs. Compare
  `startedAt` to avoid this. **Fixed:** while the popup's own request is pending, a
  stored job that isn't running is treated as the previous run's.
- If the popup is reopened during an import, the status line updates when the import
  finishes but the library list does not. **Fixed:** a popup watching an import now
  reloads the list and syncs when it finishes.
- Pages are fetched one at a time, not about two at once as planned. That's politer, so
  keep it.

## Post-merge notes (2026-09-23)

Jonah's `f874f60` (covers, latest chapters, the series-page metadata phase, **Refresh
updates**, update badges, and the cover-image referrer rule) was developed in parallel
with the review fixes and merged in `0663106`. How the overlaps were resolved:

- **"Viewed" is matched by label only.** `f874f60` also moved to label matching, but it
  fell back to the second span when no label matched. That fallback was dropped, because
  it's the positional risk the review was about. The latest chapter is matched by label
  too. It's only metadata, so a miss just leaves it for the series-page phase.
- **Latest-chapter links must belong to the same series**, on bookmark cards and series
  pages alike, matching the rule for the last-viewed link.
- **Series-page enrichment keeps the existing title** when the page has no heading.
  Before, `bulkUpsert` rejected those records, cover included.
- **Series pages are fetched from the tab's own origin.** A series saved from
  `natomanga.com` would otherwise be a cross-origin request from `www.natomanga.com`,
  and fail.
- Chrome's generated `_metadata/` folder had been committed. It's now untracked and
  gitignored.

**Follow-ups:**

- **The popup is short on room.** On a NatoManga chapter page, the save area stacks four
  full-width buttons (Update chapter, Go to chapter, Save bookmarks, Refresh updates).
  With 72px rows, fewer than two series fit in the list. Options: put the two NatoManga
  buttons side by side, or turn Refresh into a link in the status line.
- **Covers fill in slowly for big libraries.** The series-page phase checks at most 20
  series per run. If the real bookmark cards turn out to lack covers, a 3,000-4,000
  bookmark library needs many runs to fill in. A series whose page never yields a cover
  is also rechecked every run and can crowd out the rest. `metadataCheckedAt` can't
  order them, because the bookmark pass stamps it too. A separate "series page checked"
  time, checked oldest first, would rotate through the library.
- **The new permission shows a warning.** Host access to `*.2xstorage.com` makes Chrome
  show a permission warning. For store users, it's an approval prompt when they update.
