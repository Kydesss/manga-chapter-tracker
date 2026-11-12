# Settings and custom sites (plan)

Status: in progress on `feat/custom-sites` (2026-11-12). Finishes Bundle A's
Settings surface and starts Bundle B (see `ROADMAP.md`).

## Problem

Shiori only recognizes two sites, and both are written into `parser.js`. On any
other site the popup says "not a chapter page", the shortcut shows "–", and
bookmark import skips the bookmark. When NatoManga moved to manganami.com, the
fix needed a code release and a storage migration.

## Goals

- Add a site yourself: a host plus URL patterns for its chapter and series pages.
- Every part of Shiori uses it: the popup, the save shortcut and bookmark import.
- The built-in sites keep working exactly as today: same ids, same records.
- No new permissions, no database change.

Not in v1: chapter numbers in query strings (`?chapter=12`), sites whose chapter
URLs carry no series slug (e.g. `/chapter/{uuid}`), rewriting stored links when you
change a custom site's host, content scripts, save reminders.

## Decisions

### 1. Where settings live: `chrome.storage.sync`

Site definitions (and later preferences) go in `chrome.storage.sync`, wrapped by a
small `settings.js` store (the "settings store" from the roadmap's foundations).

- **It follows you between your Chrome browsers** without a Supabase table or
  migration. Series themselves already sync through Supabase: a row carries the
  site id, slug and links, so a series saved from a custom site shows up and
  Continue works on every device.
- **Not tied to the Shiori account.** It syncs with the Chrome profile, like any
  extension's settings. Site patterns aren't personal reading data, so account
  isolation (which is about the library) doesn't apply.
- **On a device without the definition** (Chrome sync off, or not caught up), its
  series still list and open; only saving new chapters from that site needs the
  definition, and the site's name falls back to its id.
- **Quota:** each site is its own item, `site:<id>` -> the definition plus `addedAt`
  (for order), at most 25 sites. Chrome limits a synced item to 8 KB, which a single
  list of sites outgrows at around 17 (Codex review); one item per site stays far under
  it. A write Chrome refuses is shown as an error in the form.

Rejected: a Supabase `sites` table (a migration and cutover for little gain);
`chrome.storage.local` only (you'd re-enter every site on each browser).

### 2. Patterns: placeholders, not regex

A pattern is a URL path with placeholders, e.g. `/manga/{slug}/chapter-{chapter}`.

- `{slug}` - one path segment's worth of text (no `/`); required once in both patterns.
- `{chapter}` - a number, with an optional decimal written `.` or `-` (`83-2` = 83.2);
  required once in the chapter pattern, not allowed in the series pattern.
- `*` - any text within a segment (no `/`), for parts that vary, like a chapter id.
- Only printable ASCII is allowed (what a browser's URL path can hold). A control
  character such as NUL would end up in series links the cloud can't store, failing
  every upload (Codex review).
- Everything else matches literally (case-insensitive). A trailing slash is optional.

Patterns compile to an anchored regex with every literal escaped, so a pattern can't
inject regex syntax, and the pieces can't overlap enough to hang (paths are short and
each placeholder is bounded by literals or `/`). Raw regex is deliberately not offered.

Both patterns are required: every record needs a series link (the cloud requires
one), built by putting the slug into the series pattern on the page's origin.

### 3. One matcher for built-in and custom sites

The parser becomes config-driven. A site is `{ id, host, name, chapterRe, seriesRe,
seriesPath(slug), legacyHosts?, canonicalOrigin? }`. Built-ins keep their hand-written
regexes (they also accept volume prefixes and page numbers); custom sites get compiled
ones. The same matching code runs over both.

`parser.js` stays synchronous and pure: each parse function takes an optional `sites`
list, defaulting to the built-ins. A new `sites.js` loads the custom definitions from
settings, compiles them, and returns built-ins + custom. The popup, the shortcut and
bookmark import pass that list in.

### 4. Site ids

A custom site's id is its host as first entered (lowercased, `www.` dropped), the
same convention as built-ins (`mangaread.org`). It never changes afterwards, so
records stay attached even if you edit the host. A host that a built-in site already
covers (including NatoManga's old domain) is refused, as is a duplicate.

The id itself is checked too, on every stored definition: it must be a plain host
that isn't, and doesn't fall under, a built-in site's id or domains. Records are keyed
`<site id>:<slug>`, so a definition arriving through Chrome sync with id
`mangaread.org` and some other host would otherwise save over your MangaRead series
(Codex review). The parser drops such a site as well, as a backstop.

### 5. Names come from the definitions

The cloud doesn't store a site's display name: a pulled row gets the built-in name or,
failing that, the site id. So the library's site label prefers the current
definition's name, then the record's `siteName`, then the id. Renaming a custom site
updates every row at once, and a sync can't replace your name with the id.

### 6. Where Settings lives

On the library page (already the options page), as a **Settings** view reached from a
header button or `library.html#settings`. v1 has one section, **Sites**:

- The built-in sites, listed and locked.
- Your sites, each with Edit and Remove.
- An add/edit form: host, name, chapter pattern, series pattern, and a **Test a URL**
  box that shows live what the URL parses to (series, chapter, or "no match") before
  you save.
- Removing a site keeps its series in the library; they just can't be saved from
  that site until it's added back.

The popup, on an unrecognized page, offers **Add this site**, which opens Settings
with the host filled in and the page's URL in the test box.

## Permissions

None added. The popup and the shortcut read the current tab's URL through
`activeTab`, which Chrome grants for whatever site you're on when you use them, and
bookmark import already sees every bookmark's URL. Nothing runs on a site's pages.

## Tests

- Pattern compiler: placeholders, escaping of regex characters, required/forbidden
  placeholders, decimals, trailing slash, refusing bad input.
- Parser with custom sites: chapter, series, unknown host, a custom site can't shadow
  a built-in, built-ins unchanged.
- Settings validation: host normalisation, duplicates, built-in hosts, the 25-site cap.
- Site labels prefer the current definition's name.
- Bookmark import and the shortcut recognize a custom site.
