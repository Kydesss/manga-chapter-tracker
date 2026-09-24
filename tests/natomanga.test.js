import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  findLastBookmarkPage,
  isNatoMangaUrl,
  normalizeNatoBookmark,
  parseNatoDate,
  parseNatoBookmarkPage,
  parseNatoSeriesPage,
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
  assert.equal(result.records[0].coverUrl, "https://www.natomanga.com/uploads/blue-lock.jpg");
  assert.equal(result.records[0].latestChapter, "350");
  assert.match(result.records[0].latestChapterUrl, /chapter-350$/);
  assert.equal(result.records[0].latestPublishedAt, "2026-09-22T10:00:00.000Z");

  assert.equal(result.records[1].title, "Witch & Mercenary");
  assert.equal(result.records[1].status, "plan");
  assert.equal(result.records[1].chapter, null);
  assert.equal(result.records[1].chapterUrl, null);
  assert.equal(result.records[1].lastReadAt, null);
  assert.equal(result.records[1].coverUrl, "https://cdn.example/witch.jpg");
  assert.equal(result.records[1].latestChapter, "12");
  assert.ok(result.records[1].latestPublishedAt);
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

test("series-page fallback parses title, cover, latest chapter, and date", async () => {
  const html = await fixture("natomanga-series.html");
  const result = parseNatoSeriesPage(
    html,
    "https://www.natomanga.com/manga/blue-lock",
    { timestamp: TIMESTAMP }
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.metadata.title, "Blue Lock");
  assert.equal(
    result.metadata.coverUrl,
    "https://www.natomanga.com/uploads/manga/blue-lock.jpg"
  );
  assert.equal(result.metadata.latestChapter, "351");
  assert.match(result.metadata.latestChapterUrl, /chapter-351$/);
  assert.ok(result.metadata.latestPublishedAt);
  assert.equal(result.metadata.metadataCheckedAt, TIMESTAMP);
});

test("NatoManga dates parse relative and short site formats", () => {
  assert.equal(parseNatoDate("Updated 2 hours ago", TIMESTAMP), "2026-09-22T10:00:00.000Z");
  assert.equal(parseNatoDate("09-20 08:30", TIMESTAMP), "2026-09-20T08:30:00.000Z");
});
