// Mock chrome.storage.local then exercise importRecords from storage.js
let store = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => ({ [k]: store[k] }),
  set: async (o) => { Object.assign(store, o); },
}}};
const { importRecords, getAll } = await import("./storage.js");
// seed existing
store.series = { "s:a": { id:"s:a", chapter:"10", updatedAt:"2026-06-01T00:00:00Z", createdAt:"2026-05-01T00:00:00Z" } };
const incoming = [
  { id:"s:a", chapter:"12", updatedAt:"2026-06-10T00:00:00Z" }, // newer -> update
  { id:"s:a", chapter:"5",  updatedAt:"2026-05-01T00:00:00Z" }, // older -> skip (but processed after, still older than stored 06-10)
  { id:"s:b", chapter:"3",  updatedAt:"2026-06-09T00:00:00Z" }, // new -> add
  { chapter:"bad" },                                            // invalid -> skip
];
const res = await importRecords(incoming);
console.log("summary", res);
const all = await getAll();
console.log("a.chapter =", all.find(r=>r.id==="s:a").chapter, "(expect 12)");
console.log("a.createdAt =", all.find(r=>r.id==="s:a").createdAt, "(expect original 2026-05-01)");
console.log("b present =", !!all.find(r=>r.id==="s:b"), "(expect true)");
