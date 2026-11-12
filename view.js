// view.js
// Pure view logic shared by the popup and the library page: filtering,
// sorting, summary counts, and small display helpers. No chrome.*, no DOM
// state, so it's unit-tested directly (tests/view.test.js).

// Stored records are partly untrusted: a JSON import only validates the
// required fields, so optional ones (siteName, createdAt, lastReadAt) can be
// any type. These helpers treat a non-string as missing instead of throwing,
// so one malformed record can't stop the library from rendering.
const text = (v) => (typeof v === "string" ? v : "");
const isoOrEmpty = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : "");

// The site name to show for a record. `names` ({ siteId: name }, from
// sites.js) wins when given: the cloud doesn't store site names, so a pulled
// record may only carry its id, and renaming a site you added should rename
// every row. Then its stored name, then its site id. Never interpolate
// r.siteName directly; it may be any type.
export function siteLabel(record, names = null) {
  return text(names?.[record?.site]) || text(record?.siteName) || text(record?.site);
}

// Where the popup leaves an "Add this site" request ({ host, url, at }) for the
// library page's Settings to pick up (chrome.storage.local).
export const PENDING_SITE_ADD_KEY = "pendingSiteAdd";

// A series with no chapter is Plan to read; anything with one is reading.
export function isPlan(record) {
  return record.chapter == null || record.chapter === "";
}

// Filter by status ("all" | "reading" | "plan"), site id ("all" or an id), and
// a case-insensitive title search. Tombstones never show.
export function filterSeries(records, { query = "", status = "all", site = "all" } = {}) {
  const q = query.trim().toLowerCase();
  return records.filter((r) => {
    if (r.deleted) return false;
    if (status === "plan" && !isPlan(r)) return false;
    if (status === "reading" && isPlan(r)) return false;
    if (site !== "all" && r.site !== site) return false;
    if (q && !text(r.title).toLowerCase().includes(q)) return false;
    return true;
  });
}

const byTitle = (a, b) => text(a.title).localeCompare(text(b.title));

// Sort a copy: "recent" (last read first), "title" (A-Z), or "added" (newest
// first). Series with no known read time (plan to read, or imported without
// one) follow the read ones alphabetically, instead of an import's timestamp
// pushing them to the top.
export function sortSeries(records, sort = "recent") {
  const list = records.slice();
  if (sort === "title") return list.sort(byTitle);
  if (sort === "added") {
    return list.sort(
      (a, b) => isoOrEmpty(b.createdAt).localeCompare(isoOrEmpty(a.createdAt)) || byTitle(a, b)
    );
  }
  return list.sort(
    (a, b) => isoOrEmpty(b.lastReadAt).localeCompare(isoOrEmpty(a.lastReadAt)) || byTitle(a, b)
  );
}

export function viewSeries(records, { query, status, site, sort } = {}) {
  return sortSeries(filterSeries(records, { query, status, site }), sort);
}

// Counts for the summary line. Tombstones don't count.
export function summarize(records) {
  let reading = 0;
  let plan = 0;
  for (const r of records) {
    if (r.deleted) continue;
    if (isPlan(r)) plan++;
    else reading++;
  }
  return { total: reading + plan, reading, plan };
}

// The sites present in the library, for the site filter: [{ id, name }] by
// name. `names` as for siteLabel.
export function sitesIn(records, names = null) {
  const seen = new Map();
  for (const r of records) {
    if (r.deleted || typeof r.site !== "string" || !r.site || seen.has(r.site)) continue;
    seen.set(r.site, siteLabel(r, names));
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// A stored link is untrusted: it can come from a hand-edited JSON import or
// another device, and older records may not have one at all. Only ever hand an
// http(s) URL to the tabs API.
export function safeUrl(raw) {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// Compare two chapter labels ("83.2", "246") numerically. Returns -1/0/1, or
// NaN when the labels aren't numerically comparable.
export function compareChapters(a, b) {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a === b ? 0 : NaN;
  return Math.sign(na - nb);
}

// Compact relative time for the "last read" line, e.g. "just now", "3d ago".
export function relativeTime(iso, now = Date.now()) {
  if (typeof iso !== "string" || !iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  if (d < 365) return `${Math.max(1, Math.floor(d / 30))}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// Orders the results of overlapping async requests (sync passes) so that only
// the newest one shows. begin() numbers a request; end() marks it finished.
// A result may be shown (accept) only if no newer request is still running and
// no newer result was already shown; shown() records that it was.
export function createResultGate() {
  const pending = new Set();
  let last = 0;
  let applied = 0;
  return {
    begin() {
      const seq = ++last;
      pending.add(seq);
      return seq;
    },
    end(seq) {
      pending.delete(seq);
    },
    accept(seq) {
      return seq >= applied && ![...pending].some((p) => p > seq);
    },
    shown(seq) {
      applied = Math.max(applied, seq);
    },
    idle() {
      return pending.size === 0;
    },
  };
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// What the "save the chapter you're on" keyboard shortcut does with a page,
// given what's saved for that series. It mirrors the popup's save button,
// except that it never moves a series back: the popup warns and asks first
// for that, and a shortcut has no way to ask.
//   pending  - parsePageUrl's record for the tab, or null (not a supported page)
//   existing - the saved series (getOne: null if not saved or removed)
// Returns { action }: "save", "moves-back", "already-reading" (a series page
// for a series you're reading), "already-planned", or "unsupported".
export function shortcutSaveDecision(pending, existing) {
  if (!pending) return { action: "unsupported" };
  if (pending.chapter == null) {
    if (existing && existing.chapter != null) return { action: "already-reading" };
    if (existing) return { action: "already-planned" };
    return { action: "save" };
  }
  // NaN (labels that can't be ranked) saves, as the popup's button does.
  if (existing && existing.chapter != null && compareChapters(pending.chapter, existing.chapter) < 0) {
    return { action: "moves-back" };
  }
  return { action: "save" };
}
