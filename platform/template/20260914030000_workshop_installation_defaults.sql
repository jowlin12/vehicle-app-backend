-- Additive installation defaults for a new workshop. Idempotent and safe to
-- re-run; it never touches business rows created by the workshop.
begin;

-- Factura v2 resolves its cutover from a singleton row. A workshop installed
-- today starts with "everything is v2" instead of a missing configuration that
-- makes the legacy/v2 decision ambiguous.
insert into public.factura_v2_config (id, cutover_at, created_at)
values (true, now(), now())
on conflict (id) do nothing;

-- Explicit operational defaults. The photo bypass must stay disabled unless an
-- administrator enables it on purpose.
insert into public.app_settings (key, value) values
  ('ready_settlement_workflow_enabled', false),
  ('allow_employee_view_finalized', false),
  ('admin_bypass_photos', false)
on conflict (key) do nothing;

-- Hourly finalization of deferred settlements, same job as the original
-- workshop. The block is skipped on engines that do not offer pg_cron.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'finalizar-formatos-liquidados') then
      perform cron.unschedule('finalizar-formatos-liquidados');
    end if;
    perform cron.schedule(
      'finalizar-formatos-liquidados',
      '5 * * * *',
      'select public.finalize_due_settlement_formats();'
    );
  end if;
end $$;

-- Self-register the migration when applied by hand. The provisioner also
-- records it in the same ledger with its own wrapper.
do $$
begin
  if to_regclass('public.vehicleapp_schema_migrations') is not null then
    insert into public.vehicleapp_schema_migrations (version, name)
    values ('20260914030000', '20260914030000_workshop_installation_defaults.sql')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
