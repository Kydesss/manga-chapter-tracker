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
- **User-extensible.** Users should be able to add their own sites, not wait for us to hardcode them.

## Status snapshot

- **Shipped:** local-first MVP (v0.1.x) and optional Google account + cross-device sync (v0.2.x), validated cross-device.
- **Supported sites:** mangaread.org, natomanga.com.
- **Surfaces:** Chrome extension.

The themes below are roughly ordered, but sequencing is flexible. Tentative version
targets are a sketch, not a commitment.

---

## Theme 1: Brand identity and design system (tentative v0.3)

**Why.** The product ships as a generic "Manga Tracker." To feel like a real product (and
carry a portfolio), it needs a name, a clear promise, a visual identity, and a documented
design system.

### Product identity (decided)

**Name:** Shiori

**Meaning:** 栞 (Japanese for bookmark) - literally the object whose only job is helping a
reader continue where they left off. The name carries the promise instead of describing a
feature, and it future-proofs the product beyond manga (webtoons, light novels, fanfiction,
articles, docs), which is the direction Theme 5 already points toward.

**Brand promise:** Never lose your place.

**Tagline:** Remember your place.

**Mission:** Help readers continue every story effortlessly across sites, browsers, and devices.

**Vision:** The universal bookmark for everything you read.

**Values:** Continuity (always resume where you left off), Reliability (progress never
disappears or moves backward), Simplicity (saving and resuming take as little effort as
possible), Respect (help without demanding attention).

Every later design decision is measured against one question: **does this help Shiori
remember the reader's place?** The identity emphasizes continuity, reliability, and
simplicity, not manga fandom or collection management.

### Logo direction

Center on a **bookmark**, recognizable at 16x16 and as a toolbar badge (legibility over
cleverness). Avoid manga panels, anime eyes, chibi mascots, and speech bubbles, they make it
read as a manga app rather than a reading-continuity tool.
- **Concept A (recommended):** a simple geometric bookmark whose negative space forms an "S".
- **Concept B:** a bookmark with a progress marker partway down ("you are here" without words).

### Voice

Calm and confident, an extension of the restraint principle. Good: "Continue reading,"
"Saved at Chapter 142," "Last read 3 days ago," "New chapter available." Avoid hype: "Epic
progress unlocked," "Keep grinding," "You're on fire."

### Design system

- Tokens (color, type, spacing, radius, elevation) promoted from the current ad-hoc CSS
  variables; a component inventory shared by the popup and the full-page app (Theme 2).
- **Palette (starting point):** Primary indigo `#4F46E5`, Success `#22C55E`, Neutral
  `#64748B`, dark Surface `#111827`, light Background `#F8FAFC`. The intended feel is
  Kindle / Notion / Linear (calm, reading-first), not anime-streaming.
- **Light and dark themes.** Respect the OS preference by default (`prefers-color-scheme`),
  with an explicit override in Settings. All tokens must pass WCAG AA contrast, including
  badges and disabled states.
- **Status color semantics:** Reading = indigo/blue, Completed = green, Planned = neutral,
  always paired with a text label, never color alone.
- **Card hierarchy:** title primary, current chapter and progress secondary, last-read
  tertiary. The current popup buries the chapter in a side badge; rework rows to this
  hierarchy so they're glanceable.
- **Progress UI rule:** show a progress bar and "Chapter X / Y" only once the latest chapter
  is known (Theme 6). Never render an empty or faked bar.
- Relative timestamps ("2 days ago") for last-read.
- Better empty and first-run states.

**Open questions.** Trademark and domain availability for "Shiori"; whether to rename the
GitHub repo / display name now or at the 1.0 launch; logo Concept A vs B; public brand assets
now or with the launch.

---

## Theme 2: Full-page app - expanded library and settings (foundation) (tentative v0.3)

**Why.** The 360px popup is great for the quick, contextual job (save the chapter I'm on,
resume where I left off) but too cramped for browsing or managing a large library, or for
settings. A full-page app, opened in its own tab, gives room for a rich layout and is the
shared home for the settings several later features need. Design target: the Figma Make
reference (cover cards, summary stats, status tabs, progress bars).

**Vision / scope.** One extension page opened in a browser tab, with two areas:
- **Library:** the rich, scannable view, summary stats (Total / Reading / Completed /
  Planned), status filter tabs, sort, and large cards (cover, title, author, status,
  current chapter, progress, last read), plus management actions (change status,
  multi-select, bulk delete, bulk import, the "potentially unsaved" list).
- **Settings:** connected sites (built-in and user-added), reminders, notifications,
  account and sync, and data (export/import).

**UX flow.** An "expand" control in the popup header opens the app in a new tab. The popup
stays compact and contextual; the app is for browsing, organizing, and configuring.

**Technical approach.** Not a second app: `library.html` / `library.js` reuse the same
modules and the same `chrome.storage` data as the popup (`storage.js`, `parser.js`,
`sync.js`, `merge.js`) and the same design tokens. Both are views over one store, so
changes reflect across them, and the app runs a sync on open like the popup. No new
backend or permissions. Opened via
`chrome.tabs.create({ url: chrome.runtime.getURL("library.html") })`.

**Staged content (not blocked on anything).**
- v1 with today's data: search, sort, status tabs (once Theme 3 lands), title, site,
  current chapter, relative last-read, and management actions.
- + Theme 5 metadata: covers and author on the cards.
- + Theme 6 live tracking: "Chapter X / Y" and the progress bar fill in, only once the
  latest chapter is known (no fake progress before then).

**Open questions.** Grid vs list density; how much management (bulk ops) in v1; whether
the app is also registered as the extension's options page.

---

## Theme 3: Series bookmarks, not just chapters (tentative v0.4)

**Why.** Readers want to save a series they *plan to start*, not only a chapter they're
mid-way through. Today the parser only recognizes chapter pages.

**Vision / scope.** A series can be **plan to read** (saved from the series page, no
chapter yet), **reading** (a chapter is saved, current behavior), or later
**completed/dropped/on hold**.

**UX flow.** On a series page, "Save series (plan to read)." On a chapter page, "Save
chapter," which also flips a plan entry into reading. The library groups or badges the
two states.

**Technical approach.** One record per series (id stays `site:slug`) with a `status`
field (`plan` | `reading`). The parser gains series-page detection. Sync rule:
`reading` supersedes `plan`; once reading, furthest-chapter governs.

**Open questions.** Visual grouping; a "start reading" shortcut from a plan entry.

---

## Theme 4: Bulk import of existing bookmarks (tentative v0.4)

**Why.** New users already have hundreds or thousands of manga in their browser
bookmarks. Importing that pile in one action is the strongest onboarding moment the
product has (Jonah's ~3-4k bookmarks are the canonical case).

**Vision / scope.** One-click import that reads browser bookmarks, keeps the ones on
supported (and user-added) sites, parses each into a record, and adds them. Pairs with
the existing JSON import/export.

**Technical approach.** Add the `bookmarks` permission; walk the tree; run the parser on
each URL. Dedupe by id, keeping the furthest chapter (reuses the conflict rule). Imported
records are marked dirty so they sync.

**Open questions.** Preview/confirm depth; folder scoping; permission-prompt framing.

---

## Theme 5: Custom sites / connectors (phased) (tentative v0.5)

**Why.** Hardcoding every manga site does not scale. Felix's question, "is this site
specific or just a list of the stuff you saved," is the prompt: let users add their own
sites so the extension works anywhere, with the same save/resume (and later live
tracking) as the built-ins. This is a real differentiator.

**Vision / scope.**
- **Phase 1 (simple, this theme):** in Settings, a user adds a site by giving its host
  and a URL pattern with placeholders, for example `/manga/{slug}/chapter-{chapter}`.
  The extension compiles that into a matcher, so save and resume work on that site like a
  built-in.
- **Phase 2 (later):** optional CSS selectors for title, cover, and latest-chapter so
  richer metadata and live tracking (Theme 6) work on custom sites too. This also brings
  real titles and cover images to built-in sites.

**UX flow.** A "Sites" section in Settings lists built-in and user sites. "Add site" form
takes a name, host, and URL pattern, with a test field to preview parsing against a
sample URL. Edit/delete per site.

**Technical approach.** Refactor the parser to be **config-driven**: built-in `SITES`
plus user-defined patterns from storage compile to one matcher interface. Placeholders
(`{slug}`, `{chapter}`, optional `{vol}`) become a regex with named groups. Pure
URL-parsing on the active tab needs no host permission (we read the active tab's URL on
click); but content-script features (live tracking, in-page nudges) on a user-added site
need an **optional host permission** requested at runtime via `chrome.permissions.request`
when the user adds the site.

**Open questions.** Pattern syntax (friendly placeholders vs raw regex); decimal/volume
chapter handling in patterns; the optional-permission UX; shareable community site
presets down the line.

---

## Theme 6: Live update detection, notifications, and badges (tentative v0.6, marquee feature)

**Why.** The headline reason a tracker becomes a daily tool: tell me what updated,
without nagging me. Deliberately deferred so it can be done with restraint.

**Vision / scope.** A toolbar badge counting series with new chapters since you last
looked; per-series "+N" badges in the list showing how far ahead a series is. Quiet by
default; OS notifications only as a later, per-series opt-in.

**Technical approach.** A background job (`chrome.alarms`) checks followed series for the
latest chapter, staggered and rate-limited. Needs host permissions for the relevant sites
(built-in plus opted-in custom sites). Parsing fetched HTML without a DOM in the service
worker likely needs an offscreen document (`DOMParser`). Store `latestChapter` and
`lastCheckedAt`; the badge is `latestChapter` minus saved `chapter`. Per-series and global
off switches (in Settings).

**Open questions.** Check frequency vs politeness; robust latest-chapter detection across
layouts and custom sites; badge colour semantics; whether counts sync or stay per-device.

---

## Theme 7: Save reminders - never lose your place (opt-in) (tentative v0.6)

**Why.** Readers get immersed and forget to hit save. This helps them not lose their
spot. Both behaviours are opt-in via Settings.

**Vision / scope.**
- **Active nudge:** when you're on a chapter page you haven't saved (or that's ahead of
  your saved position), a subtle prompt to save. Includes **end-of-chapter detection**:
  when the page shows an end state (a "back to series" / "next chapter" control), prompt
  to save the chapter you just finished.
- **Passive capture (opt-in, local only):** quietly note chapters you opened but didn't
  save and surface them in a "Potentially unsaved" list in the popup, one tap to save
  each.

**UX flow.** Two independent toggles in Settings. The "Potentially unsaved" list appears
only when passive capture is on and has items.

**Technical approach.** A content script on supported and opted-in custom sites detects
chapter pages and end-of-chapter markers and messages the worker/popup. The passive log
is stored **strictly locally**, never synced, never sent to a server by default.

**Privacy (important).** Passive capture is browsing-activity logging, so it must be
opt-in, clearly disclosed in the UI and privacy policy, local-only, and easy to purge.
Default off. Active nudges carry minimal privacy footprint.

**Open questions.** How assertive the active nudge is (icon badge vs popup toast vs
in-page); end-of-chapter detection robustness; retention window for the passive list.

---

## Theme 8: Firefox (and cross-browser) support (tentative v0.7)

**Why.** Joaquin uses Firefox; many readers do too. The product shouldn't be Chrome-only.

**Technical approach.** Adopt `browser.*` via `webextension-polyfill`; reconcile MV3
background-model and manifest differences (`browser_specific_settings`); register a second
OAuth redirect URI for Firefox's redirect domain; publish to AMO.

**Distribution.** The public AMO listing is targeted to land **with the 1.0 launch**
(Theme 10), alongside the Chrome Web Store listing, so both stores go live together.

**Open questions.** Single manifest vs a build step; background differences vs the
live-tracking job.

---

## Theme 9: Companion web app for mobile (tentative v0.8)

**Why.** Mobile browsers can't run extensions easily. A web app lets phone readers sign
in, see their library, and save a chapter by pasting its URL.

**Technical approach.** Reuse the same Supabase backend and Google auth (standard web
OAuth). **Extract the parser into a shared module** used by both extension and web app.
Host as a static PWA; same merge rules keep everything convergent.

**Open questions.** Framework or vanilla; how much UI to share vs rebuild.

---

## Theme 10: Distribution, monetization, and 1.0 (tentative v1.0)

**Why.** Take it public and make the cloud sustainable.

**What 1.0 means (decided).** 1.0 is the **polished public launch on both the Chrome Web
Store and Firefox Add-ons (AMO)**, gated on a feature bar: brand/design system (Theme 1),
settings (Theme 2), series bookmarks (Theme 3), custom sites (Theme 5), live update
detection (Theme 6), and Firefox parity (Theme 8), shipped together with the freemium
cloud and a privacy policy. Hitting that bar and being publicly listed on both stores is
1.0.

**Distribution.** Two listings at launch:
- **Chrome Web Store:** store assets, a privacy policy (also required by OAuth and by the
  passive-capture feature), and review. One-time $5 developer fee.
- **Firefox Add-ons (AMO):** no listing fee. Review can be stricter, but our plain,
  unminified, no-build code is reviewer-friendly. Firefox uses a different OAuth redirect
  domain, so its redirect URI must be registered on the Google client (see Theme 8).

Maintaining two published listings (two review cycles, kept in step) is the main ongoing
cost of cross-store parity.

**Monetization (freemium, decided).** Local-first stays free forever. Cloud accounts and
sync are the paid tier, via Stripe, likely with a free trial on sign-in. Cloud features
are gated on an active subscription; local features never are.

**Technical approach.** Stripe Checkout plus the customer portal; subscription status
tracked in Supabase via a Stripe webhook (an edge function); the extension checks
subscription state before enabling cloud sync. Cost note: storing a few thousand text
bookmarks per user is negligible; the real scale costs are auth volume and bandwidth, not
storage, so there's runway before monetization is urgent.

**Open questions.** Trial length and price point; how to transition current free cloud
testers; whether to also offer a one-time/lifetime or donation option.

---

## Exploration / maybe-someday (notes only, not committed)

- **iOS app + Safari Web Extension.** Would let the tracker run in Safari on iPhone/iPad
  (John's idea). Requires an Xcode app wrapper and the $99/yr Apple Developer Program.
  Recorded as a possibility for future scaling, not a planned theme.

## Sync hardening (ongoing)

Deferred from the v0.2 cloud-sync release (see `docs/cloud-sync-design.md`). None block
daily use.

- **Tombstone purge.** Periodically hard-delete old soft-deleted records.
- **Full multi-account handling.** v0.2 only guards against cross-account merging.
- **"Resolved N differences" indicator** when a sync pass changed local values.
- **"Set current chapter" override** to intentionally move to an earlier chapter.

## Polish backlog (small, pick up anytime)

- **Keyboard shortcut** to save the current chapter.
- **Relative timestamps** ("2 days ago") and **filter/sort by site** in the library.
- **Parser robustness** for URL variants: query strings, `#anchors`, multi-page chapter
  URLs (`/chapter-100/2`), volume-prefixed chapters (`vol-2-chapter-5`).
- **Delete undo.**

## Cross-cutting refactors

- **Config-driven parser** (enables custom sites; built-in and user patterns share one matcher).
- **Shared parser module** (enables the web app; one home for the rule).
- **Settings store** (a small, typed wrapper over `chrome.storage` for preferences).
- **Shared sync/merge core** for any future client.

## How to use this file

When we pick up a theme, spin out a focused design doc in `docs/` before building, then
move shipped work into the CHANGELOG. This file stays high-level: the vision, the themes,
and the open questions.
