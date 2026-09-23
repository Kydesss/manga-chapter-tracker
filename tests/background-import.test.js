import { test } from "node:test";
import assert from "node:assert/strict";

const TAB_URL = "https://www.natomanga.com/manga/example";
const LOGIN_PAGE = `<!doctype html><html><head><title>Login</title></head>
  <body><form class="login-form" action="/login" method="post"></form></body></html>`;

const card = (slug, title, viewed) => `
  <div class="user-bookmark-item-right">
    <a class="bm-title" href="/manga/${slug}">${title}</a>
    <span>Latest: <a href="/manga/${slug}/chapter-99">Chapter 99</a></span>
    <span>Viewed: <a href="/manga/${slug}/chapter-${viewed}">Chapter ${viewed}</a></span>
  </div>
`;

const pagination = (lastPage) =>
  `<div class="group-page">${Array.from(
    { length: lastPage },
    (_, i) => `<a href="/bookmark?page=${i + 1}">${i + 1}</a>`
  ).join("")}</div>`;

let instance = 0;

// Run one import against a mocked chrome API and a fresh copy of background.js.
// `pages` maps a bookmark page number to its HTML. `tabUrl(n)` returns the tab's
// URL on the nth chrome.tabs.get call; throwing simulates a closed tab.
async function runImport({ pages, tabUrl = () => TAB_URL }) {
  const data = {};
  const fetched = [];
  let tabCalls = 0;
  let listener;

  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
    },
    tabs: {
      async get(id) {
        return { id, url: tabUrl(tabCalls++) };
      },
    },
    scripting: {
      async executeScript({ args }) {
        const url = new URL(args[0]);
        const pageNumber = url.searchParams.get("page");
        fetched.push(Number(pageNumber));
        return [
          {
            result: { ok: true, status: 200, url: url.href, html: pages[pageNumber] },
          },
        ];
      },
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: data[key] };
          return { ...data };
        },
        async set(values) {
          Object.assign(data, structuredClone(values));
        },
        async remove(key) {
          delete data[key];
        },
      },
    },
  };

  await import(`../background.js?background-import=${++instance}`);
  assert.equal(typeof listener, "function");

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      { type: "import-natomanga-bookmarks", tabId: 42, pageUrl: TAB_URL },
      {},
      resolve
    );
    if (keepAlive !== true) reject(new Error("message channel was not kept alive"));
  });
  return { response, data, fetched };
}

test("background import fetches every page and stores each last-viewed chapter", async () => {
  const { response, data } = await runImport({
    pages: {
      1: card("first-series", "First Series", "3") + pagination(2),
      2: card("second-series", "Second Series", "7-5"),
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.pagesCompleted, 2);
  assert.equal(response.result.bookmarksFound, 2);
  assert.equal(response.result.added, 2);
  assert.equal(data.series["natomanga.com:first-series"].chapter, "3");
  assert.equal(data.series["natomanga.com:second-series"].chapter, "7.5");
  assert.equal(data.natomangaImportJob.status, "complete");
});

test("a sign-out partway through keeps the pages already saved", async () => {
  const { response, data, fetched } = await runImport({
    pages: {
      1: card("first-series", "First Series", "3") + pagination(3),
      2: LOGIN_PAGE,
      3: card("third-series", "Third Series", "1"),
    },
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /^Stopped at page 2 of 3: NatoManga signed you out\./);
  assert.match(response.error, /1 bookmark from earlier pages was saved/);
  assert.deepEqual(fetched, [1, 2]); // stops instead of carrying on to page 3
  assert.equal(data.series["natomanga.com:first-series"].chapter, "3");
  assert.equal(data.series["natomanga.com:third-series"], undefined);
  assert.equal(data.natomangaImportJob.status, "error");
  assert.equal(data.natomangaImportJob.result.added, 1);
});

test("signed out from the first page, nothing is saved", async () => {
  const { response, data } = await runImport({ pages: { 1: LOGIN_PAGE } });

  assert.equal(response.ok, false);
  assert.equal(response.error, "Sign in to NatoManga in this tab, then try again.");
  assert.equal(response.result, null);
  assert.deepEqual(Object.keys(data.series ?? {}), []);
});

test("a closed tab stops the import at once instead of retrying every page", async () => {
  const { response, data, fetched } = await runImport({
    pages: { 1: card("first-series", "First Series", "3") + pagination(5) },
    // The start-up check and page 1 see the tab; after that it's gone.
    tabUrl: (call) => {
      if (call < 2) return TAB_URL;
      throw new Error("No tab with id: 42.");
    },
  });

  assert.equal(response.ok, false);
  assert.match(
    response.error,
    /^Stopped at page 2 of 5: the NatoManga tab was closed or left NatoManga\./
  );
  assert.deepEqual(fetched, [1]);
  assert.equal(data.series["natomanga.com:first-series"].chapter, "3");
});
