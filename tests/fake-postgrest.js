// tests/fake-postgrest.js
// A stand-in for PostgREST in front of public.series after cloud schema v2
// (supabase/migrations/20261112164419_series_schema_v2.sql). It behaves like the
// real table where sync depends on it:
//   - synced_at is assigned by the server on every write (microseconds, like
//     clock_timestamp()), overwriting anything a client sends.
//   - Upserts merge only the columns sent (Prefer: resolution=merge-duplicates).
//   - Rows without client_schema >= 2, or with a chapter and its link not set
//     together, are rejected (400), and so is the rest of their batch.
//   - Timestamps come back in Postgres's "+00:00" format, not the "Z" the
//     extension writes.
//   - GET supports PostgREST's and=(...) / or(...) logic filters with eq, gt
//     and lte (plus the old updated_at=gt.X), order by synced_at (asc or desc)
//     then id, and limit. Every row comes back whole, whatever `select` says.
//   - upsert(..., { at }) commits rows with an earlier synced_at than rows
//     already visible: a slow transaction, stamped when it wrote, committing
//     after others.

const TIMESTAMP_COLUMNS = ["created_at", "updated_at", "last_read_at", "progress_at", "progress_reset_at"];

function pgTime(iso) {
  return iso == null ? iso : new Date(Date.parse(iso)).toISOString().replace("Z", "+00:00");
}

export function createFakeSeries() {
  let clock = Date.parse("2026-11-01T00:00:00.000Z");
  let micro = 0;
  // Strictly increasing server times, with microseconds.
  const stamp = () => {
    clock += 1000;
    micro = (micro + 1) % 1000;
    return new Date(clock).toISOString().replace("Z", `${String(micro).padStart(3, "0")}+00:00`);
  };

  // Rows seeded straight into a table (rather than written through upsert)
  // get a synced_at, as the migration gave existing rows.
  const ensureStamped = (table) => {
    for (const row of table.values()) row.synced_at ??= stamp();
  };

  function select(table, url) {
    ensureStamped(table);
    const p = new URL(url).searchParams;
    let rows = [...table.values()];
    for (const key of ["synced_at", "or"]) {
      if (p.has(key)) throw new Error(`Unexpected top-level ${key}= filter; sync sends and=(...)`);
    }
    // The pre-v2 cursor filter, still served to older clients.
    const updatedGt = p.get("updated_at")?.replace(/^gt\./, "");
    if (updatedGt) rows = rows.filter((r) => Date.parse(r.updated_at) > Date.parse(updatedGt));
    const and = p.get("and");
    if (and) {
      const test = parseLogic("and", and);
      rows = rows.filter(test);
    }
    const desc = p.get("order")?.startsWith("synced_at.desc");
    rows.sort((a, b) => {
      const c = compareTime(a.synced_at, b.synced_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return desc ? -c : c;
    });
    const limit = Number(p.get("limit") || Infinity);
    return rows.slice(0, limit).map((r) => {
      const out = structuredClone(r);
      for (const c of TIMESTAMP_COLUMNS) if (c in out) out[c] = pgTime(out[c]);
      return out;
    });
  }

  // Returns null on success, or the error text for a rejected batch.
  function upsert(table, rows, { at } = {}) {
    for (const r of rows) {
      for (const c of TIMESTAMP_COLUMNS) {
        if (r[c] != null && Number.isNaN(Date.parse(r[c]))) return `invalid input syntax for type timestamp with time zone: "${r[c]}"`;
      }
      if (!(r.client_schema >= 2)) return 'null value in column "client_schema" violates not-null constraint';
      if ((r.chapter == null) !== (r.chapter_url == null)) return 'violates check constraint "series_chapter_with_url"';
    }
    for (const r of rows) {
      const existing = table.get(r.id);
      table.set(r.id, { ...(existing || {}), ...structuredClone(r), synced_at: at ?? stamp() });
    }
    return null;
  }

  // Move the server clock forward (a slow pull, or time between passes).
  const advance = (ms) => {
    clock += ms;
  };

  return { select, upsert, stamp, advance };
}

// PostgREST logic filters: and=(a,b) / or=(a,b), nested as and(...) / or(...),
// with leaves column.op.value (values JSON-quoted or bare). Returns a row test.
function parseLogic(op, text) {
  let i = 0;
  const peek = () => text[i];
  function list() {
    if (text[i++] !== "(") throw new Error(`Expected ( at ${i - 1} in ${text}`);
    const items = [item()];
    while (peek() === ",") {
      i++;
      items.push(item());
    }
    if (text[i++] !== ")") throw new Error(`Expected ) at ${i - 1} in ${text}`);
    return items;
  }
  function value() {
    if (peek() === '"') {
      const start = i++;
      while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      return JSON.parse(text.slice(start, i));
    }
    const start = i;
    while (i < text.length && !",()".includes(text[i])) i++;
    return text.slice(start, i);
  }
  function item() {
    for (const word of ["and", "or"]) {
      if (text.startsWith(`${word}(`, i)) {
        i += word.length;
        return combine(word, list());
      }
    }
    const m = /^([a-z_]+)\.(eq|gt|lte)\./.exec(text.slice(i));
    if (!m) throw new Error(`Unsupported filter at ${i} in ${text}`);
    i += m[0].length;
    const [, column, cmp] = m;
    const v = value();
    return (row) => {
      const x = row[column];
      if (column.endsWith("_at")) {
        const c = compareTime(x, v);
        return cmp === "eq" ? c === 0 : cmp === "gt" ? c > 0 : c <= 0;
      }
      return cmp === "eq" ? x === v : cmp === "gt" ? x > v : x <= v;
    };
  }
  const tests = list();
  if (i !== text.length) throw new Error(`Trailing text in ${text}`);
  return combine(op, tests);
}

function combine(op, tests) {
  return op === "and" ? (row) => tests.every((t) => t(row)) : (row) => tests.some((t) => t(row));
}

// Compare server timestamps as instants, then by their microsecond digits.
function compareTime(a, b) {
  const d = Date.parse(a) - Date.parse(b);
  if (d) return d;
  return micros(a) - micros(b);
}

function after(a, b) {
  return compareTime(a, b) > 0;
}

function micros(t) {
  const m = String(t).match(/\.(\d+)/);
  return m ? Number(m[1].padEnd(6, "0").slice(0, 6)) : 0;
}

export function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(body),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
  };
}
