import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChapterUrl, chapterLinkFor, chapterNumberLabel, withCustomSites } from "../parser.js";
import { resolveChapterInput } from "../view.js";

const record = parseChapterUrl("https://www.manganami.com/manga/blue-lock/chapter-40");

test("chapter numbers build round-tripping built-in links, including decimals", () => {
  for (const [input, chapter] of [[" 45 ", "45"], ["45.5", "45.5"], ["45-5", "45.5"], ["0", "0"]]) {
    assert.equal(chapterNumberLabel(input), chapter);
    const url = chapterLinkFor(record, chapter);
    assert.equal(parseChapterUrl(url).chapter, chapter);
    assert.equal(parseChapterUrl(url).id, record.id);
  }
  for (const bad of ["-1", "1e3", "Infinity", "1.2.3", "chapter 4", "", null]) {
    assert.equal(chapterNumberLabel(bad), null);
    assert.equal(resolveChapterInput(bad, record).ok, false);
  }
});

test("set chapter detects direction and only accepts links to the same series", () => {
  for (const [input, direction, movesBack] of [["41", "forward", false], ["3", "back", true], ["40", "same", false]]) {
    const result = resolveChapterInput(input, record);
    assert.equal(result.ok, true);
    assert.equal(result.direction, direction);
    assert.equal(result.movesBack, movesBack);
  }
  assert.equal(resolveChapterInput("1", { ...record, chapter: null }).direction, "start");
  assert.equal(resolveChapterInput("1", { ...record, chapter: "special" }).movesBack, true);
  assert.equal(resolveChapterInput(record.chapterUrl, record).ok, true);
  for (const url of [record.seriesUrl, record.chapterUrl.replace("blue-lock", "other-series"), "https://evil.example/chapter-5"]) {
    assert.equal(resolveChapterInput(url, record).ok, false);
  }
});

test("custom sites build whole chapter links and request pasted links for decimals or wildcards", () => {
  const def = { id: "example.com", host: "example.com", name: "Example", chapterPattern: "/read/{slug}/ch-{chapter}", seriesPattern: "/series/{slug}" };
  const sites = withCustomSites([def]);
  const custom = parseChapterUrl("https://example.com/read/a/ch-1", sites);
  assert.equal(resolveChapterInput("2", custom, sites).chapterUrl, "https://example.com/read/a/ch-2");
  assert.equal(resolveChapterInput("2.5", custom, sites).needLink, true);
  assert.equal(resolveChapterInput("https://example.com/read/a/ch-2.5", custom, sites).ok, true);
  const wildcard = withCustomSites([{ ...def, chapterPattern: "/read/{slug}/*/ch-{chapter}" }]);
  const saved = parseChapterUrl("https://example.com/read/a/volume-1/ch-1", wildcard);
  assert.equal(resolveChapterInput("2", saved, wildcard).needLink, true);
  assert.equal(resolveChapterInput("https://example.com/read/a/volume-1/ch-2", saved, wildcard).ok, true);
});

test("a chapter link is only built when it parses back to the same series", () => {
  // A crafted backup record whose slug isn't one path segment: the built link
  // would point at another page, so none is offered.
  const crafted = { ...record, slug: "blue-lock/extra" };
  assert.equal(chapterLinkFor(crafted, "41"), null);
  assert.equal(resolveChapterInput("41", crafted).needLink, true);
  // A record still carrying NatoManga's old domain gets the current one.
  const old = { ...record, seriesUrl: "https://natomanga.com/manga/blue-lock" };
  assert.equal(chapterLinkFor(old, "41"), "https://www.manganami.com/manga/blue-lock/chapter-41");
});
