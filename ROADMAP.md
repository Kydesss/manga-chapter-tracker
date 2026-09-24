---
tags:
  - development
  - ux-design
---

# Shiori - Roadmap

The long-term vision and plan for the product, organized into **bundles**: groups of
features that share the same foundation and are best built together. Shipped work lives
in [CHANGELOG.md](./CHANGELOG.md); design detail for in-flight work lives in `docs/`.

## Vision

The one place a reader keeps their spot across everything they read, on any site, any
browser, any device. Effortless (one tap to save, one tap to resume), quietly
intelligent (it knows your position from the URL, it never loses your place), and
respectful of attention (no notification spam). It starts as a browser extension and
grows into a small cross-platform service.

## Guiding principles

- **Local-first.** Always works offline and without an account. Cloud and accounts are additive, never required.
- **Restraint.** Features must not create a second inbox to manage. Default to quiet.
- **Progress is sacred.** Reading position never silently moves backward or gets lost.
- **One library.** Series from every supported site and surface live in a single list.
- **User-extensible.** Users add their own sites rather than waiting for us to hardcode them.

## Status snapshot

- **Shipped:** local-first MVP (v0.1.x), cloud accounts + cross-device sync (v0.2.x,
  validated cross-device), and the Shiori brand + design system (v0.3.x).
- **In review:** NatoManga bookmark import on the `autoscraper` branch (targeting
  v0.4.0): a one-press import of a site's bookmarks, plus the `plan`/`reading` status,
  storage schema v3/v4, covers, `+N` update badges, and a manual **Refresh updates**.
  The review fixes are in; a live test is still needed. See
  [Site bookmark import](#in-flight-site-bookmark-import-v040).
- **Next:** MangaRead bookmark import. Planned, not built.
- **Supported sites:** mangaread.org and natomanga.com for saving chapters; natomanga.com
  for bookmark import (in review).
- **Surfaces:** Chrome extension.

## How this roadmap is organized

Features are grouped into bundles by shared foundation, so we build the common plumbing
once. Tentative version targets are a sketch, not a commitment. Sequencing is flexible,
but bundles are meant to ship together.

---

## Foundation: Brand and design system (shipped in v0.3.x, ongoing)

### Product identity (decided)

**Name:** Shiori - 栞, Japanese for bookmark; literally the object for continuing where
you left off. The name carries the promise and future-proofs the product beyond manga
(webtoons, light novels, fanfiction, articles, docs).

**Brand promise:** Never lose your place. **Tagline:** Remember your place.
**Mission:** Help readers continue every story effortlessly across sites, browsers, and
devices. **Vision:** The universal bookmark for everything you read.
**Values:** Continuity, Reliability, Simplicity, Respect.

Decision filter for everything that follows: **does this help Shiori remember the
reader's place?**

### Design system (shipped, extends as surfaces grow)

Logo (bookmark with an "S" in the negative space), indigo-led palette, calm
Kindle/Notion/Linear feel, OS light/dark themes, and formalized design tokens
(`tokens.css`, documented in `docs/design-tokens.md`). Status color semantics, card
hierarchy, and the "no faked progress bars" rule are defined for the surfaces below.

**Reversible-action pattern (v0.3.3).** Wherever a surface can move the reader's position,
the action that moves it is primary and a non-destructive one sits beside it: the popup
pairs **Update chapter** with **Go to chapter X**, which returns you to your saved place
without touching it. "Progress is sacred" made reversible - carry it into every later
surface that can move a position.

---

## In flight: Site bookmark import (v0.4.0)

**Shared foundation:** each site gets a *bookmark adapter*. The adapter recognizes the
site, finds its bookmark pages, turns bookmark cards into records, and detects a
signed-out session. Everything else is shared: a service-worker import job that fetches
pages inside the user's signed-in tab, and a single storage write that only ever moves
progress forward. The adapter is the only site-specific part.

- **NatoManga (built, in review).** Jonah's importer: one **Save bookmarks** press walks
  every `/bookmark?page=N` page, then fills in missing covers and latest chapters from
  up to 20 series pages. **Refresh updates** reruns it. The plan and the pre-merge
  review are in
  [natomanga-bookmark-import-plan.md](./docs/natomanga-bookmark-import-plan.md). The
  review's four blockers and follow-up bugs are fixed, with regression tests. Before
  merging, it still needs a live test with a signed-in NatoManga account and a real
  captured fixture page.
- **MangaRead (next, planned).** MangaRead runs on Madara, a WordPress manga theme that
  many sites use, so its adapter will be a general Madara adapter configured by host. See
  [mangaread-bookmark-import-plan.md](./docs/mangaread-bookmark-import-plan.md).
- **Refactor first.** The branch hard-codes NatoManga in its message types, job key, and
  popup button. Turn that into the adapter interface before adding the second site, so
  MangaRead doesn't duplicate it.

**How this changes the bundles below.** Import brings parts of Bundles A and C forward:

- **Bundle A:** The `status` field (`plan` | `reading`) and schema v3 land with the
  import. The full-page library also becomes more urgent. An import can add thousands of
  series to a 360px popup that has title-only search and no status or site filter.
- **Bundle B:** A Madara adapter configured by host is a natural first connector for
  custom sites. Adding a site built on Madara could bring import along with URL parsing.
- **Bundle C:** Bookmark pages can list each series' latest chapter all at once. That's
  cheaper and politer than fetching every series page. Prefer bookmark-page metadata and
  fall back to per-series fetches. For NatoManga this already landed: covers, latest
  chapters, per-series `+N` badges, and a manual refresh. Scheduled checks and the
  toolbar badge remain.
- **Sync:** Plan-to-read records don't sync yet, because the cloud table requires a
  chapter. A cloud schema migration is now needed to keep one library across devices.
- **Progress is sacred:** Reading position only moves forward, so an importer that
  misreads a page advances series for good. That makes the "Set current chapter"
  override and a preview before an import writes anything more important.

**Open questions.**

- Should re-importing restore series the user removed from Shiori? Today it does.
- Should bookmark pages be parsed in the tab with the real DOM, or with the current
  string parser that has no dependencies?
- Should imports have a preview/confirm step, as Bundle A plans for browser-bookmark
  import, or stay one press?

---

## Bundle A: Management surface (tentative v0.4)

**Shared foundation:** a full-page app and a per-series `status` field. Statuses need a
place to live and filter; the app is where they render; bulk import's preview lives in
the app. Building these together avoids doing the card UI and status plumbing twice.

- **Full-page library + settings app.** One extension page opened in a tab (compact
  popup stays for quick save/resume). Reuses the same `chrome.storage` data and modules
  as the popup, no new backend. Two areas: a rich **Library** (summary stats, status
  filter tabs, sort, large cards, management actions) and **Settings** (connected sites,
  reminders, notifications, account/sync, data import/export). Design target: the Figma
  Make reference. Opened via `chrome.tabs.create({ url: chrome.runtime.getURL("library.html") })`.
  Needs a counterpart to the popup's reversible-action pattern: the app is where a series
  sitting at the wrong chapter is most likely to be noticed.
- **Series bookmarks / statuses.** One record per series gains a `status`
  (`plan` | `reading` | later `completed`/`dropped`). Save a series page as "plan to
  read"; saving a chapter flips it to "reading." Needs series-page detection in the
  parser. Sync rule: `reading` supersedes `plan`; furthest-chapter governs once reading.
  *Partly landed with site bookmark import:* the `plan`/`reading` field, Plan to read in
  the popup, "saving a chapter flips it to reading," and the sync rule in `merge.js`.
  Still to do: saving from a series page, and syncing Plan-to-read records, which needs
  the cloud migration.
- **Bulk import of browser bookmarks.** One-click import (the `bookmarks` permission)
  that filters to supported/custom sites, parses each URL, dedupes by furthest chapter,
  and marks records dirty to sync. Preview/confirm UI lives in the app. Covers readers
  whose bookmarks live in the browser; site bookmark import covers bookmarks kept on the
  sites. Both should share `bulkUpsert` and the preview.

**Open questions.** Grid vs list density; how much management (bulk ops) in v1; whether
the app is also the extension's options page; folder scoping for import.

---

## Bundle B: User extensibility (tentative v0.5)

**Shared foundation:** the Settings surface (from Bundle A) plus a content script
injected on chapter pages. Both features below need exactly this, so the content-script
and settings plumbing is built once.

- **Custom sites / connectors (phase 1).** In Settings, add a site by host + a URL
  pattern with placeholders (`/manga/{slug}/chapter-{chapter}`). The parser becomes
  config-driven: built-in sites plus user patterns compile to one matcher. Pure
  URL-parsing needs no host permission; content-script features on a user site request
  an optional host permission at runtime.
- **Save reminders.** Active nudge when you're on an unsaved chapter (including
  end-of-chapter "back to series" detection), and an opt-in, **local-only** passive
  "potentially unsaved" list. Both toggle in Settings. Passive capture is opt-in,
  disclosed, never synced, easy to purge.

**Open questions.** Pattern syntax (placeholders vs regex); optional-permission UX; how
assertive the active nudge is; retention window for the passive list.

---

## Bundle C: Series-page intelligence (tentative v0.6)

**Shared foundation:** a "series-page reader" that fetches a series page and parses it
(offscreen-document `DOMParser`). The same mechanism yields the title, the cover image,
and the latest chapter, so metadata, live tracking, and custom-site selectors all build
on it.

- **Richer metadata.** Real series titles (replacing slug-derived ones) and cover
  thumbnails on the cards, for built-in and custom sites. *Partly landed:* NatoManga
  bookmark import brings real titles and covers for the series it imports. Covers are
  remote images, and NatoManga's cover host needs a referrer rule (`declarativeNetRequest`).
- **Live update detection.** *Partly landed:* NatoManga series get per-series `+N`
  badges and a manual **Refresh updates**. Still to do: a background job
  (`chrome.alarms`, staggered, polite) that checks followed series for the latest
  chapter. Toolbar badge counts series with updates;
  per-series "+N" badges show how far ahead each is; quiet by default, OS notifications
  only as a later per-series opt-in. Per-series and global off switches in Settings.
  Once latest is known, the save area can offer "Go to latest chapter" as a third action
  beside the existing jump to your saved one.
- **Custom-site selectors (phase 2).** Optional CSS selectors per custom site for title,
  cover, and latest chapter, so the two features above also work on user-added sites.

**Open questions.** Check frequency vs politeness; robust latest-chapter detection across
layouts; cover URL stability and fallback; whether update counts sync or stay per-device.

---

## Bundle D: Reach - mobile web app (tentative v0.7)

**Shared foundation:** extract the parser (and ideally the merge/sync core) into a
**shared module** reused by the extension and the web app. This refactor also smooths
Firefox (Bundle E), so it pays for itself twice.

- **Companion mobile web app.** A small, mobile-friendly PWA: sign in with the same
  Google account, see the same library, and save a chapter by pasting its URL. Reuses
  the same Supabase backend and auth (standard web OAuth). Same merge rules keep it
  convergent with the extensions.

**Open questions.** Framework or vanilla; how much library UI to share vs rebuild.

---

## Bundle E: Launch and 1.0 (tentative v1.0)

**Shared foundation:** these are all launch prerequisites; none ship value alone, so they
go together as the public-release push. 1.0 = the polished public launch on both stores,
gated on the feature bar from Bundles A-C.

- **Firefox / cross-browser parity.** `browser.*` via `webextension-polyfill`, manifest
  and background-model differences, a second OAuth redirect URI for Firefox's domain.
  Benefits from Bundle D's shared-module refactor.
- **Store listings.** Chrome Web Store (one-time $5 fee) and Firefox Add-ons / AMO (no
  fee, stricter review, our plain no-build code is reviewer-friendly): assets, review.
- **Privacy policy.** Required by OAuth, the stores, and the passive-capture feature.
- **Freemium cloud monetization.** Local-first stays free forever; cloud accounts and
  sync are the paid tier via Stripe (likely a free trial). Subscription status tracked in
  Supabase via a Stripe webhook; cloud features gate on an active subscription, local
  never does. Cost note: text bookmarks are cheap to store, so this is not urgent.

**Open questions.** Trial length and price; transitioning current free cloud testers;
optional lifetime/donation tier; renaming the GitHub repo from `manga-chapter-tracker`.

---

## Cross-cutting refactors

Done alongside the bundle that first needs them:

- **Config-driven parser** (Bundle B) - built-in and user patterns share one matcher.
- **Shared parser / merge / sync module** (Bundle D, helps Bundle E) - one home for the rules.
- **Settings store** (Bundle A) - a small typed wrapper over `chrome.storage` for preferences.
- **Series-page reader** (Bundle C) - offscreen-document HTML parsing. Pick one parsing
  approach for this and the bookmark adapters (see the site import open questions).
- **Site bookmark adapters** (v0.4) - one interface per site for bookmark import:
  NatoManga first, then MangaRead through a Madara adapter.

## Sync hardening (ongoing)

Deferred from the v0.2 cloud-sync release (see `docs/cloud-sync-design.md`); none block
daily use.

- Tombstone purge (hard-delete old soft-deletes).
- Full multi-account handling (v0.2 only guards against cross-account merging).
- "Resolved N differences" indicator after a conflict.
- "Set current chapter" override to intentionally move to an earlier chapter. The v0.3.3
  "Go to chapter X" button is the read-only half of this; deliberately moving the saved
  position backward still means overwriting it from the chapter page. Site import raises
  the stakes: an import that misreads a page can only be undone this way.
- **Plan to read in the cloud.** Make `chapter` nullable, and add `status` and the
  metadata columns to the Supabase table, so imported Plan-to-read records and
  covers/latest chapters sync. The merge rule it depends on, "a real chapter always
  beats no chapter," is already in `merge.js`. See `docs/cloud-sync-design.md`,
  "Addendum: schema v3", for the proposed migration.

## Polish backlog (small, pick up anytime)

- Keyboard shortcut to save the current chapter.
- Filter/sort by site in the library.
- Parser robustness for URL variants (query strings, `#anchors`, `/chapter-100/2`, `vol-2-chapter-5`).
- Delete undo.
- Chapter labels that can't be ranked numerically ("Extra", "Omake"), which reach storage
  through import or another client. v0.3.3 stops the save area claiming a direction for
  them, but the furthest-chapter merge rule still can't order them either: needs a real
  chapter-ordering model, not a `parseFloat`.

## Exploration / maybe-someday (not committed)

- **iOS app + Safari Web Extension.** Run Shiori in Safari on iPhone/iPad. Requires an
  Xcode app wrapper and the $99/yr Apple Developer Program. A possibility for future
  scaling, not a planned bundle.

## How to use this file

When we pick up a bundle, spin out a focused design doc in `docs/` before building, then
move shipped work into the CHANGELOG. This file stays high-level: the vision, the bundles,
the shared foundations, and the open questions.
