import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChapterUrl, parseSeriesUrl, parsePageUrl, upgradeSiteUrl } from "../parser.js";
import { mergeRemoteIntoLocal } from "../merge.js";
import { fromRow } from "../sync.js";

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

// --- NatoManga moved to manganami.com (same paths) -------------------------

test("a manganami.com chapter saves under the same NatoManga id", () => {
  const record = parseChapterUrl("https://www.manganami.com/manga/blue-lock/chapter-348-5");

  assert.equal(record.id, "natomanga.com:blue-lock");
  assert.equal(record.site, "natomanga.com");
  assert.equal(record.chapter, "348.5");
  assert.equal(record.chapterUrl, "https://www.manganami.com/manga/blue-lock/chapter-348-5");
  assert.equal(record.seriesUrl, "https://www.manganami.com/manga/blue-lock");
  assert.equal(parseChapterUrl("https://manganami.com/manga/blue-lock/chapter-1").id, record.id);
});

test("an old natomanga.com link still parses, saved with manganami.com links", () => {
  const chapter = parseChapterUrl("https://natomanga.com/manga/blue-lock/chapter-3?src=x#top");
  assert.equal(chapter.id, "natomanga.com:blue-lock");
  assert.equal(chapter.chapterUrl, "https://www.manganami.com/manga/blue-lock/chapter-3?src=x#top");
  assert.equal(chapter.seriesUrl, "https://www.manganami.com/manga/blue-lock");

  const series = parseSeriesUrl("https://www.natomanga.com/manga/blue-lock/");
  assert.equal(series.seriesUrl, "https://www.manganami.com/manga/blue-lock");
});

test("manganami lookalike hosts are rejected", () => {
  assert.equal(parseChapterUrl("https://manganami.com.evil.example/manga/a/chapter-1"), null);
  assert.equal(parseChapterUrl("https://notmanganami.com/manga/a/chapter-1"), null);
  assert.equal(parseSeriesUrl("https://evilnatomanga.com/manga/a"), null);
});

test("upgradeSiteUrl moves only old-domain links and passes everything else through", () => {
  assert.equal(
    upgradeSiteUrl("http://natomanga.com/manga/a/chapter-2"),
    "https://www.manganami.com/manga/a/chapter-2"
  );
  for (const unchanged of [
    "https://www.manganami.com/manga/a/chapter-2",
    "https://www.mangaread.org/manga/a/chapter-2/",
    "https://evilnatomanga.com/manga/a",
    "ftp://natomanga.com/manga/a/chapter-999",
    "javascript://natomanga.com/%0Aalert(1)",
    "not a url",
    "",
    null,
    undefined,
  ]) {
    assert.equal(upgradeSiteUrl(unchanged), unchanged);
  }
});

test("a cloud row with old NatoManga links merges cleanly with a migrated local record", () => {
  const row = {
    id: "natomanga.com:a",
    site: "natomanga.com",
    slug: "a",
    title: "A",
    chapter: "2",
    chapter_url: "https://www.natomanga.com/manga/a/chapter-2",
    series_url: "https://www.natomanga.com/manga/a",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted: false,
  };
  const remote = fromRow(row);
  assert.equal(remote.chapterUrl, "https://www.manganami.com/manga/a/chapter-2");
  assert.equal(remote.seriesUrl, "https://www.manganami.com/manga/a");

  // The local copy after the v5 migration: same record, new links, clean.
  const local = { ...remote, dirty: false };
  const { changedIds } = mergeRemoteIntoLocal({ [local.id]: local }, [remote]);
  assert.deepEqual(changedIds, []); // no spurious change, nothing to push
});
