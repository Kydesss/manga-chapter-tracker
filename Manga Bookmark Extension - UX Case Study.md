# Case Study: A Bookmark Tracker for Manga Readers

A self-initiated UX project that turns a real frustration into a focused product concept: a Chrome extension that tracks which chapter a reader is on, across hundreds or thousands of ongoing manga.

## Quick facts

- Role: Product designer (research, UX, interaction design, product definition)
- Type: Self-initiated concept project
- Timeline: Ongoing
- Collaborator: Jonah (engineering partner and primary user)
- Status: Problem definition and v1 design complete; build planned

## Overview

Avid manga readers follow dozens to hundreds of ongoing series at once, each updating on its own schedule. The web's default tool for "remember where I was" is the browser bookmark, which was never designed for this. This project reframes the problem around the reader's actual job to be done, knowing where they left off, and proposes a lightweight extension that understands chapters rather than just storing links.

The project began with a conversation. My friend Jonah, who reads constantly, said he just wanted "a program to track all of my bookmarks." That offhand comment was the seed. I treated it as a UX problem worth defining properly before jumping to a solution.

## The problem

Jonah had over 3,000 browser bookmarks. That number is the headline symptom of a tool being used for something it was never built to do.

Browser bookmarks fail manga readers in specific ways:

They are flat and unstructured. Three thousand entries in a list with no concept of "series" versus "chapter." Finding the one you want means scrolling or remembering an exact title.

They are static. A bookmark to chapter 100 stays pointed at chapter 100 forever. When chapter 101 releases, the reader has to manually find it, open it, delete the old bookmark, and re-save. Multiply that ritual across hundreds of active series.

They carry no reading state. A bookmark cannot answer the one question that matters: "which chapter am I on?" The reader holds that information in their own memory, which does not scale to thousands of series.

They do not travel well. Bookmarks live in one browser profile and are painful to organize, search, or back up.

Reading state is fragmented across sites. This is the pain that browser bookmarks cannot touch at all. Sites like natomanga.com and mangaread.org each ship their own built-in bookmarking and follow tools, but those are walled gardens: each requires a separate account, lives only on that one site, and only knows about that site's series. A reader like Jonah who follows manga across multiple sites ends up juggling several disconnected reading lists plus a pile of browser bookmarks, with no single place that answers "what am I reading and where am I." The extension sits above all of them, consolidating reading position across every supported site into one unified library, regardless of which site a given series lives on.

The core user need, stated plainly: "Across everything I'm reading, let me instantly see and return to the exact chapter I left off on, without manual upkeep."

A key constraint surfaced in research, too. When I raised the idea of live "new chapter" notifications, Jonah pushed back immediately: with thousands of series, real-time alerts would be noise, not value. That shaped scope as much as any feature request did.

## Process

### Understanding the user

My collaborator was also my primary research subject, which gave me unusually direct access to behavior and pain. Key things I learned:

The pain is volume, not complexity. The task per series is trivial. The problem is doing it 3,000 times and keeping it current.

Reading position is the atomic unit of value. Everything the reader cares about reduces to one fact per series: the last chapter read.

More features can make it worse. The notification pushback was the clearest signal. For a high-volume user, an over-eager product creates a second inbox to manage. Restraint was a feature.

### The enabling insight

The technical breakthrough that makes a clean UX possible: on the sites Jonah reads, the chapter number is already in the page URL. A link like `.../blue-lock/chapter-350/` literally contains the series and the chapter. The product does not need to interpret page content or guess. It can read structured meaning directly from the address bar.

I confirmed this held across the two target sites (mangaread.org and natomanga.com), which share nearly identical URL shapes:

- mangaread.org: `https://www.mangaread.org/manga/{series}/chapter-{number}/`
- natomanga.com: `https://www.natomanga.com/manga/{series}/chapter-{number}`

This insight is what lets the interface stay simple. The user's job becomes one tap to save; the system does the parsing and bookkeeping.

### Scoping decisions

I made deliberate cuts to keep v1 honest and shippable:

In: one-tap save of the current chapter, automatic series and chapter detection, a searchable and sortable list of all series, one record per series that updates in place, and instant return to the last chapter.

Out: live update detection and notifications, background polling, and support beyond the two launch sites. These were not dropped for being hard. They were dropped because v1's job is to nail the core need, and because the highest-volume user explicitly did not want notifications turned on by default.

### Designing for a hybrid storage model

A design decision with real UX consequences: the product works fully offline with local storage and has no account requirement, and it optionally syncs to a cloud account for cross-device continuity. The UX principle here is that the tool must be useful the second it is installed, with zero setup friction, and rewarding to invest in later. Sign-in is a benefit the user opts into, never a gate.

## The solution

A Manifest V3 Chrome extension with a single, focused surface: a popup launched from the toolbar.

### Save and update in one action

While reading any chapter on a supported site, the user clicks the extension and hits Save. The system reads the URL, extracts the series and chapter, and stores one record per series. Saving a new chapter for a series already tracked simply updates that record in place. There is no duplicate management, no "delete the old one" ritual. The single most repeated task in the old workflow is reduced to one tap with no cleanup.

### A library that understands series

Instead of a flat list of links, the popup presents a library of series. Each entry shows the series title and the exact chapter the reader is on. Critically, series from natomanga.com and mangaread.org sit side by side in the same list, so the reader stops juggling each site's separate built-in bookmark tool and gets one home for everything they read. The reader can search by name and sort by most recently read or alphabetically, which is what makes a collection spanning multiple sites and thousands of entries navigable rather than overwhelming.

### One tap back to where you left off

Clicking any entry opens the precise chapter the reader last saved. The product's entire reason for existing, "take me back to where I was," is a single click from anywhere.

### Restraint by design

Notifications are deliberately absent from v1. When update detection does arrive, the design intent is that it surfaces quietly inside the popup as a badge the user sees when they choose to look, with a per-series on/off switch, and never as an operating-system alert by default. This directly answers the research finding that, at high volume, push notifications destroy the experience.

## How I would measure success

Because this is a concept project rather than a shipped product, I defined the signals I would track post-launch rather than claiming results I do not have:

Primary: time and number of actions to return to the correct chapter, compared against the current bookmark workflow. The target is one tap versus the multi-step manual hunt today.

Adoption: the share of a user's active series actually tracked in the tool versus left in raw bookmarks.

Retention of the core loop: how often users return to the library to resume reading, which tells me whether the product became the default entry point.

Restraint validation: if and when notifications ship, what fraction of users enable them, and whether enabling them increases or decreases continued use.

## What I learned

Define the problem before designing the product. "Track my bookmarks" was the request. "Let me return to my exact reading position without upkeep" was the actual job. The gap between those two framings is the whole design.

Constraints from the user are gifts. Jonah's resistance to notifications was the most useful piece of research I got. It prevented me from building the obvious feature that would have quietly made the product worse for the people who need it most.

Look for structure that already exists. The chapter number sitting in the URL meant the simplest possible interface was also the most reliable one. The best UX leaned on a technical reality rather than fighting it.

Scope is a design tool. Cutting notifications, extra sites, and accounts from v1 was not a compromise. It was how I kept the core experience clean enough to be worth using on day one.

### What I would explore next

Bulk import of a reader's existing thousands of bookmarks, filtered to supported sites and parsed into clean records, as an onboarding moment that delivers instant value.

Quiet, opt-in update detection that respects the high-volume user.

Broader site support, designed so each new site is a small addition rather than a rewrite.

## Visual asset list (to produce for the portfolio)

- Before and after: a screenshot of a chaotic 3,000-item bookmark bar next to the clean series library.
- The save interaction: the popup on top of a chapter page, mid-save.
- The library view: search and sort in action across many series.
- A simple diagram: URL in, parsed into series plus chapter, stored as one record.
- The restraint principle: a mock of an in-popup update badge with its per-series toggle.
