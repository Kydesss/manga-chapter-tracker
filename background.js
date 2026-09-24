// background.js
// Service worker. It runs long-lived work that must outlive the popup: Google
// sign-in and authenticated NatoManga bookmark imports.
//
// Why this exists: chrome.identity.launchWebAuthFlow opens a separate auth
// window, which takes focus and causes Chrome to close the extension popup. If
// the flow is run from the popup, the popup's JavaScript is destroyed mid-flow
// and the session is never stored. Running it here, in the service worker, keeps
// the flow alive regardless of the popup, and the session is stored before we
// respond. The popup just sends a message and reads the result.

import { signInWithGoogle, signOut } from "./auth.js";
import {
  parseNatoBookmarkPage,
  parseNatoSeriesPage,
  isNatoMangaUrl,
} from "./natomanga.js";
import { bulkUpsert, getAll, migrate } from "./storage.js";

const IMPORT_JOB_KEY = "natomangaImportJob";
const MAX_IMPORT_PAGES = 1000;
const MAX_RETRIES = 3;
const MAX_SERIES_ENRICH_PER_RUN = 20;
const COUNT_FIELDS = ["added", "advanced", "enriched", "unchanged", "skipped", "processed"];
let importRunning = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "signin") {
    signInWithGoogle()
      .then((session) => sendResponse({ ok: true, session }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true; // keep the channel open for the async response
  }
  if (msg?.type === "signout") {
    signOut()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg?.type === "get-natomanga-import-state") {
    chrome.storage.local
      .get(IMPORT_JOB_KEY)
      .then(async (result) => {
        let job = result[IMPORT_JOB_KEY] || null;
        // A service-worker restart clears the in-memory lock. A persisted
        // "running" job at that point was interrupted and must be retryable.
        if (job?.status === "running" && !importRunning) {
          job = {
            ...job,
            status: "error",
            error:
              "The previous import was interrupted. Pages it finished were saved; press Save bookmarks to finish.",
            finishedAt: nowISO(),
            updatedAt: nowISO(),
          };
          await chrome.storage.local.set({ [IMPORT_JOB_KEY]: job });
        }
        sendResponse({ ok: true, job });
      })
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
    return true;
  }
  if (
    msg?.type === "import-natomanga-bookmarks" ||
    msg?.type === "refresh-natomanga-updates"
  ) {
    if (importRunning) {
      chrome.storage.local.get(IMPORT_JOB_KEY).then((result) =>
        sendResponse({ ok: true, inProgress: true, job: result[IMPORT_JOB_KEY] || null })
      );
      return true;
    }
    importRunning = true;
    importNatoMangaBookmarks(msg)
      .then((result) => sendResponse({ ok: true, result }))
      .catch(async (err) => {
        const error = errorMessage(err);
        // An import that stopped partway has already saved its earlier pages.
        const result = err?.result ?? null;
        await updateImportJob({ status: "error", error, result, finishedAt: nowISO() });
        sendResponse({ ok: false, error, result });
      })
      .finally(() => {
        importRunning = false;
      });
    return true;
  }
  return false;
});

async function importNatoMangaBookmarks({ tabId, pageUrl, type }) {
  if (!Number.isInteger(tabId) || !isNatoMangaUrl(pageUrl)) {
    throw new Error("Open NatoManga in the active tab before importing bookmarks.");
  }
  await ensureTabOnNatoManga(tabId);

  await migrate();
  const startedAt = nowISO();
  const bookmarkUrl = new URL("/bookmark?page=1", pageUrl).href;
  const operation = type === "refresh-natomanga-updates" ? "refresh" : "import";
  await chrome.storage.local.set({
    [IMPORT_JOB_KEY]: {
      status: "running",
      operation,
      phase: "bookmarks",
      startedAt,
      updatedAt: startedAt,
      pagesCompleted: 0,
      pagesTotal: 1,
      bookmarksFound: 0,
      failedPages: [],
      error: null,
      result: null,
    },
  });

  const counts = Object.fromEntries(COUNT_FIELDS.map((field) => [field, 0]));
  let total = null;
  const diagnostics = [];
  const failedPages = [];
  let bookmarksFound = 0;
  let pagesCompleted = 0;
  let pagesTotal = 1;
  let stop = null;

  for (let page = 1; page <= pagesTotal; page++) {
    if (page > MAX_IMPORT_PAGES) {
      throw new Error(`NatoManga reported more than ${MAX_IMPORT_PAGES} bookmark pages.`);
    }

    const targetUrl = new URL(`/bookmark?page=${page}`, bookmarkUrl).href;
    try {
      await ensureTabOnNatoManga(tabId);
      const response = await fetchPageInTab(tabId, targetUrl);
      const timestamp = nowISO();
      const parsed = parseNatoBookmarkPage(response.html, response.url || targetUrl, {
        timestamp,
      });
      if (parsed.loginRequired) {
        throw stopError(
          "Sign in to NatoManga in this tab, then try again.",
          "NatoManga signed you out",
          "Sign in and press Save bookmarks to finish."
        );
      }
      // Save each page as it arrives, so an interrupted import keeps what it
      // already fetched. Re-running is safe: bulkUpsert never moves progress back.
      const saved = await bulkUpsert(parsed.records, { timestamp });
      for (const field of COUNT_FIELDS) counts[field] += saved[field];
      total = saved.total;
      bookmarksFound += parsed.records.length;
      diagnostics.push(...parsed.diagnostics.map((value) => `page-${page}:${value}`));
      pagesTotal = Math.min(
        MAX_IMPORT_PAGES,
        Math.max(pagesTotal, parsed.pageCount || 1)
      );
      pagesCompleted++;
    } catch (err) {
      if (err?.stop) {
        stop = { page, err };
        break;
      }
      failedPages.push({ page, error: errorMessage(err) });
    }

    await updateImportJob({
      pagesCompleted,
      pagesTotal,
      bookmarksFound,
      failedPages,
    });
  }

  const result = {
    ...counts,
    total,
    pagesCompleted,
    pagesTotal,
    bookmarksFound,
    seriesPagesChecked: 0,
    failedPages,
    diagnostics,
  };

  if (stop) {
    if (!pagesCompleted) throw stop.err; // nothing was saved
    const saved = `${bookmarksFound} bookmark${bookmarksFound === 1 ? "" : "s"}`;
    const partial = new Error(
      `Stopped at page ${stop.page} of ${pagesTotal}: ${stop.err.reason}. ` +
        `${saved} from earlier pages ${bookmarksFound === 1 ? "was" : "were"} saved. ` +
        stop.err.resume
    );
    partial.result = result;
    throw partial;
  }
  if (!pagesCompleted && failedPages.length) {
    throw new Error("No bookmarks could be imported because every bookmark page failed.");
  }

  // Metadata phase: fill in covers and latest chapters that the bookmark cards
  // didn't have, from a capped number of series pages per run.
  const metadata = await enrichFromSeriesPages(tabId, bookmarkUrl, diagnostics);
  for (const field of ["advanced", "enriched", "unchanged", "skipped"]) {
    result[field] += metadata.counts[field] ?? 0;
  }
  if (metadata.counts.total != null) result.total = metadata.counts.total;
  result.seriesPagesChecked = metadata.checked;

  await updateImportJob({
    status: "complete",
    phase: "complete",
    finishedAt: nowISO(),
    result,
    error: null,
  });
  return result;
}

// Fetch series pages for NatoManga series still missing a cover or latest
// chapter, at most MAX_SERIES_ENRICH_PER_RUN per run. This is best-effort: a
// failed page is a diagnostic, and a closed tab just ends the phase, because
// the bookmarks themselves are already saved.
async function enrichFromSeriesPages(tabId, bookmarkUrl, diagnostics) {
  const needsSeriesPage = (await getAll())
    .filter(
      (record) =>
        record.site === "natomanga.com" &&
        (!record.coverUrl || !record.latestChapter || !record.latestChapterUrl)
    )
    .slice(0, MAX_SERIES_ENRICH_PER_RUN);
  if (!needsSeriesPage.length) return { counts: {}, checked: 0 };

  await updateImportJob({
    phase: "metadata",
    seriesPagesCompleted: 0,
    seriesPagesTotal: needsSeriesPage.length,
  });

  const timestamp = nowISO();
  const enrichments = [];
  let checked = 0;
  for (const record of needsSeriesPage) {
    try {
      // Fetch from the tab's own origin: a series saved from natomanga.com would
      // otherwise be a cross-origin request from www.natomanga.com, and fail.
      const seriesUrl = new URL(new URL(record.seriesUrl).pathname, bookmarkUrl).href;
      const response = await fetchPageInTab(tabId, seriesUrl);
      const parsed = parseNatoSeriesPage(response.html, response.url || seriesUrl, {
        timestamp,
      });
      diagnostics.push(...parsed.diagnostics.map((value) => `series-${record.slug}:${value}`));
      const found = parsed.metadata;
      if (found && (found.coverUrl || found.latestChapter || found.title)) {
        // A page without a heading must not blank the title: bulkUpsert would
        // then reject the whole record, cover included.
        enrichments.push({ ...record, ...found, title: found.title || record.title });
      }
    } catch (err) {
      diagnostics.push(`series-${record.slug}:${errorMessage(err)}`);
      if (err?.stop) break;
    }
    checked++;
    await updateImportJob({
      seriesPagesCompleted: checked,
      seriesPagesTotal: needsSeriesPage.length,
    });
  }

  const counts = enrichments.length ? await bulkUpsert(enrichments, { timestamp }) : {};
  return { counts, checked };
}

// Stop (instead of retrying) once the import's tab is closed or leaves
// NatoManga: every remaining request would fail or run on the wrong site.
async function ensureTabOnNatoManga(tabId) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    // The tab was closed.
  }
  if (!isNatoMangaUrl(tab?.url)) {
    throw stopError(
      "The NatoManga tab was closed or left NatoManga. Open NatoManga and press Save bookmarks again.",
      "the NatoManga tab was closed or left NatoManga",
      "Press Save bookmarks on a NatoManga tab to finish."
    );
  }
}

// An error that ends the import rather than failing one page. `reason` and
// `resume` build the message when earlier pages were already saved.
function stopError(message, reason, resume) {
  const err = new Error(message);
  err.stop = true;
  err.reason = reason;
  err.resume = resume;
  return err;
}

async function fetchPageInTab(tabId, url) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (targetUrl) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          try {
            const response = await fetch(targetUrl, {
              credentials: "include",
              cache: "no-store",
              signal: controller.signal,
            });
            const html = await response.text();
            return {
              ok: response.ok,
              status: response.status,
              url: response.url,
              html,
            };
          } finally {
            clearTimeout(timer);
          }
        },
        args: [url],
      });
      const response = results?.[0]?.result;
      if (!response) throw new Error("NatoManga did not return a page response.");
      if (!response.ok) {
        const error = new Error(`NatoManga request failed (${response.status}).`);
        error.transient = response.status === 429 || response.status >= 500;
        throw error;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (err?.transient === false || attempt === MAX_RETRIES - 1) break;
      await ensureTabOnNatoManga(tabId); // a closed tab ends the import, no retries
      await delay(500 * 2 ** attempt);
    }
  }
  throw lastError || new Error("NatoManga request failed.");
}

async function updateImportJob(patch) {
  const result = await chrome.storage.local.get(IMPORT_JOB_KEY);
  const existing = result[IMPORT_JOB_KEY] || {};
  await chrome.storage.local.set({
    [IMPORT_JOB_KEY]: { ...existing, ...patch, updatedAt: nowISO() },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowISO() {
  return new Date().toISOString();
}

function errorMessage(err) {
  return err?.message || String(err);
}
