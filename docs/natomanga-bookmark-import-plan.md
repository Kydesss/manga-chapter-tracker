---
tags:
  - development
  - planning
  - natomanga
---

# Plan: NatoManga Bookmark Import and Library Expansion

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
