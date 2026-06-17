// auth.js
// Google sign-in for a Manifest V3 extension, exchanged for a Supabase session.
//
// Why launchWebAuthFlow and not getAuthToken: Supabase's id_token grant needs a
// Google ID token (a JWT). chrome.identity.getAuthToken returns an OAuth access
// token, which is the wrong type. launchWebAuthFlow lets us request
// response_type=id_token directly and read it back from the redirect fragment.

import { SUPABASE_URL, SUPABASE_KEY, GOOGLE_CLIENT_ID } from "./config.js";

const SESSION_KEY = "supabase_session";

// --- Public API -----------------------------------------------------------

// Returns the stored session ({ access_token, refresh_token, user, ... }) or null.
export async function getSession() {
  const r = await chrome.storage.local.get(SESSION_KEY);
  return r[SESSION_KEY] || null;
}

export function getUserEmail(session) {
  return session?.user?.email || null;
}

// Runs the full interactive sign-in. Must be called from a user gesture
// (e.g. a button click in the popup). Returns the session on success.
export async function signInWithGoogle() {
  if (GOOGLE_CLIENT_ID.startsWith("PASTE_")) {
    throw new Error("Google client id not set. See GOOGLE-SETUP.md.");
  }

  const redirectUri = chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/

  const authUrl = new URL("https://accounts.google.com/o/oauth2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("response_type", "id_token");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("prompt", "select_account");

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  // Google returns the token in the URL fragment: #id_token=...&...
  // Strip the leading '#' before parsing.
  const fragment = new URL(responseUrl).hash.substring(1);
  const idToken = new URLSearchParams(fragment).get("id_token");
  if (!idToken) throw new Error("Google did not return an id_token.");

  const session = await exchangeIdToken(idToken);
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

// Clears the session locally and best-effort revokes it server-side.
export async function signOut() {
  const session = await getSession();
  if (session?.access_token) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
      });
    } catch {
      // Ignore network errors on logout; we still clear locally.
    }
  }
  await chrome.storage.local.remove(SESSION_KEY);
}

// Refreshes an expired access token using the refresh token. Returns the new
// session, or null if refresh fails (caller should then treat as signed out).
export async function refreshSession() {
  const session = await getSession();
  if (!session?.refresh_token) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      }
    );
    if (!res.ok) return null;
    const next = await res.json();
    await chrome.storage.local.set({ [SESSION_KEY]: next });
    return next;
  } catch {
    return null;
  }
}

// --- Internals ------------------------------------------------------------

// Exchange a Google ID token for a Supabase session via the GoTrue REST API.
// This is the REST equivalent of supabase.auth.signInWithIdToken.
async function exchangeIdToken(idToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=id_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify({ provider: "google", id_token: idToken }),
  });
  if (!res.ok) {
    throw new Error(
      `Supabase token exchange failed (${res.status}): ${await res.text()}`
    );
  }
  return res.json();
}
