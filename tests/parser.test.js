import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChapterUrl, parseSeriesUrl, parsePageUrl } from "../parser.js";

test("chapter parser creates the extended reading record", () => {
  const record = parseChapterUrl(
    "https://www.natomanga.com/manga/blue-lock/chapter-348-5?source=test#reader"
  );

  assert.equal(record.id, "natomanga.com:blue-lock");
  assert.equal(record.chapter, "348.5");
  assert.equal(record.status, "reading");
  assert.equal(record.lastReadAt, record.updatedAt);
  assert.equal(record.coverUrl, null);
  assert.equal(record.latestChapter, null);
  assert.equal(record.latestChapterUrl, null);
  assert.equal(record.latestPublishedAt, null);
  assert.equal(record.metadataCheckedAt, null);
});

test("chapter parser continues to reject series pages and lookalike hosts", () => {
  assert.equal(parseChapterUrl("https://www.natomanga.com/manga/blue-lock"), null);
  assert.equal(
    parseChapterUrl("https://natomanga.com.evil.example/manga/blue-lock/chapter-1"),
    null
  );
});

test("series parser turns a series page into a Plan-to-read record", () => {
  const record = parseSeriesUrl("https://www.mangaread.org/manga/solo-leveling/");

  assert.equal(record.id, "mangaread.org:solo-leveling");
  assert.equal(record.title, "Solo Leveling");
  assert.equal(record.chapter, null);
  assert.equal(record.chapterUrl, null);
  assert.equal(record.status, "plan");
  assert.equal(record.lastReadAt, null);
  assert.equal(record.seriesUrl, "https://www.mangaread.org/manga/solo-leveling");
});

test("a series page and its chapters share one id and series URL", () => {
  const series = parseSeriesUrl("https://www.natomanga.com/manga/blue-lock?tab=chapters");
  const chapter = parseChapterUrl("https://www.natomanga.com/manga/blue-lock/chapter-12");

  assert.equal(series.id, chapter.id);
  assert.equal(series.seriesUrl, chapter.seriesUrl);
});

test("series parser rejects chapter pages, deeper paths, other sites, and junk", () => {
  assert.equal(parseSeriesUrl("https://www.natomanga.com/manga/blue-lock/chapter-1"), null);
  assert.equal(parseSeriesUrl("https://www.natomanga.com/genre/manga/blue-lock"), null);
  assert.equal(parseSeriesUrl("https://www.natomanga.com/manga/"), null);
  assert.equal(parseSeriesUrl("https://natomanga.com.evil.example/manga/blue-lock"), null);
  assert.equal(parseSeriesUrl("chrome://extensions"), null);
});

test("page parser prefers a chapter and falls back to a series page", () => {
  assert.equal(
    parsePageUrl("https://www.natomanga.com/manga/blue-lock/chapter-3").status,
    "reading"
  );
  assert.equal(parsePageUrl("https://www.natomanga.com/manga/blue-lock").status, "plan");
  assert.equal(parsePageUrl("https://www.natomanga.com/"), null);
});
