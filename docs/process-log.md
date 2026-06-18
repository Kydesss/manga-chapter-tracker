# Process Log (decision journal)

A running, chronological record of how this project actually unfolded: the
decisions, the reasoning, and Joaquin's own words at each turn. This is **source
material**, not a polished artifact. When we write the portfolio case study, we pull
from here so the narrative reflects Joaquin's real thinking and voice rather than a
tidied-up retcon.

Convention: append a new entry whenever a real decision, reframe, or insight happens.
Quote Joaquin verbatim where the phrasing matters. Keep the why, not just the what.

---

## 1. Origin: a late-night chat

The project started as a casual exchange between Joaquin (kydesss) and his friend
Jonah (Sombaudy). Jonah, who reads a lot of manga, said:

> "maybe ill just make a program to track all of my bookmarks"

Joaquin immediately saw the shape of a solution and the key technical insight, that
the chapter number is already in the URL:

> "it will just get link / and since link already has chap number / it should be
> fairly easy ... then save link to database / then just build UI on extension to
> access bookmarks"

He floated a live-tracker idea (loop the HTML, detect a new chapter, notify). Jonah
pushed back, and this became a defining constraint:

> Jonah: "but really i just need to track which chaps im at / if i have live bookmark
> the notifs will get fucked / i have 3-4k bookmarks lmao"

Joaquin's response shaped the product's stance on restraint:

> "I mean just build the notifs in the UI when you open the extension on Chrome lmao /
> or just enable/disable for specfic chaps"

**Why it mattered.** Two of the product's core principles came straight from this
chat: position-from-URL (the technical enabler) and restraint about notifications (the
3-4k-bookmarks user would be buried by alerts). Jonah's offhand pushback became a real
design constraint.

---

## 2. Reframe: from "a program" to a UX problem

Joaquin chose to treat the idea as a portfolio-worthy UX project:

> "make this seem like a problem-solving UX project for my portfolio"

The reframe was deliberate: "track my bookmarks" was the request, but the real job to
be done was "let me return to my exact reading position without manual upkeep." The gap
between those two framings became the spine of the case study.

**Why it mattered.** It shifted the work from "build a tool" to "define the problem,"
which is the difference between a script and a UX story.

---

## 3. The cross-site insight (Joaquin's own addition)

After the first draft, Joaquin added a pain point that wasn't in the original chat:

> "since NatoManga.com and mangaread.org are two different websites, they have their
> own bookmarking tool on their website. So this kind of also helps users like Jonah
> and me to track multiple websites bookmarks."

**Why it mattered.** This sharpened the product's reason to exist beyond "a better
bookmark." Each site's native bookmark tool is a walled garden; the extension is the
one place that spans them. This is now a headline point in the case study.

---

## 4. MVP scope decisions

Decisions Joaquin made when prompted:

- **MVP = bookmark tracking only.** No notifications in v1, consistent with Jonah's pushback.
- **Two launch sites:** mangaread.org and natomanga.com (the sites he and Jonah actually read on).
- **Storage:** local-first, with cloud accounts added later ("a mix of both").
- **Intent:** a learning project first.
- **Save trigger:** manual button ("full control, zero surprise writes").

**Why it mattered.** Tight scope kept v1 honest and shippable, and the cuts were
principled (notifications deferred for restraint, not laziness).

---

## 5. Building v0.1 and polishing to v0.1.2

Shipped the local-first MVP (parser, storage, popup library), then a polish pass.
Joaquin asked for refinement options and chose a priority set: export/import, list
virtualization for the ~3-4k scale, "already-saved" awareness, and accessibility. He
framed it as wanting v1 "more refined" before moving on.

**Why it mattered.** Shows judgment about finishing v1 properly (data safety, scale,
a11y) before chasing the next phase.

---

## 6. Cloud sync: scoping before building

Joaquin asked to scope the cloud work "before actually building it." Decisions:
Supabase, Google OAuth, sync on save + popup open. He explicitly wanted to understand
the plan first.

**Why it mattered.** Demonstrates planning discipline: a full design doc
(`cloud-sync-design.md`) before a line of sync code.

---

## 7. The edge-case deliberations (Joaquin's risk instincts)

This is the richest part of the process for a case study, because Joaquin drove it.

First, the data-loss worry:

> "I am just worried about some edge cases where we have an initial user that uses the
> offline method of storage and then they start to log in ... perhaps there's a world
> where the local storage gets rewritten by the cloud storage that is empty. So I just
> want to make sure that the edge cases for the sync between local and the cloud are
> seamless."

This led to the data-safety invariants, the key one being **"absence is never
deletion."**

Then, the conflict question:

> "How are we going to solve an edge case where the local storage and the cloud storage
> conflict in the chapters? Like, for example, if I have a manga that I read like a few
> weeks ago, and then I didn't sign in for a while ... duplicate or like old versus new
> bookmarks and how will we know?"

This produced the **furthest-chapter-wins** (monotonic progress) rule, instead of a
naive last-write-wins that could silently move a reader backward.

**Why it mattered.** These weren't prompted by Claude; Joaquin surfaced the failure
modes himself. For a portfolio, this is the strongest evidence of product thinking:
anticipating data loss and silent regressions before they ship.

---

## 8. Auth and sync, built and tested

Built the Google OAuth spike (verified end to end with a real Supabase user), then the
sync engine with the conflict rule isolated as a pure, unit-tested module (19 tests).
Joaquin handled the Google Cloud setup himself.

**Why it mattered.** Shows the project is real and working, not just designed, and that
the riskiest piece (auth) was de-risked first.

---

## 9. Product vision and roadmap

Joaquin laid out the longer-term vision: a brand identity and design system (his note:
the popup "seems very empty with 'Manga Tracker' as a very generic name"), series-page
bookmarks, a companion mobile web app, Firefox support, live update detection with
toolbar and per-series badges, and bulk import of existing bookmarks. He asked for a
dedicated roadmap "for reference for you, Claude and me as well."

**Why it mattered.** Shows the ability to hold a product vision beyond the MVP, and to
sequence it.

---

## 10. Live testing: cross-device sync, and a real bug it caught

Joaquin ran the sync feature against the real backend, step by step: save a new series,
advance a chapter, delete one, then a true cross-device test by loading the extension
on a separate MacBook with an empty library and signing into the same account.

Two real bugs surfaced only because we tested live, not in unit tests:
- **Deletes did not sync.** The delete handler never triggered a sync pass, so
  tombstones sat locally. Fixed by triggering sync on delete.
- **Sign-in silently failed on macOS.** The Google auth window took focus and Chrome
  closed the popup mid-flow, destroying its JavaScript before the session was stored.
  It only "worked" with DevTools attached (which keeps the popup alive). Fixed by moving
  the OAuth flow into a background service worker so it survives the popup closing.

The cross-device test itself passed cleanly: the Mac pulled all 55 series and correctly
hid the one that had been deleted (the tombstone was respected).

**Why it mattered.** This is the strongest QA story in the project. Unit tests proved
the merge logic; live, cross-device testing proved the integration and caught two bugs
that no amount of mocked testing would have found (a missing trigger and a
platform-specific UI lifecycle race). Good evidence of testing rigor and of debugging a
subtle Manifest V3 behavior.

---

## 11. Bringing on a collaborator

Joaquin invited Jonah (the original "i have 3-4k bookmarks" friend) to collaborate via
GitHub. Notable framings from their chat:

- On his own role: "im using AI / i'm just making decisions / creative vision." A third
  friend dubbed it "vibe coding but supervised"; Jonah refined it to "semi-supervised
  vibe coding."
- On the roadmap: "well I told it my ideas and it created a roadmap ... so not 100%
  generated ... it just did the groundwork and I tweaked it."
- Decided to keep the repo private for now and "maybe open source it when we hit version
  1.0."
- Jonah will be the real stress test (~3-4k bookmarks) and uses local-only for now.

**Why it mattered.** The project becomes a genuine two-person collaboration, and Joaquin
is candid that his contribution is product direction and decision-making on top of
AI-assisted implementation. That honesty, plus the roadmap and QA rigor, is a credible
portfolio narrative.

## 12. Scaling ideas from friends, and the 1.0 / business shape

A conversation with friends (Felix and John) generated the next wave of roadmap thinking,
and Joaquin made several product/business calls:

- **Custom sites.** Felix asked whether the tool is "site specific or just a list of the
  stuff you saved." That reframed a scaling problem into a feature: instead of hardcoding
  every site, let users add their own via a settings page (host + URL pattern), so the
  extension works anywhere. Joaquin chose a phased build (simple URL patterns first,
  metadata/live-tracking selectors later).
- **Save reminders.** From Joaquin's own pain of getting immersed and forgetting to save:
  both an active nudge (including detecting the end-of-chapter "back to series" control)
  and an opt-in, local-only passive "potentially unsaved" list. He flagged the privacy
  question himself.
- **A settings page** emerged as the shared foundation these need.
- **Monetization.** Worried about Supabase cost at scale, Joaquin chose a freemium model:
  local-first free forever, cloud as the paid tier (Stripe, likely a free trial).
- **1.0 and going public.** Releasing to the Chrome Web Store would signal 1.0. Defined
  1.0 as the polished public launch gated on a feature bar (design system, settings,
  series bookmarks, custom sites, live tracking) plus freemium cloud and a privacy policy.
- **iOS/Safari** (John's idea) kept as an exploration note only, not a committed theme.

**Why it mattered.** Shows Joaquin moving from "a feature" to product and business
thinking: extensibility as a moat, a sustainability model that aligns cost with payment,
a clear 1.0 definition, and the judgment to keep speculative ideas as notes rather than
commitments.

---

## 13. UI direction from a reference, and the full-page app

Joaquin shared a Figma Make AI mockup of a manga tracker (light cards, cover art, status
badges, summary stats, progress bars) as inspiration and asked for improvements "we can
implement for ourselves." We ran a structured critique rather than copying it.

Key decisions:
- The mockup is a wide management layout, not a 360px popup. So the popup stays compact
  and contextual (save, resume), and the rich layout moves to a separate **full-page app**
  opened in a tab.
- **Library and Settings become one full-page app** (Joaquin's call), reusing the same
  storage and modules as the popup, so it's a new surface, not a second codebase.
- The reference's visual language was folded into the design system: OS-aware light/dark
  themes, status color semantics (with text labels, never color alone), a clearer card
  hierarchy, and a rule to show progress bars only once the latest chapter is known (no
  faked progress).
- Two quick wins shipped immediately: relative "last read" timestamps and an OS-aware
  light theme.

**Why it mattered.** Shows using a reference critically (adopt / adapt / skip, by
surface), recognizing that layout belongs to the right surface, and separating "do it now"
polish from features that depend on data we don't have yet (covers, progress).

---

## 14. Naming the product: Shiori

Joaquin chose the name **Shiori** (栞, Japanese for bookmark) and wrote a full brand
foundation around it. His framing:

> "A manga tracker tracks chapters. Shiori remembers your place. That's a much stronger
> promise."

The reasoning is positioning, not decoration:
- The literal meaning (the object whose only purpose is continuing where you left off) maps
  directly onto the product's principles, "progress is sacred," "never lose your place."
- It future-proofs past manga toward a universal reading-continuity platform (webtoons,
  light novels, fanfiction, articles), which is where Theme 5 already points.
- Brand promise "Never lose your place"; tagline "Remember your place"; calm, confident
  voice (an extension of restraint); a bookmark-centric logo; a Kindle/Notion/Linear visual
  feel rather than anime-streaming.

He set a test to anchor every later decision: **does this help Shiori remember the reader's
place?**

**Why it mattered.** Strong brand thinking: the name is chosen as a promise and a market
position (a continuity tool, not a manga collection manager), with a one-line decision filter
to keep the product coherent as it grows.

---

## Threads to draw out in the case study

- The reframe from "track bookmarks" to "never lose my place."
- A real user's constraint (Jonah's 3-4k bookmarks + notification fatigue) shaping scope.
- Joaquin personally surfacing the two hardest risks (empty-cloud data loss; old-vs-new conflict) and the principled rules that resolved them.
- Restraint as a feature.
- Local-first as a respect-for-the-user stance.
