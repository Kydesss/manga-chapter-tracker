// Run explicitly with node scripts/check-sync-ui.mjs. Uses an isolated Chrome
// profile and mocked extension APIs; never opens the user's browser profile.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseChapterUrl } from "../parser.js";

const root = resolve(import.meta.dirname, "..");
const profile = await mkdtemp(join(tmpdir(), "shiori-sync-ui-"));
const server = createServer(async (req, res) => {
  const path = resolve(root, `.${new URL(req.url, "http://localhost").pathname}`);
  if (!path.startsWith(root + "/") && !path.startsWith(root + "\\")) { res.writeHead(403).end(); return; }
  try {
    res.setHeader("Content-Type", ({ ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml" })[extname(path)] || "application/octet-stream");
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(Error("Chrome startup timed out")), 15000);
    chrome.on("error", reject);
    chrome.stderr.on("data", chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, "open");
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") console.error(JSON.stringify(message.params.exceptionDetails));
    if (!message.id) return;
    const pair = pending.get(message.id);
    pending.delete(message.id);
    message.error ? pair.reject(Error(JSON.stringify(message.error))) : pair.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error(`Timed out: ${expression}; focus: ${await evaluate('document.activeElement?.outerHTML.slice(0, 300)')}; page: ${await evaluate('document.body?.innerText')}`);
  };
  const record = { ...parseChapterUrl("https://www.manganami.com/manga/blue-lock/chapter-40"), createdAt: "2026-01-01T00:00:00.000Z", dirty: false };
  const source = `
    window.fixture = ${JSON.stringify({ schemaVersion: 7, series: { [record.id]: record } })};
    Object.assign(window.chrome, {
      storage: {
        local: {
          async get(keys) { return structuredClone(typeof keys === 'string' ? { [keys]: fixture[keys] } : fixture); },
          async set(values) { Object.assign(fixture, structuredClone(values)); },
          async remove(key) { delete fixture[key]; }
        },
        sync: { async get() { return {}; } },
        onChanged: { addListener() {} }
      },
      tabs: { async query() { return [{ id: 1, url: 'https://www.manganami.com/manga/blue-lock/chapter-45' }]; }, async create() {} },
      runtime: { async openOptionsPage() {} }
    });
    window.testInput = value => { const input = document.querySelector('#chapterInput'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  `;
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: origin + "/library.html" });
  await waitFor(`!!document.querySelector('[data-action="set"]')`);
  await evaluate(`document.querySelector('[data-action="set"]').click()`);
  assert.equal(await evaluate(`document.activeElement.id`), "chapterInput");
  await evaluate(`testInput('3')`);
  assert.equal(await evaluate(`document.querySelector('#chapterSave').textContent`), "Move back to 3");
  assert.equal(await evaluate(`document.querySelector('#chapterDialog').getBoundingClientRect().right <= innerWidth`), true);
  await evaluate(`document.querySelector('#chapterSave').click()`);
  await waitFor(`!document.querySelector('#chapterDialog').open`);
  await waitFor(`document.querySelector('#toastText').textContent.includes('moved back to chapter 3')`);
  assert.equal(await evaluate(`fixture.series[${JSON.stringify(record.id)}].chapter`), "3");
  assert.equal(await evaluate(`fixture.series[${JSON.stringify(record.id)}].progressAt === fixture.series[${JSON.stringify(record.id)}].progressResetAt`), true);
  await evaluate(`document.querySelector('[data-action="set"]').click(); testInput('5'); fixture.series[${JSON.stringify(record.id)}].chapter = '60'`);
  await evaluate(`document.querySelector('#chapterSave').click()`);
  await waitFor(`document.querySelector('#chapterCurrent').textContent.includes('changed meanwhile')`);
  assert.equal(await evaluate(`fixture.series[${JSON.stringify(record.id)}].chapter`), "60");
  assert.equal(await evaluate(`document.querySelector('#chapterSave').textContent`), "Move back to 5");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector('#chapterDialog').open`);
  await waitFor(`document.activeElement.dataset.action === 'set'`);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await evaluate(`document.querySelector('[data-action="set"]').click(); testInput('5'); fixture.libraryEpoch = 'another-account'; document.querySelector('#chapterSave').click()`);
  await waitFor(`document.querySelector('#toastText').textContent.includes('library changed')`);
  assert.equal(await evaluate(`fixture.series[${JSON.stringify(record.id)}].chapter`), "60");
  await waitFor(`!document.querySelector('#chapterDialog').open`);
  await cdp("Page.navigate", { url: origin + "/popup.html" });
  await waitFor(`!!document.querySelector('#saveBtn') && !document.querySelector('#saveBtn').disabled`);
  await evaluate(`fixture.series[${JSON.stringify(record.id)}].chapter = '50'; document.querySelector('#saveBtn').click()`);
  await waitFor(`document.querySelector('#toastText').textContent.includes('changed while')`);
  assert.equal(await evaluate(`fixture.series[${JSON.stringify(record.id)}].chapter`), "50");
  await waitFor(`document.body.innerText.includes('Saved: chapter 50. This would move you back to 45.')`);
  await evaluate(`fixture.libraryEpoch = 'another-account'; document.querySelector('#saveBtn').click()`);
  await waitFor(`document.querySelector('#toastText').textContent.includes('switched accounts')`);
  assert.equal(await evaluate(`fixture.series[${JSON.stringify(record.id)}].chapter`), "50");
  console.log("Browser checks passed: narrow/light and desktop/dark dialog, focus, move back/reset, same-timestamp conflict, Esc, stale popup redraw, account switches.");
} finally {
  socket?.close();
  server.close();
  if (chrome.exitCode === null && chrome.pid) {
    const exited = once(chrome, "exit");
    chrome.kill();
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
