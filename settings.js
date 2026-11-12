// settings.js
// The settings store: a small wrapper over chrome.storage.sync, so settings
// follow you between your Chrome browsers (no Supabase table needed). v1 holds
// one setting, the sites you've added yourself. See docs/custom-sites-plan.md.
//
// The validation below is pure (no chrome.*), so it's unit-tested in Node.

import { BUILTIN_SITES, compilePattern, siteCovers } from "./parser.js";

export const MAX_CUSTOM_SITES = 25;
const MAX_NAME_LENGTH = 40;
const SETTINGS_LOCK = "shiori-settings";

// --- Validation (pure) -------------------------------------------------------

// What someone types as a host ("https://www.Example.com/manga/x", "example.com")
// as a stored host ("example.com"), or null if it isn't one.
export function normalizeHost(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null; // needs a dot, no oddities
  return host;
}

// A custom site's id is the plain host it was first added with. It must never
// be, or fall under, a built-in site's id or domains: records are keyed
// "<site id>:<slug>", so a custom site claiming "mangaread.org" would save over
// your MangaRead series (Codex review). Checked on every stored definition,
// since one can arrive from another browser through Chrome sync.
export function isUsableSiteId(id) {
  return (
    typeof id === "string" &&
    normalizeHost(id) === id &&
    !BUILTIN_SITES.some((site) => site.id === id || siteCovers(site, id))
  );
}

function hostOverlaps(a, b) {
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

// Check a site from the Settings form against the sites already saved.
// `input` is { host, name, chapterPattern, seriesPattern }; `existing` is the
// stored custom list; `editingId` is the id of the site being edited, if any.
// Returns { ok: true, site } with the definition to store, or
// { ok: false, field, error } naming the form field at fault.
export function validateSiteDef(input, existing = [], { editingId = null } = {}) {
  const others = (Array.isArray(existing) ? existing : []).filter((s) => s && s.id !== editingId);
  const editing = editingId ? existing.find((s) => s && s.id === editingId) : null;
  if (editingId && !editing) return { ok: false, field: "host", error: "That site was removed." };

  const host = normalizeHost(input?.host);
  if (!host) return { ok: false, field: "host", error: "Enter the site's address, like example.com." };
  const builtin = BUILTIN_SITES.find((site) => siteCovers(site, host));
  if (builtin) {
    return { ok: false, field: "host", error: `${builtin.name} is already built in.` };
  }
  const clash = others.find((s) => hostOverlaps(host, s.host));
  if (clash) return { ok: false, field: "host", error: `You've already added ${clash.host}.` };

  // A new site's id is its host, fixed from then on; an edit keeps its id.
  const id = editing ? editing.id : host;
  if (!isUsableSiteId(id)) {
    return { ok: false, field: "host", error: "That site can't be saved: its id is reserved or invalid." };
  }
  if (!editing && others.some((s) => s.id === id)) {
    return {
      ok: false,
      field: "host",
      error: `${host} was the first address of a site you've added. Edit that site instead.`,
    };
  }
  if (!editing && others.length >= MAX_CUSTOM_SITES) {
    return { ok: false, field: "host", error: `You can add up to ${MAX_CUSTOM_SITES} sites.` };
  }

  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, field: "name", error: `Keep the name under ${MAX_NAME_LENGTH} characters.` };
  }

  const chapter = compilePattern(input?.chapterPattern, "chapter");
  if (!chapter.ok) return { ok: false, field: "chapterPattern", error: chapter.error };
  const series = compilePattern(input?.seriesPattern, "series");
  if (!series.ok) return { ok: false, field: "seriesPattern", error: series.error };

  return {
    ok: true,
    site: {
      id,
      host,
      name: name || host,
      chapterPattern: chapter.source,
      seriesPattern: series.source,
    },
  };
}

// The stored list as it should be used: entries that still validate on their
// own, without duplicates, in order. Stored settings can come from another
// browser through Chrome sync (an older or newer version), so nothing in them
// is trusted.
export function cleanCustomSites(stored) {
  const out = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) continue;
    if (out.length >= MAX_CUSTOM_SITES) break;
    // Validate as if editing a site with this id that's already in `out`'s
    // place, so the id is kept and only the others are checked for clashes.
    const result = validateSiteDef(entry, [...out, entry], { editingId: entry.id });
    if (result.ok && !out.some((s) => s.id === entry.id)) out.push(result.site);
  }
  return out;
}

// --- chrome.storage.sync -----------------------------------------------------
//
// Each site is its own item, "site:<id>" -> { ...definition, addedAt }. Chrome
// limits a synced item to 8 KB, which one list of sites outgrows at around 17;
// one item per site stays far under it (Codex review). addedAt keeps the order.

export const SITE_KEY_PREFIX = "site:";
const siteKey = (id) => SITE_KEY_PREFIX + id;

// chrome.storage.sync, or local storage where sync isn't available.
function area() {
  return chrome.storage.sync || chrome.storage.local;
}

function withSettingsLock(fn) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(SETTINGS_LOCK, () => fn()) : fn();
}

// The stored items (everything under "site:") as the ordered list
// cleanCustomSites expects. An item whose key doesn't match its id is ignored.
export function storedSiteList(items) {
  const entries = [];
  for (const [key, value] of Object.entries(items || {})) {
    if (!key.startsWith(SITE_KEY_PREFIX) || !value || typeof value !== "object") continue;
    // Type-check before building the key: a non-string id (say, an object
    // with no usable toString) would throw and hide every site (Codex review).
    if (typeof value.id !== "string" || key !== siteKey(value.id)) continue;
    entries.push(value);
  }
  const at = (v) => (typeof v.addedAt === "number" && Number.isFinite(v.addedAt) ? v.addedAt : 0);
  return entries.sort((a, b) => at(a) - at(b) || String(a.id).localeCompare(String(b.id)));
}

// The sites you've added, cleaned, in the order added. Each carries addedAt.
export async function getCustomSites() {
  const items = await area().get(null);
  const list = storedSiteList(items);
  const addedAt = new Map(list.map((v) => [v.id, v.addedAt]));
  return cleanCustomSites(list).map((site) => ({ ...site, addedAt: addedAt.get(site.id) ?? 0 }));
}

async function writeSite(site, addedAt) {
  try {
    await area().set({ [siteKey(site.id)]: { ...site, addedAt } });
    return null;
  } catch (err) {
    return { ok: false, field: "host", error: `Chrome couldn't save the site: ${err?.message || err}` };
  }
}

// Add a site (no editingId) or change one. Returns validateSiteDef's result,
// or a failure if Chrome refused the write.
export function saveCustomSite(input, { editingId = null } = {}) {
  return withSettingsLock(async () => {
    const current = await getCustomSites();
    const result = validateSiteDef(input, current, { editingId });
    if (!result.ok) return result;
    const previous = editingId ? current.find((s) => s.id === editingId) : null;
    const failed = await writeSite(result.site, previous ? previous.addedAt : Date.now());
    return failed || result;
  });
}

// Remove a site. Its series stay in the library. Returns the definition as it
// was stored at that moment (for Undo), or null if it was already gone.
export function removeCustomSite(id) {
  return withSettingsLock(async () => {
    const current = await getCustomSites();
    const removed = current.find((s) => s.id === id) || null;
    await area().remove(siteKey(id));
    return removed;
  });
}

// Put back a site exactly as it was (Undo after Remove), id and place
// included, so the series saved from it are attached again. Refused if it no
// longer fits (say, its address was added again in the meantime).
export function restoreCustomSite(def) {
  return withSettingsLock(async () => {
    const current = await getCustomSites();
    if (current.some((s) => s.id === def?.id)) return { ok: false, error: "That site is already back." };
    if (current.length >= MAX_CUSTOM_SITES) {
      return { ok: false, error: `You can add up to ${MAX_CUSTOM_SITES} sites.` };
    }
    const result = validateSiteDef(def, [...current, def], { editingId: def?.id });
    if (!result.ok) return result;
    const failed = await writeSite(result.site, typeof def.addedAt === "number" ? def.addedAt : Date.now());
    return failed || result;
  });
}

// Call `listener` when the custom sites change, here or in another browser.
export function onCustomSitesChanged(listener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const ours = chrome.storage.sync ? "sync" : "local";
    if (areaName === ours && Object.keys(changes).some((k) => k.startsWith(SITE_KEY_PREFIX))) listener();
  });
}
