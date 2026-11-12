// library.js
// The full-page library (also the extension's options page). Filters the same
// library the popup shows by status, site, and title; sorts it; and offers
// per-series actions: Continue/Start (a read-only jump to your place), Series,
// and Remove with Undo. Design: docs/library-page-plan.md.
//
// Never moves a reading position: there's deliberately no "set chapter" here
// yet, because sync's furthest-chapter rule would undo a backward move (see the
// plan's "Why Set current chapter is deferred").

import { migrate, getAll, remove, restore } from "./storage.js";
import { getSession, getUserEmail } from "./auth.js";
import { syncNow } from "./sync.js";
import { viewSeries, summarize, sitesIn, safeUrl, relativeTime, isPlan } from "./view.js";

const $ = (id) => document.getElementById(id);
const summaryEl = $("summary");
const siteSelect = $("site");
const searchInput = $("search");
const sortSelect = $("sort");
const scroller = $("scroller");
const sizer = $("sizer");
const emptyEl = $("empty");
const noResultsEl = $("noResults");
const toastEl = $("toast");
const toastText = $("toastText");
const toastAction = $("toastAction");
const syncDot = $("syncDot");
const syncStatus = $("syncStatus");
const tabs = [...document.querySelectorAll(".tab")];
const toolbarEl = document.querySelector(".toolbar");

const OVERSCAN = 6;
const UNDO_MS = 6000;

let allRecords = [];
let rows = []; // the current filtered + sorted view, which we virtualize
let status = "all";

// --- Data ------------------------------------------------------------------

async function load({ keepScroll = false } = {}) {
  allRecords = await getAll();
  refreshSiteOptions();
  render({ keepScroll });
}

// The site filter lists only sites present in the library. Keep the current
// choice if it still exists; otherwise fall back to All sites.
function refreshSiteOptions() {
  const current = siteSelect.value;
  const sites = sitesIn(allRecords);
  siteSelect.replaceChildren(new Option("All sites", "all"));
  for (const s of sites) siteSelect.add(new Option(s.name, s.id));
  siteSelect.value = sites.some((s) => s.id === current) ? current : "all";
  // One site (or none) makes the filter pointless; hide it rather than offer a no-op.
  siteSelect.hidden = sites.length < 2;
  siteSelect.previousElementSibling.hidden = sites.length < 2;
}

// --- Rendering -------------------------------------------------------------

function rowHeight() {
  const v = parseFloat(getComputedStyle(document.body).getPropertyValue("--lib-row-h"));
  return Number.isFinite(v) && v > 0 ? v : 64;
}

function render({ keepScroll = false } = {}) {
  rows = viewSeries(allRecords, {
    query: searchInput.value,
    status,
    site: siteSelect.value,
    sort: sortSelect.value,
  });

  const { total, reading, plan } = summarize(allRecords);
  summaryEl.textContent = total
    ? `${total} series · ${reading} reading · ${plan} plan to read`
    : "";

  // Filters do nothing on an empty library; show the welcome state alone.
  toolbarEl.hidden = total === 0;
  emptyEl.hidden = total > 0;
  noResultsEl.hidden = !(total > 0 && rows.length === 0);
  scroller.hidden = rows.length === 0;

  sizer.style.height = rows.length * rowHeight() + "px";
  if (!keepScroll) scroller.scrollTop = 0;
  renderWindow();
}

// Render only the rows in view. Rows are rebuilt as you scroll, so remember
// which control had focus and put it back, or keyboard users would lose their
// place every time the list moves.
function renderWindow() {
  const active = document.activeElement;
  const focusedRow = active?.closest?.(".row");
  const restoreFocus = focusedRow
    ? { id: focusedRow.dataset.id, action: active.dataset.action }
    : null;

  const rowH = rowHeight();
  const viewport = scroller.clientHeight || 600;
  const start = Math.max(0, Math.floor(scroller.scrollTop / rowH) - OVERSCAN);
  const end = Math.min(rows.length, start + Math.ceil(viewport / rowH) + OVERSCAN * 2);

  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const row = renderRow(rows[i]);
    row.style.top = i * rowH + "px";
    fragment.appendChild(row);
  }
  sizer.replaceChildren(fragment);

  if (restoreFocus) {
    const row = [...sizer.children].find((el) => el.dataset.id === restoreFocus.id);
    const target = row?.querySelector(`[data-action="${restoreFocus.action}"]`);
    target?.focus({ preventScroll: true });
  }
}

function renderRow(r) {
  const plan = isPlan(r);
  const row = document.createElement("div");
  row.className = "row";
  row.setAttribute("role", "listitem");
  row.dataset.id = r.id;

  const main = document.createElement("div");
  main.className = "row-main";

  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = r.title;
  title.title = r.title;

  const sub = document.createElement("div");
  sub.className = "row-sub";
  const where = document.createElement("span");
  where.className = plan ? "row-plan" : "row-chapter";
  where.textContent = plan ? "Plan to read" : `Chapter ${r.chapter}`;
  const when = relativeTime(r.lastReadAt);
  sub.append(where, ` · ${r.siteName || r.site}${when ? ` · ${when}` : ""}`);

  main.append(title, sub);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  // Primary: back to your place. Read-only, like the popup's "Go to chapter X".
  const primaryUrl = plan ? safeUrl(r.seriesUrl) : safeUrl(r.chapterUrl);
  const primary = button(plan ? "Start" : "Continue", "btn primary", "primary");
  primary.setAttribute(
    "aria-label",
    plan ? `Start ${r.title}: open its series page` : `Continue ${r.title} at chapter ${r.chapter}`
  );
  wireOpen(primary, primaryUrl);

  // A plan's primary action already opens the series page. The primary action
  // goes last (beside Remove) so Continue/Start line up down the list.
  if (!plan) {
    const series = button("Series", "btn", "series");
    series.setAttribute("aria-label", `Open the series page for ${r.title}`);
    wireOpen(series, safeUrl(r.seriesUrl));
    actions.append(series);
  }
  actions.append(primary);

  const del = button("×", "remove-btn", "remove");
  del.title = "Remove from library";
  del.setAttribute("aria-label", `Remove ${r.title} from library`);
  // detail is 0 for a click synthesized from Enter/Space, the click count for a mouse.
  del.addEventListener("click", (e) => removeSeries(r, { fromKeyboard: e.detail === 0 }));
  actions.append(del);

  row.append(main, actions);
  return row;
}

function button(text, className, action) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  b.dataset.action = action;
  return b;
}

function wireOpen(btn, url) {
  if (!url) {
    btn.disabled = true;
    btn.title = "No usable saved link";
    return;
  }
  btn.addEventListener("click", () => chrome.tabs.create({ url }));
}

// --- Actions ---------------------------------------------------------------

// `fromKeyboard`: the remove button was activated with Enter/Space. Its row is
// gone after the reload, so focus moves to Undo instead of falling back to the
// page, where a keyboard user couldn't reach Undo before it expires.
async function removeSeries(r, { fromKeyboard = false } = {}) {
  const previous = await remove(r.id); // the series exactly as it was
  await load({ keepScroll: true });
  showToast(`Removed ${r.title}`, {
    label: "Undo",
    focus: fromKeyboard,
    run: async () => {
      const restored = await restore(r.id, previous);
      await load({ keepScroll: true });
      showToast(restored ? `Restored ${r.title}` : `${r.title} was already back`);
      focusRow(r.id) || searchInput.focus();
      runSync();
    },
  });
  runSync(); // push the tombstone so the removal propagates
}

// Focus a row's primary action if it's rendered. Returns whether it was.
function focusRow(id) {
  const row = [...sizer.children].find((el) => el.dataset.id === id);
  const target = row?.querySelector('[data-action="primary"]:not(:disabled), [data-action="remove"]');
  target?.focus();
  return Boolean(target);
}

// --- Toast -----------------------------------------------------------------

let toastTimer;
function showToast(message, action = null) {
  toastText.textContent = message;
  toastAction.hidden = !action;
  toastAction.onclick = null;
  if (action) {
    toastAction.textContent = action.label;
    toastAction.onclick = () => {
      hideToast();
      action.run();
    };
  }
  toastEl.hidden = false;
  if (action?.focus) toastAction.focus();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? UNDO_MS : 2500);
}

function hideToast() {
  // Don't strand keyboard focus on a button that's about to disappear.
  const hadFocus = document.activeElement === toastAction;
  toastEl.hidden = true;
  toastAction.onclick = null;
  if (hadFocus) searchInput.focus();
}

// --- Sync status -------------------------------------------------------------

function setSyncState(state, email = null) {
  syncDot.className = "sync-dot is-" + state;
  syncStatus.textContent =
    state === "signedout"
      ? "Not signed in"
      : state === "syncing"
        ? "Syncing..."
        : state === "offline"
          ? "Offline, will sync later"
          : email
            ? `Synced: ${email}`
            : "Synced";
}

async function runSync(opts = {}) {
  const session = await getSession();
  if (!session) {
    setSyncState("signedout");
    return;
  }
  const email = getUserEmail(session);
  setSyncState("syncing");
  const res = await syncNow(opts);
  // A pass that pulled changes rewrites storage; the onChanged listener reloads.
  if (res?.error) setSyncState("offline");
  else setSyncState("synced", email);
}

// --- Events ----------------------------------------------------------------

function setStatus(next) {
  status = next;
  for (const t of tabs) t.setAttribute("aria-pressed", String(t.dataset.status === next));
  render();
}

for (const t of tabs) t.addEventListener("click", () => setStatus(t.dataset.status));
siteSelect.addEventListener("change", () => render());
sortSelect.addEventListener("change", () => render());
searchInput.addEventListener("input", debounce(() => render(), 120));

let rafPending = false;
scroller.addEventListener("scroll", () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderWindow();
  });
});

// Row height changes at the narrow breakpoint; re-lay out on resize.
window.addEventListener("resize", debounce(() => render({ keepScroll: true }), 100));

// Stay current: a save from the popup or a sync pass rewrites the library in
// storage. Reload in place, keeping the scroll position and filters.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.series) reloadSoon();
});
const reloadSoon = debounce(() => load({ keepScroll: true }), 150);

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --- Start -----------------------------------------------------------------

async function initialize() {
  await migrate(); // also for local-only users, who never reach sync
  await load();
  runSync({ throttle: true });
}

initialize();
