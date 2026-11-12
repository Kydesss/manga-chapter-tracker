// popup.js
// Ties everything together: reads the active tab, lets the user save it (with
// awareness of what's already saved), and renders a virtualized, searchable,
// sortable library that stays fast at thousands of entries. Also handles
// JSON export/import for backup. Loaded as an ES module.

import { parsePageUrl } from "./parser.js";
import { migrate, getAll, getLibrary, getOne, upsert, remove, restore, importRecords, OWNER_KEY } from "./storage.js";
import { getSession, getUserEmail, signOut, SESSION_KEY } from "./auth.js";
import { syncNow, resolveAccount } from "./sync.js";
import { viewSeries, safeUrl, compareChapters, relativeTime, escapeHtml, siteLabel, createResultGate } from "./view.js";

// Elements.
const saveInfo = document.getElementById("saveInfo");
const saveBtn = document.getElementById("saveBtn");
const goSavedBtn = document.getElementById("goSavedBtn");
const searchInput = document.getElementById("search");
const sortSelect = document.getElementById("sort");
const scroller = document.getElementById("scroller");
const sizer = document.getElementById("sizer");
const emptyEl = document.getElementById("empty");
const noResultsEl = document.getElementById("noResults");
const countEl = document.getElementById("count");
const toastEl = document.getElementById("toast");
const toastText = document.getElementById("toastText");
const toastAction = document.getElementById("toastAction");
const toastDismiss = document.getElementById("toastDismiss");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFile = document.getElementById("importFile");
const authStatus = document.getElementById("authStatus");
const authBtn = document.getElementById("authBtn");
const syncDot = document.getElementById("syncDot");
const libraryBtn = document.getElementById("libraryBtn");
const accountPrompt = document.getElementById("accountPrompt");
const accountPromptTitle = document.getElementById("accountPromptTitle");
const accountPromptText = document.getElementById("accountPromptText");
const keepSeparateBtn = document.getElementById("keepSeparateBtn");
const mergeBtn = document.getElementById("mergeBtn");

// The full library is the extension's options page: openOptionsPage focuses
// the tab if it's already open instead of opening a second one.
libraryBtn.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});

const ROW_H = 56; // must match --row-h in popup.css
const OVERSCAN = 4; // rows rendered above/below the viewport for smooth scroll

let pending = null; // parsed record for the current tab, or null
let pendingTabId = null; // the tab `pending` came from, so we can navigate it
// The save area warned that saving moves the series back. Clicking Save after
// that warning is a deliberate move back, which sync must keep (storage.upsert
// `resetProgress`), not undo with the furthest chapter.
let pendingMovesBack = false;
let allRecords = []; // every saved series (source of truth in memory)
let libraryEpoch; // which library allRecords came from (storage.js getLibrary)
let filtered = []; // current search/sort view, the array we virtualize

// --- Active tab + already-saved awareness ---------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// compareChapters, safeUrl, relativeTime, and escapeHtml live in view.js,
// shared with the library page.

// The secondary "go to your saved chapter" action. Hidden unless this tab is a
// different chapter of a series we already track, or a different page of the
// saved chapter (`sameChapter`: labelled "your saved page").
function setGoToSaved(record, url, { sameChapter = false } = {}) {
  if (!record || !url) {
    goSavedBtn.hidden = true;
    delete goSavedBtn.dataset.url;
    return;
  }
  goSavedBtn.hidden = false;
  goSavedBtn.textContent = sameChapter ? "Go to your saved page" : `Go to chapter ${record.chapter}`;
  goSavedBtn.setAttribute(
    "aria-label",
    sameChapter
      ? `Go to your saved page of chapter ${record.chapter} of ${record.title}, without changing it`
      : `Go to your saved chapter ${record.chapter} of ${record.title}, without changing it`
  );
  goSavedBtn.dataset.url = url;
}

async function refreshSaveArea() {
  const tab = await getActiveTab();
  pendingTabId = tab?.id ?? null;
  pending = tab?.url ? parsePageUrl(tab.url) : null;

  if (!pending) {
    saveInfo.textContent =
      "Open a chapter or series page on a supported site (MangaRead or NatoManga, now at manganami.com) to save it.";
    saveBtn.textContent = "Save chapter";
    saveBtn.disabled = true;
    setGoToSaved(null, null);
    return;
  }

  // Is this series already tracked? Show the relationship so a save is never
  // a surprise overwrite.
  const existing = await getOne(pending.id);
  pendingMovesBack = false;

  if (pending.chapter == null) {
    refreshSeriesSaveArea(existing);
    return;
  }
  let note = "";
  let savedUrl = null;
  let sameChapterJump = false;
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
      pendingMovesBack = true;
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
    // Within the same chapter, offer it when the saved link is a different
    // page of it (/chapter-100/12 saved, /chapter-100/2 open); a different
    // query string or #anchor alone doesn't count.
    savedUrl = safeUrl(existing.chapterUrl);
    if (savedUrl && dir === 0 && samePath(savedUrl, pending.chapterUrl)) savedUrl = null;
    if (savedUrl && savedUrl === safeUrl(pending.chapterUrl)) savedUrl = null;
    sameChapterJump = dir === 0;
  } else {
    saveBtn.textContent = "Save chapter";
  }

  // Prefer the stored title: a JSON import or another device may know the real
  // one, where the parser only has the slug.
  saveInfo.innerHTML =
    `<strong>${escapeHtml(existing?.title || pending.title)}</strong><br>Chapter ${escapeHtml(
      pending.chapter
    )} on ${escapeHtml(pending.siteName)}` + note;
  saveBtn.disabled = false;
  setGoToSaved(existing, savedUrl, { sameChapter: sameChapterJump });
}

function samePath(a, b) {
  try {
    return new URL(a).pathname.replace(/\/$/, "") === new URL(b).pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

// The save area on a series page: the only thing to save is "plan to read".
// A series you're already reading has nothing to save here (planning it would
// never erase your chapter anyway), so offer the way back to your place instead.
function refreshSeriesSaveArea(existing) {
  let note = "";
  let savedUrl = null;
  if (!existing) {
    saveBtn.textContent = "Plan to read";
    saveBtn.disabled = false;
  } else if (existing.chapter == null) {
    note = `<div class="save-note same">Already in Plan to read.</div>`;
    saveBtn.textContent = "Planned";
    saveBtn.disabled = true;
  } else {
    note = `<div class="save-note same">Reading: saved at chapter ${escapeHtml(
      existing.chapter
    )}.</div>`;
    saveBtn.textContent = "Already reading";
    saveBtn.disabled = true;
    savedUrl = safeUrl(existing.chapterUrl);
  }

  saveInfo.innerHTML =
    `<strong>${escapeHtml(existing?.title || pending.title)}</strong><br>Series page on ${escapeHtml(
      pending.siteName
    )}` + note;
  setGoToSaved(existing, savedUrl);
}

// --- Saving ---------------------------------------------------------------

saveBtn.addEventListener("click", async () => {
  if (!pending) return;
  const saved = await upsert(
    { ...pending, updatedAt: new Date().toISOString() },
    { resetProgress: pendingMovesBack }
  );
  showToast(
    saved.chapter == null
      ? `Added ${saved.title} to Plan to read`
      : `Saved ${saved.title} - ch. ${saved.chapter}`
  );
  await load();
  await refreshSaveArea();
  runSync(); // push this save to the cloud if signed in (fire and forget)
});

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
  ({ records: allRecords, epoch: libraryEpoch } = await getLibrary());
  computeView();
}

function computeView() {
  // Search + sort (recently read first, unread series alphabetically after).
  filtered = viewSeries(allRecords, { query: searchInput.value, sort: sortSelect.value });

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
  const row = document.createElement("div");
  row.className = "item";
  row.setAttribute("role", "listitem");
  row.tabIndex = 0; // keyboard focusable
  row.setAttribute(
    "aria-label",
    r.chapter == null
      ? `${r.title}, plan to read, ${siteLabel(r)}`
      : `${r.title}, chapter ${r.chapter}, ${siteLabel(r)}`
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
    // Only keys aimed at the row itself. Enter or Space on the remove button
    // bubbles up here too, and handling it would cancel the button's own
    // press and open the series instead of removing it.
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  const main = document.createElement("div");
  main.className = "item-main";

  // Primary: title.
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = r.title;

  // Secondary: chapter (emphasized), then site and last-read (tertiary, muted).
  const meta = document.createElement("div");
  meta.className = "item-sub";
  const chap = document.createElement("span");
  chap.className = "item-chapter";
  chap.textContent = r.chapter == null ? "Plan to read" : "Chapter " + r.chapter;
  const rest = document.createElement("span");
  rest.className = "item-meta";
  const when = relativeTime(r.lastReadAt); // unknown for plan-to-read records
  rest.textContent = when ? ` · ${siteLabel(r)} · ${when}` : ` · ${siteLabel(r)}`;
  meta.append(chap, rest);

  main.append(title, meta);

  const del = document.createElement("button");
  del.className = "delete-btn";
  del.textContent = "×"; // multiplication sign as a tidy close glyph
  del.setAttribute("aria-label", `Remove ${r.title} from library`);
  del.title = "Remove from library";
  const epoch = libraryEpoch; // the library this row was drawn from
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    // A keyboard press (detail 0) loses its focus with the row: move it to Undo.
    const fromKeyboard = e.detail === 0;
    const removed = await remove(r.id, { epoch });
    await load();
    await refreshSaveArea(); // the save area may describe this series
    if (removed === false) {
      showToast("The library changed; nothing was removed");
      return;
    }
    showToast(`Removed ${r.title}`, {
      label: "Undo",
      focus: fromKeyboard,
      run: () => undoRemove(r, removed),
    });
    runSync(); // push the tombstone so the deletion propagates
  });

  row.append(main, del);
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

// A plain message hides itself after a moment. One with an action (Undo) has
// no deadline: it stays until used, dismissed (×), replaced by the next
// message, or the popup closes, so nobody runs out of time to reach it.
let toastTimer;
function showToast(msg, action = null) {
  clearTimeout(toastTimer);
  // Replacing a message whose Undo had focus: don't leave focus on a button
  // that's about to disappear (Codex review).
  const hadFocus = toastEl.contains(document.activeElement);
  toastText.textContent = msg;
  toastAction.hidden = !action;
  toastDismiss.hidden = !action;
  toastAction.onclick = null;
  if (action) {
    toastAction.textContent = action.label;
    toastAction.onclick = () => {
      hideToast();
      action.run();
    };
  } else {
    toastTimer = setTimeout(hideToast, 2000);
  }
  toastEl.hidden = false;
  if (action?.focus || (hadFocus && action)) toastAction.focus();
  else if (hadFocus) searchInput.focus();
}

function hideToast() {
  clearTimeout(toastTimer);
  // Don't strand keyboard focus on a button that's about to disappear.
  const hadFocus = toastEl.contains(document.activeElement);
  toastEl.hidden = true;
  toastAction.onclick = null;
  if (hadFocus) searchInput.focus();
}

toastDismiss.addEventListener("click", hideToast);

// Undo a Remove: storage.restore brings the series back at the furthest
// chapter it knew, and refuses (false) if the library was switched or merged
// since, so one account's series can't land in another's library.
async function undoRemove(r, previous) {
  const restored = await restore(r.id, previous);
  await load();
  await refreshSaveArea();
  if (restored === false) {
    showToast("The library changed; nothing was restored");
    return;
  }
  if (!restored) {
    showToast(`${r.title} is already back`);
    return;
  }
  showToast(`Restored ${r.title}`);
  runSync(); // push the restore so it wins over the tombstone everywhere
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
// state: "signedout" | "syncing" | "synced" | "offline" | "paused"
function setSyncState(state) {
  syncDot.className = "sync-dot is-" + state;
  const dotTitle = { signedout: "Signed out", syncing: "Syncing", synced: "Synced", offline: "Offline", paused: "Paused" };
  syncDot.title = dotTitle[state] || "";
  // A pass starting doesn't settle anything; keep the prompt up until one does.
  if (state !== "paused" && state !== "syncing") accountPrompt.hidden = true;
  if (state === "signedout") {
    authStatus.textContent = "Sign in to sync";
  } else if (state === "paused") {
    authStatus.textContent = "Sync paused";
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

async function doSignOut() {
  await signOut();
  currentEmail = null;
  authBtn.textContent = "Sign in";
  setSyncState("signedout");
  showToast("Signed out");
}

authBtn.addEventListener("click", async () => {
  authBtn.disabled = true;
  try {
    const session = await getSession();
    if (session) {
      await doSignOut();
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

// --- Account mismatch ------------------------------------------------------
// The signed-in account isn't the one this library syncs with. Sync stays
// paused (sync.js pushes nothing) until the user picks one of these.

let asked = null; // { userId, epoch }: what the prompt is asking about

function showAccountPrompt({ owner, user, epoch }) {
  asked = { userId: user?.id, epoch };
  const me = user?.email || "this account";
  accountPromptTitle.replaceChildren();
  accountPromptText.replaceChildren();
  const strong = (text) => {
    const el = document.createElement("strong");
    el.textContent = text;
    return el;
  };
  if (owner?.id) {
    const them = owner.email || "another account";
    accountPromptTitle.textContent = `This library is ${them}'s`;
    accountPromptText.append(
      "You're signed in as ", strong(me), ", so syncing is paused. ",
      strong("Keep separate"), " saves this library for ", them, " and loads yours. ",
      strong("Merge"), " adds these series to your account."
    );
    keepSeparateBtn.hidden = false;
    mergeBtn.className = "save-btn secondary";
  } else {
    accountPromptTitle.textContent = "Whose library is this?";
    accountPromptText.append(
      "It synced before this update, and Shiori can't tell which account it was. ",
      "Syncing is paused. ", strong("Merge"), " adds these series to ", me,
      "; if they aren't yours, sign out below."
    );
    keepSeparateBtn.hidden = true; // it would never come back
    mergeBtn.className = "save-btn";
  }
  accountPrompt.hidden = false;
}

async function chooseAccount(choice) {
  for (const b of [keepSeparateBtn, mergeBtn]) b.disabled = true;
  try {
    const result = await resolveAccount(choice, asked || {});
    if (result.stale) {
      // The account or library changed while this waited: ask again about what's there now.
      showToast("The account changed; check again");
      await load();
      await runSync();
      return;
    }
    accountPrompt.hidden = true;
    showToast(choice === "separate" ? "Switched libraries" : "Merging into this account");
    await load(); // the library may have just been swapped
    await refreshSaveArea();
    await runSync();
  } catch (err) {
    showToast("Couldn't switch: " + (err?.message || "failed"));
  } finally {
    for (const b of [keepSeparateBtn, mergeBtn]) b.disabled = false;
  }
}

keepSeparateBtn.addEventListener("click", () => chooseAccount("separate"));
mergeBtn.addEventListener("click", () => chooseAccount("merge"));

const syncGate = createResultGate(); // only the newest sync result shows

// Run a sync pass (when signed in), reflect pulled changes, and update status.
// When runs overlap, only the newest reports, and only for the account still
// signed in: an older pass finishing late can't replace "Sync paused" with
// "Synced" (the same rule as the library page).
async function runSync(opts = {}) {
  const seq = syncGate.begin();
  let session = null;
  let res = null;
  try {
    session = await getSession();
    if (session) {
      if (syncGate.accept(seq)) setSyncState("syncing");
      res = await syncNow(opts);
    }
  } finally {
    syncGate.end(seq);
  }
  const now = await getSession();
  // Checked after the last await, so nothing newer can start before we report.
  if (!syncGate.accept(seq)) return; // newer work reports (or already did)
  if (!now) {
    syncGate.shown(seq);
    setSyncState("signedout");
    return;
  }
  // The account changed mid-pass: the run that change triggered reports.
  if (now.user?.id !== session?.user?.id || res?.skipped === "account-changed") return;
  syncGate.shown(seq);
  if (res?.skipped === "account-mismatch") {
    showAccountPrompt(res);
    setSyncState("paused");
  } else if (res?.ok || res?.skipped) {
    // Status first, with no await since the gate check: a newer run (say, one
    // that finds the account changed and pauses) can then only come after it.
    setSyncState("synced");
    if (res?.ok) {
      await load();
      await refreshSaveArea();
    }
  } else if (res?.error) {
    setSyncState("offline");
    showToast("Sync error: " + res.error);
  }
}

// The account can change while this popup is open (signing in or choosing an
// account from another window). Follow it, so the status never says "Synced"
// for a library whose sync is paused.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[SESSION_KEY] || changes[OWNER_KEY]) followAccountChange();
  // Another context changed the library (the keyboard shortcut, the library
  // page, a sync pass): show it here too (Codex review).
  if (changes.series) followLibraryChange();
  // A switch or merge replaced the library: a pending Undo no longer applies.
  if (changes[OWNER_KEY] && !toastDismiss.hidden && !toastEl.hidden) hideToast();
});
const followLibraryChange = debounce(async () => {
  await load();
  await refreshSaveArea();
}, 150);
const followAccountChange = debounce(async () => {
  await refreshAuthUI();
  await load();
  runSync();
}, 150);

// Re-filter as the user types (debounced) or changes the sort.
searchInput.addEventListener("input", debounce(computeView, 150));
sortSelect.addEventListener("change", computeView);

// Migrate before any reads or sync work so local-only and signed-in startup
// paths cannot race while rewriting the stored map.
async function initialize() {
  await migrate();
  await refreshSaveArea();
  await Promise.all([refreshAuthUI(), load()]);
  runSync({ throttle: true });
}

initialize();
