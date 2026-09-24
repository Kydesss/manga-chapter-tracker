import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../manifest.json", import.meta.url);
const imageRulesUrl = new URL("../rules/natomanga-image-referer.json", import.meta.url);

test("NatoManga cover hosts receive the referrer required by anti-hotlinking", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const rules = JSON.parse(await readFile(imageRulesUrl, "utf8"));

  assert.ok(manifest.permissions.includes("declarativeNetRequestWithHostAccess"));
  assert.ok(manifest.host_permissions.includes("https://*.2xstorage.com/*"));
  assert.deepEqual(manifest.declarative_net_request.rule_resources, [
    {
      id: "natomanga_image_referer",
      enabled: true,
      path: "rules/natomanga-image-referer.json",
    },
  ]);

  assert.equal(rules.length, 1);
  assert.equal(rules[0].condition.urlFilter, "||2xstorage.com/thumb/");
  assert.deepEqual(rules[0].condition.resourceTypes, ["image"]);
  assert.deepEqual(rules[0].action.requestHeaders, [
    {
      header: "Referer",
      operation: "set",
      value: "https://www.natomanga.com/",
    },
  ]);
});
