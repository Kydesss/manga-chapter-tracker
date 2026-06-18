# Shiori

**Never lose your place.** Shiori (栞, Japanese for bookmark) is a browser extension that tracks which chapter you're on across manga sites, in one unified library. Save the chapter you're reading with one click, then search, sort, and jump back to any series from a single popup. Works offline with local storage, and currently supports MangaRead and NatoManga.

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

## What each file does

`manifest.json` is the extension's config. It declares the name, the permissions we need (`storage` to save data, `activeTab` to read the URL of the tab you're on when you click the icon, `unlimitedStorage` so thousands of series fit), and that clicking the toolbar icon opens `popup.html`. There is deliberately no background service worker: because saving is manual and only happens while the popup is open, the popup does all the work itself. That keeps the extension simple.

`parser.js` is the core of the product. `parseChapterUrl(url)` takes a URL string and returns a structured record (`{ id, site, title, chapter, chapterUrl, seriesUrl, ... }`) or `null` if it isn't a supported chapter page. The key idea: the chapter number is already in the URL, so one regex extracts everything. The record `id` is `site:slug` (for example `mangaread.org:blue-lock`), which is what makes saving an **upsert**: save the same series again and it updates in place instead of creating a duplicate. To support a new site, add one entry to the `SITES` array, as long as it uses the same `/manga/{slug}/chapter-{number}` shape.

`storage.js` wraps `chrome.storage.local`. Everything lives in one object keyed by id, so `getAll`, `upsert`, and `remove` are short and fast. If the dataset ever outgrows `chrome.storage`, swapping to IndexedDB only touches this one file, nothing else has to change.

`popup.html` / `popup.css` is the interface: a save area that reflects the current tab, a search box, a sort dropdown, and the library list.

`popup.js` wires it together. On open it reads the active tab, runs it through the parser, and either enables the Save button (showing the detected series and chapter) or explains that this isn't a supported chapter page. It renders the library, filters as you type, sorts by recent or title, opens a series on click, and removes one on the delete button.

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

## Verified

The parser was tested against real URLs from both sites, including decimal chapters (`chapter-83-2` displays as `83.2`), the no-`www` form, and non-chapter pages (series pages, home pages, unsupported sites) which correctly return `null`. See `test-parser.mjs` notes in the project history if you want to re-run with Node.

## Roadmap

The full product vision and planned themes (brand and design system, a full-page
library + settings app, series bookmarks, bulk import, user-added custom sites, live
update detection, save reminders, Firefox support, a companion web app, and a public 1.0
launch with freemium cloud) live in [ROADMAP.md](./ROADMAP.md). Shipped work is in the
[changelog](./CHANGELOG.md).
