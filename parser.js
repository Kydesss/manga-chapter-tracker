// parser.js
// Turns a chapter-page URL (or a series-page URL, for Plan to read) into a
// structured record.
// This is the heart of the product: because the chapter number lives in the
// URL, we never have to scrape page content to know where the reader is.

// The sites we support. Add a new site by adding an entry here.
// `host` is the site's current domain, matched against the end of the hostname
// so both "manganami.com" and "www.manganami.com" work.
//
// `id` is the stable key stored in every record and cloud row, so it never
// changes, even when a site moves domain. A move adds the old domain to
// `legacyHosts`: its URLs are still recognized, and are rewritten to
// `canonicalOrigin` wherever they enter the library (see upgradeSiteUrl).
//   NatoManga moved: natomanga.com now 301-redirects to www.manganami.com with
//   the same paths (checked 2026-11-12). The site calls itself MangaNato there.
const SITES = [
  { id: "mangaread.org", host: "mangaread.org", name: "MangaRead" },
  {
    id: "natomanga.com",
    host: "manganami.com",
    name: "NatoManga",
    legacyHosts: ["natomanga.com"],
    canonicalOrigin: "https://www.manganami.com",
  },
];

// Both sites share the same shape:
//   /manga/{slug}/chapter-{number}
// The number can be a decimal expressed with a dash or dot, e.g. "83-2" or
// "520-5" (meaning 83.2 / 520.5), so we must NOT assume an integer.
// Also accepted (the link is saved as-is, so Continue returns to the page):
//   - a volume prefix, /manga/{slug}/vol-2-chapter-5. The chapter number is
//     the label; the volume isn't part of it, so a site that restarts chapter
//     numbers each volume would rank them wrongly (neither site does today).
//   - a page number after the chapter, /manga/{slug}/chapter-100/2. Only a
//     number, so a different page under a chapter (comments, say) isn't
//     mistaken for reading it.
// Query strings and #anchors never reach this: it matches the URL's path.
const CHAPTER_RE = /\/manga\/([^/]+)\/(?:vol(?:ume)?-[0-9]+-)?chapter-([0-9]+(?:[-.][0-9]+)?)(?:\/[0-9]+)?\/?$/i;

// A series page is the chapter URL minus the chapter: /manga/{slug}, with or
// without a trailing slash (MangaRead adds one). Anchored at the start so a
// deeper path that merely contains "/manga/x" isn't mistaken for one.
const SERIES_RE = /^\/manga\/([^/]+)\/?$/i;

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith("." + domain);
}

function isLegacyHost(site, hostname) {
  return (site.legacyHosts || []).some((d) => hostMatches(hostname, d));
}

// Find which supported site a hostname belongs to (or null), current or old domain.
function matchSite(hostname) {
  const h = hostname.toLowerCase();
  return SITES.find((s) => hostMatches(h, s.host) || isLegacyHost(s, h)) || null;
}

// Rewrite a URL on a site's old domain to its current one, keeping the path,
// query, and fragment. Anything else (other sites, non-URLs, null) comes back
// unchanged, so this is safe to run over any stored link. Only http(s) links
// are rewritten: turning, say, an ftp:// link into https would let it slip past
// the link checks that guard imports.
export function upgradeSiteUrl(raw) {
  if (typeof raw !== "string") return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
  const h = url.hostname.toLowerCase();
  const site = SITES.find((s) => s.canonicalOrigin && isLegacyHost(s, h));
  if (!site) return raw;
  return `${site.canonicalOrigin}${url.pathname}${url.search}${url.hash}`;
}

// The origin to build a series URL from: the page's own, unless it's an old domain.
function originFor(site, url) {
  return isLegacyHost(site, url.hostname.toLowerCase()) ? site.canonicalOrigin : url.origin;
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
    chapterUrl: upgradeSiteUrl(url.href),
    seriesUrl: `${originFor(site, url)}/manga/${slug}`,
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
    seriesUrl: `${originFor(site, url)}/manga/${slug}`,
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
