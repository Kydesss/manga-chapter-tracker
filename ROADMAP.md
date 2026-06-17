# Manga Chapter Tracker - Roadmap

The long-term vision and plan for the product. Shipped work lives in
[CHANGELOG.md](./CHANGELOG.md); design detail for in-flight work lives in `docs/`.
This file is the shared reference for where the product is headed and why.

## Vision

The one place a reader keeps their spot across everything they read, on any site,
any browser, any device. It should feel effortless (one tap to save, one tap to
resume), quietly intelligent (it knows your position from the URL, it never loses
your place), and respectful of attention (no notification spam). It starts as a
browser extension and grows into a small cross-platform service.

## Guiding principles

- **Local-first.** Always works offline and without an account. Cloud and accounts are additive, never required.
- **Restraint.** Features must not create a second inbox to manage. Default to quiet.
- **Progress is sacred.** Reading position never silently moves backward or gets lost.
- **One library.** Series from every supported site and surface live in a single list.

## Status snapshot

- **Shipped:** local-first MVP (v0.1.x) and optional Google account + cross-device sync (v0.2.x).
- **Supported sites:** mangaread.org, natomanga.com.
- **Surfaces:** Chrome extension.

The themes below are roughly ordered, but sequencing is flexible. Tentative version
targets are noted only as a sketch.

---

## Theme 1: Brand identity and design system (tentative v0.3)

**Why.** The product currently opens to a generic "Manga Tracker" header and a
sparse popup. To feel like a real product (and to carry a portfolio), it needs a
name, a visual identity, and a documented design system.

**Vision / scope.**
- A distinctive name and logo. The current name is a placeholder. Naming directions to explore (all need a trademark and domain check before committing):
  - Bookmark / place-keeping metaphors: *Shiori* (栞, Japanese for bookmark), *Marque*, *Dogear*.
  - Continuation metaphors: *Tsuzuki* (続き, "to be continued"), *Nextup*, *Resume*.
  - Reading metaphors: *Yomu* (読む, "to read"), *Chapterly*, *Pagekeep*.
- A formal design system: design tokens (color, type scale, spacing, radius, elevation) promoted from the current ad-hoc CSS variables into a documented set; light and dark themes; a component inventory (list row, chapter badge, status line, buttons, empty state, sign-in control).
- Better empty and first-run states: a friendly empty library, a short first-run explainer of how saving works, clearer "open a chapter to save it" guidance.

**UX flow.** First install shows a welcoming empty state with a one-line how-it-works
and a sample. The popup header carries the brand. Visual hierarchy makes the current
series and chapter the clear focal point.

**Technical notes.** The popup already uses CSS variables; formalize them into a
tokens file and document usage. Keep it dependency-free. A logo as an SVG drives all
icon sizes.

**Open questions.** Final name; tone (playful vs minimal); do we want a public brand
(landing page, store listing art) now or after the web app exists?

---

## Theme 2: Series bookmarks, not just chapters (tentative v0.4)

**Why.** Readers want to save a series they *plan to start*, not only a chapter
they're mid-way through. Today the parser only recognizes chapter pages.

**Vision / scope.** A single series can be in one of a few states:
- **Plan to read:** saved from the series page, no chapter yet.
- **Reading:** a chapter is saved (current behavior).
- (future) **Completed / dropped / on hold:** optional shelf states.

**UX flow.**
- On a **series page**, the popup offers "Save series (plan to read)."
- On a **chapter page**, it offers "Save chapter" (current behavior), which also
  transitions a plan-to-read entry into reading.
- The library separates or badges "Plan to read" vs "Reading" (a filter or a section).

**Technical approach.** Keep one record per series (id stays `site:slug`), and add a
`status` field (`plan` | `reading`). Bookmarking a series creates a record with
`status: "plan"` and no chapter; saving a chapter sets the chapter and flips to
`reading`. The series bookmark and reading progress are the same evolving entity, which
avoids duplicates. The parser gains series-page detection (today a series URL returns
null). Sync rule addition: `reading` always supersedes `plan`, and once reading, the
furthest-chapter rule governs as today.

**Open questions.** One record vs two (recommend one); how the library visually groups
states; should completing a plan-to-read auto-suggest chapter 1; a "start reading"
shortcut from a plan entry (a "resume / start" action when you land on a series page).

---

## Theme 3: Bulk import of existing bookmarks (tentative v0.4, high-value onboarding)

**Why.** New users (like Jonah) already have hundreds or thousands of manga in their
browser bookmarks. Asking them to re-save each one by hand is a non-starter. Importing
that pile in one action is the single strongest onboarding moment the product has.

**Vision / scope.** A one-click import that reads the user's browser bookmarks, keeps
only the ones on supported sites, parses each into a record, and adds them to the
library. Pairs with the existing JSON Import/Export.

**UX flow.** From settings/footer, "Import from browser bookmarks" scans and shows a
preview ("Found 312 chapters across 2 sites"), then imports on confirm. A summary
reports added / updated / skipped (reusing the existing import summary).

**Technical approach.** Add the `bookmarks` permission and walk the bookmark tree,
running `parseChapterUrl` on each URL. Dedupe by record id: if the same series appears
at several chapters (a common bookmark habit), keep the **furthest** chapter, reusing
the existing conflict rule. Series-page bookmarks become plan-to-read once Theme 2
lands. Imported records are marked dirty so they sync to the cloud.

**Open questions.** Preview/confirm UI depth; how to treat duplicate-series bookmarks
(furthest wins by default); whether to offer folder scoping; permission prompt framing.

---

## Theme 4: Breadth - more sites and richer metadata (tentative v0.5)

**Why.** Two sites and slug-derived titles are enough to prove the idea, not to be a
daily driver. Breadth makes the library feel complete and legible.

**Vision / scope.**
- **More supported sites.** Add popular manga sites beyond mangaread.org and
  natomanga.com.
- **Real series titles.** Replace the prettified-from-slug title with the actual title
  from the page.
- **Cover images.** Show a small cover thumbnail per series so the library is scannable
  at a glance.

**Technical approach.** Sites that share the `/manga/{slug}/chapter-{n}` shape are a
near-trivial addition to the parser's `SITES` list; sites with different URL shapes need
their own patterns. Real titles and covers come from a content script reading the page
(title element, cover image URL) at save time, stored as `title` and `coverUrl` on the
record. Covers are referenced by URL (with a fallback) rather than cached as blobs to
start.

**Open questions.** Which sites next and in what priority; content script vs background
fetch for metadata; cover URL stability and a graceful fallback; storage and bandwidth
of thumbnails.

---

## Theme 5: Live update detection, notifications, and badges (tentative v0.6, marquee feature)

**Why.** The headline reason a tracker becomes a daily tool: tell me what updated,
without nagging me. Deliberately deferred so it can be done with restraint.

**Vision / scope.**
- A **toolbar badge**: a small number on the extension icon showing how many followed
  series have new chapters since you last looked.
- **Per-series indicators in the list**: a colored badge showing how many chapters a
  series is ahead of your saved position (for example "+3").
- Quiet by default: indicators live in the extension, surfaced when the user looks.
  Optional, per-series, opt-in OS notifications come later if at all.

**UX flow.** You open the popup; series with updates float up or are marked with a
"+N" badge; opening/saving the newest chapter clears that series' count and decrements
the toolbar badge.

**Technical approach.** The most technically involved theme.
- A background job (via `chrome.alarms`) periodically checks followed series for the
  latest available chapter, staggered and rate-limited to be polite to the sites.
- Fetching a series page from the background needs host permissions for the manga
  sites. Parsing HTML without a DOM in an MV3 service worker is a known hurdle; likely
  needs an offscreen document (`DOMParser`) or careful regex extraction.
- Store `latestChapter` and `lastCheckedAt` per series; the badge count is `latestChapter`
  minus saved `chapter`.
- Toolbar badge via `chrome.action.setBadgeText` / `setBadgeBackgroundColor`.
- Respect restraint: per-series enable/disable, sensible check frequency, global off switch.

**Open questions.** Check frequency vs politeness; robust "latest chapter" detection
across layout changes; colour semantics for the per-series badge; whether counts sync
across devices or stay per-device; OS notifications yes/no and when.

---

## Theme 6: Firefox (and cross-browser) support (tentative v0.7)

**Why.** You use Firefox; many readers do too. The product shouldn't be Chrome-only.

**Vision / scope.** A Firefox build with feature parity, published to AMO
(addons.mozilla.org), from a single codebase.

**Technical approach.**
- Adopt the `browser.*` namespace via `webextension-polyfill` so one codebase targets both.
- Reconcile manifest differences (Firefox MV3 background model differs from Chrome's
  service worker; `browser_specific_settings` carries the Firefox add-on id).
- Auth: `browser.identity.launchWebAuthFlow` exists in Firefox but the redirect URL
  differs from Chrome's `chromiumapp.org`, so a second redirect URI must be registered
  on the Google OAuth client.
- Distribution: AMO review and signing; possibly a tiny build step to emit per-browser manifests.

**Open questions.** Single manifest with conditionals vs a build step; how the
background/service-worker differences affect the live-tracking job; Safari later?

---

## Theme 7: Companion web app for mobile and manual entry (tentative v0.8)

**Why.** Mobile browsers can't run extensions easily. A lightweight web app lets phone
readers sign in and manage their list, and lets anyone save a chapter by pasting its URL.

**Vision / scope.** A small, mobile-friendly web app (installable as a PWA) where a
user signs in with the same Google account and sees the same library. Core action:
paste a chapter URL, it parses and saves to the same series list. Reading and resuming
are also available.

**UX flow.** Open the site on your phone, sign in once, paste a link from your manga
reader's share sheet, tap save. Your extension on desktop sees it after its next sync.

**Technical approach.**
- Reuse the backend as-is: same Supabase project, same `series` table, same Google auth
  (standard web OAuth redirect flow rather than the extension flow).
- **Extract `parser.js` into a shared module** used by both the extension and the web
  app, so URL parsing lives in one place. A clean refactor worth doing regardless.
- Host as a static app (for example Vercel or Netlify) with the Supabase client.
- The same merge/conflict rules keep the web app and extensions convergent.

**Open questions.** Framework (or stay vanilla); how much of the library UI to share vs
rebuild; whether the web app also offers the manual "set chapter" override.

---

## Sync hardening (ongoing, as the sync feature matures)

Items deferred from the v0.2 cloud-sync release (see `docs/cloud-sync-design.md`). None
block daily use; they harden and refine sync over time.

- **Tombstone purge.** Periodically hard-delete soft-deleted records past a threshold so the table doesn't grow forever.
- **Full multi-account handling.** v0.2 only guards against silently merging one account's local data into another; full account-switching support comes later.
- **"Resolved N differences" indicator.** Surface, quietly, when a sync pass changed local values due to a conflict.
- **"Set current chapter" override.** An explicit, authoritative way to move to an *earlier* chapter (a reread, or a renumbered series), since progress is otherwise forward-only.

## Polish backlog (small, pick up anytime)

Quality-of-life items raised during earlier reviews, not yet built:

- **Keyboard shortcut** to save the current chapter without opening the popup.
- **Relative timestamps** ("2 days ago") and **filter/sort by site** in the library.
- **Parser robustness** for URL variants: trailing query strings, `#anchors`, multi-page chapter URLs (`/chapter-100/2`), and volume-prefixed chapters (`vol-2-chapter-5`).
- **Delete undo** (a brief "undo" affordance after removing a series).

## Cross-cutting refactors worth doing along the way

- **Shared parser module** (enables Theme 7 and keeps the rule in one place).
- **Shared sync/merge core** that both the extension and any future client can use.
- **A small build step** if/when Firefox and the web app both need to consume shared modules.

## How to use this file

When we pick up a theme, we spin out a focused design doc in `docs/` (like
`docs/cloud-sync-design.md`) before building, then move shipped work into the CHANGELOG.
This file stays high-level: the vision, the themes, and the open questions.
