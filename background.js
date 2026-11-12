// background.js
// Service worker. It runs Google sign-in, which must outlive the popup.
//
// Why this exists: chrome.identity.launchWebAuthFlow opens a separate auth
// window, which takes focus and causes Chrome to close the extension popup. If
// the flow is run from the popup, the popup's JavaScript is destroyed mid-flow
// and the session is never stored. Running it here, in the service worker, keeps
// the flow alive regardless of the popup, and the session is stored before we
// respond. The popup just sends a message and reads the result.

import { signInWithGoogle, signOut } from "./auth.js";

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
