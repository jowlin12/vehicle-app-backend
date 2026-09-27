-- Commercial gate for supplier invoices. Existing evidence stays stored; when
-- paused, reads are hidden and offline writes remain queued for later retry.
begin;

alter table public.vehicleapp_installation
  add column if not exists supplier_invoices_enabled boolean not null default false,
  add column if not exists supplier_invoices_expires_at timestamptz;

-- Older template versions inserted the UUID foreign key as text in the
-- offline-mutation worker. Patch its definition without changing its receipt,
-- authorization, or idempotency behavior.
do $$
declare
  v_definition text;
  v_old_expression constant text :=
    'v_data ->> ''id_formato'', v_data ->> ''proveedor''';
  v_new_expression constant text :=
    '(v_data ->> ''id_formato'')::uuid, v_data ->> ''proveedor''';
begin
  select pg_catalog.pg_get_functiondef(
    'private.apply_offline_mutation(uuid,text,text,jsonb)'::regprocedure
  ) into v_definition;
  if pg_catalog.strpos(v_definition, v_old_expression) > 0 then
    execute pg_catalog.replace(v_definition, v_old_expression, v_new_expression);
  elsif pg_catalog.strpos(v_definition, v_new_expression) = 0 then
    raise exception 'supplier_invoice_offline_contract_not_found';
  end if;
end;
$$;

create or replace function public.supplier_invoices_module_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select installation.supplier_invoices_enabled
      and (installation.supplier_invoices_expires_at is null
        or installation.supplier_invoices_expires_at > pg_catalog.statement_timestamp())
    from public.vehicleapp_installation installation
    where installation.singleton
  ), false);
$$;
revoke all on function public.supplier_invoices_module_active() from public, anon;
grant execute on function public.supplier_invoices_module_active() to authenticated, service_role;

create or replace function private.guard_supplier_invoice_module()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.supplier_invoices_module_active() then
    raise exception 'supplier_invoices_module_disabled' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.guard_supplier_invoice_module() from public, anon, authenticated;

drop trigger if exists guard_supplier_invoice_module on public.facturas_proveedores;
create trigger guard_supplier_invoice_module
  before insert or update or delete on public.facturas_proveedores
  for each row execute function private.guard_supplier_invoice_module();

drop policy if exists supplier_invoice_module_read on public.facturas_proveedores;
create policy supplier_invoice_module_read on public.facturas_proveedores
  as restrictive for select to authenticated
  using (public.supplier_invoices_module_active());

-- The baseline granted broad privileges to anon and included TRUNCATE. Revoke
-- those bypasses while keeping normal authenticated CRUD under RLS and trigger.
revoke all on public.facturas_proveedores from public, anon;
revoke truncate, references, trigger on public.facturas_proveedores from authenticated;
grant select, insert, update, delete on public.facturas_proveedores to authenticated;

create or replace function public.apply_offline_mutation(
  p_operation_id uuid,
  p_kind text,
  p_entity_key text,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path to 'public', 'private'
as $function$
declare
  v_active uuid := public.current_test_environment_id();
  v_declared uuid := nullif(
    trim(coalesce(p_payload ->> '_test_environment_id', '')),
    ''
  )::uuid;
begin
  if auth.uid() is null then
    raise exception 'Usuario no autenticado' using errcode = '42501';
  end if;

  if v_declared is distinct from v_active then
    return jsonb_build_object(
      'status', 'conflict',
      'message',
        'Este cambio pertenece a otro entorno. Activa el entorno correcto antes de sincronizarlo.'
    );
  end if;

  if v_active is not null
     and lower(trim(coalesce(p_kind, ''))) in (
       'profile.update',
       'setting.set',
       'weekly_goal.set',
       'weekly_goal.clear'
     ) then
    return jsonb_build_object(
      'status', 'conflict',
      'message',
        'La configuración real y los perfiles están bloqueados en el entorno global de pruebas.'
    );
  end if;

  if lower(trim(coalesce(p_kind, ''))) ~ '^(format|servicio|repuesto)\.'
     and exists (
       select 1
       from public.vehicleapp_installation
       where singleton
         and (not orders_enabled
           or (orders_expires_at is not null and orders_expires_at <= pg_catalog.statement_timestamp()))
     ) then
    return jsonb_build_object(
      'status', 'deferred',
      'message', 'El plan de Órdenes no está activo. El cambio sigue guardado en el teléfono y se sincronizará al reactivarlo.'
    );
  end if;

  if lower(trim(coalesce(p_kind, ''))) = 'supplier_invoice.create'
     and not public.supplier_invoices_module_active() then
    return jsonb_build_object(
      'status', 'deferred',
      'message', 'Facturas de proveedores no está activo. El comprobante sigue guardado en el teléfono y se sincronizará al reactivar el módulo.'
    );
  end if;

  return private.apply_offline_mutation(
    p_operation_id,
    p_kind,
    p_entity_key,
    p_payload - '_test_environment_id'
  );
end;
$function$;

update public.vehicleapp_installation
set schema_version = '20260926.2'
where singleton;

commit;
