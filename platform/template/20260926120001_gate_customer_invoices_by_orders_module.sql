-- Customer invoices belong to the Orders module. Keep their data and queued
-- mutations intact while preventing reads and writes after the module expires.
begin;

create or replace function public.orders_module_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select installation.orders_enabled
      and (installation.orders_expires_at is null
        or installation.orders_expires_at > pg_catalog.statement_timestamp())
    from public.vehicleapp_installation installation
    where installation.singleton
  ), false);
$$;
revoke all on function public.orders_module_active() from public, anon;
grant execute on function public.orders_module_active() to authenticated, service_role;

create or replace function private.guard_customer_invoice_orders_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.orders_module_active() then
    raise exception 'orders_module_disabled' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.guard_customer_invoice_orders_write()
  from public, anon, authenticated;

drop trigger if exists guard_customer_invoice_orders_write on public.facturas;
create trigger guard_customer_invoice_orders_write
  before insert or update or delete on public.facturas
  for each row execute function private.guard_customer_invoice_orders_write();

drop trigger if exists guard_customer_invoice_orders_write on public.abonos;
create trigger guard_customer_invoice_orders_write
  before insert or update or delete on public.abonos
  for each row execute function private.guard_customer_invoice_orders_write();

drop policy if exists customer_invoice_orders_module_read on public.facturas;
create policy customer_invoice_orders_module_read on public.facturas
  as restrictive for select to authenticated
  using (public.orders_module_active());

drop policy if exists customer_payment_orders_module_read on public.abonos;
create policy customer_payment_orders_module_read on public.abonos
  as restrictive for select to authenticated
  using (public.orders_module_active());

-- Remove baseline grants that would bypass row triggers or expose invoice data
-- to anonymous callers. Authenticated users keep normal reads under RLS.
revoke all on public.facturas, public.abonos from public, anon;
revoke truncate, references, trigger on public.facturas, public.abonos
  from public, anon, authenticated;
grant select on public.facturas, public.abonos to authenticated;

-- SECURITY DEFINER functions bypass table RLS, so enforce the same module
-- entitlement before returning invoice data. Patch only their outer function
-- body and fail closed if a future baseline changes this contract.
do $$
declare
  v_target regprocedure;
  v_definition text;
  v_anchor constant text := 'BEGIN';
  v_guard constant text := E'BEGIN\n  if not public.orders_module_active() then\n    raise exception ''orders_module_disabled'' using errcode = ''42501'';\n  end if;\n';
  v_position integer;
begin
  foreach v_target in array array[
    'public.crear_o_actualizar_factura_desde_formato(text)'::regprocedure,
    'public.obtener_factura_v2(bigint)'::regprocedure,
    'public.listar_facturas_v2(text,text,date,date,boolean,text,integer,integer,boolean)'::regprocedure,
    'public.listar_facturas_v2(text,text,date,date,boolean,text,integer,integer)'::regprocedure,
    'public.obtener_factura_por_formato_v2(text)'::regprocedure
  ] loop
    v_definition := pg_catalog.pg_get_functiondef(v_target);
    if pg_catalog.strpos(v_definition, 'orders_module_active()') > 0 then
      continue;
    end if;
    v_position := pg_catalog.strpos(pg_catalog.upper(v_definition), v_anchor);
    if v_position = 0 then
      raise exception 'customer_invoice_orders_guard_contract_not_found: %', v_target;
    end if;
    v_definition := pg_catalog.substr(v_definition, 1, v_position - 1)
      || v_guard
      || pg_catalog.substr(v_definition, v_position + pg_catalog.char_length(v_anchor));
    execute v_definition;
  end loop;
end;
$$;

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

  if lower(trim(coalesce(p_kind, ''))) ~ '^invoice\.(payment_create|payment_delete|delete|detach)$'
     and not public.orders_module_active() then
    return jsonb_build_object(
      'status', 'deferred',
      'message', 'El plan de Órdenes no está activo. El cambio de cartera sigue guardado en el teléfono y se sincronizará al reactivarlo.'
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
set schema_version = '20260926.3'
where singleton;

commit;
