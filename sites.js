// sites.js
// Every site Shiori recognizes right now: the built-ins plus the ones you've
// added in Settings, ready to hand to the parser (parsePageUrl(url, sites)).

import { BUILTIN_SITES, withCustomSites } from "./parser.js";
import { getCustomSites } from "./settings.js";

// Never throws: if the settings can't be read, the built-ins still work.
export async function getSites() {
  try {
    return withCustomSites(await getCustomSites());
  } catch {
    return BUILTIN_SITES;
  }
}

// { siteId: display name } for the library's labels. The cloud doesn't store
// site names, so the current definitions are the source of truth.
export function siteNames(sites) {
  return Object.fromEntries(sites.map((s) => [s.id, s.name]));
}
