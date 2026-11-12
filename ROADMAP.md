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
  validated cross-device), the Shiori brand + design system (v0.3.x), and **v0.4.0**
  (2026-11-12): the full-page library, Plan to read (synced), browser-bookmark import,
  account isolation, and cloud schema v2 (server change order for the sync cursor, a
  synced progress reset marker), and **v0.5.0** (2026-11-12): Settings with custom sites
  (add any site by address and URL patterns,
  [custom-sites-plan.md](./docs/custom-sites-plan.md)), a save shortcut, popup Undo, and
  more chapter URLs. See the [changelog](./CHANGELOG.md).
- **Next:** sync hardening (the popup's Save checking for an account switch, Set current
  chapter on the library page, the concurrent-upload race), then save reminders (the rest
  of Bundle B) and the rest of Settings. Site bookmark import is paused with no site
  planned.
- **Supported sites:** mangaread.org and NatoManga (now at manganami.com) built in, plus
  any site you add in Settings whose chapter URLs carry the series and chapter number.
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

## Paused: Site bookmark import

Importing the bookmarks a reader keeps *on a site* (as opposed to in the browser, see
Bundle A). No site is planned right now.

- **NatoManga (built, then removed).** Jonah's importer walked every
  `/bookmark?page=N` page, then filled in covers and latest chapters from up to 20
  series pages, with **Refresh updates** to rerun it. It was removed before release. Its
  plan and pre-merge review stay in
  [natomanga-bookmark-import-plan.md](./docs/natomanga-bookmark-import-plan.md) as a
  starting point if it comes back; `natomanga.js` is in git history before the removal.
- **MangaRead (dropped).** Taken off the roadmap on 2026-11-12. The research notes stay
  in [mangaread-bookmark-import-plan.md](./docs/mangaread-bookmark-import-plan.md) for
  reference.

**What's already in place if it comes back.** The shared, forward-only bulk write
(`bulkUpsert` in `storage.js`) is back, because browser-bookmark import needs it too.
A per-site *bookmark adapter* (recognize the site, find its bookmark pages, turn cards
into records, detect a signed-out session) is deferred until there's a site to build it
for. The removed NatoManga importer hard-coded the site in its message types, job key,
and popup button; whichever site comes next should go through an adapter interface.

**Lessons that still apply.**

- **Progress is sacred:** Reading position only moves forward, so an importer that
  misreads a page advances series for good. That makes the "Set current chapter"
  override and a preview before an import writes anything more important.
- **Bundle C:** Bookmark pages can list each series' latest chapter all at once. That's
  cheaper and politer than fetching every series page.

**Open questions (if it resumes).**

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
  Make reference. *The Library shipped in v0.4.0
  ([library-page-plan.md](./docs/library-page-plan.md)); Settings started with its
  Sites section ([custom-sites-plan.md](./docs/custom-sites-plan.md)), the rest of its
  sections to follow.* It's also the options page,
  opened with `chrome.runtime.openOptionsPage()`. Needs a counterpart to the popup's
  reversible-action pattern: the app is where a series sitting at the wrong chapter is
  most likely to be noticed. v1 has the read-only half (Continue / Start); moving a
  position backward waits on `progressResetAt` (Sync hardening), because sync would
  undo it today.
- **Series bookmarks / statuses.** One record per series gains a `status`
  (`plan` | `reading` | later `completed`/`dropped`). Save a series page as "plan to
  read"; saving a chapter flips it to "reading." Needs series-page detection in the
  parser. Sync rule: `reading` supersedes `plan`; furthest-chapter governs once reading.
  *On `master`:* the `plan`/`reading` field, Plan to read in the popup, saving a series
  page as Plan to read (the parser recognizes series pages), "saving a chapter flips it
  to reading," and the sync rule in `merge.js`. Syncing Plan-to-read records is in
  progress with cloud schema v2 (see Sync hardening).
- **Bulk import of browser bookmarks** *(shipped in v0.4.0; see
  [bookmark-import-plan.md](./docs/bookmark-import-plan.md))*. **Import bookmarks** on
  the library page asks for the optional `bookmarks` permission, keeps bookmarks on
  supported sites, and previews what would change before anything is written. It
  imports through `bulkUpsert`, which dedupes to the furthest chapter, never moves a
  series back, leaves removed series alone, and now respects resets, using each
  bookmark's own date as its chapter's set time. Later: a folder picker, per-item
  selection, custom sites (Bundle B).

**Open questions.** Grid vs list density; how much management (bulk ops) in v1; whether
the app is also the extension's options page (yes); folder scoping for import (all
bookmarks in v1, with a preview).

---

## Bundle B: User extensibility (v0.5: custom sites shipped)

**Shared foundation:** the Settings surface (from Bundle A) plus a content script
injected on chapter pages. Both features below need exactly this, so the content-script
and settings plumbing is built once.

- **Custom sites / connectors (phase 1). Shipped in v0.5.0:** path patterns
  with `{slug}`, `{chapter}` and `*`, synced through `chrome.storage.sync`, no content
  script or permission needed. Later: chapter numbers in query strings, rewriting stored
  links when a site you added moves. Original plan: in Settings, add a site by host + a URL
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
  thumbnails on the cards, for built-in and custom sites. Storage already keeps real
  titles through saves and sync, and schema v3 has unused cover fields. (NatoManga's cover
  host needs a referrer rule, `declarativeNetRequest`, as the removed importer found.)
- **Live update detection.** Not built (the removed NatoManga importer had per-series
  `+N` badges and a manual refresh). To do: a background job
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

- **Config-driven parser** (Bundle B, done) - built-in and user patterns share one matcher.
- **Shared parser / merge / sync module** (Bundle D, helps Bundle E) - one home for the rules.
- **Settings store** (Bundle A, done) - `settings.js`, a small wrapper over
  `chrome.storage.sync` (custom sites for now).
- **Series-page reader** (Bundle C) - offscreen-document HTML parsing. Pick one parsing
  approach for this and the bookmark adapters (see the site import open questions).
- **Site bookmark adapters** (paused) - one interface per site for bookmark import,
  built when a site is chosen. The shared bulk write they'd use already exists.

## Sync hardening (ongoing)

Deferred from the v0.2 cloud-sync release (see `docs/cloud-sync-design.md`), plus gaps
found in later reviews.

- **Account isolation (done, PR #7).** The library records its owner; a different
  account pauses sync and the popup offers Keep separate (libraries parked per account)
  or Merge. See Invariant 5 in `docs/cloud-sync-design.md`.
- **Cloud schema v2 (shipped in v0.4.0, PR #8).** One migration for the four
  items marked *(schema v2)* below; see
  [cloud-schema-v2-plan.md](./docs/cloud-schema-v2-plan.md). Applied to the live
  project on 2026-11-12. Older installs can no longer push (a hard cutover) until they
  load this build.
- **Server change order for the sync cursor** *(schema v2)*. The incremental-pull cursor
  is built from `updated_at`, which devices set from their own clocks. One record stamped
  ahead of real time (a device with a fast clock) moves the cursor ahead, and later
  changes from other devices are skipped until real time catches up. Fix: a
  server-assigned `synced_at` for the cursor, keeping `updated_at` for conflict
  resolution.
- **Concurrent uploads can briefly overwrite each other.** A push is an unconditional
  upsert, so if device A pulls chapter 40, device B pushes 50, and A's push of 41 lands
  last, the cloud holds 41 until B's next pass merges and pushes 50 again. It converges
  (furthest chapter wins), but other devices can see the lower chapter in between.
  Fix: a conditional write (an RPC that merges server-side, or an `updated_at` /
  `synced_at` precondition). Found in Codex review of cloud schema v2; predates it.
- The popup's Save doesn't check the library epoch: a save made from a popup drawn
  before an account switch lands in the new account's library. The keyboard shortcut
  decides and saves under the lock, and Remove/Undo check the epoch; Save should too.
  Found in Codex review of the polish batch; predates it.
- RLS policies call `auth.uid()` per row; Supabase's advisor suggests
  `(select auth.uid())` so it's evaluated once per query. A small performance change.
- Tombstone purge (hard-delete old soft-deletes).
- Fuller multi-account handling beyond Keep separate: a way to see or export a parked
  library without signing in as its account, and to recover a library whose owner was
  unknown at upgrade.
- "Resolved N differences" indicator after a conflict.
- "Set current chapter" override to intentionally move to an earlier chapter *(schema
  v2: from the chapter page)*. Saving an earlier chapter from the popup, after its "This
  would move you back" warning, now sets the reset marker below, so sync keeps it. Still
  to do: a Set current chapter action in the library page, which needs a safe way to get
  the chapter's link.
- **One synced reset marker: `progressResetAt`** *(schema v2)*. Proposed while planning
  the library page. Sync's furthest-chapter rule means a deliberate backward move (Set current
  chapter, or saving an earlier chapter from the popup while signed in) is undone by the
  next sync pass today. A synced `progressResetAt`, set by a delete or by Set current
  chapter, would let the merge ignore progress from before the reset. It solves this and
  the deletion boundary below with one cloud column; see
  [library-page-plan.md](./docs/library-page-plan.md).
- **A deletion boundary that syncs** *(schema v2: a removal sets `progressResetAt`)*.
  Since v0.4, a save that resurrects a deleted series
  restarts it, so the tombstone's old chapter doesn't win. But a device that never saw the
  deletion still holds the old chapter, and merging it with the restart revives that
  chapter for everyone (found in Codex review of PR #3). Fix: store when a series was
  last deleted (or a restart generation) and sync it, so progress from before the
  deletion never counts.
- **Plan to read in the cloud** *(schema v2)*. `chapter` and `chapter_url` become
  nullable, so Plan-to-read records sync. A `status` column and the metadata columns
  (covers, latest chapters) wait until something needs them: status follows from the
  chapter today, and nothing writes metadata since the NatoManga importer was removed.

## Polish backlog (small, pick up anytime)

- ~~Keyboard shortcut to save the current chapter.~~ Done (Alt+Shift+S).
- ~~Parser robustness for URL variants.~~ Done: page suffixes and volume prefixes; query
  strings and anchors already worked.
- ~~Undo for the popup's Remove.~~ Done.
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
