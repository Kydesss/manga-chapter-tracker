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
  assert.equal(result.records[0].lastReadAt, TIMESTAMP);
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
