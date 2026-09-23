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
import { parseNatoBookmarkPage, isNatoMangaUrl } from "./natomanga.js";
import { bulkUpsert, migrate } from "./storage.js";

const IMPORT_JOB_KEY = "natomangaImportJob";
const MAX_IMPORT_PAGES = 1000;
const MAX_RETRIES = 3;
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
            error: "The previous import was interrupted. Press Save bookmarks to retry.",
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
  if (msg?.type === "import-natomanga-bookmarks") {
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
        await updateImportJob({ status: "error", error, finishedAt: nowISO() });
        sendResponse({ ok: false, error });
      })
      .finally(() => {
        importRunning = false;
      });
    return true;
  }
  return false;
});

async function importNatoMangaBookmarks({ tabId, pageUrl }) {
  if (!Number.isInteger(tabId) || !isNatoMangaUrl(pageUrl)) {
    throw new Error("Open NatoManga in the active tab before importing bookmarks.");
  }
  const tab = await chrome.tabs.get(tabId);
  if (!isNatoMangaUrl(tab?.url)) {
    throw new Error("The selected tab is no longer on NatoManga.");
  }

  await migrate();
  const timestamp = nowISO();
  const bookmarkUrl = new URL("/bookmark?page=1", pageUrl).href;
  await chrome.storage.local.set({
    [IMPORT_JOB_KEY]: {
      status: "running",
      startedAt: timestamp,
      updatedAt: timestamp,
      pagesCompleted: 0,
      pagesTotal: 1,
      bookmarksFound: 0,
      failedPages: [],
      error: null,
      result: null,
    },
  });

  const records = [];
  const diagnostics = [];
  const failedPages = [];
  let pagesCompleted = 0;
  let pagesTotal = 1;

  for (let page = 1; page <= pagesTotal; page++) {
    if (page > MAX_IMPORT_PAGES) {
      throw new Error(`NatoManga reported more than ${MAX_IMPORT_PAGES} bookmark pages.`);
    }

    const targetUrl = new URL(`/bookmark?page=${page}`, bookmarkUrl).href;
    try {
      const response = await fetchPageInTab(tabId, targetUrl);
      const parsed = parseNatoBookmarkPage(response.html, response.url || targetUrl, {
        timestamp,
      });
      if (parsed.loginRequired) {
        throw new Error("Sign in to NatoManga in this tab, then try again.");
      }
      records.push(...parsed.records);
      diagnostics.push(...parsed.diagnostics.map((value) => `page-${page}:${value}`));
      pagesTotal = Math.min(
        MAX_IMPORT_PAGES,
        Math.max(pagesTotal, parsed.pageCount || 1)
      );
      pagesCompleted++;
    } catch (err) {
      const message = errorMessage(err);
      if (/Sign in to NatoManga/i.test(message)) throw err;
      failedPages.push({ page, error: message });
    }

    await updateImportJob({
      pagesCompleted,
      pagesTotal,
      bookmarksFound: records.length,
      failedPages,
    });
  }

  if (!records.length && failedPages.length) {
    throw new Error("No bookmarks could be imported because every bookmark page failed.");
  }
  if (!records.length && diagnostics.includes("page-1:no-bookmark-items")) {
    // An empty account is a valid successful import.
    pagesTotal = 1;
  }

  const storageResult = await bulkUpsert(records, { timestamp });
  const result = {
    ...storageResult,
    pagesCompleted,
    pagesTotal,
    bookmarksFound: records.length,
    failedPages,
    diagnostics,
  };
  await updateImportJob({
    status: "complete",
    finishedAt: nowISO(),
    result,
    error: null,
  });
  return result;
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
