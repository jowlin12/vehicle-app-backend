-- New workshop installations only; not a change to the current production APK.
begin;
alter table public.app_settings enable row level security;
alter table public.update_notifications enable row level security;
alter table public.notification_views enable row level security;
create policy app_settings_read on public.app_settings for select to authenticated using (auth.uid() is not null);
create policy app_settings_admin on public.app_settings for all to authenticated
using (public.is_current_user_admin()) with check (public.is_current_user_admin());

-- Row ownership alone does not stop a user from setting their own role=admin.
revoke insert, update on public.profiles from public, anon, authenticated;
grant update(full_name, username) on public.profiles to authenticated;
revoke create on schema public from public, anon, authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as signature, p.proname, p.proconfig
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef
  loop
    if f.proname <> 'get_email_by_username' then
      execute format('revoke execute on function %s from public, anon', f.signature);
    end if;
  end loop;
  for f in select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.prokind='f' and p.proconfig is null
    and not exists(select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.signature);
  end loop;
end;
$$;
commit;
