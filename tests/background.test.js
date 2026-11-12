// tests/background.test.js
// The service worker's "save the chapter you're on" keyboard shortcut, run
// against a fake chrome: what it saves and what the toolbar icon says.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

let data; // chrome.storage.local
let commandListener;
let badges; // [{ tabId, text, title }]
let activeTab;

beforeEach(() => {
  data = { schemaVersion: 7, series: {} };
  badges = [];
  activeTab = null;
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return structuredClone({ [key]: data[key] });
          if (Array.isArray(key)) return structuredClone(Object.fromEntries(key.map((k) => [k, data[k]])));
          return structuredClone(data);
        },
        async set(values) {
          Object.assign(data, structuredClone(values));
        },
        async remove(key) {
          for (const k of [].concat(key)) delete data[k];
        },
      },
    },
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    commands: { onCommand: { addListener: (fn) => (commandListener = fn) } },
    tabs: { query: async () => (activeTab ? [activeTab] : []) },
    action: {
      setBadgeText: async (opts) => {
        if (opts.text === "") return; // the delayed clear
        badges.push({ tabId: opts.tabId, text: opts.text });
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async (opts) => {
        const last = badges.at(-1);
        if (last && last.tabId === opts.tabId && last.title === undefined) last.title = opts.title;
      },
    },
  };
});

let n = 0;
async function press(tab) {
  commandListener = null;
  await import(`../background.js?t=${n++}`);
  const before = badges.length;
  commandListener("save-chapter", tab);
  for (let i = 0; i < 100 && badges.length === before; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20)); // let the title land
  return badges.at(-1);
}

const URL_40 = "https://www.manganami.com/manga/blue-lock/chapter-40";

test("the shortcut saves the chapter on the active tab", async () => {
  const badge = await press({ id: 7, url: URL_40 });
  assert.equal(badge.text, "✓");
  assert.match(badge.title, /Saved Blue Lock, chapter 40/);
  const rec = data.series["natomanga.com:blue-lock"];
  assert.equal(rec.chapter, "40");
  assert.equal(rec.chapterUrl, URL_40);
  assert.equal(rec.dirty, true, "queued for sync");
});

test("the shortcut won't move a series back, and says so", async () => {
  await press({ id: 7, url: URL_40 });
  const badge = await press({ id: 7, url: "https://www.manganami.com/manga/blue-lock/chapter-12" });
  assert.equal(badge.text, "!");
  assert.match(badge.title, /earlier than your saved chapter 40/);
  assert.equal(data.series["natomanga.com:blue-lock"].chapter, "40");
});

test("on a series page it plans the series, or reports it's already saved", async () => {
  const series = "https://www.manganami.com/manga/blue-lock";
  let badge = await press({ id: 3, url: series });
  assert.match(badge.title, /Added Blue Lock to Plan to read/);
  assert.equal(data.series["natomanga.com:blue-lock"].chapter, null);
  await press({ id: 3, url: URL_40 });
  badge = await press({ id: 3, url: series });
  assert.match(badge.title, /saved at chapter 40/);
  assert.equal(data.series["natomanga.com:blue-lock"].chapter, "40", "planning never erases a chapter");
});

test("on an unsupported page it saves nothing", async () => {
  const badge = await press({ id: 9, url: "https://example.com/" });
  assert.equal(badge.text, "–");
  assert.deepEqual(data.series, {});
});

test("without a tab in the event it uses the active tab", async () => {
  activeTab = { id: 11, url: URL_40 };
  const badge = await press(undefined);
  assert.equal(badge.tabId, 11);
  assert.equal(data.series["natomanga.com:blue-lock"].chapter, "40");
});

test("a removed series comes back when its chapter is saved, as from the popup", async () => {
  await press({ id: 7, url: URL_40 });
  const { remove } = await import("../storage.js");
  await remove("natomanga.com:blue-lock");
  await press({ id: 7, url: "https://www.manganami.com/manga/blue-lock/chapter-2" });
  const rec = data.series["natomanga.com:blue-lock"];
  assert.equal(rec.deleted, false);
  assert.equal(rec.chapter, "2");
});
