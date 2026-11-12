import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compilePattern,
  compileSite,
  withCustomSites,
  parseChapterUrl,
  parseSeriesUrl,
  parsePageUrl,
  hostOf,
  BUILTIN_SITES,
} from "../parser.js";
import {
  normalizeHost,
  validateSiteDef,
  cleanCustomSites,
  saveCustomSite,
  removeCustomSite,
  restoreCustomSite,
  getCustomSites,
  SITE_KEY_PREFIX,
  isUsableSiteId,
  MAX_CUSTOM_SITES,
} from "../settings.js";
import { getSites, siteNames } from "../sites.js";
import { siteLabel, sitesIn } from "../view.js";
import { collectBookmarks } from "../bookmarks.js";

const EXAMPLE = {
  id: "example.com",
  host: "example.com",
  name: "Example",
  chapterPattern: "/read/{slug}/ch-{chapter}",
  seriesPattern: "/series/{slug}/",
};
const sites = withCustomSites([EXAMPLE]);

// --- Pattern compiler --------------------------------------------------------

test("a chapter pattern compiles and matches with placeholders", () => {
  const site = compileSite(EXAMPLE);
  assert.deepEqual(site.matchChapter("/read/one-piece/ch-12"), { slug: "one-piece", chapter: "12" });
  assert.deepEqual(site.matchChapter("/READ/one-piece/CH-12-5/"), { slug: "one-piece", chapter: "12-5" });
  assert.equal(site.matchChapter("/read/one-piece/ch-12/extra"), null, "segment counts must match");
  assert.equal(site.matchChapter("/read/one-piece/ch-twelve"), null, "chapter must be a number");
  assert.equal(site.matchChapter("/x/read/one-piece/ch-12"), null, "anchored at the start");
  assert.equal(site.seriesPath("one-piece"), "/series/one-piece");
});

test("pattern literals are never treated as regex", () => {
  const p = compilePattern("/a.b/(x)+/{slug}/c[1]-{chapter}", "chapter");
  assert.equal(p.ok, true);
  const site = compileSite({ ...EXAMPLE, chapterPattern: "/a.b/(x)+/{slug}/c[1]-{chapter}" });
  assert.deepEqual(site.matchChapter("/a.b/(x)+/s/c[1]-3"), { slug: "s", chapter: "3" });
  assert.equal(site.matchChapter("/aXb/(x)+/s/c[1]-3"), null, "a dot is a dot");
  assert.equal(site.matchChapter("/a.b/xx/s/c1-3"), null, "( ) + [ ] are literal");
});

test("* matches within one segment, in chapter patterns only", () => {
  const site = compileSite({ ...EXAMPLE, chapterPattern: "/read/{slug}/*/chapter-{chapter}" });
  assert.deepEqual(site.matchChapter("/read/abc/8f3a2/chapter-4"), { slug: "abc", chapter: "4" });
  assert.equal(site.matchChapter("/read/abc/8f/3a/chapter-4"), null);
  assert.equal(compilePattern("/series/{slug}/*", "series").ok, false);
});

test("bad patterns are refused with a message", () => {
  const bad = {
    "": "Enter",
    "read/{slug}/{chapter}": "starts with /",
    "/read/{slug}?c={chapter}": "path only",
    "/read/{slug} /{chapter}": "path only",
    "/read/{chapter}": "{slug} exactly once",
    "/{slug}/{slug}/{chapter}": "{slug} exactly once",
    "/read/{slug}": "{chapter} exactly once",
    "/read/{slug}/{chapter}/{chapter}": "{chapter} exactly once",
    "/read/{slug}{chapter}": "text between",
    "/read/{slug}-*-{chapter}": "at most two",
    "/read/{slug}/{page}/{chapter}": "Unknown placeholder",
    "/read/{slug}/ch{-{chapter}": "{ and }",
    "/read//{slug}/{chapter}": "//",
    ["/" + "a".repeat(250) + "/{slug}/{chapter}"]: "too long",
  };
  for (const [pattern, message] of Object.entries(bad)) {
    const result = compilePattern(pattern, "chapter");
    assert.equal(result.ok, false, pattern);
    assert.match(result.error, new RegExp(message.replace(/[{}?/]/g, "\\$&")), pattern);
  }
  assert.match(compilePattern("/series/{slug}/{chapter}", "series").error, /can't contain \{chapter\}/);
});

test("very long paths never match a custom pattern", () => {
  const site = compileSite({ ...EXAMPLE, chapterPattern: "/read/{slug}-x-{chapter}" });
  const long = "/read/" + "a-x-".repeat(400) + "1";
  assert.equal(site.matchChapter(long), null);
});

// --- Parsing with custom sites ------------------------------------------------

test("custom sites parse chapter and series pages into records", () => {
  const chapter = parseChapterUrl("https://www.example.com/read/blue-lock/ch-348-5?p=2#x", sites);
  assert.equal(chapter.id, "example.com:blue-lock");
  assert.equal(chapter.site, "example.com");
  assert.equal(chapter.siteName, "Example");
  assert.equal(chapter.chapter, "348.5");
  assert.equal(chapter.chapterUrl, "https://www.example.com/read/blue-lock/ch-348-5?p=2#x");
  assert.equal(chapter.seriesUrl, "https://www.example.com/series/blue-lock");

  const series = parseSeriesUrl("https://example.com/series/blue-lock/", sites);
  assert.equal(series.id, chapter.id, "a later chapter save upgrades the planned series");
  assert.equal(series.chapter, null);
  assert.equal(series.status, "plan");

  assert.equal(parsePageUrl("https://example.com/about", sites), null);
  assert.equal(parsePageUrl("https://example.org/read/x/ch-1", sites), null);
  assert.equal(parsePageUrl("https://example.com.evil.test/read/x/ch-1", sites), null);
});

test("custom sites are only used when passed in", () => {
  assert.equal(parsePageUrl("https://example.com/read/x/ch-1"), null);
});

test("built-in sites parse exactly as before alongside custom sites", () => {
  const url = "https://natomanga.com/manga/blue-lock/vol-2-chapter-5/3";
  const withCustom = parseChapterUrl(url, sites);
  const builtin = parseChapterUrl(url);
  assert.deepEqual({ ...withCustom, lastReadAt: 0, updatedAt: 0 }, { ...builtin, lastReadAt: 0, updatedAt: 0 });
  assert.equal(builtin.seriesUrl, "https://www.manganami.com/manga/blue-lock");
});

test("a custom site can never take over a built-in site", () => {
  const list = withCustomSites([
    { ...EXAMPLE, id: "manganami.com", host: "manganami.com", name: "Mine" },
    { ...EXAMPLE, id: "x.natomanga.com", host: "x.natomanga.com" },
    { ...EXAMPLE, id: "org-parent", host: "org" },
  ]);
  assert.equal(list.length, BUILTIN_SITES.length, "all three are dropped");
  const rec = parsePageUrl("https://www.manganami.com/manga/a/chapter-1", list);
  assert.equal(rec.siteName, "NatoManga");
});

test("definitions that don't compile are skipped", () => {
  const list = withCustomSites([null, "x", { ...EXAMPLE, chapterPattern: "/nope" }, EXAMPLE, 42]);
  assert.equal(list.length, BUILTIN_SITES.length + 1);
  assert.equal(compileSite({ ...EXAMPLE, id: "" }), null);
});

test("hostOf gives the host as Settings stores it", () => {
  assert.equal(hostOf("https://WWW.Example.com/read/x"), "example.com");
  assert.equal(hostOf("chrome://extensions"), null);
  assert.equal(hostOf("not a url"), null);
});

// --- Validation ---------------------------------------------------------------

test("hosts are normalised from what people paste", () => {
  assert.equal(normalizeHost("example.com"), "example.com");
  assert.equal(normalizeHost(" https://WWW.Example.com/manga/x?y=1 "), "example.com");
  assert.equal(normalizeHost("read.example.co.uk"), "read.example.co.uk");
  assert.equal(normalizeHost("localhost"), null);
  assert.equal(normalizeHost("ftp://example.com"), null);
  assert.equal(normalizeHost(""), null);
  assert.equal(normalizeHost(42), null);
});

test("a valid site validates into the stored shape, id = host", () => {
  const result = validateSiteDef({
    host: "https://www.Example.com/",
    name: "  ",
    chapterPattern: " /read/{slug}/ch-{chapter} ",
    seriesPattern: "/series/{slug}",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.site, {
    id: "example.com",
    host: "example.com",
    name: "example.com",
    chapterPattern: "/read/{slug}/ch-{chapter}",
    seriesPattern: "/series/{slug}",
  });
});

test("validation names the field at fault", () => {
  const base = { host: "example.com", chapterPattern: "/r/{slug}/{chapter}", seriesPattern: "/s/{slug}" };
  assert.equal(validateSiteDef({ ...base, host: "nope" }).field, "host");
  assert.equal(validateSiteDef({ ...base, name: "x".repeat(41) }).field, "name");
  assert.equal(validateSiteDef({ ...base, chapterPattern: "/r/{slug}" }).field, "chapterPattern");
  assert.equal(validateSiteDef({ ...base, seriesPattern: "/s" }).field, "seriesPattern");
});

test("built-in hosts, duplicates and the cap are refused", () => {
  const base = { chapterPattern: "/r/{slug}/{chapter}", seriesPattern: "/s/{slug}" };
  assert.match(validateSiteDef({ ...base, host: "www.manganami.com" }).error, /NatoManga is already built in/);
  assert.match(validateSiteDef({ ...base, host: "natomanga.com" }).error, /NatoManga/);
  assert.match(validateSiteDef({ ...base, host: "mangaread.org" }).error, /MangaRead/);

  const existing = [{ ...EXAMPLE }];
  assert.match(validateSiteDef({ ...base, host: "example.com" }, existing).error, /already added/);
  assert.match(validateSiteDef({ ...base, host: "read.example.com" }, existing).error, /already added/);

  const many = Array.from({ length: MAX_CUSTOM_SITES }, (_, i) => ({ ...EXAMPLE, id: `s${i}.test`, host: `s${i}.test` }));
  assert.match(validateSiteDef({ ...base, host: "new.test" }, many).error, /up to 25/);
});

test("editing keeps the site's id, even when its address changes", () => {
  const existing = [{ ...EXAMPLE }];
  const result = validateSiteDef(
    { host: "example.net", name: "Moved", chapterPattern: EXAMPLE.chapterPattern, seriesPattern: EXAMPLE.seriesPattern },
    existing,
    { editingId: "example.com" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.site.id, "example.com");
  assert.equal(result.site.host, "example.net");
});

test("a new site can't reuse the id of a site whose address moved", () => {
  const moved = [{ ...EXAMPLE, host: "example.net" }]; // id still example.com
  const result = validateSiteDef(
    { host: "example.com", chapterPattern: EXAMPLE.chapterPattern, seriesPattern: EXAMPLE.seriesPattern },
    moved
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /first address of a site/);
});

test("stored settings are cleaned: bad, duplicate and clashing entries dropped", () => {
  const cleaned = cleanCustomSites([
    EXAMPLE,
    { ...EXAMPLE }, // duplicate id
    { ...EXAMPLE, id: "other", host: "www.example.com" }, // same host
    { ...EXAMPLE, id: "bad", host: "bad.test", chapterPattern: "/x" },
    { ...EXAMPLE, id: "nato", host: "manganami.com" },
    null,
    "junk",
    { ...EXAMPLE, id: "ok.test", host: "ok.test", name: 7 },
  ]);
  assert.deepEqual(
    cleaned.map((s) => [s.id, s.name]),
    [
      ["example.com", "Example"],
      ["ok.test", "ok.test"],
    ]
  );
  assert.deepEqual(cleanCustomSites("nope"), []);
});

// --- Labels ---------------------------------------------------------------------

test("site labels prefer the current site name over what a record carries", () => {
  const names = siteNames(sites);
  const pulled = { site: "example.com", siteName: "example.com" }; // fromRow's fallback
  assert.equal(siteLabel(pulled, names), "Example");
  assert.equal(siteLabel(pulled), "example.com");
  assert.equal(siteLabel({ site: "gone.test", siteName: "Gone" }, names), "Gone");
  assert.equal(siteLabel({ site: "gone.test" }, names), "gone.test");
  assert.deepEqual(sitesIn([pulled, { site: "mangaread.org" }], names), [
    { id: "example.com", name: "Example" },
    { id: "mangaread.org", name: "MangaRead" },
  ]);
});

// --- Bookmark import ------------------------------------------------------------

test("bookmark import recognizes custom sites when given them", () => {
  const tree = [
    {
      children: [
        { url: "https://example.com/read/blue-lock/ch-30", dateAdded: Date.UTC(2026, 0, 1) },
        { url: "https://example.com/series/kaiju-8", dateAdded: Date.UTC(2026, 0, 2) },
        { url: "https://example.com/about", dateAdded: Date.UTC(2026, 0, 3) },
      ],
    },
  ];
  const withSites = collectBookmarks(tree, { sites });
  assert.deepEqual(
    withSites.records.map((r) => [r.id, r.chapter]),
    [
      ["example.com:kaiju-8", null],
      ["example.com:blue-lock", "30"],
    ]
  );
  assert.equal(withSites.unsupported, 1);
  assert.equal(collectBookmarks(tree).records.length, 0, "built-ins only by default");
});

// --- The store (chrome.storage.sync) --------------------------------------------

function fakeChrome({ withSync = true } = {}) {
  const areas = { sync: {}, local: {} };
  const listeners = [];
  const area = (name) => ({
    async get(key) {
      if (key === null) return structuredClone(areas[name]);
      return key in areas[name] ? { [key]: structuredClone(areas[name][key]) } : {};
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: areas[name][k], newValue: structuredClone(v) };
        areas[name][k] = structuredClone(v);
      }
      for (const l of listeners) l(changes, name);
    },
    async remove(key) {
      const changes = { [key]: { oldValue: areas[name][key] } };
      delete areas[name][key];
      for (const l of listeners) l(changes, name);
    },
  });
  areas.quota = Infinity; // bytes per item, as Chrome's QUOTA_BYTES_PER_ITEM
  const realSet = area("sync").set;
  const syncArea = area("sync");
  syncArea.set = async (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (k.length + JSON.stringify(v).length > areas.quota) throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
    }
    return realSet(obj);
  };
  globalThis.chrome = {
    storage: {
      sync: withSync ? syncArea : undefined,
      local: area("local"),
      onChanged: { addListener: (l) => listeners.push(l) },
    },
  };
  return areas;
}

const FORM = { host: "example.com", name: "Example", chapterPattern: "/read/{slug}/ch-{chapter}", seriesPattern: "/series/{slug}" };

test("sites are saved to chrome.storage.sync and parse through getSites", async () => {
  const areas = fakeChrome();
  const added = await saveCustomSite(FORM);
  assert.equal(added.ok, true);
  assert.deepEqual(siteKeys(areas.sync), ["site:example.com"]);
  assert.deepEqual(siteKeys(areas.local), []);

  const all = await getSites();
  assert.equal(parsePageUrl("https://example.com/read/x/ch-2", all).siteName, "Example");

  const refused = await saveCustomSite(FORM);
  assert.equal(refused.ok, false);
  assert.equal((await getCustomSites()).length, 1);
});

test("editing, removing and Undo keep the site's id", async () => {
  fakeChrome();
  await saveCustomSite(FORM);
  const edited = await saveCustomSite({ ...FORM, host: "example.net", name: "Moved" }, { editingId: "example.com" });
  assert.equal(edited.ok, true);
  let [site] = await getCustomSites();
  assert.deepEqual([site.id, site.host, site.name], ["example.com", "example.net", "Moved"]);

  await removeCustomSite("example.com");
  assert.deepEqual(await getCustomSites(), []);
  const back = await restoreCustomSite(site);
  assert.equal(back.ok, true);
  [site] = await getCustomSites();
  assert.deepEqual([site.id, site.host], ["example.com", "example.net"], "Undo restores the original id");
  assert.equal((await restoreCustomSite(site)).ok, false, "can't restore twice");
});

test("editing a site that was removed elsewhere is refused", async () => {
  fakeChrome();
  await saveCustomSite(FORM);
  await removeCustomSite("example.com");
  const result = await saveCustomSite(FORM, { editingId: "example.com" });
  assert.equal(result.ok, false);
  assert.match(result.error, /removed/);
  assert.deepEqual(await getCustomSites(), [], "an edit never re-adds a removed site");
});

test("Undo is refused when the address was added again meanwhile", async () => {
  fakeChrome();
  await saveCustomSite(FORM);
  const [site] = await getCustomSites();
  await removeCustomSite(site.id);
  await saveCustomSite({ ...FORM, name: "Again" });
  const result = await restoreCustomSite(site);
  assert.equal(result.ok, false);
  assert.equal((await getCustomSites()).length, 1);
});

test("settings fall back to local storage where sync isn't available", async () => {
  const areas = fakeChrome({ withSync: false });
  await saveCustomSite(FORM);
  assert.deepEqual(siteKeys(areas.local), ["site:example.com"]);
});

test("getSites falls back to the built-ins if settings can't be read", async () => {
  globalThis.chrome = {
    storage: {
      sync: { get: async () => { throw new Error("quota"); } },
      local: {},
      onChanged: { addListener() {} },
    },
  };
  assert.deepEqual(await getSites(), BUILTIN_SITES);
});

test("tampered synced settings can't break parsing", async () => {
  const areas = fakeChrome();
  for (const def of [
    { id: "x.test", host: "x.test", chapterPattern: "(.*)*", seriesPattern: 7 },
    { id: "nato.test", host: "manganami.com", chapterPattern: "/manga/{slug}/{chapter}", seriesPattern: "/manga/{slug}" },
    { ...EXAMPLE },
  ]) areas.sync[SITE_KEY_PREFIX + def.id] = def;
  areas.sync["site:wrong-key"] = { ...EXAMPLE, id: "other.test", host: "other.test" };
  const all = await getSites();
  assert.equal(all.length, BUILTIN_SITES.length + 1);
  assert.equal(parsePageUrl("https://www.manganami.com/manga/a/chapter-2", all).siteName, "NatoManga");
});

const siteKeys = (area) => Object.keys(area).filter((k) => k.startsWith(SITE_KEY_PREFIX)).sort();

// --- Codex review, round 1 --------------------------------------------------------

test("a custom site can't use a built-in site's id, whatever its host", async () => {
  // Records are keyed "<site id>:<slug>": this one would save over MangaRead's.
  const areas = fakeChrome();
  for (const def of [
    { ...EXAMPLE, id: "mangaread.org", host: "example.com" },
    { ...EXAMPLE, id: "natomanga.com", host: "example.net" },
    { ...EXAMPLE, id: "www.manganami.com", host: "example.org" },
    { ...EXAMPLE, id: "Example.IO", host: "example.io" },
  ]) areas.sync[SITE_KEY_PREFIX + def.id] = def;
  assert.deepEqual(await getCustomSites(), []);
  const all = await getSites();
  assert.equal(parsePageUrl("https://example.com/read/blue-lock/ch-1", all), null);
  assert.equal(siteNames(all)["mangaread.org"], "MangaRead");

  // The parser's own backstop, for a definition that skips the store.
  assert.equal(withCustomSites([{ ...EXAMPLE, id: "mangaread.org" }]).length, BUILTIN_SITES.length);
  assert.equal(isUsableSiteId("mangaread.org"), false);
  assert.equal(isUsableSiteId("read.mangaread.org"), false);
  assert.equal(isUsableSiteId("example.com"), true);
  assert.equal(isUsableSiteId("Example.com"), false);
});

test("patterns only accept characters a web address can hold", () => {
  for (const bad of ["/series/{slug}\u0000", "/series/{slug}/\u00e9", "/series\\{slug}", "/series/{slug}\u007f"]) {
    const result = compilePattern(bad, "series");
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  assert.equal(compileSite({ ...EXAMPLE, seriesPattern: "/series/{slug}\u0000" }), null);
  assert.equal(compilePattern("/a-b_c.d~e!$&'()+,;=:@%25/{slug}", "series").ok, true);
});

test("Undo restores the site as it was removed, not an older copy", async () => {
  fakeChrome();
  await saveCustomSite(FORM);
  const [stale] = await getCustomSites(); // what a row rendered earlier holds
  // Another tab edits it.
  await saveCustomSite({ ...FORM, host: "new.example", name: "New" }, { editingId: "example.com" });
  const removed = await removeCustomSite(stale.id);
  assert.equal(removed.host, "new.example", "remove returns the current definition");
  await restoreCustomSite(removed);
  const [back] = await getCustomSites();
  assert.deepEqual([back.id, back.host, back.name], ["example.com", "new.example", "New"]);
  assert.equal(await removeCustomSite("gone.test"), null);
});

test("25 long sites fit: each site is its own synced item", async () => {
  const areas = fakeChrome();
  areas.quota = 8192;
  const long = (n) => "/" + "x".repeat(n);
  for (let i = 0; i < MAX_CUSTOM_SITES; i++) {
    const result = await saveCustomSite({
      host: `site${i}.example-long-domain-name.test`,
      name: "N".repeat(40),
      chapterPattern: long(150) + "/{slug}/chapter-{chapter}",
      seriesPattern: long(150) + "/{slug}",
    });
    assert.equal(result.ok, true, `site ${i}: ${result.error}`);
  }
  assert.equal((await getCustomSites()).length, MAX_CUSTOM_SITES);
  assert.equal(siteKeys(areas.sync).length, MAX_CUSTOM_SITES);
});

test("a write Chrome refuses is reported, not thrown", async () => {
  const areas = fakeChrome();
  areas.quota = 10;
  const result = await saveCustomSite(FORM);
  assert.equal(result.ok, false);
  assert.match(result.error, /Chrome couldn't save the site: QUOTA/);
  assert.deepEqual(await getCustomSites(), []);
});

test("sites keep the order they were added in, through edits and Undo", async () => {
  fakeChrome();
  await saveCustomSite({ ...FORM, host: "b.test" });
  await new Promise((r) => setTimeout(r, 5));
  await saveCustomSite({ ...FORM, host: "a.test" });
  await saveCustomSite({ ...FORM, host: "b.test", name: "B edited" }, { editingId: "b.test" });
  assert.deepEqual((await getCustomSites()).map((s) => s.id), ["b.test", "a.test"]);
  const removed = await removeCustomSite("b.test");
  await restoreCustomSite(removed);
  assert.deepEqual((await getCustomSites()).map((s) => s.id), ["b.test", "a.test"]);
});

// --- Codex review, round 2 --------------------------------------------------------

test("one stored site with a malformed id doesn't hide the others", async () => {
  const areas = fakeChrome();
  await saveCustomSite(FORM);
  areas.sync["site:broken.test"] = { id: { toString: null }, host: "broken.test" };
  areas.sync["site:7"] = { id: 7, host: "seven.test" };
  assert.deepEqual((await getCustomSites()).map((s) => s.id), ["example.com"]);
  const all = await getSites();
  assert.equal(parsePageUrl("https://example.com/read/x/ch-2", all).siteName, "Example");
  assert.equal((await saveCustomSite({ ...FORM, host: "other.test" })).ok, true);
});

// --- Codex review, round 3 --------------------------------------------------------

test("a placeholder repeated within one segment is refused, not thrown", () => {
  for (const [pattern, kind] of [
    ["/read/{slug}-{slug}/{chapter}", "chapter"],
    ["/read/{slug}/{chapter}-{chapter}", "chapter"],
    ["/series/{slug}-{slug}", "series"],
  ]) {
    let result;
    assert.doesNotThrow(() => (result = compilePattern(pattern, kind)), pattern);
    assert.equal(result.ok, false, pattern);
    assert.match(result.error, /exactly once/, pattern);
  }
  assert.doesNotThrow(() => validateSiteDef({ host: "a.test", chapterPattern: "/r/{slug}-{slug}/{chapter}", seriesPattern: "/s/{slug}" }));
});

test("a stored site with a repeated placeholder doesn't hide the others", async () => {
  const areas = fakeChrome();
  await saveCustomSite(FORM);
  areas.sync["site:dup.test"] = {
    id: "dup.test", host: "dup.test", addedAt: 0,
    chapterPattern: "/read/{slug}-{slug}/{chapter}", seriesPattern: "/series/{slug}",
  };
  assert.deepEqual((await getCustomSites()).map((s) => s.id), ["example.com"]);
  const all = await getSites();
  assert.equal(parsePageUrl("https://example.com/read/x/ch-2", all).siteName, "Example");
});
