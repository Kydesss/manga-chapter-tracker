-- Cloud schema v2 for public.series. See docs/cloud-schema-v2-plan.md.
-- Not applied automatically: apply together with the extension release that
-- sends client_schema = 2 (older builds can't push once this runs, by design).

begin;

-- 1. Plan to read: a series can be saved without a chapter. A chapter and its
--    link are always present or absent together.
alter table public.series
  alter column chapter drop not null,
  alter column chapter_url drop not null,
  add constraint series_chapter_with_url
    check ((chapter is null) = (chapter_url is null));

-- 2. last_read_at: when the chapter was last read (display and sort; null when
--    unknown, e.g. imported). progress_at: when the chapter was set (a save,
--    an advancing import, an Undo). progress_reset_at: when the series'
--    reading history last restarted (a removal or a deliberate move back);
--    a chapter whose progress_at is before it doesn't count in merges.
alter table public.series
  add column last_read_at timestamptz,
  add column progress_at timestamptz,
  add column progress_reset_at timestamptz;

-- Existing rows: their last save is the best estimate of both, as the
-- extension assumed before these columns existed. Filled here so clients can
-- read a null as "unknown" instead of guessing.
update public.series
  set last_read_at = updated_at,
      progress_at = updated_at
  where chapter is not null;

-- 3. Hard cutover for older installs: they don't send client_schema, so their
--    upserts fail the NOT NULL check and their changes wait locally until they
--    update. Existing rows get 2; the default is then removed.
alter table public.series
  add column client_schema smallint not null default 2;
alter table public.series
  alter column client_schema drop default,
  add constraint series_client_schema_floor check (client_schema >= 2);

-- 4. Server change order for incremental pulls. Only the server sets it: the
--    trigger overwrites whatever a client sends. updated_at stays the client's
--    edit time and keeps deciding conflicts.
alter table public.series
  add column synced_at timestamptz not null default clock_timestamp();

create function public.series_set_synced_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.synced_at := clock_timestamp();
  return new;
end;
$$;

create trigger series_set_synced_at
  before insert or update on public.series
  for each row execute function public.series_set_synced_at();

create index series_user_synced_idx on public.series (user_id, synced_at, id);

commit;
