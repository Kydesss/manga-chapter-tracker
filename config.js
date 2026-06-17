// config.js
// Public configuration for the extension. These values are safe to ship:
// the Supabase publishable key and a Google OAuth client id are designed to be
// client-visible. Data is protected by Supabase row-level security, not by
// hiding these keys. Never put a Supabase service-role key here.

export const SUPABASE_URL = "https://fohkznuvisjohcuzelca.supabase.co";

// Supabase publishable key (preferred over the legacy anon JWT).
export const SUPABASE_KEY = "sb_publishable_WnI_vlzGAZWbFKqAMu9Pbw_R50KWMXl";

// Google OAuth 2.0 Web client id. FILL THIS IN after creating the OAuth client
// (see GOOGLE-SETUP.md). It looks like: 1234567890-abc123.apps.googleusercontent.com
export const GOOGLE_CLIENT_ID =
    "136049255836-2kdqm5lic6ad4etlilmm8m0s2ipbass9.apps.googleusercontent.com";
