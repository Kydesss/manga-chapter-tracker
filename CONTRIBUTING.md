# Contributing

Welcome. This is a small two-person project (Joaquin and Jonah) building a manga
chapter-tracking browser extension. This guide gets you running locally and explains
how we work together so we don't step on each other.

For what the product is and where it's headed, see the [README](./README.md) and
[ROADMAP.md](./ROADMAP.md).

## Get the code

The repo is private; you'll need to be added as a collaborator (you are). Then:

```bash
git clone https://github.com/Kydesss/manga-chapter-tracker.git
cd manga-chapter-tracker
```

### Recommended: keep your working copy out of cloud-synced folders

Put the clone somewhere plain like `~/projects/` or `Documents/`, **not** inside a
OneDrive / Dropbox / iCloud folder. We hit real bugs where cloud sync lagged behind
file edits and committed stale files (a stale `manifest.json` once shipped without the
auth config). Keeping the repo outside a sync folder avoids that entirely.

## Run it (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the project folder.
4. Confirm the extension **ID is `oelpohodhpkilfbdijlmopejppdafige`**. That fixed ID
   comes from the `key` in `manifest.json` and is what makes Google sign-in work, so it
   should be identical on every machine.
5. Pin the toolbar icon. Open a chapter on a supported site (mangaread.org or
   natomanga.com) and hit Save.

After editing any file, return to `chrome://extensions` and click the reload icon on
the extension card.

## Local-only vs cloud

- **Local storage works with zero setup.** No account needed; everything is saved on
  your machine. This is all you need to develop and test most things.
- **Cloud sync requires being added as a test user.** The Google sign-in consent screen
  is in "testing" mode, so only allow-listed Google accounts can sign in. If you want to
  test cross-device sync, ask Joaquin to add your Google email as a test user in the
  Google Cloud console. Until then, "Sign in" will fail by design, and that's fine.

The Supabase publishable key and Google client id in `config.js` are safe to have in the
repo (they're meant to be client-visible; data is protected by row-level security). Never
add a Supabase service-role key or the `key.pem` signing key to the repo.

## Run the tests

Unit tests cover the parser, the storage layer, and the sync conflict logic. With Node
installed:

```bash
npm test
```

Please run this before pushing, and add tests when you change the parser, storage, or
merge logic.

## Project layout

- `manifest.json` - extension config (MV3).
- `parser.js` - turns a chapter URL into a structured record. Add a site here.
- `storage.js` - local persistence (chrome.storage.local), soft-deletes, sync bookkeeping.
- `merge.js` - pure conflict-resolution logic (unit-tested).
- `sync.js` - the sync engine (pull, merge, push over Supabase PostgREST).
- `auth.js` - Google sign-in + Supabase session.
- `background.js` - service worker; runs the sign-in flow so it survives the popup closing.
- `popup.html` / `popup.css` / `popup.js` - the UI.
- `docs/` - design docs (`cloud-sync-design.md`) and the `process-log.md` decision journal.

## How we work together

- **Branch per change.** Create a feature branch (`feature/firefox-support`,
  `fix/delete-sync`), open a pull request, and let the other person glance at it before
  merging. Avoid committing straight to `master`.
- **Pull before you push** to avoid conflicts.
- **Keep commits scoped** with clear messages (for example `v0.3: design tokens` or
  `fix: delete now triggers sync`).
- **Keep the docs honest.** On a release, update `CHANGELOG.md` and the `version` in
  `manifest.json` together. When scope changes, update `ROADMAP.md`. Significant product
  or design decisions get a short entry in `docs/process-log.md` (it's the source for the
  portfolio write-up).
- **Versioning.** We're pre-1.0; `0.x` releases. The roadmap sketches themes through 0.8.

## Where to start

Pick something from [ROADMAP.md](./ROADMAP.md) or grab an open issue. The "Polish backlog"
items there are small and self-contained, good first changes. When in doubt, ping Joaquin
about which theme to take.
