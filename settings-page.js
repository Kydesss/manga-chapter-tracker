// settings-page.js
// The Settings view of the library page (library.html#settings). v1 has one
// section, Sites: the built-in sites, the ones you've added, and a form to add
// or edit one with a live address test. See docs/custom-sites-plan.md.

import { BUILTIN_SITES, compileSite, parseChapterUrl, parseSeriesUrl, hostOf } from "./parser.js";
import { getCustomSites, saveCustomSite, removeCustomSite, restoreCustomSite, validateSiteDef } from "./settings.js";
import { PENDING_SITE_ADD_KEY } from "./view.js";

// An "Add this site" request from the popup older than this is ignored (the
// library page wasn't open to pick it up, and you've moved on since).
const PENDING_ADD_MAX_AGE_MS = 10 * 60 * 1000;

const $ = (id) => document.getElementById(id);

// `showToast(message, action)` is the library page's; `show()` switches the
// page to Settings.
export function createSettingsPage({ showToast, show }) {
  const list = $("siteList");
  const addOpen = $("addSiteOpen");
  const form = $("siteForm");
  const formTitle = $("siteFormTitle");
  const saveBtn = $("siteSave");
  const cancelBtn = $("siteCancel");
  const testInput = $("siteTest");
  const testResult = $("siteTestResult");
  const fields = {
    host: { input: $("siteHost"), error: $("siteHostError") },
    name: { input: $("siteName"), error: $("siteNameError") },
    chapterPattern: { input: $("siteChapter"), error: $("siteChapterError") },
    seriesPattern: { input: $("siteSeries"), error: $("siteSeriesError") },
  };

  let custom = [];
  let editingId = null; // the site being edited, or null when adding
  let returnFocus = null; // where focus goes when the form closes

  // --- List ------------------------------------------------------------------

  async function refresh() {
    const previous = custom;
    custom = await getCustomSites();
    // The site being edited was removed elsewhere (another tab or browser):
    // close the form, say why, and don't leave focus on a hidden field.
    if (editingId && !custom.some((s) => s.id === editingId)) {
      const name = previous.find((s) => s.id === editingId)?.name || "That site";
      const focusWasInForm = form.contains(document.activeElement);
      closeForm({ restoreFocus: false });
      if (focusWasInForm) addOpen.focus();
      showToast(`${name} was removed elsewhere, so your changes weren't saved`);
    }
    renderList();
    updateTest();
  }

  // Rows are rebuilt on every change (including the storage echo of your own
  // save), so keep keyboard focus on the same site's same button.
  function renderList() {
    const active = document.activeElement;
    const keep = list.contains(active) ? { id: active.dataset.siteId, action: active.dataset.action } : null;
    list.replaceChildren();
    for (const site of BUILTIN_SITES) {
      const domains = [site.host, ...(site.legacyHosts || []).map((h) => `${h} (old address)`)];
      list.append(siteItem(site.name, domains.join(", "), null));
    }
    for (const site of custom) list.append(siteItem(site.name, `${site.host} · ${site.chapterPattern}`, site));
    // The focused site was removed elsewhere: land on Add a site instead.
    if (keep?.id) (siteButton(keep.id, keep.action) || addOpen).focus();
  }

  function siteButton(id, action = "edit") {
    return [...list.querySelectorAll("button[data-site-id]")].find(
      (b) => b.dataset.siteId === id && b.dataset.action === action
    );
  }

  function siteItem(name, detail, site) {
    const li = document.createElement("li");
    li.className = "site-item";
    const main = document.createElement("div");
    main.className = "site-main";
    const title = document.createElement("div");
    title.className = "site-name";
    title.textContent = name;
    const sub = document.createElement("div");
    sub.className = "site-detail";
    sub.textContent = detail;
    main.append(title, sub);
    li.append(main);

    if (!site) {
      const badge = document.createElement("span");
      badge.className = "site-badge";
      badge.textContent = "Built in";
      li.append(badge);
      return li;
    }
    const actions = document.createElement("div");
    actions.className = "site-actions";
    const edit = button("Edit", `Edit ${name}`, () => openForm(site));
    const remove = button("Remove", `Remove ${name}`, () => removeSite(site));
    edit.dataset.siteId = remove.dataset.siteId = site.id;
    edit.dataset.action = "edit";
    remove.dataset.action = "remove";
    actions.append(edit, remove);
    li.append(actions);
    return li;
  }

  function button(label, ariaLabel, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = label;
    b.setAttribute("aria-label", ariaLabel);
    b.addEventListener("click", onClick);
    return b;
  }

  async function removeSite(site) {
    if (editingId === site.id) closeForm({ restoreFocus: false });
    // Undo restores what was removed, read under the settings lock, not this
    // row's copy, which another tab may have edited since (Codex review).
    const removed = await removeCustomSite(site.id);
    addOpen.focus(); // the row (and its button) is about to go
    if (!removed) {
      showToast(`${site.name} was already removed`);
      return;
    }
    showToast(`Removed ${removed.name}. Series you saved from it stay in your library.`, {
      label: "Undo",
      run: async () => {
        const result = await restoreCustomSite(removed);
        showToast(result.ok ? `${removed.name} is back` : `Couldn't put ${removed.name} back: ${result.error}`);
      },
    });
  }

  // --- Form ------------------------------------------------------------------

  // `site` to edit one; otherwise `prefill` ({ host, testUrl }) for a new one.
  function openForm(site = null, prefill = {}) {
    returnFocus = document.activeElement;
    editingId = site?.id ?? null;
    formTitle.textContent = site ? `Edit ${site.name}` : "Add a site";
    saveBtn.textContent = site ? "Save" : "Add site";
    fields.host.input.value = site?.host ?? prefill.host ?? "";
    fields.name.input.value = site && site.name !== site.host ? site.name : "";
    fields.chapterPattern.input.value = site?.chapterPattern ?? "";
    fields.seriesPattern.input.value = site?.seriesPattern ?? "";
    testInput.value = prefill.testUrl ?? "";
    clearErrors();
    form.hidden = false;
    updateTest();
    // A prefilled address (from the popup) leaves the patterns to fill in.
    (prefill.host && !site ? fields.chapterPattern.input : fields.host.input).focus();
    form.scrollIntoView({ block: "nearest" });
  }

  function closeForm({ restoreFocus = true } = {}) {
    form.hidden = true;
    editingId = null;
    clearErrors();
    if (!restoreFocus) return;
    const target = returnFocus?.isConnected && !returnFocus.closest("[hidden]") ? returnFocus : addOpen;
    target.focus();
  }

  function values() {
    return Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.input.value]));
  }

  function clearErrors() {
    for (const f of Object.values(fields)) {
      f.error.textContent = "";
      f.input.removeAttribute("aria-invalid");
    }
  }

  function showError(field, message) {
    clearErrors();
    const f = fields[field] || fields.host;
    f.error.textContent = message;
    f.input.setAttribute("aria-invalid", "true");
    f.input.focus();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    try {
      const wasEditing = editingId;
      let result;
      try {
        result = await saveCustomSite(values(), { editingId });
      } catch (err) {
        result = { ok: false, field: "host", error: `Couldn't save the site: ${err?.message || err}` };
      }
      if (!result.ok) {
        showError(result.field, result.error);
        return;
      }
      closeForm({ restoreFocus: false });
      await refresh();
      // Focus the saved site's Edit button, so you land on what you changed.
      (siteButton(result.site.id) || addOpen).focus();
      showToast(wasEditing ? `Saved ${result.site.name}` : `Added ${result.site.name}`);
    } finally {
      saveBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener("click", () => closeForm());
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeForm();
    }
  });
  addOpen.addEventListener("click", () => openForm());
  for (const f of Object.values(fields)) {
    f.input.addEventListener("input", () => {
      f.error.textContent = "";
      f.input.removeAttribute("aria-invalid");
      updateTest();
    });
  }
  testInput.addEventListener("input", updateTest);

  // --- Live address test -----------------------------------------------------

  function updateTest() {
    const { text, match } = testOutcome(testInput.value.trim());
    testResult.textContent = text;
    testResult.classList.toggle("is-match", match);
  }

  function testOutcome(url) {
    if (form.hidden || !url) return { text: "", match: false };
    const checked = validateSiteDef(values(), custom, { editingId });
    if (!checked.ok) return { text: `Can't test yet: ${checked.error}`, match: false };
    const site = compileSite(checked.site);
    const host = hostOf(url);
    if (!site || !host) return { text: "That isn't a web address.", match: false };
    const onSite = host === site.host || host.endsWith("." + site.host);
    if (!onSite) return { text: `That address isn't on ${site.host}.`, match: false };
    const chapter = parseChapterUrl(url, [site]);
    if (chapter) {
      return { text: `Chapter page: ${chapter.title}, chapter ${chapter.chapter}.`, match: true };
    }
    const series = parseSeriesUrl(url, [site]);
    if (series) return { text: `Series page: ${series.title}, saved as Plan to read.`, match: true };
    return { text: "That address is on the site, but matches neither pattern.", match: false };
  }

  // --- "Add this site" from the popup ----------------------------------------

  async function takePendingAdd() {
    const data = await chrome.storage.local.get(PENDING_SITE_ADD_KEY);
    const request = data?.[PENDING_SITE_ADD_KEY];
    if (!request) return;
    await chrome.storage.local.remove(PENDING_SITE_ADD_KEY);
    if (typeof request.host !== "string" || !(Date.now() - request.at < PENDING_ADD_MAX_AGE_MS)) return;
    show();
    await refresh();
    openForm(null, {
      host: request.host,
      testUrl: typeof request.url === "string" ? request.url : "",
    });
  }

  return { refresh, takePendingAdd };
}
