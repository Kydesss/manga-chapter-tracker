// natomanga.js
// Pure, dependency-free parsing helpers for NatoManga bookmark pages. These
// functions accept HTML strings and return plain data, so saved fixtures can be
// tested in Node without network access or a browser DOM implementation.

import { parseChapterUrl } from "./parser.js";

export const NATOMANGA_HOST = "natomanga.com";

export const NATOMANGA_SELECTORS = Object.freeze({
  pagination: "group-page",
  bookmarkItem: "user-bookmark-item-right",
  title: "bm-title",
  // Each card has labelled <span>s for the reader's last-viewed chapter and the
  // newest chapter. The last-viewed one is matched by its label, never by
  // position, so a reordered card can't turn the newest chapter into progress.
  lastViewedLabel: /\bview(?:ed)?\b|\blast\s*read\b/i,
  latestLabel: /\b(?:latest|newest|current|new|updated?)\b/i,
});

const SERIES_PATH_RE = /^\/manga\/([^/]+)\/?$/i;

export function isNatoMangaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (host === NATOMANGA_HOST || host.endsWith(`.${NATOMANGA_HOST}`))
    );
  } catch {
    return false;
  }
}

export function parseSeriesUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isNatoMangaUrl(url.href)) return null;
  const match = url.pathname.match(SERIES_PATH_RE);
  if (!match) return null;
  const slug = match[1];
  return {
    id: `${NATOMANGA_HOST}:${slug}`,
    site: NATOMANGA_HOST,
    siteName: "NatoManga",
    slug,
    seriesUrl: `${url.origin}/manga/${slug}`,
  };
}

// Normalize bookmark-card data into the extended Shiori record shape. The
// caller supplies a timestamp so this remains deterministic and easy to test.
export function normalizeNatoBookmark(
  { title, seriesUrl, lastViewedUrl = null },
  { timestamp = null } = {}
) {
  const series = parseSeriesUrl(seriesUrl);
  if (!series || !String(title || "").trim()) return null;

  // The last-viewed link must be a chapter of this same series.
  const parsedChapter = lastViewedUrl ? parseChapterUrl(lastViewedUrl) : null;
  const chapter = parsedChapter?.id === series.id ? parsedChapter : null;

  return {
    ...series,
    title: cleanText(title),
    status: chapter ? "reading" : "plan",
    chapter: chapter?.chapter ?? null,
    chapterUrl: chapter?.chapterUrl ?? null,
    // Bookmark cards don't say when the chapter was read, and the import time
    // isn't a read time. Unknown stays null.
    lastReadAt: null,
    coverUrl: null,
    latestChapter: null,
    latestChapterUrl: null,
    latestPublishedAt: null,
    metadataCheckedAt: null,
    updatedAt: timestamp,
  };
}

export function findLastBookmarkPage(html, baseUrl = "https://www.natomanga.com/bookmark") {
  const groups = findElementsByClass(String(html || ""), NATOMANGA_SELECTORS.pagination);
  let maxPage = 1;
  for (const group of groups) {
    for (const anchor of findElementsByTag(group.inner, "a")) {
      const href = resolveUrl(getAttribute(anchor.attrs, "href"), baseUrl);
      if (!href || !isNatoMangaUrl(href)) continue;
      const url = new URL(href);
      if (url.pathname.replace(/\/$/, "") !== "/bookmark") continue;
      const page = Number.parseInt(url.searchParams.get("page") || "", 10);
      if (Number.isSafeInteger(page) && page > maxPage) maxPage = page;
    }
  }
  return maxPage;
}

export function parseNatoBookmarkPage(
  html,
  baseUrl = "https://www.natomanga.com/bookmark",
  { timestamp = null } = {}
) {
  const source = String(html || "");
  const diagnostics = [];
  const records = [];
  const items = findElementsByClass(source, NATOMANGA_SELECTORS.bookmarkItem);

  // Only a page without bookmark cards can be the login page. A signed-in page
  // may still carry a login-looking form (a header modal, say).
  if (!items.length && looksLikeLoginPage(source, baseUrl)) {
    return { records, pageCount: 1, diagnostics: ["login-required"], loginRequired: true };
  }

  if (!items.length) diagnostics.push("no-bookmark-items");

  items.forEach((item, index) => {
    const titleElement = findElementsByClass(item.inner, NATOMANGA_SELECTORS.title)[0];
    if (!titleElement) {
      diagnostics.push(`item-${index + 1}:missing-title`);
      return;
    }

    const allAnchors = findElementsByTag(item.inner, "a");
    const titleAnchor =
      (titleElement.tag === "a" ? titleElement : null) ||
      findElementsByTag(titleElement.inner, "a")[0] ||
      allAnchors.find((anchor) => {
        const href = resolveUrl(getAttribute(anchor.attrs, "href"), baseUrl);
        return href && parseSeriesUrl(href);
      });
    const seriesUrl = resolveUrl(getAttribute(titleAnchor?.attrs, "href"), baseUrl);
    const title = cleanText(titleElement.inner);
    if (!seriesUrl || !parseSeriesUrl(seriesUrl)) {
      diagnostics.push(`item-${index + 1}:missing-series-url`);
      return;
    }

    // Never fall back to an arbitrary chapter link: another link may be the
    // newest chapter, which would falsely advance reading progress. Without a
    // "Viewed" span the series is imported as plan to read.
    const viewedSpan = findLastViewedSpan(item.inner);
    if (!viewedSpan) diagnostics.push(`item-${index + 1}:missing-last-viewed-label`);
    const viewedAnchor = viewedSpan ? findElementsByTag(viewedSpan.inner, "a")[0] : null;
    const lastViewedUrl = resolveUrl(getAttribute(viewedAnchor?.attrs, "href"), baseUrl);
    const record = normalizeNatoBookmark(
      { title, seriesUrl, lastViewedUrl },
      { timestamp }
    );

    if (!record) {
      diagnostics.push(`item-${index + 1}:invalid-record`);
      return;
    }
    if (lastViewedUrl && record.chapter == null) {
      diagnostics.push(`item-${index + 1}:unrecognized-last-viewed-link`);
    }
    records.push(record);
  });

  return {
    records,
    pageCount: findLastBookmarkPage(source, baseUrl),
    diagnostics,
    loginRequired: false,
  };
}

// The first span whose own label (its text outside links) reads as "Viewed".
// Spans labelled as the newest chapter are skipped even if they also match,
// and the title's span has no label outside its link, so a title containing
// "viewed" can't be mistaken for it.
function findLastViewedSpan(cardHtml) {
  for (const span of findElementsByTag(cardHtml, "span")) {
    const label = cleanText(span.inner.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, " "));
    if (NATOMANGA_SELECTORS.latestLabel.test(label)) continue;
    if (NATOMANGA_SELECTORS.lastViewedLabel.test(label)) return span;
  }
  return null;
}

function looksLikeLoginPage(html, baseUrl) {
  try {
    if (new URL(baseUrl).pathname.replace(/\/$/, "") === "/login") return true;
  } catch {
    // The URL diagnostic is optional; continue with markup checks.
  }
  return (
    /<form\b[^>]*(?:action=["'][^"']*\/login|class=["'][^"']*login)/i.test(html) ||
    /<title\b[^>]*>\s*login\b/i.test(html)
  );
}

function resolveUrl(raw, baseUrl) {
  if (!raw) return null;
  try {
    const url = new URL(decodeEntities(raw), baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function getAttribute(rawAttrs, name) {
  if (!rawAttrs) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rawAttrs.match(
    new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
  );
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : null;
}

function hasClass(rawAttrs, className) {
  const classes = decodeEntities(getAttribute(rawAttrs, "class") || "").split(/\s+/);
  return classes.includes(className);
}

// Extract matching elements while respecting nested elements of the same tag.
// This is intentionally small rather than a general-purpose HTML parser; it
// supports the stable structural subset used by NatoManga bookmark fixtures.
function findElementsByClass(html, className) {
  return findElements(html, (_tag, attrs) => hasClass(attrs, className));
}

function findElementsByTag(html, tagName) {
  const wanted = tagName.toLowerCase();
  return findElements(html, (tag) => tag === wanted);
}

function findElements(html, predicate) {
  const results = [];
  const openTag = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  let match;
  while ((match = openTag.exec(html))) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] || "";
    if (!predicate(tag, attrs)) continue;
    const openStart = match.index;
    const openEnd = openTag.lastIndex;
    const close = findClosingTag(html, tag, openEnd);
    if (!close) continue;
    results.push({
      tag,
      attrs,
      inner: html.slice(openEnd, close.start),
      outer: html.slice(openStart, close.end),
    });
  }
  return results;
}

function findClosingTag(html, tag, fromIndex) {
  const token = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  token.lastIndex = fromIndex;
  let depth = 1;
  let match;
  while ((match = token.exec(html))) {
    const value = match[0];
    if (/^<\//.test(value)) {
      depth--;
      if (depth === 0) return { start: match.index, end: token.lastIndex };
    } else if (!/\/\s*>$/.test(value)) {
      depth++;
    }
  }
  return null;
}

function cleanText(value) {
  return decodeEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value || "").replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, code) => {
      const named = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: '"',
      };
      const lower = code.toLowerCase();
      if (named[lower] !== undefined) return named[lower];
      const radix = lower.startsWith("#x") ? 16 : 10;
      const digits = lower.replace(/^#x?/, "");
      const point = Number.parseInt(digits, radix);
      // Like browsers, map NUL, surrogates, and out-of-range values to U+FFFD
      // instead of letting String.fromCodePoint throw on one bad title.
      return isValidCodePoint(point) ? String.fromCodePoint(point) : "\uFFFD";
    }
  );
}

function isValidCodePoint(point) {
  return (
    Number.isInteger(point) &&
    point > 0 &&
    point <= 0x10ffff &&
    (point < 0xd800 || point > 0xdfff)
  );
}
