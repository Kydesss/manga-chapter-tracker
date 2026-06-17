# Google Sign-In Setup (Milestone 1 auth spike)

These are the one-time steps only you can do, because they use your Google and Supabase accounts. The code and the Supabase project/table are already done. After this, sign-in works.

Your fixed values (already wired into the code):

- **Extension ID:** `oelpohodhpkilfbdijlmopejppdafige`
- **OAuth redirect URI:** `https://oelpohodhpkilfbdijlmopejppdafige.chromiumapp.org/`
- **Supabase project URL:** `https://fohkznuvisjohcuzelca.supabase.co`

The extension ID is fixed by the `key` in `manifest.json`, so it stays the same every time you load it. That is what lets the redirect URI below stay valid.

## 1. Load the extension and confirm the ID

1. Go to `chrome://extensions`, enable Developer mode, Load unpacked, and select the `manga-chapter-tracker` folder (if not already loaded; otherwise click reload).
2. On the extension card, confirm the **ID is exactly** `oelpohodhpkilfbdijlmopejppdafige`. If it differs, the `key` did not load, so stop and tell me.

## 2. Create the Google OAuth client

1. Open the Google Cloud Console at https://console.cloud.google.com and create a project (or pick one).
2. Go to **APIs & Services > OAuth consent screen**:
   - User type **External**.
   - Fill app name, your support email, and developer contact email.
   - Add the scopes `openid`, `email`, `profile`.
   - While the app is in **Testing**, add your Google account (`jpop0393@gmail.com`) under **Test users**. Only test users can sign in until the app is verified.
3. Go to **APIs & Services > Credentials > Create credentials > OAuth client ID**:
   - Application type: **Web application**.
   - Under **Authorized redirect URIs**, add both of these (to be safe with or without the trailing slash):
     - `https://oelpohodhpkilfbdijlmopejppdafige.chromiumapp.org/`
     - `https://oelpohodhpkilfbdijlmopejppdafige.chromiumapp.org`
   - Create, then **copy the Client ID** (looks like `1234567890-abc.apps.googleusercontent.com`).

## 3. Put the Client ID in the code

Open `config.js` and replace the placeholder:

```js
export const GOOGLE_CLIENT_ID = "PASTE_YOUR_GOOGLE_CLIENT_ID_HERE";
```

with your real Client ID.

## 4. Enable Google in Supabase

1. Open the Google provider page:
   https://supabase.com/dashboard/project/fohkznuvisjohcuzelca/auth/providers
2. Expand **Google**, toggle it **on**.
3. Paste your Google **Client ID** into the **Client IDs** field (the list used for ID-token / native sign-in). You can leave the Client Secret blank for this flow.
4. Save.

## 5. Test the spike

1. Back at `chrome://extensions`, click reload on the extension card.
2. Open the popup and click **Sign in** (bottom-left).
3. A Google account chooser opens. Pick your account and approve.
4. The footer should change to **Signed in: your@email**. Click **Sign out** to confirm that path too.

## If it fails

Tell me the exact message from the popup (it surfaces auth errors as a toast). Common ones:

- `redirect_uri_mismatch` from Google: the redirect URI in step 2 does not exactly match. Re-check both entries.
- `Supabase token exchange failed`: the Client ID is not yet registered on the Supabase Google provider (step 4), or not saved.
- Nothing happens / `Authorization page could not be loaded`: the `GOOGLE_CLIENT_ID` in `config.js` is still the placeholder, or the consent screen is not configured.

Once sign-in works, Milestone 1 is done and we can build the sync engine (Milestone 5) on top of it.
