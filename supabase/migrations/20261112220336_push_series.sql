-- Uploads only overwrite what the device last saw (docs/sync-hardening-plan.md,
-- item 3), plus the RLS performance tweak Supabase's advisor suggests.
--
-- push_series(rows) writes a batch of series rows for the signed-in user. Each
-- row carries base_synced_at: the server's synced_at of the cloud version the
-- device last merged or wrote (null if it has never seen one).
--   - base given: the row is updated only if its synced_at still equals it.
--   - no base, or no row with this id: the row is inserted only if absent.
-- Returns the accepted rows' ids with their new synced_at. Anything not returned
-- was rejected because the cloud changed since the device looked: the client
-- fetches those rows by id, merges them (merge.js) and pushes again.
--
-- No cutover: the table stays writable as before, so older installs keep
-- syncing. security invoker, so row-level security applies exactly as for a
-- direct write; user_id is always auth.uid(). The synced_at trigger still
-- stamps every write.

begin;

create function public.push_series(rows jsonb)
returns table (id text, synced_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  uid uuid := auth.uid();
  got_id text;
  got_at timestamptz;
begin
  if uid is null then
    raise exception 'push_series: not signed in' using errcode = '42501';
  end if;
  if jsonb_typeof(rows) is distinct from 'array' then
    raise exception 'push_series: rows must be a JSON array' using errcode = '22023';
  end if;

  for r in
    select * from jsonb_to_recordset(rows) as x(
      id text, site text, slug text, title text, chapter text, chapter_url text,
      series_url text, last_read_at timestamptz, progress_at timestamptz,
      progress_reset_at timestamptz, created_at timestamptz, updated_at timestamptz,
      deleted boolean, client_schema smallint, base_synced_at timestamptz
    )
  loop
    got_id := null;
    got_at := null;

    if r.base_synced_at is not null then
      update public.series as s set
        site = r.site,
        slug = r.slug,
        title = r.title,
        chapter = r.chapter,
        chapter_url = r.chapter_url,
        series_url = r.series_url,
        last_read_at = r.last_read_at,
        progress_at = r.progress_at,
        progress_reset_at = r.progress_reset_at,
        updated_at = r.updated_at,
        deleted = coalesce(r.deleted, false),
        client_schema = r.client_schema
      where s.user_id = uid and s.id = r.id and s.synced_at = r.base_synced_at
      returning s.id, s.synced_at into got_id, got_at;
    end if;

    if got_id is null then
      insert into public.series as s (
        user_id, id, site, slug, title, chapter, chapter_url, series_url,
        last_read_at, progress_at, progress_reset_at, created_at, updated_at,
        deleted, client_schema
      ) values (
        uid, r.id, r.site, r.slug, r.title, r.chapter, r.chapter_url, r.series_url,
        r.last_read_at, r.progress_at, r.progress_reset_at, coalesce(r.created_at, now()),
        r.updated_at, coalesce(r.deleted, false), r.client_schema
      )
      on conflict on constraint series_pkey do nothing
      returning s.id, s.synced_at into got_id, got_at;
    end if;

    if got_id is not null then
      id := got_id;
      synced_at := got_at;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.push_series(jsonb) from public, anon;
grant execute on function public.push_series(jsonb) to authenticated;

-- RLS: evaluate auth.uid() once per query instead of once per row.
alter policy "own rows: select" on public.series using ((select auth.uid()) = user_id);
alter policy "own rows: insert" on public.series with check ((select auth.uid()) = user_id);
alter policy "own rows: update" on public.series
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own rows: delete" on public.series using ((select auth.uid()) = user_id);

commit;
