-- Managed-workshop entitlement for electronic invoicing. Keep issued invoice
-- history readable after expiry; block creating or changing fiscal documents.
begin;

alter table public.vehicleapp_installation
  add column if not exists electronic_invoices_enabled boolean not null default false,
  add column if not exists electronic_invoices_expires_at timestamptz;

create or replace function public.electronic_invoices_module_active()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_workshop_member();
  return public.orders_module_active() and coalesce((
    select installation.electronic_invoices_enabled
      and (installation.electronic_invoices_expires_at is null
        or installation.electronic_invoices_expires_at > pg_catalog.statement_timestamp())
    from public.vehicleapp_installation installation
    where installation.singleton
  ), false);
end;
$$;
revoke all on function public.electronic_invoices_module_active() from public, anon;
grant execute on function public.electronic_invoices_module_active() to authenticated, service_role;

create or replace function private.require_electronic_invoices_module()
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not public.electronic_invoices_module_active() then
    raise exception 'electronic_invoices_module_disabled' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_electronic_invoices_module() from public, anon;
grant execute on function private.require_electronic_invoices_module() to authenticated, service_role;

create or replace function private.guard_electronic_invoices_module()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_electronic_invoices_module();
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.guard_electronic_invoices_module()
  from public, anon, authenticated;

drop trigger if exists guard_electronic_invoices_module on public.facturas_electronicas;
create trigger guard_electronic_invoices_module
  before insert or update or delete on public.facturas_electronicas
  for each row execute function private.guard_electronic_invoices_module();

-- The baseline includes broad grants; remove anonymous and bulk bypasses.
revoke all on public.facturas_electronicas from public, anon;
revoke truncate, references, trigger on public.facturas_electronicas from authenticated;
grant select, insert, update, delete on public.facturas_electronicas to authenticated;

update public.vehicleapp_installation
set schema_version = '20260927.1'
where singleton;

commit;
