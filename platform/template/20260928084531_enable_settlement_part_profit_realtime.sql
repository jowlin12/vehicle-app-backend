begin;

do $migration$
begin
  if to_regclass('public.settlement_part_profit_snapshots') is not null then
    if not exists (
      select 1
      from pg_publication
      where pubname = 'supabase_realtime'
    ) then
      raise exception 'Publication supabase_realtime does not exist.';
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'settlement_part_profit_snapshots'
    ) then
      execute 'alter publication supabase_realtime add table public.settlement_part_profit_snapshots';
    end if;
  end if;
end
$migration$;

update public.vehicleapp_installation
set schema_version = '20260928.1'
where singleton;

commit;
