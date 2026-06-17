// popup.js
// Ties everything together: reads the active tab, lets the user save it, and
// renders the searchable/sortable library. Loaded as an ES module so it can
// import the parser and storage helpers.

import { parseChapterUrl } from "./parser.js";
import { getAll, upsert, remove } from "./storage.js";

// Grab the elements we interact with.
const saveInfo = document.getElementById("saveInfo");
const saveBtn = document.getElementById("saveBtn");
const searchInput = document.getElementById("search");
const sortSelect = document.getElementById("sort");
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const toastEl = document.getElementById("toast");

// `pending` holds the parsed record for the current tab (or null if the tab
// is not a supported chapter page). It's what the Save button commits.
let pending = null;

// --- Active tab detection -------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Inspect the current tab and update the save area accordingly.
async function refreshSaveArea() {
  const tab = await getActiveTab();
  pending = tab?.url ? parseChapterUrl(tab.url) : null;

  if (pending) {
    saveInfo.innerHTML = `<strong>${escapeHtml(pending.title)}</strong><br>Chapter ${escapeHtml(
      pending.chapter
    )} on ${escapeHtml(pending.siteName)}`;
    saveBtn.disabled = false;
    saveBtn.textContent = "Save chapter";
  } else {
    saveInfo.textContent =
      "Open a chapter on a supported site (MangaRead or NatoManga) to save it.";
    saveBtn.disabled = true;
  }
}

// --- Saving ---------------------------------------------------------------

saveBtn.addEventListener("click", async () => {
  if (!pending) return;
  // Re-stamp the time at the moment of saving.
  await upsert({ ...pending, updatedAt: new Date().toISOString() });
  showToast(`Saved ${pending.title} - ch. ${pending.chapter}`);
  await render();
});

// --- Rendering the library ------------------------------------------------

async function render() {
  const all = await getAll();
  countEl.textContent = all.length ? `${all.length} series` : "";

  const query = searchInput.value.trim().toLowerCase();
  let items = query
    ? all.filter((r) => r.title.toLowerCase().includes(query))
    : all;

  if (sortSelect.value === "title") {
    items.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listEl.innerHTML = "";
  emptyEl.hidden = all.length > 0;

  for (const r of items) {
    listEl.appendChild(renderItem(r));
  }
}

function renderItem(r) {
  const li = document.createElement("li");
  li.className = "item";
  li.title = "Open chapter " + r.chapter;

  // Clicking the row opens the saved chapter in a new tab.
  li.addEventListener("click", () => {
    chrome.tabs.create({ url: r.chapterUrl });
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
  del.textContent = "x";
  del.title = "Remove from library";
  del.addEventListener("click", async (e) => {
    e.stopPropagation(); // don't trigger the row's open handler
    await remove(r.id);
    await render();
  });

  li.append(main, badge, del);
  return li;
}

// --- Helpers --------------------------------------------------------------

let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 1800);
}

// Prevent any odd characters in titles from breaking the markup we set via
// innerHTML in the save area.
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// Re-render the list as the user types or changes the sort.
searchInput.addEventListener("input", render);
sortSelect.addEventListener("change", render);

// Initial paint.
refreshSaveArea();
render();
