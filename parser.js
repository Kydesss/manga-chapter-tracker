// parser.js
// Turns a chapter-page URL (or a series-page URL, for Plan to read) into a
// structured record.
// This is the heart of the product: because the chapter number lives in the
// URL, we never have to scrape page content to know where the reader is.

// The built-in sites. `host` is the site's current domain, matched against the
// end of the hostname so both "manganami.com" and "www.manganami.com" work.
//
// `id` is the stable key stored in every record and cloud row, so it never
// changes, even when a site moves domain. A move adds the old domain to
// `legacyHosts`: its URLs are still recognized, and are rewritten to
// `canonicalOrigin` wherever they enter the library (see upgradeSiteUrl).
//   NatoManga moved: natomanga.com now 301-redirects to www.manganami.com with
//   the same paths (checked 2026-11-12). The site calls itself MangaNato there.
//
// Sites you add yourself (Settings > Sites) are compiled by compileSite below
// into the same shape and listed after these, so a custom site can never
// shadow a built-in one. See docs/custom-sites-plan.md.

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
const CHAPTER_RE = /\/manga\/(?<slug>[^/]+)\/(?:vol(?:ume)?-[0-9]+-)?chapter-(?<chapter>[0-9]+(?:[-.][0-9]+)?)(?:\/[0-9]+)?\/?$/i;

// A series page is the chapter URL minus the chapter: /manga/{slug}, with or
// without a trailing slash (MangaRead adds one). Anchored at the start so a
// deeper path that merely contains "/manga/x" isn't mistaken for one.
const SERIES_RE = /^\/manga\/(?<slug>[^/]+)\/?$/i;

const builtinMatchers = {
  matchChapter: (path) => path.match(CHAPTER_RE)?.groups || null,
  matchSeries: (path) => path.match(SERIES_RE)?.groups || null,
  seriesPath: (slug) => `/manga/${slug}`,
};

const BUILTIN_SITES = [
  { id: "mangaread.org", host: "mangaread.org", name: "MangaRead", builtin: true, ...builtinMatchers },
  {
    id: "natomanga.com",
    host: "manganami.com",
    name: "NatoManga",
    builtin: true,
    legacyHosts: ["natomanga.com"],
    canonicalOrigin: "https://www.manganami.com",
    ...builtinMatchers,
  },
];

// --- Custom site patterns ----------------------------------------------------
// A pattern is a URL path with placeholders, e.g. /manga/{slug}/chapter-{chapter}:
//   {slug}     one segment's worth of text (no "/"), the series' key
//   {chapter}  a number, optionally with a decimal written "." or "-" (83-2 = 83.2)
//   *          any text within one segment (chapter pattern only)
// Everything else matches literally, case-insensitively; a trailing slash is
// optional. Patterns are never treated as regex: each segment compiles to its
// own anchored regex with the literals escaped, and a path only matches a
// pattern with the same number of segments. At most two variable pieces per
// segment, separated by text, keeps matching cheap and unambiguous.

const MAX_PATTERN_LENGTH = 200;
const MAX_PATH_LENGTH = 1024; // longer paths never match a custom pattern
const PIECE_RE = /(\{[^{}]*\}|\*)/;
const PIECE_SOURCE = {
  "{slug}": "(?<slug>[^/]+)",
  "{chapter}": "(?<chapter>[0-9]+(?:[-.][0-9]+)?)",
  "*": "[^/]*",
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// Split "/a/b/" into ["a", "b"]: no leading or trailing empty segment.
function pathSegments(path) {
  const parts = path.split("/");
  if (parts[0] === "") parts.shift();
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// Compile one pattern. kind is "chapter" or "series". Returns
// { ok: true, segments, source } or { ok: false, error } with a message for
// Settings.
export function compilePattern(pattern, kind) {
  if (typeof pattern !== "string" || !pattern.trim()) {
    return { ok: false, error: `Enter a ${kind} page pattern.` };
  }
  const p = pattern.trim();
  if (p.length > MAX_PATTERN_LENGTH) return { ok: false, error: "That pattern is too long." };
  if (!p.startsWith("/")) return { ok: false, error: "A pattern is a path, so it starts with /." };
  if (/[?#\s]/.test(p)) {
    return { ok: false, error: "Patterns match the path only: leave out spaces, ? and #." };
  }
  // Printable ASCII only: a browser's URL path never holds anything else (it
  // percent-encodes the rest), and a control character such as NUL would end up
  // in series links the cloud can't store, failing every upload (Codex review).
  if (!/^[\x21-\x7e]+$/.test(p) || p.includes("\\")) {
    return { ok: false, error: "Use only characters that appear in a web address." };
  }
  const counts = { "{slug}": 0, "{chapter}": 0, "*": 0 };
  const segments = [];
  for (const segment of pathSegments(p)) {
    if (segment === "") return { ok: false, error: "A pattern can't contain //." };
    const tokens = segment.split(PIECE_RE).filter((t) => t !== "");
    let variable = 0;
    let previousWasPiece = false;
    let source = "";
    for (const token of tokens) {
      const isPiece = token === "*" || /^\{[^{}]*\}$/.test(token);
      if (isPiece) {
        if (!(token in PIECE_SOURCE)) {
          return { ok: false, error: `Unknown placeholder ${token}. Use {slug}, {chapter} or *.` };
        }
        if (previousWasPiece) {
          return { ok: false, error: "Put some text between {slug}, {chapter} and *." };
        }
        // Refuse a repeat now: the regex below can't hold two groups with one
        // name, and building it would throw (Codex review).
        if (token !== "*" && counts[token] >= 1) {
          return { ok: false, error: `The ${kind} pattern needs ${token} exactly once.` };
        }
        counts[token]++;
        variable++;
        source += PIECE_SOURCE[token];
      } else {
        if (/[{}]/.test(token)) return { ok: false, error: "Use { and } only around slug or chapter." };
        source += escapeRegex(token);
      }
      previousWasPiece = isPiece;
    }
    if (variable > 2) {
      return { ok: false, error: "Use at most two of {slug}, {chapter} and * between two slashes." };
    }
    let re = null;
    if (variable) {
      try {
        re = new RegExp(`^${source}$`, "i");
      } catch {
        return { ok: false, error: "That pattern can't be used." }; // never thrown to callers
      }
    }
    segments.push(re ? { re } : { literal: segment.toLowerCase() });
  }
  if (counts["{slug}"] !== 1) return { ok: false, error: `The ${kind} pattern needs {slug} exactly once.` };
  if (kind === "chapter" && counts["{chapter}"] !== 1) {
    return { ok: false, error: "The chapter pattern needs {chapter} exactly once." };
  }
  if (kind === "series" && counts["{chapter}"]) {
    return { ok: false, error: "The series pattern can't contain {chapter}." };
  }
  if (kind === "series" && counts["*"]) {
    return { ok: false, error: "The series pattern can't contain *: Shiori builds series links from it." };
  }
  return { ok: true, segments, source: p };
}

// Match a URL path against compiled segments: their captured groups, or null.
function matchSegments(segments, path) {
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH) return null;
  const parts = pathSegments(path);
  if (parts.length !== segments.length) return null;
  const groups = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = segments[i];
    if (seg.literal !== undefined) {
      if (parts[i].toLowerCase() !== seg.literal) return null;
      continue;
    }
    const m = parts[i].match(seg.re);
    if (!m) return null;
    Object.assign(groups, m.groups);
  }
  return groups;
}

// A stored custom site definition ({ id, host, name, chapterPattern,
// seriesPattern }) as a site the parser can use, or null if it doesn't
// compile. Definitions are validated when saved (settings.js); this is the
// backstop for one that arrives some other way (Chrome sync, a hand edit).
export function compileSite(def) {
  if (!def || typeof def !== "object") return null;
  const { id, host, name } = def;
  if (typeof id !== "string" || !id || typeof host !== "string" || !host) return null;
  const chapter = compilePattern(def.chapterPattern, "chapter");
  const series = compilePattern(def.seriesPattern, "series");
  if (!chapter.ok || !series.ok) return null;
  const seriesSource = series.source.replace(/\/+$/, "");
  return {
    id,
    host: host.toLowerCase(),
    name: typeof name === "string" && name.trim() ? name.trim() : host,
    custom: true,
    matchChapter: (path) => matchSegments(chapter.segments, path),
    matchSeries: (path) => matchSegments(series.segments, path),
    seriesPath: (slug) => seriesSource.replace("{slug}", () => slug),
  };
}

// Built-ins first, then the custom sites that compile, minus any that would
// take over a built-in's host. Safe to call with anything.
export function withCustomSites(defs) {
  const custom = (Array.isArray(defs) ? defs : [])
    .map(compileSite)
    .filter(
      (site) =>
        site &&
        !BUILTIN_SITES.some((b) => b.id === site.id || siteCovers(b, site.id) || siteCovers(b, site.host))
    );
  return [...BUILTIN_SITES, ...custom];
}

// True when a site already answers for this host (its own domain or an old
// one), or the host is a parent of one of the site's domains.
export function siteCovers(site, host) {
  const h = host.toLowerCase();
  const domains = [site.host, ...(site.legacyHosts || [])];
  return domains.some((d) => hostMatches(h, d) || hostMatches(d, h));
}

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith("." + domain);
}

function isLegacyHost(site, hostname) {
  return (site.legacyHosts || []).some((d) => hostMatches(hostname, d));
}

// Find which site a hostname belongs to (or null), current or old domain.
// Built-ins come first in every list, so they win over a custom site.
function matchSite(hostname, sites) {
  const h = hostname.toLowerCase();
  return sites.find((s) => hostMatches(h, s.host) || isLegacyHost(s, h)) || null;
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
  const site = BUILTIN_SITES.find((s) => s.canonicalOrigin && isLegacyHost(s, h));
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
// chapter page on one of `sites` (the built-ins unless given; sites.js adds
// the ones you've added yourself).
export function parseChapterUrl(rawUrl, sites = BUILTIN_SITES) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null; // not a valid URL (e.g. chrome:// pages, blank tabs)
  }

  const site = matchSite(url.hostname, sites);
  if (!site) return null;

  const match = site.matchChapter(url.pathname);
  if (!match) return null; // on the site, but not on a chapter page

  const slug = match.slug;
  const chapterRaw = match.chapter;
  const timestamp = new Date().toISOString();

  return {
    id: `${site.id}:${slug}`, // stable key => "save" is an upsert, never a dupe
    site: site.id,
    siteName: site.name,
    slug,
    title: prettifyTitle(slug),
    chapter: chapterLabel(chapterRaw),
    chapterUrl: upgradeSiteUrl(url.href),
    seriesUrl: `${originFor(site, url)}${site.seriesPath(slug)}`,
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
// Returns null if this URL is not a series page on one of `sites`.
export function parseSeriesUrl(rawUrl, sites = BUILTIN_SITES) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const site = matchSite(url.hostname, sites);
  if (!site) return null;

  const match = site.matchSeries(url.pathname);
  if (!match) return null;

  const slug = match.slug;
  const timestamp = new Date().toISOString();

  return {
    id: `${site.id}:${slug}`,
    site: site.id,
    siteName: site.name,
    slug,
    title: prettifyTitle(slug),
    chapter: null,
    chapterUrl: null,
    seriesUrl: `${originFor(site, url)}${site.seriesPath(slug)}`,
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
export function parsePageUrl(rawUrl, sites = BUILTIN_SITES) {
  return parseChapterUrl(rawUrl, sites) || parseSeriesUrl(rawUrl, sites);
}

// The host part of a page URL as Settings would store it (lowercase, no
// "www."), or null for anything that isn't an http(s) page.
export function hostOf(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

// SITES is the built-in list, kept under its old name for existing imports.
export { BUILTIN_SITES, BUILTIN_SITES as SITES };
