import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChapterUrl } from "../parser.js";

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
