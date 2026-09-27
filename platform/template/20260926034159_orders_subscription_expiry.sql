-- A managed workshop enforces the central administrator's approved order plan
-- locally, including its expiry date, so a phone cannot keep writing after it.
begin;

alter table public.vehicleapp_installation
  add column if not exists orders_expires_at timestamptz;

create or replace function private.guard_orders_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.vehicleapp_installation
    where singleton
      and orders_enabled
      and (orders_expires_at is null or orders_expires_at > pg_catalog.statement_timestamp())
  ) then
    raise exception 'orders_module_disabled' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.guard_orders_write() from public, anon, authenticated;

create or replace function public.vehicleapp_installation_contract() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'contract', 'vehicleapp.orders.v1',
    'installation_id', i.installation_id,
    'schema_version', i.schema_version,
    'ready', i.verified_at is not null
      and to_regclass('public.formatos') is not null
      and to_regclass('public.servicios') is not null
      and to_regclass('public.repuestos') is not null
      and to_regprocedure('public.apply_offline_mutation(uuid,text,text,jsonb)') is not null
  ) from public.vehicleapp_installation i where singleton;
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

  return private.apply_offline_mutation(
    p_operation_id,
    p_kind,
    p_entity_key,
    p_payload - '_test_environment_id'
  );
end;
$function$;

update public.vehicleapp_installation
set schema_version = '20260926.1'
where singleton;

commit;
