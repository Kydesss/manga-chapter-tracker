---
tags:
  - development
---

<p align="center"><img src="icons/logo.svg" width="88" alt="Shiori logo"></p>

# Shiori

**Never lose your place.** Shiori (栞, Japanese for bookmark) is a browser extension that tracks which chapter you're on across manga sites, in one unified library. Save the chapter you're reading with one click, then search, sort, and jump back to any series from a single popup. Currently supports MangaRead and NatoManga.

Shiori is **local-first**: it works offline, with no account, storing everything in the browser. Signing in with Google is optional and additive — it syncs the same library across devices through Supabase, and reading position never moves backward when devices disagree.

(The repository and folders still use the `manga-chapter-tracker` name; the product is branded Shiori.)

For the version history and what changed in each release, see [CHANGELOG.md](./CHANGELOG.md).

## About this project

Manga readers follow dozens to hundreds of ongoing series, each updating on its own schedule. The web's default tool for "remember where I was" is the browser bookmark, which was never built for it: bookmarks are flat, static, carry no reading state, and can't span the separate bookmark tools that each manga site ships. The pain scales badly. The reader who inspired this had over 3,000 bookmarks across multiple sites.

This extension reframes the problem around the reader's actual job: instantly see and return to the exact chapter you left off on, across every site, with no manual upkeep. The enabling insight is that the chapter number already lives in the page URL, so the tool can read your position directly instead of scraping pages, which keeps the interface to a single tap.

It started as a self-initiated UX project. The full problem definition, research, design decisions, and rationale are written up in [the UX case study](./Manga%20Bookmark%20Extension%20-%20UX%20Case%20Study.md). This repo is the working build of that concept.

## Load it in Chrome (2 minutes)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked**.
4. Select this `manga-chapter-tracker` folder.
5. The puzzle-piece icon in the toolbar now has the extension. Pin it for easy access.

To try it: open any chapter, for example `https://www.mangaread.org/manga/blue-lock/chapter-350/`, click the extension, and hit **Save chapter**. It appears in your library. Click it later to jump straight back. After you edit any file, return to `chrome://extensions` and click the reload icon on the extension card.

Everything above works without an account. To also sync across devices, hit **Sign in** in the popup footer; setting up your own Google OAuth client and Supabase project is covered in [GOOGLE-SETUP.md](./GOOGLE-SETUP.md).

## What each file does

`manifest.json` is the extension's config. It declares the name, the permissions we need (`storage` to save data, `activeTab` to read the URL of the tab you're on when you click the icon, `unlimitedStorage` so thousands of series fit, `identity` for Google sign-in), the one `host_permissions` entry for the Supabase project, the icon set, and that clicking the toolbar icon opens `popup.html`. It also registers `background.js` as a module service worker. The manifest `key` pins the extension ID, which is what keeps OAuth and sync working across reloads — don't remove it.

The popup still does all the reading and saving work itself, because saving is manual and only happens while the popup is open. The service worker exists for one reason: the sign-in flow (see `background.js`).

`parser.js` is the core of the product. `parseChapterUrl(url)` takes a URL string and returns a structured record (`{ id, site, title, chapter, chapterUrl, seriesUrl, ... }`) or `null` if it isn't a supported chapter page. The key idea: the chapter number is already in the URL, so one regex extracts everything. The record `id` is `site:slug` (for example `mangaread.org:blue-lock`), which is what makes saving an **upsert**: save the same series again and it updates in place instead of creating a duplicate. To support a new site, add one entry to the `SITES` array, as long as it uses the same `/manga/{slug}/chapter-{number}` shape.

`storage.js` wraps `chrome.storage.local`. Everything lives in one object keyed by id, so `getAll`, `upsert`, and `remove` are short and fast. It also owns the sync bookkeeping: the schema migration, dirty flags, soft-delete tombstones, the pull cursor, and the safety snapshot taken before a first sync. If the dataset ever outgrows `chrome.storage`, swapping to IndexedDB only touches this one file, nothing else has to change.

`config.js` holds the public configuration: the Supabase URL, the Supabase **publishable** key, and the Google OAuth client id. These are designed to be client-visible; the data is protected by Supabase row-level security, not by hiding them. A service-role key must never go here.

`auth.js` runs Google sign-in and exchanges the result for a Supabase session, which it stores in `chrome.storage.local`. It uses `chrome.identity.launchWebAuthFlow` with `response_type=id_token` rather than `getAuthToken`, because Supabase's id_token grant needs a Google **ID token** (a JWT), and `getAuthToken` returns an access token, which is the wrong type. Setup steps for the OAuth client are in [GOOGLE-SETUP.md](./GOOGLE-SETUP.md).

`background.js` is the service worker, and its only job is running that sign-in flow. `launchWebAuthFlow` opens a separate auth window, which takes focus and makes Chrome close the extension popup; run from the popup, the flow would be destroyed mid-way and the session never stored. The popup sends a `signin` / `signout` message instead and reads back the result.

`merge.js` is pure conflict-resolution logic — no `chrome`, no network, no storage — so the data-safety rules can be unit-tested in isolation. The rules: deletion resolves first by recency; **reading position is monotonic, the furthest chapter always wins** regardless of which side was written more recently, so a stale device can never move you back; cosmetic fields take the more recent value; `createdAt` keeps the earliest and `updatedAt` the max.

`sync.js` is the sync engine: it reconciles local storage with Supabase over PostgREST via `fetch` (no `supabase-js`), and handles I/O, batching, throttling, the lock, and the cursor. A pass runs **pull → merge → push**, so remote progress is incorporated before anything is sent and a further chapter is never blindly overwritten. The design rationale lives in [docs/cloud-sync-design.md](./docs/cloud-sync-design.md).

`tokens.css` is the design system's single source of truth — colour, type scale, spacing, radius, and elevation tokens, in light and dark — shared by the popup and the planned full-page app. See [docs/design-tokens.md](./docs/design-tokens.md).

`popup.html` / `popup.css` is the interface, styled from those tokens: a save area that reflects the current tab, a search box, a sort dropdown, the scrolling library list, and a pinned footer with sync status, sign in/out, and export/import.

`popup.js` wires it together. On open it reads the active tab, runs it through the parser, and either enables the Save button (showing the detected series and chapter) or explains that this isn't a supported chapter page. When the tab is a different chapter of a series you already track, it also offers a secondary "Go to chapter X" that returns you to your saved position without saving. It renders the library (virtualized, so thousands of rows stay fast), filters as you type, sorts by recent or title, opens a series on click, removes one on the delete button, shows relative last-read times, and — when signed in — kicks off a sync pass and reflects its status.

## How the pieces talk

```
        click icon
            |
        popup.js  --reads active tab URL-->  parser.js  --returns record-->
            |                                                              |
            |  Save button                                                 |
            v                                                              v
        storage.js  (chrome.storage.local)  <-------- upsert(record) ------+
            |
            |  getAll()
            v
        popup.js renders the library list
```

Signed in, one extra loop runs on top of that — on open, after a save, and after a
delete. Local storage stays the source of truth for the UI; sync only reconciles it.

```
        popup.js  --"signin"-->  background.js  -->  auth.js  -->  Google + Supabase
            |                                                            |
            |                                        session stored <----+
            |  runSync()
            v
         sync.js  --pull-->  Supabase (PostgREST)
            |                     |
            |    remote records <-+
            v
         merge.js  (furthest chapter wins, deletes by recency)
            |
            +--> storage.js (write merged)  --dirty records--> sync.js --push--> Supabase
```

## Verified

The conflict-resolution rules in `merge.js` are covered by unit tests in `tests/`. Run them
with Node (no dependencies to install):

```bash
npm test
```

The parser was tested against real URLs from both sites, including decimal chapters (`chapter-83-2` displays as `83.2`), the no-`www` form, and non-chapter pages (series pages, home pages, unsupported sites) which correctly return `null`. Cross-device sync was validated against two signed-in browsers.

## Roadmap

The full product vision lives in [ROADMAP.md](./ROADMAP.md), organized into bundles of
features that share a foundation and ship together: the management surface (full-page app
+ statuses + bulk import), user extensibility (custom sites + save reminders),
series-page intelligence (metadata + live updates), a mobile web app, and the 1.0 launch
(Firefox + stores + freemium cloud). Shipped work is in the [changelog](./CHANGELOG.md).
