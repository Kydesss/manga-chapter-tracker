// parser.js
// Turns a chapter-page URL (or a series-page URL, for Plan to read) into a
// structured record.
// This is the heart of the product: because the chapter number lives in the
// URL, we never have to scrape page content to know where the reader is.

// The two sites we support at launch. Add a new site by adding an entry here.
// `host` is matched against the end of the hostname so both "natomanga.com"
// and "www.natomanga.com" work.
const SITES = [
  { id: "mangaread.org", host: "mangaread.org", name: "MangaRead" },
  { id: "natomanga.com", host: "natomanga.com", name: "NatoManga" },
];

// Both sites share the same shape:
//   /manga/{slug}/chapter-{number}
// The number can be a decimal expressed with a dash or dot, e.g. "83-2" or
// "520-5" (meaning 83.2 / 520.5), so we must NOT assume an integer.
const CHAPTER_RE = /\/manga\/([^/]+)\/chapter-([0-9]+(?:[-.][0-9]+)?)\/?$/i;

// A series page is the chapter URL minus the chapter: /manga/{slug}, with or
// without a trailing slash (MangaRead adds one). Anchored at the start so a
// deeper path that merely contains "/manga/x" isn't mistaken for one.
const SERIES_RE = /^\/manga\/([^/]+)\/?$/i;

// Find which supported site a hostname belongs to (or null).
function matchSite(hostname) {
  const h = hostname.toLowerCase();
  return SITES.find((s) => h === s.host || h.endsWith("." + s.host)) || null;
}

// Turn a slug like "blue-lock" into a readable "Blue Lock".
// This is the simple fallback title source for v1 (no content script needed).
export function prettifyTitle(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// True when `title` is only the slug-derived fallback above. A real title (from
// a bookmark import, or later the page itself) should never be replaced by it.
export function isSlugTitle(title, slug) {
  return typeof slug === "string" && title === prettifyTitle(slug);
}

// Chapter "83-2" should display as "83.2".
function chapterLabel(raw) {
  return raw.replace("-", ".");
}

// Main entry point. Returns a record object, or null if this URL is not a
// supported chapter page.
export function parseChapterUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null; // not a valid URL (e.g. chrome:// pages, blank tabs)
  }

  const site = matchSite(url.hostname);
  if (!site) return null;

  const match = url.pathname.match(CHAPTER_RE);
  if (!match) return null; // on the site, but not on a chapter page

  const slug = match[1];
  const chapterRaw = match[2];
  const timestamp = new Date().toISOString();

  return {
    id: `${site.id}:${slug}`, // stable key => "save" is an upsert, never a dupe
    site: site.id,
    siteName: site.name,
    slug,
    title: prettifyTitle(slug),
    chapter: chapterLabel(chapterRaw),
    chapterUrl: url.href,
    seriesUrl: `${url.origin}/manga/${slug}`,
    status: "reading",
    lastReadAt: timestamp,
    coverUrl: null,
    latestChapter: null,
    latestChapterUrl: null,
    latestPublishedAt: null,
    metadataCheckedAt: null,
    updatedAt: timestamp,
  };
}

// A series page becomes a Plan-to-read record: same id and seriesUrl as the
// chapter parser produces, so a later chapter save upgrades this same record.
// Returns null if this URL is not a supported series page.
export function parseSeriesUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const site = matchSite(url.hostname);
  if (!site) return null;

  const match = url.pathname.match(SERIES_RE);
  if (!match) return null;

  const slug = match[1];
  const timestamp = new Date().toISOString();

  return {
    id: `${site.id}:${slug}`,
    site: site.id,
    siteName: site.name,
    slug,
    title: prettifyTitle(slug),
    chapter: null,
    chapterUrl: null,
    seriesUrl: `${url.origin}/manga/${slug}`,
    status: "plan",
    lastReadAt: null, // planning to read isn't reading
    coverUrl: null,
    latestChapter: null,
    latestChapterUrl: null,
    latestPublishedAt: null,
    metadataCheckedAt: null,
    updatedAt: timestamp,
  };
}

// What the popup calls: a chapter page (reading) or a series page (plan to read),
// or null for anything else.
export function parsePageUrl(rawUrl) {
  return parseChapterUrl(rawUrl) || parseSeriesUrl(rawUrl);
}

// Exported for the README / tests and potential reuse.
export { SITES };
