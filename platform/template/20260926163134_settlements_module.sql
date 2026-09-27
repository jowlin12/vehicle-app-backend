-- Managed workshops only. History remains readable when this module expires.
begin;

alter table public.vehicleapp_installation
  add column if not exists settlements_enabled boolean not null default false,
  add column if not exists settlements_expires_at timestamptz;

create or replace function public.settlements_module_active()
returns boolean language sql stable security definer set search_path = ''
as $$
  select public.orders_module_active() and coalesce((
    select installation.settlements_enabled
      and (installation.settlements_expires_at is null
        or installation.settlements_expires_at > pg_catalog.statement_timestamp())
    from public.vehicleapp_installation installation where installation.singleton
  ), false);
$$;
revoke all on function public.settlements_module_active() from public, anon;
grant execute on function public.settlements_module_active() to authenticated, service_role;

create or replace function private.require_settlements_module()
returns void language plpgsql set search_path = ''
as $$
begin
  if not public.settlements_module_active() then
    raise exception 'settlements_module_disabled' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_settlements_module() from public, anon;
grant execute on function private.require_settlements_module() to authenticated, service_role;

create or replace function private.guard_settlements_module()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_settlements_module();
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.guard_settlements_module() from public, anon, authenticated;

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'weekly_settlements', 'weekly_settlement_goals', 'settlement_items',
    'settlement_deferrals', 'settlement_items_voided', 'settlement_deferrals_voided',
    'settlement_worker_payments', 'settlement_part_profit_snapshots'
  ] loop
    execute pg_catalog.format('drop trigger if exists guard_settlements_module on public.%I', v_table);
    execute pg_catalog.format('create trigger guard_settlements_module before insert or update or delete on public.%I for each row execute function private.guard_settlements_module()', v_table);
    execute pg_catalog.format('revoke all on public.%I from public, anon', v_table);
    execute pg_catalog.format('revoke truncate, references, trigger on public.%I from authenticated', v_table);
  end loop;
end;
$$;

-- Guard privileged RPCs before their bodies run, even for empty updates. Keep
-- their existing signatures, ownership, grants and environment/role checks.
do $$
declare
  v_target regprocedure;
  v_definition text;
  v_position integer;
begin
  foreach v_target in array array[
    'public.close_weekly_settlement(date,date,numeric,jsonb,jsonb,numeric,jsonb)'::regprocedure,
    'public.close_weekly_settlement_with_parts(date,date,numeric,jsonb,jsonb,numeric,jsonb)'::regprocedure,
    'public.restore_weekly_settlement(uuid)'::regprocedure,
    'public.delete_weekly_settlement(uuid,boolean)'::regprocedure,
    'public.recalculate_settlement_totals(uuid)'::regprocedure,
    'public.set_weekly_labor_goal(date,date,numeric)'::regprocedure,
    'public.clear_weekly_labor_goal(date,date)'::regprocedure
  ] loop
    v_definition := pg_catalog.pg_get_functiondef(v_target);
    if pg_catalog.strpos(v_definition, 'private.require_settlements_module()') > 0 then continue; end if;
    v_position := pg_catalog.strpos(pg_catalog.upper(v_definition), 'BEGIN');
    if v_position = 0 then raise exception 'settlements_rpc_contract_not_found: %', v_target; end if;
    execute pg_catalog.substr(v_definition, 1, v_position + 4)
      || E'\n  perform private.require_settlements_module();\n'
      || pg_catalog.substr(v_definition, v_position + 5);
  end loop;
end;
$$;

-- Defer before the worker records an idempotency receipt. A renewal can replay
-- the exact same operation once, without declaring a conflict or losing it.
do $$
declare
  v_definition text;
  v_anchor constant text := '  return private.apply_offline_mutation(';
begin
  v_definition := pg_catalog.pg_get_functiondef('public.apply_offline_mutation(uuid,text,text,jsonb)'::regprocedure);
  if pg_catalog.strpos(v_definition, 'settlements_module_active()') = 0 then
    if pg_catalog.strpos(v_definition, v_anchor) = 0 then
      raise exception 'settlements_offline_contract_not_found';
    end if;
    execute pg_catalog.replace(v_definition, v_anchor,
      E'  if lower(trim(coalesce(p_kind, ''''))) in (''settlement.create'', ''settlement.delete'', ''settlement.restore'', ''weekly_goal.set'', ''weekly_goal.clear'')\n'
      || E'     and not public.settlements_module_active() then\n'
      || E'    return jsonb_build_object(''status'', ''deferred'', ''message'', ''Liquidaciones no está activo. El cambio sigue guardado en el teléfono y se sincronizará al reactivar el módulo.'');\n'
      || E'  end if;\n\n' || v_anchor);
  end if;
end;
$$;

-- finalize_due_settlement_formats only completes already committed settlements;
-- it is deliberately kept available to finish their existing lifecycle.
update public.vehicleapp_installation set schema_version = '20260926.4' where singleton;
commit;
