-- Operational write gate for newly installed workshops only. The original
-- workshop database is not changed by this template migration.
begin;

create or replace function private.guard_orders_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.vehicleapp_installation
    where singleton and orders_enabled
  ) then
    raise exception 'orders_module_disabled' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.guard_orders_write() from public, anon, authenticated;

create trigger a_guard_orders_write before insert or update or delete
on public.formatos for each row execute function private.guard_orders_write();
create trigger a_guard_orders_write before insert or update or delete
on public.servicios for each row execute function private.guard_orders_write();
create trigger a_guard_orders_write before insert or update or delete
on public.repuestos for each row execute function private.guard_orders_write();

-- Record only when manually applied to an already installed test workshop.
-- The provisioner wraps and records this migration in the same transaction.
do $$
begin
  if to_regclass('public.vehicleapp_schema_migrations') is not null then
    insert into public.vehicleapp_schema_migrations(version, name)
    values ('20260917185322', '20260917185322_orders_write_gate.sql')
    on conflict (version) do nothing;
  end if;
end;
$$;

commit;
