// bookmarks.js
// Turns Chrome's bookmark tree into series records for bulkUpsert. Pure: no
// chrome APIs here (the library page reads the tree and hands it in), so the
// walk is unit-tested in Node. See docs/bookmark-import-plan.md.

import { parseChapterUrl, parseSeriesUrl } from "./parser.js";

// Walk a tree from chrome.bookmarks.getTree() (an array of root nodes).
// Returns:
//   records     - one per bookmark on a supported chapter or series page
//   scanned     - bookmarks with a link (folders and separators don't count)
//   unsupported - of those, how many aren't a supported page
// `now` (ms) caps bookmark dates: a date in the future (a skewed clock) is
// treated as now.
export function collectBookmarks(tree, { now = Date.now() } = {}) {
  const records = [];
  let scanned = 0;
  let unsupported = 0;

  const stack = Array.isArray(tree) ? [...tree] : tree ? [tree] : [];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    // One at a time: spreading a huge folder into push() overflows the stack.
    if (Array.isArray(node.children)) for (const child of node.children) stack.push(child);
    if (typeof node.url !== "string") continue; // a folder
    scanned++;
    const record = bookmarkRecord(node, now);
    if (record) records.push(record);
    else unsupported++;
  }
  return { records, scanned, unsupported };
}

// A supported chapter bookmark is reading progress; a series bookmark is Plan
// to read. The parsers stamp "now" as the read time (right for a popup save,
// wrong for an import), so the times are replaced with what the bookmark
// itself says.
function bookmarkRecord(node, now) {
  const chapter = parseChapterUrl(node.url);
  if (chapter) {
    const at = bookmarkTime(node, now);
    // When you were at this chapter, as far as Chrome knows: shown as the last
    // read time, and used as the chapter's set time against resets.
    return { ...chapter, lastReadAt: at, progressAt: at };
  }
  const series = parseSeriesUrl(node.url);
  if (series) return { ...series, lastReadAt: null, progressAt: null };
  return null;
}

// The later of when the bookmark was added and last opened, no later than
// `now`, as an ISO string; null if Chrome recorded neither.
function bookmarkTime(node, now) {
  const times = [node.dateAdded, node.dateLastUsed].filter(
    (t) => typeof t === "number" && Number.isFinite(t) && t > 0
  );
  if (!times.length) return null;
  return new Date(Math.min(Math.max(...times), now)).toISOString();
}
