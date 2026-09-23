---
tags:
  - development
  - planning
  - mangaread
---

# Plan: MangaRead Bookmark Import

**Status:** planning only; nothing is built yet. Written 2026-09-23 after reviewing the
NatoManga importer on the `autoscraper` branch
([natomanga-bookmark-import-plan.md](./natomanga-bookmark-import-plan.md)). Start
building once that branch is merged. Its review fixes are in, and a live test is still
needed.

## Goal

Same promise as the NatoManga importer. On mangaread.org, one press of **Save
bookmarks** brings every MangaRead bookmark into the Shiori library. Each series is
saved at the reader's chapter when MangaRead knows it, and as **Plan to read**
otherwise. The same principles apply:

- Local-first: works without a Shiori account.
- No MangaRead credentials are asked for or stored. Requests run inside the user's
  signed-in tab.
- Progress is sacred: an import never moves a series backward, and a *latest* chapter is
  never mistaken for the reader's chapter.
- One library: imported series merge with chapters already saved from MangaRead.
- Polite: user-triggered, one request at a time.

## What we already know (public pages, checked 2026-09-23)

- **MangaRead runs Madara**, a commercial WordPress manga theme (`themes/madara`,
  `plugins/madara-core`). Many manga sites use it, so parsing written against Madara's
  markup is likely reusable on other sites.
- **When signed out, the bookmarks page redirects to the home page.**
  `/user-settings/?tab=bookmark` ends at `/` with a 200, not at a login URL. So the
  "signed out" check has to look at where the response ended up and whether the
  settings markup is there. It can't look for a login page.
- **Every signed-out page has a login form.** Each one includes a login modal
  (`#form-login`, `#loginform`) and a login nonce in an inline script
  (`wpMangaLogin.nonce`). A "the page has a login form" check like NatoManga's would
  misfire here. Fixtures must also have the nonce removed.
- **The bookmark list is a table.** The theme's CSS targets
  `.settings-page table.list-bookmark`, rows containing `div.mange-name` (Madara's
  spelling), and a `#delete-bookmark-manga` control. We haven't seen it signed in yet.
- **Series pages are rendered on the server.** `/manga/{slug}/` lists every chapter as
  `li.wp-manga-chapter > a`, newest first, with a release date in
  `span.chapter-release-date i`, formatted day.month.year (`15.09.2026`). The title is
  in `.post-title h1` and `og:title`. The cover is in `.summary_image img`, and
  `og:image` has the full-size version. The page also exposes a numeric `manga_id`.
- **Chapter URLs** look like `/manga/{slug}/chapter-{n}/`, trailing slash included, and
  `parser.js` already handles them. So imported ids (`mangaread.org:{slug}`) match
  chapters saved by hand.
- **robots.txt** only disallows `/wp-admin/` (except `admin-ajax.php`) and `/WP-manga/`.

## Open questions (need a signed-in session)

1. **Where does MangaRead keep the reader's position?** This is the one that matters.
   The bookmark table may show only the newest chapters, and those must never be
   imported as progress. Madara also has a History tab
   (`/user-settings/?tab=history`) that may record the last chapter read, if MangaRead
   has it turned on.
2. Is the bookmark list paginated? If so, how: a query string, `/page/N/`, or AJAX?
3. Does each bookmark row include the latest chapter and its date? That would give
   Phase 5 metadata for free.
4. What does a signed-in account with no bookmarks look like?
5. Do any bookmarked series use chapter slugs other than `chapter-{n}`, such as
   `chapter-12-5` or a chapter title in the slug?

Start by capturing a sanitized, signed-in bookmark page (and the history page) as
fixtures. That answers most of these questions and becomes the test suite.

## Approach

### Step 0: generalize the NatoManga plumbing (prerequisite)

The branch hard-codes NatoManga at every layer. It has `import-natomanga-bookmarks` and
`get-natomanga-import-state` messages, a `natomangaImportJob` storage key,
`natoImportBtn`/`natoImportStatus` in the popup, and NatoManga wording in
`background.js`'s errors. Before adding a second site:

- Define a bookmark adapter interface, roughly:

  ```js
  {
    siteId: "mangaread.org",
    siteName: "MangaRead",
    matches(url),                  // is this tab on the site?
    firstPageUrl(tabUrl),          // where the bookmark list starts
    parsePage(html, responseUrl, { timestamp }),
    // -> { records, pageCount or nextPageUrl, diagnostics, loginRequired }
  }
  ```

- Use one job runner in `background.js`, parameterized by adapter. It gets generic
  `import-bookmarks`/`get-import-state` messages and one `importJob` record that names
  its site.
- Show one **Save bookmarks** button on any site that has an adapter.
- Move NatoManga behind the interface with no behavior change. Its tests should pass
  unchanged.

### Step 1: a Madara adapter, configured for MangaRead

Write `madara.js` with pure parsing of the bookmark table (and the history page, if
that's where progress lives), with its selectors in one place. Add a MangaRead config
with host, site id, and display name. Move the HTML-walking helpers from `natomanga.js`
into a shared module rather than copying them, or settle the parsing decision below
first.

### Step 2: the import

Keep the NatoManga job's behavior: user-triggered, one request at a time, timeouts and
backoff, per-page diagnostics, and each page saved with `bulkUpsert` as it arrives. Stop
at once when the tab closes, leaves the site, or is signed out, and run one sync pass
afterward. When signed out from the start, show "Sign in to MangaRead in this tab, then
try again."

### Step 3: metadata (later, with Phase 5)

Take covers and latest chapters from the bookmark table if it has them. Otherwise, read
them from series pages, whose public markup is described above.

## Decisions to make

- **Parse inside the tab, or keep Node-testable string parsing?** The job already runs
  code inside the site's tab, where `DOMParser` and real CSS selectors are available.
  That's sturdier than regex-walking HTML, but unit tests would then need a DOM library,
  and the project has no dependencies today. The alternative is to keep pure string
  parsing and share one tested helper module.
- **Bookmarks or history as the source of progress** (open question 1).
- **Same series on both sites.** A series bookmarked on NatoManga and MangaRead becomes
  two records, because ids are per site. Leave it that way for now; linking series
  across sites is a separate feature.

## Acceptance criteria

- One press imports every MangaRead bookmark. Pressing it again changes nothing unless
  MangaRead's data changed.
- A newest chapter is never imported as progress. If the reader's chapter is unknown,
  the series becomes Plan to read.
- A signed-out user gets a clear message, and nothing is written.
- Series already saved from MangaRead chapter pages merge by id, and progress never
  moves backward.
- NatoManga import behaves exactly as it did before the refactor.
- Fixtures are real captures with personal data and nonces removed.

## Before starting

- The NatoManga branch is merged. Its review fixes, done 2026-09-23, cover everything a
  second importer relies on: the sync merge rule, saves keeping imported data, JSON
  import of Plan-to-read records, per-page saving, and the storage lock.
- Open questions 1 and 2 are answered from a signed-in session.
