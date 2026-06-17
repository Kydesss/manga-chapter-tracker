// popup.js
// Ties everything together: reads the active tab, lets the user save it (with
// awareness of what's already saved), and renders a virtualized, searchable,
// sortable library that stays fast at thousands of entries. Also handles
// JSON export/import for backup. Loaded as an ES module.

import { parseChapterUrl } from "./parser.js";
import { getAll, getOne, upsert, remove, importRecords } from "./storage.js";
import { getSession, getUserEmail, signOut } from "./auth.js";
import { syncNow } from "./sync.js";

// Elements.
const saveInfo = document.getElementById("saveInfo");
const saveBtn = document.getElementById("saveBtn");
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

const ROW_H = 56; // must match --row-h in popup.css
const OVERSCAN = 4; // rows rendered above/below the viewport for smooth scroll

let pending = null; // parsed record for the current tab, or null
let allRecords = []; // every saved series (source of truth in memory)
let filtered = []; // current search/sort view, the array we virtualize

// --- Active tab + already-saved awareness ---------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Compare two chapter labels ("83.2", "246") numerically. Returns -1/0/1.
function compareChapters(a, b) {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a === b ? 0 : NaN;
  return Math.sign(na - nb);
}

async function refreshSaveArea() {
  const tab = await getActiveTab();
  pending = tab?.url ? parseChapterUrl(tab.url) : null;

  if (!pending) {
    saveInfo.textContent =
      "Open a chapter on a supported site (MangaRead or NatoManga) to save it.";
    saveBtn.disabled = true;
    return;
  }

  // Is this series already tracked? Show the relationship so a save is never
  // a surprise overwrite.
  const existing = await getOne(pending.id);
  let note = "";
  if (existing) {
    const dir = compareChapters(pending.chapter, existing.chapter);
    if (dir === 0) {
      note = `<div class="save-note same">Already saved at chapter ${escapeHtml(
        existing.chapter
      )}.</div>`;
      saveBtn.textContent = "Save again";
    } else if (dir > 0) {
      note = `<div class="save-note advance">Saved: chapter ${escapeHtml(
        existing.chapter
      )} &rarr; will advance to ${escapeHtml(pending.chapter)}.</div>`;
      saveBtn.textContent = "Update chapter";
    } else {
      note = `<div class="save-note back">Saved: chapter ${escapeHtml(
        existing.chapter
      )}. This would move you back to ${escapeHtml(pending.chapter)}.</div>`;
      saveBtn.textContent = "Update chapter";
    }
  } else {
    saveBtn.textContent = "Save chapter";
  }

  saveInfo.innerHTML =
    `<strong>${escapeHtml(pending.title)}</strong><br>Chapter ${escapeHtml(
      pending.chapter
    )} on ${escapeHtml(pending.siteName)}` + note;
  saveBtn.disabled = false;
}

// --- Saving ---------------------------------------------------------------

saveBtn.addEventListener("click", async () => {
  if (!pending) return;
  await upsert({ ...pending, updatedAt: new Date().toISOString() });
  showToast(`Saved ${pending.title} - ch. ${pending.chapter}`);
  await load();
  await refreshSaveArea();
  runSync(); // push this save to the cloud if signed in (fire and forget)
});

// --- Data load + view computation -----------------------------------------

async function load() {
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
    filtered.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  // Header count + empty/no-results messaging.
  countEl.textContent = allRecords.length ? `${allRecords.length} series` : "";
  emptyEl.hidden = allRecords.length > 0;
  noResultsEl.hidden = !(allRecords.length > 0 && filtered.length === 0);

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
  const row = document.createElement("div");
  row.className = "item";
  row.setAttribute("role", "listitem");
  row.tabIndex = 0; // keyboard focusable
  row.setAttribute("aria-label", `${r.title}, chapter ${r.chapter}, ${r.siteName}`);

  const open = () => chrome.tabs.create({ url: r.chapterUrl });
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  const main = document.createElement("div");
  main.className = "item-main";
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = r.title;
  const sub = document.createElement("div");
  sub.className = "item-sub";
  sub.textContent = r.siteName;
  main.append(title, sub);

  const badge = document.createElement("span");
  badge.className = "chapter-badge";
  badge.textContent = "Ch. " + r.chapter;

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

  row.append(main, badge, del);
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

// Initial paint, then a throttled sync on open (no-op when signed out).
refreshSaveArea();
refreshAuthUI();
load();
runSync({ throttle: true });
