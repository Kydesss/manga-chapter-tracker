import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  findLastBookmarkPage,
  isNatoMangaUrl,
  normalizeNatoBookmark,
  parseNatoBookmarkPage,
  parseSeriesUrl,
} from "../natomanga.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const TIMESTAMP = "2026-09-22T12:00:00.000Z";

async function fixture(name) {
  return readFile(new URL(name, FIXTURES), "utf8");
}

test("isNatoMangaUrl accepts the site and real subdomains only", () => {
  assert.equal(isNatoMangaUrl("https://natomanga.com/bookmark"), true);
  assert.equal(isNatoMangaUrl("https://www.natomanga.com/manga/foo"), true);
  assert.equal(isNatoMangaUrl("https://natomanga.com.evil.example/bookmark"), false);
  assert.equal(isNatoMangaUrl("javascript:alert(1)"), false);
});

test("parseSeriesUrl accepts only NatoManga series pages", () => {
  assert.deepEqual(parseSeriesUrl("https://www.natomanga.com/manga/blue-lock/"), {
    id: "natomanga.com:blue-lock",
    site: "natomanga.com",
    siteName: "NatoManga",
    slug: "blue-lock",
    seriesUrl: "https://www.natomanga.com/manga/blue-lock",
  });
  assert.equal(parseSeriesUrl("https://www.natomanga.com/manga/blue-lock/chapter-1"), null);
  assert.equal(parseSeriesUrl("https://example.com/manga/blue-lock"), null);
});

test("saved bookmark fixture parses reading and unread records", async () => {
  const html = await fixture("natomanga-bookmarks-page-1.html");
  const result = parseNatoBookmarkPage(html, "https://www.natomanga.com/bookmark?page=1", {
    timestamp: TIMESTAMP,
  });

  assert.equal(result.loginRequired, false);
  assert.equal(result.pageCount, 12);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.records.length, 2);

  assert.equal(result.records[0].title, "Blue Lock");
  assert.equal(result.records[0].status, "reading");
  assert.equal(result.records[0].chapter, "348.5");
  assert.equal(result.records[0].lastReadAt, null); // an import is not a read
  assert.equal(result.records[0].latestChapter, null);

  assert.equal(result.records[1].title, "Witch & Mercenary");
  assert.equal(result.records[1].status, "plan");
  assert.equal(result.records[1].chapter, null);
  assert.equal(result.records[1].chapterUrl, null);
  assert.equal(result.records[1].lastReadAt, null);
});

test("pagination ignores labels and uses the greatest page query", async () => {
  const html = await fixture("natomanga-bookmarks-page-1.html");
  assert.equal(findLastBookmarkPage(html), 12);
  assert.equal(findLastBookmarkPage("<p>No pagination</p>"), 1);
});

test("malformed bookmark cards are skipped with diagnostics", async () => {
  const html = await fixture("natomanga-bookmarks-malformed.html");
  const result = parseNatoBookmarkPage(html);
  assert.equal(result.records.length, 0);
  assert.deepEqual(result.diagnostics, [
    "item-1:missing-title",
    "item-2:missing-series-url",
  ]);
});

test("login pages return an explicit login-required diagnostic", async () => {
  const html = await fixture("natomanga-login.html");
  const result = parseNatoBookmarkPage(html, "https://www.natomanga.com/login");
  assert.equal(result.loginRequired, true);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.diagnostics, ["login-required"]);
});

// One bookmark card, for layout variations the saved fixtures don't cover.
function page(cardInner, extra = "") {
  return `${extra}<div class="user-bookmark-item-right">${cardInner}</div>`;
}

function parse(html) {
  return parseNatoBookmarkPage(html, "https://www.natomanga.com/bookmark?page=1", {
    timestamp: TIMESTAMP,
  });
}

test("the last-viewed chapter is found by its label, not its position", () => {
  const result = parse(
    page(`
      <a class="bm-title" href="/manga/blue-lock">Blue Lock</a>
      <span>Viewed: <a href="/manga/blue-lock/chapter-12">Chapter 12</a></span>
      <span>Latest: <a href="/manga/blue-lock/chapter-350">Chapter 350</a></span>
    `)
  );
  assert.equal(result.records[0].chapter, "12");
  assert.deepEqual(result.diagnostics, []);
});

test("a title containing 'viewed' is not mistaken for the Viewed span", () => {
  const result = parse(
    page(`
      <span class="bm-title"><a href="/manga/most-viewed">Most Viewed</a></span>
      <span>Current : <a href="/manga/most-viewed/chapter-9">Chapter 9</a></span>
      <span>Viewed : <a href="/manga/most-viewed/chapter-4">Chapter 4</a></span>
    `)
  );
  assert.equal(result.records[0].title, "Most Viewed");
  assert.equal(result.records[0].chapter, "4");
});

test("a card without a Viewed label imports as plan to read, with a diagnostic", () => {
  const result = parse(
    page(`
      <a class="bm-title" href="/manga/blue-lock">Blue Lock</a>
      <span><a href="/manga/blue-lock/chapter-350">Chapter 350</a></span>
      <span><a href="/manga/blue-lock/chapter-12">Chapter 12</a></span>
    `)
  );
  assert.equal(result.records[0].status, "plan");
  assert.equal(result.records[0].chapter, null);
  assert.deepEqual(result.diagnostics, ["item-1:missing-last-viewed-label"]);
});

test("a Viewed link to a different series is not imported as progress", () => {
  const result = parse(
    page(`
      <a class="bm-title" href="/manga/blue-lock">Blue Lock</a>
      <span>Viewed: <a href="/manga/other-series/chapter-5">Chapter 5</a></span>
    `)
  );
  assert.equal(result.records[0].chapter, null);
  assert.deepEqual(result.diagnostics, ["item-1:unrecognized-last-viewed-link"]);
});

test("bookmark cards win over a login-looking form on the same page", () => {
  const result = parse(
    page(
      `
      <a class="bm-title" href="/manga/blue-lock">Blue Lock</a>
      <span>Viewed: <a href="/manga/blue-lock/chapter-12">Chapter 12</a></span>
    `,
      '<form class="modal-login" action="/login"></form>'
    )
  );
  assert.equal(result.loginRequired, false);
  assert.equal(result.records.length, 1);
});

test("invalid character references decode to U+FFFD instead of throwing", () => {
  const result = parse(
    page(`
      <a class="bm-title" href="/manga/odd">Odd &#x110000; &#xD800; &#0; Title &#x1F4D6;</a>
      <span>Viewed: None</span>
    `)
  );
  assert.equal(result.records[0].title, "Odd \uFFFD \uFFFD \uFFFD Title \u{1F4D6}");
});

test("normalization does not mistake the latest chapter for reading progress", () => {
  const record = normalizeNatoBookmark(
    {
      title: "Unread Example",
      seriesUrl: "https://www.natomanga.com/manga/unread-example",
      lastViewedUrl: null,
    },
    { timestamp: TIMESTAMP }
  );
  assert.equal(record.status, "plan");
  assert.equal(record.chapter, null);
  assert.equal(record.updatedAt, TIMESTAMP);
});
