-- When the central plan pauses orders, durable edits stay queued on each
-- device instead of becoming permanent conflicts. Re-enabling the module lets
-- apply_offline_mutation retry them through the existing idempotent contract.
begin;

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
       where singleton and not orders_enabled
     ) then
    return jsonb_build_object(
      'status', 'deferred',
      'message', 'Órdenes está pausado. El cambio sigue guardado en el teléfono y se sincronizará al reactivarlo.'
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
set schema_version = '20260925.1'
where singleton;

commit;
