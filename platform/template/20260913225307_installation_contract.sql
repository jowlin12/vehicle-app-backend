-- Additive and unconfigured by default. Does not modify any existing business row.
begin;
create table public.vehicleapp_installation (
  singleton boolean primary key default true check(singleton),
  installation_id uuid not null unique,
  schema_version text not null,
  -- Set only after an isolated end-to-end orders acceptance test.
  verified_at timestamptz,
  orders_enabled boolean not null default true
);
alter table public.vehicleapp_installation enable row level security;
revoke all on public.vehicleapp_installation from public, anon, authenticated;
grant select on public.vehicleapp_installation to authenticated;
grant select, insert, update on public.vehicleapp_installation to service_role;
create policy installation_read on public.vehicleapp_installation for select to authenticated
using (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role in ('admin','empleado')));

create function public.vehicleapp_installation_contract() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'contract', 'vehicleapp.orders.v1',
    'installation_id', i.installation_id,
    'schema_version', i.schema_version,
    'ready', i.verified_at is not null and i.orders_enabled
      and to_regclass('public.formatos') is not null
      and to_regclass('public.servicios') is not null
      and to_regclass('public.repuestos') is not null
      and to_regprocedure('public.apply_offline_mutation(uuid,text,text,jsonb)') is not null
  ) from public.vehicleapp_installation i where singleton;
$$;
revoke all on function public.vehicleapp_installation_contract() from public, anon;
grant execute on function public.vehicleapp_installation_contract() to authenticated;
commit;
