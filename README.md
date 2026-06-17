# Manga Chapter Tracker (v0.1)

A Chrome extension that tracks which chapter you're on across manga sites, in one unified library. This is the Phase 0 + Phase 1 MVP from the case study: manual save, local storage, two sites (MangaRead and NatoManga).

## Load it in Chrome (2 minutes)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked**.
4. Select this `manga-chapter-tracker` folder.
5. The puzzle-piece icon in the toolbar now has the extension. Pin it for easy access.

To try it: open any chapter, for example `https://www.mangaread.org/manga/blue-lock/chapter-350/`, click the extension, and hit **Save chapter**. It appears in your library. Click it later to jump straight back. After you edit any file, return to `chrome://extensions` and click the reload icon on the extension card.

## What each file does

`manifest.json` is the extension's config. It declares the name, the permissions we need (`storage` to save data, `activeTab` to read the URL of the tab you're on when you click the icon, `unlimitedStorage` so thousands of series fit), and that clicking the toolbar icon opens `popup.html`. There is deliberately no background service worker: because saving is manual and only happens while the popup is open, the popup does all the work itself. That keeps v1 simple.

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

## What's next (later phases)

- **Phase 2 polish:** virtualized list for very large libraries, better empty/loading states.
- **Phase 3 cloud accounts:** optional sign-in with last-write-wins sync (Supabase is the planned backend), so the library follows you across devices.
- **Phase 4:** bulk-import existing browser bookmarks, real series titles via a content script, cover images.
- **Later:** quiet, opt-in "new chapter" detection surfaced inside the popup only, with a per-series toggle, never as an OS notification by default.
