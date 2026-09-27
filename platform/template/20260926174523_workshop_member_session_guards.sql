-- Managed installations only; never apply to the legacy production workshop.
begin;
grant usage on schema private to authenticated,service_role;
create table private.workshop_member_access (
  user_id uuid primary key references auth.users(id),
  role text not null check(role in ('admin','empleado')),
  active boolean not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);
create table private.workshop_member_sessions (
  session_id uuid primary key,
  user_id uuid not null references private.workshop_member_access(user_id),
  revision bigint not null,
  created_at timestamptz not null default now()
);
create index workshop_member_sessions_user_idx on private.workshop_member_sessions(user_id);
alter table private.workshop_member_access enable row level security;
alter table private.workshop_member_sessions enable row level security;
revoke all on private.workshop_member_access,private.workshop_member_sessions from public,anon,authenticated;
grant select,insert,update,delete on private.workshop_member_access,private.workshop_member_sessions to service_role;

create function private.workshop_member_allowed() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_sid uuid; v_access private.workshop_member_access;
begin
  if auth.role()='service_role' then return true; end if;
  -- Scheduled jobs and installation acceptance run through privileged DB connections.
  if v_user is null then
    return coalesce(auth.role(),'')='' and session_user in ('postgres','supabase_admin','supabase_auth_admin');
  end if;
  if not exists(select 1 from public.profiles p where p.id=v_user
    and p.is_active and p.deleted_at is null) then return false; end if;
  select * into v_access from private.workshop_member_access where user_id=v_user;
  if not found then return true; end if; -- Owner / preexisting managed identities.
  if not v_access.active or not exists(select 1 from public.profiles
    where id=v_user and role=v_access.role) then return false; end if;
  begin v_sid := nullif(auth.jwt()->>'session_id','')::uuid;
  exception when invalid_text_representation then return false; end;
  if v_sid is null then return false; end if;
  return exists(select 1 from private.workshop_member_sessions s
    join auth.sessions a on a.id=s.session_id and a.user_id=s.user_id
    where s.session_id=v_sid and s.user_id=v_user and s.revision=v_access.revision);
end;
$$;
revoke all on function private.workshop_member_allowed() from public,anon;
grant execute on function private.workshop_member_allowed() to authenticated,service_role;

create function private.require_workshop_member() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not private.workshop_member_allowed() then
    raise exception 'workshop_access_revoked' using errcode='42501';
  end if;
end;
$$;
revoke all on function private.require_workshop_member() from public,anon;
grant execute on function private.require_workshop_member() to authenticated,service_role;

create function public.platform_set_member_access(p_workshop uuid,p_user uuid,p_role text,p_active boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_access private.workshop_member_access;
begin
  if auth.role() is distinct from 'service_role' and current_user <> 'postgres' then
    raise insufficient_privilege; end if;
  if p_role not in ('admin','empleado') or p_active is null or not exists(
    select 1 from public.vehicleapp_installation where singleton and installation_id=p_workshop
  ) then raise exception 'invalid_member_access'; end if;
  insert into private.workshop_member_access(user_id,role,active) values(p_user,p_role,p_active)
  on conflict(user_id) do update set role=excluded.role,active=excluded.active,
    revision=private.workshop_member_access.revision+1,updated_at=now()
  where (private.workshop_member_access.role,private.workshop_member_access.active)
    is distinct from (excluded.role,excluded.active);
  select * into strict v_access from private.workshop_member_access where user_id=p_user for update;
  update public.profiles set role=p_role,is_active=p_active where id=p_user and deleted_at is null;
  if not found then raise exception 'member_profile_unavailable'; end if;
  delete from private.workshop_member_sessions where user_id=p_user and revision<>v_access.revision;
  return to_jsonb(v_access);
end;
$$;
revoke all on function public.platform_set_member_access(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.platform_set_member_access(uuid,uuid,text,boolean) to service_role;

create function public.platform_member_access(p_user uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select to_jsonb(a) from private.workshop_member_access a where a.user_id=p_user;
$$;
revoke all on function public.platform_member_access(uuid) from public,anon,authenticated;
grant execute on function public.platform_member_access(uuid) to service_role;

create function public.platform_allow_member_session(p_user uuid,p_session uuid,p_revision bigint)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from private.workshop_member_access a join public.profiles p on p.id=a.user_id
    where a.user_id=p_user and a.revision=p_revision and a.active and p.is_active
      and p.deleted_at is null and p.role=a.role for update of a;
  if not found or not exists(select 1 from auth.sessions where id=p_session and user_id=p_user) then
    raise exception 'member_access_changed' using errcode='42501'; end if;
  insert into private.workshop_member_sessions(session_id,user_id,revision)
    values(p_session,p_user,p_revision) on conflict(session_id) do nothing;
  if not exists(select 1 from private.workshop_member_sessions
    where session_id=p_session and user_id=p_user and revision=p_revision) then
    raise exception 'member_access_changed' using errcode='42501'; end if;
end;
$$;
revoke all on function public.platform_allow_member_session(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.platform_allow_member_session(uuid,uuid,bigint) to service_role;
grant select on auth.sessions to service_role;

-- Restrictive policies cover direct Data API queries and Realtime row visibility.
do $$ declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity
  loop
    execute format('create policy workshop_member_access on public.%I as restrictive for all to authenticated using ((select private.workshop_member_allowed())) with check ((select private.workshop_member_allowed()))',t.relname);
  end loop;
end;
$$;

-- Privileged RPCs need their own check because their owner bypasses RLS.
-- Keep signatures/defaults and original grants; the implementation is private.
do $$
declare f record; v_inner text; v_call text; v_body text; v_grants text;
begin
  for f in select p.oid,p.proname,p.proretset,p.provolatile,p.prosecdef,n.nspname,
    pg_get_function_identity_arguments(p.oid) identity_args,
    pg_get_function_arguments(p.oid) args,pg_get_function_result(p.oid) result,
    pg_get_functiondef(p.oid) definition,
    p.pronargs,
    has_function_privilege('authenticated',p.oid,'execute') client_allowed,
    has_function_privilege('service_role',p.oid,'execute') service_allowed
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f'
      and (has_function_privilege('authenticated',p.oid,'execute') or (n.nspname='public' and p.prosecdef))
      and p.prorettype not in ('trigger'::regtype,'event_trigger'::regtype)
      and p.proname<>'get_email_by_username'
      and p.proname not in ('workshop_member_allowed','require_workshop_member')
      and not exists(select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
  loop
    v_inner := 'member_guard_'||left(f.proname,40)||'_'||left(md5(f.nspname||f.identity_args),8);
    select string_agg('$'||i,',') into v_call from generate_series(1,f.pronargs) i;
    v_call := format('private.%I(%s)',v_inner,coalesce(v_call,''));
    -- Preserve the public OID: existing policies have bound references to it.
    execute regexp_replace(f.definition,
      '^CREATE OR REPLACE FUNCTION '||f.nspname||'[.]'||quote_ident(f.proname)||'[(]',
      format('CREATE FUNCTION private.%I(',v_inner));
    execute format('revoke all on function private.%I(%s) from public,anon,authenticated',v_inner,f.identity_args);
    v_body := 'begin perform private.require_workshop_member(); '||
      case when f.proretset then 'return query select * from '||v_call||'; return;'
      when f.result='void' then 'perform '||v_call||'; return;'
      else 'return '||v_call||';' end||' end;';
    execute format('create or replace function %I.%I(%s) returns %s language plpgsql %s security %s set search_path = %L as %L',
      f.nspname,f.proname,f.args,f.result,case f.provolatile when 'v' then 'volatile' else 'stable' end,
      case when f.prosecdef then 'definer' else 'invoker' end,'',v_body);
    execute format('revoke all on function %I.%I(%s) from public,anon,authenticated,service_role',f.nspname,f.proname,f.identity_args);
    if f.client_allowed then
      execute format('grant execute on function %I.%I(%s) to authenticated',f.nspname,f.proname,f.identity_args);
      if not f.prosecdef then execute format('grant execute on function private.%I(%s) to authenticated',v_inner,f.identity_args); end if;
    end if;
    if f.service_allowed then
      execute format('grant execute on function %I.%I(%s) to service_role',f.nspname,f.proname,f.identity_args);
      execute format('grant execute on function private.%I(%s) to service_role',v_inner,f.identity_args);
    end if;
  end loop;
end;
$$;
-- Own status only, deliberately available after revocation so the app can exit.
create function public.workshop_access_status() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('active',private.workshop_member_allowed());
$$;
revoke all on function public.workshop_access_status() from public,anon;
grant execute on function public.workshop_access_status() to authenticated,service_role;
commit;
