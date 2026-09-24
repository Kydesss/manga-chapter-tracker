// popup.js
// Ties everything together: reads the active tab, lets the user save it (with
// awareness of what's already saved), and renders a virtualized, searchable,
// sortable library that stays fast at thousands of entries. Also handles
// JSON export/import for backup. Loaded as an ES module.

import { parseChapterUrl } from "./parser.js";
import { isNatoMangaUrl } from "./natomanga.js";
import { migrate, getAll, getOne, upsert, remove, importRecords } from "./storage.js";
import { getSession, getUserEmail, signOut } from "./auth.js";
import { syncNow } from "./sync.js";

// Elements.
const saveInfo = document.getElementById("saveInfo");
const saveBtn = document.getElementById("saveBtn");
const goSavedBtn = document.getElementById("goSavedBtn");
const natoImportBtn = document.getElementById("natoImportBtn");
const natoRefreshBtn = document.getElementById("natoRefreshBtn");
const natoImportStatus = document.getElementById("natoImportStatus");
const searchInput = document.getElementById("search");
const sortSelect = document.getElementById("sort");
const scroller = document.getElementById("scroller");
const sizer = document.getElementById("sizer");
const emptyEl = document.getElementById("empty");
const noResultsEl = document.getElementById("noResults");
const countEl = document.getElementById("count");
const toastEl = document.getElementById("toast");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFile = document.getElementById("importFile");
const authStatus = document.getElementById("authStatus");
const authBtn = document.getElementById("authBtn");
const syncDot = document.getElementById("syncDot");

const ROW_H = 72; // must match the .item height in popup.css
const OVERSCAN = 4; // rows rendered above/below the viewport for smooth scroll

let pending = null; // parsed record for the current tab, or null
let pendingTabId = null; // the tab `pending` came from, so we can navigate it
let activeIsNatoManga = false;
let allRecords = []; // every saved series (source of truth in memory)
let filtered = []; // current search/sort view, the array we virtualize

// --- Active tab + already-saved awareness ---------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Compare two chapter labels ("83.2", "246") numerically. Returns -1/0/1, or
// NaN when the labels aren't numerically comparable (possible for records that
// arrived through JSON import or another device, never from our own parser).
function compareChapters(a, b) {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a === b ? 0 : NaN;
  return Math.sign(na - nb);
}

// A stored chapterUrl is untrusted: it can come from a hand-edited JSON import
// or another device, and older records may not have one at all. Only ever hand
// an http(s) URL to the tabs API.
function safeUrl(raw) {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// The secondary "go to your saved chapter" action. Hidden unless this tab is a
// different chapter of a series we already track.
function setGoToSaved(record, url) {
  if (!record || !url) {
    goSavedBtn.hidden = true;
    delete goSavedBtn.dataset.url;
    return;
  }
  goSavedBtn.hidden = false;
  goSavedBtn.textContent = `Go to chapter ${record.chapter}`;
  goSavedBtn.setAttribute(
    "aria-label",
    `Go to your saved chapter ${record.chapter} of ${record.title}, without changing it`
  );
  goSavedBtn.dataset.url = url;
}

async function refreshSaveArea() {
  const tab = await getActiveTab();
  pendingTabId = tab?.id ?? null;
  pending = tab?.url ? parseChapterUrl(tab.url) : null;
  const onNatoManga = tab?.url ? isNatoMangaUrl(tab.url) : false;
  activeIsNatoManga = onNatoManga;
  natoImportBtn.hidden = !onNatoManga;
  natoRefreshBtn.hidden = !onNatoManga;
  if (!onNatoManga) natoImportStatus.hidden = true;

  if (!pending) {
    saveInfo.textContent = onNatoManga
      ? "NatoManga detected. Save every bookmark using your current NatoManga session."
      : "Open a chapter on a supported site (MangaRead or NatoManga) to save it.";
    saveBtn.disabled = true;
    setGoToSaved(null, null);
    return;
  }

  // Is this series already tracked? Show the relationship so a save is never
  // a surprise overwrite.
  const existing = await getOne(pending.id);
  let note = "";
  let savedUrl = null;
  if (existing) {
    const dir = existing.chapter == null ? NaN : compareChapters(pending.chapter, existing.chapter);
    if (existing.chapter == null) {
      note = `<div class="save-note">Already in your library, but not started.</div>`;
      saveBtn.textContent = "Start reading";
    } else if (dir === 0) {
      note = `<div class="save-note same">Already saved at chapter ${escapeHtml(
        existing.chapter
      )}.</div>`;
      saveBtn.textContent = "Save again";
    } else if (dir > 0) {
      note = `<div class="save-note advance">Saved: chapter ${escapeHtml(
        existing.chapter
      )} &rarr; will advance to ${escapeHtml(pending.chapter)}.</div>`;
      saveBtn.textContent = "Update chapter";
    } else if (dir < 0) {
      note = `<div class="save-note back">Saved: chapter ${escapeHtml(
        existing.chapter
      )}. This would move you back to ${escapeHtml(pending.chapter)}.</div>`;
      saveBtn.textContent = "Update chapter";
    } else {
      // NaN: we can't rank these labels, so state the saved position without
      // claiming a direction rather than wrongly warning about moving back.
      note = `<div class="save-note">Saved: chapter ${escapeHtml(
        existing.chapter
      )}.</div>`;
      saveBtn.textContent = "Update chapter";
    }

    // Offer the jump whenever the saved chapter is a different one (either
    // direction: you can overshoot as easily as you can fall behind). Skip it
    // when the saved link is unusable, or is the page you're already on.
    if (dir !== 0) {
      savedUrl = safeUrl(existing.chapterUrl);
      if (savedUrl && savedUrl === safeUrl(pending.chapterUrl)) savedUrl = null;
    }
  } else {
    saveBtn.textContent = "Save chapter";
  }

  // Prefer the stored title: an import may know the real one, where the parser
  // only has the slug.
  saveInfo.innerHTML =
    `<strong>${escapeHtml(existing?.title || pending.title)}</strong><br>Chapter ${escapeHtml(
      pending.chapter
    )} on ${escapeHtml(pending.siteName)}` + note;
  saveBtn.disabled = false;
  setGoToSaved(existing, savedUrl);
}

// --- Saving ---------------------------------------------------------------

saveBtn.addEventListener("click", async () => {
  if (!pending) return;
  const saved = await upsert({ ...pending, updatedAt: new Date().toISOString() });
  showToast(`Saved ${saved.title} - ch. ${saved.chapter}`);
  await load();
  await refreshSaveArea();
  runSync(); // push this save to the cloud if signed in (fire and forget)
});

// --- NatoManga bookmark import -------------------------------------------

let importPollTimer = null;
let importRequestPending = false; // this popup started an import and awaits its reply
let lastJobStatus = null; // to notice a watched import finishing

natoImportBtn.addEventListener("click", () => runNatoOperation("import-natomanga-bookmarks"));
natoRefreshBtn.addEventListener("click", () => runNatoOperation("refresh-natomanga-updates"));

// Import and Refresh run the same background job: every bookmark page, then a
// capped series-page pass for missing covers and latest chapters.
async function runNatoOperation(type) {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url || !isNatoMangaUrl(tab.url)) return;

  const refreshing = type === "refresh-natomanga-updates";
  importRequestPending = true;
  showImportJob({
    status: "running",
    operation: refreshing ? "refresh" : "import",
    phase: "bookmarks",
    pagesCompleted: 0,
    pagesTotal: 1,
    bookmarksFound: 0,
  });
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type, tabId: tab.id, pageUrl: tab.url });
    if (!response?.ok) throw new Error(response?.error || "Bookmark import failed.");
    if (!response.inProgress) {
      const result = response.result;
      showToast(
        `${refreshing ? "Refreshed" : "Saved"} ` +
          `${result.added} new bookmark${result.added === 1 ? "" : "s"}` +
          (result.advanced ? `, advanced ${result.advanced}` : "")
      );
    }
  } catch (err) {
    showImportJob({ status: "error", error: err?.message || "Bookmark import failed." });
    showToast(
      response?.result
        ? "Import stopped early; earlier pages were saved."
        : "Import failed: " + (err?.message || "unknown error")
    );
  } finally {
    importRequestPending = false;
    lastJobStatus = null; // handled here, so the refresh below isn't a new finish
    // Pages are saved as they arrive, so even a stopped import may have added
    // series: refresh the list and sync whatever landed.
    if (!response?.inProgress) {
      await load();
      runSync();
    }
    refreshImportState();
  }
}

// "+N" when the latest known chapter is ahead of the saved one, "NEW" when the
// labels can't be ranked but differ, nothing otherwise.
function updateBadge(record) {
  if (record.chapter == null || record.latestChapter == null) return null;
  const saved = Number.parseFloat(record.chapter);
  const latest = Number.parseFloat(record.latestChapter);
  if (!Number.isNaN(saved) && !Number.isNaN(latest)) {
    const difference = latest - saved;
    if (difference <= 0) return null;
    return `+${Number.isInteger(difference) ? difference : difference.toFixed(1)}`;
  }
  return record.chapter === record.latestChapter ? null : "NEW";
}

async function refreshImportState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-natomanga-import-state" });
    if (!response?.ok || !response.job) return;
    // Until this popup's own request is answered, the stored job may still be
    // the previous run's. Keep showing progress rather than that old result.
    if (importRequestPending && response.job.status !== "running") {
      clearTimeout(importPollTimer);
      importPollTimer = setTimeout(refreshImportState, 500);
      return;
    }
    showImportJob(response.job);
  } catch {
    // The service worker may be starting; the next popup open retries.
  }
}

function showImportJob(job) {
  clearTimeout(importPollTimer);
  const running = job?.status === "running";
  // An import this popup watched, but didn't start, just finished. Its pages
  // are already saved, so bring them into the list and sync them.
  if (lastJobStatus === "running" && !running && !importRequestPending) {
    load();
    runSync();
  }
  lastJobStatus = job?.status ?? null;
  const refreshing = job?.operation === "refresh";
  natoImportBtn.disabled = running;
  natoRefreshBtn.disabled = running;
  natoImportBtn.textContent = running && !refreshing ? "Saving bookmarks..." : "Save bookmarks";
  natoRefreshBtn.textContent = running && refreshing ? "Refreshing updates..." : "Refresh updates";

  if (!job || !activeIsNatoManga) {
    natoImportStatus.hidden = true;
    return;
  }

  natoImportStatus.hidden = false;
  if (running) {
    if (job.phase === "metadata") {
      natoImportStatus.textContent =
        `Checking series details ${Math.min(
          (job.seriesPagesCompleted || 0) + 1,
          job.seriesPagesTotal || 1
        )} of ${job.seriesPagesTotal || 1}`;
    } else {
      natoImportStatus.textContent =
        `Scanning bookmarks page ${Math.min(
          (job.pagesCompleted || 0) + 1,
          job.pagesTotal || 1
        )} of ${job.pagesTotal || 1} · ${job.bookmarksFound || 0} found`;
    }
    importPollTimer = setTimeout(refreshImportState, 500);
  } else if (job.status === "complete") {
    const result = job.result || {};
    if (!result.bookmarksFound) {
      natoImportStatus.textContent =
        "No bookmarks found. Check that this NatoManga account has bookmarks.";
    } else {
      natoImportStatus.textContent =
        `${result.bookmarksFound} found · ${result.added || 0} new` +
        (result.advanced ? ` · ${result.advanced} advanced` : "") +
        (result.seriesPagesChecked ? ` · ${result.seriesPagesChecked} details checked` : "") +
        (result.failedPages?.length ? ` · ${result.failedPages.length} page failed` : "");
    }
  } else if (job.status === "error") {
    natoImportStatus.textContent = job.error || "Bookmark import failed.";
  }
}

// Jump to the saved chapter. Deliberately does NOT save: it's the way out of a
// mismatch that leaves your position untouched.
goSavedBtn.addEventListener("click", async () => {
  const url = safeUrl(goSavedBtn.dataset.url);
  if (!url) return;
  // Navigate the tab you're already on rather than opening a second one: you're
  // on the wrong chapter of this very series, and Back still returns you.
  if (pendingTabId != null) {
    await chrome.tabs.update(pendingTabId, { url });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
});

// --- Data load + view computation -----------------------------------------

async function load() {
  // Migrations must also run for local-only users; sync may never be invoked.
  await migrate();
  allRecords = await getAll();
  computeView();
}

function computeView() {
  const query = searchInput.value.trim().toLowerCase();
  filtered = query
    ? allRecords.filter((r) => r.title.toLowerCase().includes(query))
    : allRecords.slice();

  if (sortSelect.value === "title") {
    filtered.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    // Recently read first. Series with no known read time (plan to read, or
    // imported without one) follow alphabetically, instead of an import's
    // timestamp pushing them all to the top.
    filtered.sort(
      (a, b) =>
        (b.lastReadAt || "").localeCompare(a.lastReadAt || "") ||
        a.title.localeCompare(b.title)
    );
  }

  // Header count + empty/no-results messaging.
  countEl.textContent = allRecords.length ? `${allRecords.length} series` : "";
  emptyEl.hidden = allRecords.length > 0;
  noResultsEl.hidden = !(allRecords.length > 0 && filtered.length === 0);
  // Hide the (flexing) list when there's nothing to show, so the empty/no-results
  // message centres in the freed space instead of an empty scroller holding it.
  scroller.hidden = filtered.length === 0;

  // Re-virtualize from the top whenever the dataset/view changes.
  sizer.style.height = filtered.length * ROW_H + "px";
  scroller.scrollTop = 0;
  renderWindow();
}

// --- Virtualized rendering -------------------------------------------------

function renderWindow() {
  const scrollTop = scroller.scrollTop;
  const viewport = scroller.clientHeight || 340;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewport / ROW_H) + OVERSCAN * 2;
  const end = Math.min(filtered.length, start + visibleCount);

  sizer.replaceChildren();
  for (let i = start; i < end; i++) {
    const row = renderItem(filtered[i]);
    row.style.top = i * ROW_H + "px";
    sizer.appendChild(row);
  }
}

// Throttle scroll handling to one render per animation frame.
let rafPending = false;
scroller.addEventListener("scroll", () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderWindow();
  });
});

function renderItem(r) {
  const badgeLabel = updateBadge(r);
  const row = document.createElement("div");
  row.className = "item";
  row.setAttribute("role", "listitem");
  row.tabIndex = 0; // keyboard focusable
  row.setAttribute(
    "aria-label",
    (r.chapter == null
      ? `${r.title}, plan to read, ${r.siteName}`
      : `${r.title}, chapter ${r.chapter}, ${r.siteName}`) +
      (badgeLabel ? `, latest chapter ${r.latestChapter}` : "")
  );

  const open = () => {
    const url = safeUrl(r.chapterUrl) || safeUrl(r.seriesUrl);
    if (!url) {
      showToast("That series has no usable saved link.");
      return;
    }
    chrome.tabs.create({ url });
  };
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  // Cover thumbnail, lazy-loaded, with the Shiori mark when missing or broken.
  const cover = document.createElement("img");
  cover.className = "item-cover";
  cover.alt = "";
  cover.loading = "lazy";
  cover.src = safeUrl(r.coverUrl) || chrome.runtime.getURL("icons/logo.svg");
  cover.addEventListener("error", () => {
    const fallback = chrome.runtime.getURL("icons/logo.svg");
    if (cover.src !== fallback) cover.src = fallback;
  });

  const main = document.createElement("div");
  main.className = "item-main";

  // Primary: title, with an update badge when newer chapters are out.
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = r.title;
  const titleLine = document.createElement("div");
  titleLine.className = "item-title-line";
  titleLine.appendChild(title);
  if (badgeLabel) {
    const badge = document.createElement("span");
    badge.className = "update-badge";
    badge.textContent = badgeLabel;
    badge.title = `Latest chapter: ${r.latestChapter}`;
    titleLine.appendChild(badge);
  }

  // Secondary: chapter (emphasized), then site, last-read, and the latest
  // chapter when known (tertiary, muted).
  const meta = document.createElement("div");
  meta.className = "item-sub";
  const chap = document.createElement("span");
  chap.className = "item-chapter";
  chap.textContent = r.chapter == null ? "Plan to read" : "Chapter " + r.chapter;
  const rest = document.createElement("span");
  rest.className = "item-meta";
  const when = relativeTime(r.lastReadAt); // unknown for plan-to-read and imports
  const latestWhen = relativeTime(r.latestPublishedAt);
  rest.textContent =
    (when ? ` · ${r.siteName} · ${when}` : ` · ${r.siteName}`) +
    (r.latestChapter
      ? ` · Latest ${r.latestChapter}${latestWhen ? ` (${latestWhen})` : ""}`
      : "");
  meta.append(chap, rest);

  main.append(titleLine, meta);

  const del = document.createElement("button");
  del.className = "delete-btn";
  del.textContent = "×"; // multiplication sign as a tidy close glyph
  del.setAttribute("aria-label", `Remove ${r.title} from library`);
  del.title = "Remove from library";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    await remove(r.id);
    await load();
    showToast(`Removed ${r.title}`);
    runSync(); // push the tombstone so the deletion propagates
  });

  row.append(cover, main, del);
  return row;
}

// --- Export / Import -------------------------------------------------------

exportBtn.addEventListener("click", async () => {
  const data = await getAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `manga-tracker-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${data.length} series`);
});

importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const records = JSON.parse(text);
    const result = await importRecords(records);
    await load();
    showToast(
      `Imported: ${result.added} new, ${result.updated} updated` +
        (result.skipped ? `, ${result.skipped} skipped` : "")
    );
  } catch (err) {
    showToast("Import failed: " + (err?.message || "invalid file"));
  } finally {
    importFile.value = ""; // allow re-importing the same file
  }
});

// --- Helpers --------------------------------------------------------------

let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2000);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Compact relative time for the "last read" line, e.g. "just now", "3d ago".
function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// --- Auth + sync status ---------------------------------------------------

let currentEmail = null;

// Drive the footer status: a coloured dot plus a short label.
// state: "signedout" | "syncing" | "synced" | "offline"
function setSyncState(state) {
  syncDot.className = "sync-dot is-" + state;
  const dotTitle = { signedout: "Signed out", syncing: "Syncing", synced: "Synced", offline: "Offline" };
  syncDot.title = dotTitle[state] || "";
  if (state === "signedout") {
    authStatus.textContent = "Sign in to sync";
  } else if (state === "syncing") {
    authStatus.textContent = "Syncing...";
  } else if (state === "offline") {
    authStatus.textContent = "Offline, will sync later";
  } else {
    authStatus.textContent = currentEmail ? `Synced: ${currentEmail}` : "Synced";
  }
  authStatus.title = authStatus.textContent;
}

async function refreshAuthUI() {
  const session = await getSession();
  if (session) {
    currentEmail = getUserEmail(session);
    authBtn.textContent = "Sign out";
    setSyncState("synced"); // optimistic resting state; a failed sync flips to offline
  } else {
    currentEmail = null;
    authBtn.textContent = "Sign in";
    setSyncState("signedout");
  }
}

authBtn.addEventListener("click", async () => {
  authBtn.disabled = true;
  try {
    const session = await getSession();
    if (session) {
      await signOut();
      currentEmail = null;
      authBtn.textContent = "Sign in";
      setSyncState("signedout");
      showToast("Signed out");
    } else {
      // Run sign-in in the service worker so it survives the popup closing
      // (launchWebAuthFlow takes focus and Chrome closes the popup otherwise).
      const res = await chrome.runtime.sendMessage({ type: "signin" });
      if (!res?.ok) throw new Error(res?.error || "Sign-in failed");
      currentEmail = getUserEmail(res.session);
      authBtn.textContent = "Sign out";
      showToast(`Signed in as ${currentEmail || "user"}`);
      await runSync(); // first sync: merge local with the cloud
    }
  } catch (err) {
    showToast("Auth error: " + (err?.message || "failed"));
    refreshAuthUI();
  } finally {
    authBtn.disabled = false;
  }
});

// Run a sync pass (when signed in), reflect pulled changes, and update status.
async function runSync(opts = {}) {
  const session = await getSession();
  if (!session) {
    setSyncState("signedout");
    return;
  }
  setSyncState("syncing");
  const res = await syncNow(opts);
  if (res?.ok || res?.skipped) {
    if (res?.ok) {
      await load();
      await refreshSaveArea();
    }
    setSyncState("synced");
  } else if (res?.error) {
    setSyncState("offline");
    showToast("Sync error: " + res.error);
  }
}

// Re-filter as the user types (debounced) or changes the sort.
searchInput.addEventListener("input", debounce(computeView, 150));
sortSelect.addEventListener("change", computeView);

// Migrate before any reads or sync work so local-only and signed-in startup
// paths cannot race while rewriting the stored map.
async function initialize() {
  await migrate();
  await refreshSaveArea();
  await Promise.all([refreshAuthUI(), refreshImportState(), load()]);
  runSync({ throttle: true });
}

initialize();
