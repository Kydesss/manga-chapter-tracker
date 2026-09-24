import { test } from "node:test";
import assert from "node:assert/strict";

test("background import fetches every page and stores each last-viewed chapter", async () => {
  const data = {};
  let listener;
  const page = (slug, title, viewed, pagination = "") => `
    <div class="user-bookmark-item-right">
      <a class="bm-title" href="/manga/${slug}">${title}</a>
      <span>Latest: <a href="/manga/${slug}/chapter-99">Chapter 99</a></span>
      <span>Viewed: <a href="/manga/${slug}/chapter-${viewed}">Chapter ${viewed}</a></span>
    </div>
    ${pagination}
  `;
  const pages = {
    "1": page(
      "first-series",
      "First Series",
      "3",
      '<div class="group-page"><a href="/bookmark?page=1">1</a><a href="/bookmark?page=2">2</a></div>'
    ),
    "2": page("second-series", "Second Series", "7-5"),
  };

  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
    },
    tabs: {
      async get() {
        return { id: 42, url: "https://www.natomanga.com/manga/example" };
      },
    },
    scripting: {
      async executeScript({ args }) {
        const url = new URL(args[0]);
        const pageNumber = url.searchParams.get("page");
        const isSeriesPage = url.pathname.startsWith("/manga/");
        const slug = url.pathname.split("/").filter(Boolean)[1];
        return [
          {
            result: {
              ok: true,
              status: 200,
              url: url.href,
              html: isSeriesPage
                ? `<div class="manga-info-pic"><img src="/covers/${slug}.jpg"></div>
                   <div class="manga-info-text"><h1>${slug}</h1></div>
                   <div class="chapter-list"><a href="/manga/${slug}/chapter-99">Chapter 99</a> 1 day ago</div>`
                : pages[pageNumber],
            },
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

  await import(`../background.js?background-import=${Date.now()}`);
  assert.equal(typeof listener, "function");

  const response = await new Promise((resolve, reject) => {
    const keepAlive = listener(
      {
        type: "import-natomanga-bookmarks",
        tabId: 42,
        pageUrl: "https://www.natomanga.com/manga/example",
      },
      {},
      resolve
    );
    if (keepAlive !== true) reject(new Error("message channel was not kept alive"));
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.pagesCompleted, 2);
  assert.equal(response.result.bookmarksFound, 2);
  assert.equal(response.result.added, 2);
  assert.equal(response.result.seriesPagesChecked, 2);
  assert.equal(data.series["natomanga.com:first-series"].chapter, "3");
  assert.equal(data.series["natomanga.com:second-series"].chapter, "7.5");
  assert.match(data.series["natomanga.com:first-series"].coverUrl, /first-series\.jpg$/);
  assert.equal(data.series["natomanga.com:first-series"].latestChapter, "99");
  assert.equal(data.natomangaImportJob.status, "complete");
});
