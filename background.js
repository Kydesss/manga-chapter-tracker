// background.js
// Service worker. It runs Google sign-in, which must outlive the popup, and
// the "save the chapter you're on" keyboard shortcut.
//
// Why this exists: chrome.identity.launchWebAuthFlow opens a separate auth
// window, which takes focus and causes Chrome to close the extension popup. If
// the flow is run from the popup, the popup's JavaScript is destroyed mid-flow
// and the session is never stored. Running it here, in the service worker, keeps
// the flow alive regardless of the popup, and the session is stored before we
// respond. The popup just sends a message and reads the result.

import { signInWithGoogle, signOut } from "./auth.js";
import { parsePageUrl } from "./parser.js";
import { getSites } from "./sites.js";
import { migrate, saveIfAllowed } from "./storage.js";
import { syncNow } from "./sync.js";
import { shortcutSaveDecision } from "./view.js";

// The removed NatoManga bookmark import kept its progress under this key.
const LEGACY_IMPORT_JOB_KEY = "natomangaImportJob";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(LEGACY_IMPORT_JOB_KEY).catch(() => {});
});

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
  return false;
});

// --- Keyboard shortcut: save the chapter you're on -------------------------
//
// Bound to "save-chapter" in the manifest (Alt+Shift+S by default; people can
// change it at chrome://extensions/shortcuts). Pressing it grants activeTab
// for the current tab, so its URL is readable. The result shows on the
// toolbar icon for a few seconds: a badge, and the tooltip says what happened.

const BADGE_MS = 4000;
const DEFAULT_TITLE = "Shiori";
const OK = "#16a34a"; // green
const WARN = "#d97706"; // amber
const IDLE = "#64748b"; // slate

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "save-chapter") return;
  saveFromShortcut(tab).catch((err) =>
    flag(tab?.id, "!", `Shiori couldn't save: ${err?.message || err}`, WARN)
  );
});

async function saveFromShortcut(tab) {
  if (!tab?.id) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  const pending = tab.url ? parsePageUrl(tab.url, await getSites()) : null;
  if (!pending) {
    flag(tab.id, "–", "Not a chapter or series page on a supported site", IDLE);
    return;
  }
  await migrate();
  // The decision is made against the series as it is under the storage lock,
  // and the save happens in the same step.
  const { action, saved, existing } = await saveIfAllowed(
    { ...pending, updatedAt: new Date().toISOString() },
    shortcutSaveDecision
  );
  const title = saved?.title || existing?.title || pending.title;

  switch (action) {
    case "save": {
      flag(
        tab.id,
        "✓",
        saved.chapter == null ? `Added ${title} to Plan to read` : `Saved ${title}, chapter ${saved.chapter}`,
        OK
      );
      syncNow().catch(() => {}); // push it if signed in; errors show in the popup
      return;
    }
    case "moves-back":
      flag(
        tab.id,
        "!",
        `Not saved: chapter ${pending.chapter} is earlier than your saved chapter ${existing.chapter}. Open Shiori to move back.`,
        WARN
      );
      return;
    case "already-reading":
      flag(tab.id, "✓", `${title} is saved at chapter ${existing.chapter}`, IDLE);
      return;
    case "already-planned":
      flag(tab.id, "✓", `${title} is already in Plan to read`, IDLE);
      return;
    default:
      flag(tab.id, "–", "Not a chapter or series page on a supported site", IDLE);
  }
}

// Show a short result on this tab's toolbar icon, then clear it.
const flagTimers = new Map();
function flag(tabId, text, title, color) {
  if (tabId == null) return;
  clearTimeout(flagTimers.get(tabId));
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setTitle({ tabId, title: `${DEFAULT_TITLE}: ${title}` }).catch(() => {});
  flagTimers.set(
    tabId,
    setTimeout(() => {
      flagTimers.delete(tabId);
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }).catch(() => {});
    }, BADGE_MS)
  );
}
