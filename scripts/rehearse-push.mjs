// Rehearse the push_series migration on PGlite, on top of the schema v2 table.
// Usage: node rehearse-push.mjs <pglite-dir> <v2.sql> <push.sql>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [pgliteDir, v2Path, pushPath] = process.argv.slice(2);
const { PGlite } = await import(
  pathToFileURL(resolve(pgliteDir, "node_modules/@electric-sql/pglite/dist/index.js")).href
);
const db = await PGlite.create();
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}
const q = (sql, p) => db.query(sql, p);

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  insert into auth.users values ('${A}'), ('${B}');
  create table public.series (
    user_id uuid not null references auth.users (id) on delete cascade,
    id text not null, site text not null, slug text not null, title text not null,
    chapter text not null, chapter_url text not null, series_url text not null,
    created_at timestamptz not null default now(), updated_at timestamptz not null,
    deleted boolean not null default false, primary key (user_id, id));
  alter table public.series enable row level security;
  create policy "own rows: select" on public.series for select using (auth.uid() = user_id);
  create policy "own rows: insert" on public.series for insert with check (auth.uid() = user_id);
  create policy "own rows: update" on public.series for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "own rows: delete" on public.series for delete using (auth.uid() = user_id);
  grant usage on schema public to anon, authenticated;
  grant select, insert, update, delete on public.series to anon, authenticated;
`);
await db.exec(readFileSync(v2Path, "utf8"));
try {
  await db.exec(readFileSync(pushPath, "utf8"));
  check("push_series migration applies cleanly", true);
} catch (e) {
  check("push_series migration applies cleanly", false, e.message);
  process.exit(1);
}

async function asUser(uid) {
  await db.exec(`reset role; set role authenticated`);
  await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
}
const row = (id, chapter, extra = {}) => ({
  id, site: "natomanga.com", slug: id.split(":")[1], title: "T", chapter,
  chapter_url: chapter == null ? null : `https://x.test/${id}/${chapter}`, series_url: "https://x.test/s",
  last_read_at: null, progress_at: null, progress_reset_at: null,
  created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-12T10:00:00.000Z",
  deleted: false, client_schema: 2, base_synced_at: null, ...extra,
});
const push = async (rows) => (await q(`select id, to_json(synced_at) #>> '{}' as synced_at from public.push_series($1::jsonb)`, [JSON.stringify(rows)])).rows;
const get = async (id) => (await q(`select chapter, to_json(synced_at) #>> '{}' as synced_at, created_at from public.series where id = $1`, [id])).rows[0];
const tick = () => new Promise((r) => setTimeout(r, 5));

await asUser(A);
// New row, no base: inserted.
let res = await push([row("n:a", "40")]);
check("new row without a base is inserted", res.length === 1 && res[0].id === "n:a");
const base40 = res[0].synced_at;
check("returns the new synced_at", typeof base40 === "string" && base40 === (await get("n:a")).synced_at);

// Device B pushes 50 with the right base.
await tick();
res = await push([row("n:a", "50", { base_synced_at: base40 })]);
check("update with the current base is accepted", res.length === 1 && (await get("n:a")).chapter === "50");
const base50 = res[0].synced_at;
check("an accepted update moves synced_at forward", base50 > base40);

// Device A, still on base40, pushes 41: rejected, cloud keeps 50.
res = await push([row("n:a", "41", { base_synced_at: base40 })]);
check("update with a stale base is rejected", res.length === 0);
check("the cloud keeps the newer row", (await get("n:a")).chapter === "50");

// No base but the row exists (first sync): rejected.
res = await push([row("n:a", "1")]);
check("no base on an existing row is rejected", res.length === 0 && (await get("n:a")).chapter === "50");

// Base given but row missing (e.g. never reached this account): inserted.
res = await push([row("n:b", "3", { base_synced_at: base40 })]);
check("a base for a missing row inserts it", res.length === 1 && (await get("n:b")).chapter === "3");

// Mixed batch: one accepted, one rejected.
await tick();
res = await push([row("n:a", "51", { base_synced_at: base50 }), row("n:b", "9", { base_synced_at: base40 })]);
check("a mixed batch returns only the accepted rows", res.length === 1 && res[0].id === "n:a");
check("created_at isn't changed by an update", +(await get("n:a")).created_at === +new Date("2026-11-01T00:00:00Z"));

// Plan to read (null chapter + link) and the chapter/link check still apply.
res = await push([row("n:p", null)]);
check("plan-to-read rows are accepted", res.length === 1);
try {
  await push([row("n:bad", "4", { chapter_url: null })]);
  check("a chapter without its link is rejected by the table check", false);
} catch (e) {
  check("a chapter without its link is rejected by the table check", /series_chapter_with_url/.test(e.message), e.message);
}
try {
  await push([row("n:old", "4", { client_schema: 1 })]);
  check("client_schema below 2 still rejected", false);
} catch (e) {
  check("client_schema below 2 still rejected", /client_schema_floor/.test(e.message), e.message);
}
try {
  await q(`select * from public.push_series('{"id":"x"}'::jsonb)`);
  check("a non-array argument is refused", false);
} catch (e) {
  check("a non-array argument is refused", /must be a JSON array/.test(e.message), e.message);
}

// Isolation: B can't touch A's rows through the function, even with A's base.
const aRow = await get("n:a");
await asUser(B);
res = await push([row("n:a", "999", { base_synced_at: aRow.synced_at })]);
check("another user's base creates their own row, never touches A's", res.length === 1);
const bSees = (await q(`select user_id, chapter from public.series where id = 'n:a'`)).rows;
check("B sees only B's row", bSees.length === 1 && bSees[0].user_id === B && bSees[0].chapter === "999");
await asUser(A);
check("A's row is untouched", (await get("n:a")).chapter === "51");

// Signed out and anon.
await db.exec(`reset role; set role anon; select set_config('request.jwt.claims', '', false)`);
try {
  await push([row("n:z", "1")]);
  check("anon can't call push_series", false);
} catch (e) {
  check("anon can't call push_series", /permission denied/.test(e.message), e.message);
}
await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claims', '', false)`);
try {
  await push([row("n:z", "1")]);
  check("an authenticated call without a user is refused", false);
} catch (e) {
  check("an authenticated call without a user is refused", /not signed in/.test(e.message), e.message);
}

// Policies rewritten with (select auth.uid()).
await db.exec(`reset role`);
const pol = (await q(`select policyname, coalesce(qual,'') || ' ' || coalesce(with_check,'') as d from pg_policies where tablename = 'series'`)).rows;
check("all four policies use (select auth.uid())", pol.length === 4 && pol.every((p) => /SELECT auth\.uid\(\)/i.test(p.d)), JSON.stringify(pol));

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
