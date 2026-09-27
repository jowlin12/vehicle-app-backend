'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const {uuid_ossp}=require('@electric-sql/pglite/contrib/uuid_ossp');
const {templates,migrationTransaction}=require('./provisioning');
const USER='10000000-0000-4000-8000-000000000021';
const OTHER='10000000-0000-4000-8000-000000000022';
const WORKSHOP='80000000-0000-4000-8000-000000000021';
const S1='50000000-0000-4000-8000-000000000021';
const S2='50000000-0000-4000-8000-000000000022';
const S3='50000000-0000-4000-8000-000000000023';
async function fixture(){
  const db=new PGlite({extensions:{pgcrypto,uuid_ossp}});
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id));
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
    create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    grant usage on schema auth,public to authenticated,anon,service_role;
    create publication supabase_realtime;
    create table public.vehicleapp_schema_migrations(version text primary key,name text not null,applied_at timestamptz default now());`);
  for(const m of templates().migrations)await db.exec(migrationTransaction(m));
  await db.query(`insert into auth.users(id,email,raw_user_meta_data) values
    ($1,'worker@example.invalid','{"full_name":"Worker QA"}'),($2,'other@example.invalid','{"full_name":"Other QA"}')`,[USER,OTHER]);
  await db.query(`insert into public.vehicleapp_installation(singleton,installation_id,schema_version,orders_enabled,verified_at)
    values(true,$1,'20260926.5',true,now())`,[WORKSHOP]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$4),($2,$4),($3,$4)',[S1,S2,S3,USER]);
  return db;
}
async function claims(db,role,user=USER,sid=S1){
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.role',$1,false),set_config('request.jwt.claim.sub',$2,false),set_config('request.jwt.claims',$3,false)",
    [role,user,JSON.stringify({role,sub:user,session_id:sid})]);
  await db.exec(`set role ${role}`);
}
async function setAccess(db,role,active){
  await claims(db,'service_role');
  return (await db.query('select public.platform_set_member_access($1,$2,$3,$4) as access',[WORKSHOP,USER,role,active])).rows[0].access;
}
async function allow(db,sid,revision){
  return db.query('select public.platform_allow_member_session($1,$2,$3)',[USER,sid,revision]);
}
test('revocation covers direct rows, privileged RPCs, old sessions after reactivation, and downgrade',async()=>{
  const db=await fixture();try{
    const first=await setAccess(db,'admin',true); await allow(db,S1,first.revision);
    await claims(db,'authenticated');
    assert.equal((await db.query('select public.is_current_user_admin() allowed')).rows[0].allowed,true);
    const payload={data:{placa:'QA1234',marca:'QA',tipo_vehiculo:'Prueba',nombre_cliente:'QA',tipo_formato:'SERVICIO',estado:'ACTIVO',costo_mano_obra:0,costo_repuestos:0}};
    const create=()=>db.query("select public.apply_offline_mutation('72000000-0000-4000-8000-000000000081','format.create','format:QA', $1::jsonb)",[JSON.stringify(payload)]);
    await create();
    assert.equal((await db.query('select count(*)::int n from public.formatos')).rows[0].n,1);
    await setAccess(db,'admin',false);
    await claims(db,'authenticated');
    assert.equal((await db.query('select public.workshop_access_status() status')).rows[0].status.active,false);
    await assert.rejects(create(),/workshop_access_revoked/);
    await assert.rejects(db.query('select public.is_current_user_admin()'),/workshop_access_revoked/);
    const read=await db.query('select count(*)::int n from public.profiles');
    assert.equal(read.rows[0].n,0);
    assert.equal((await db.query("update public.profiles set full_name='Denied' where id=$1",[USER])).affectedRows,0);
    const reactivated=await setAccess(db,'admin',true);
    await claims(db,'authenticated');
    await assert.rejects(create(),/workshop_access_revoked/);
    await claims(db,'service_role'); await allow(db,S2,reactivated.revision);
    await claims(db,'authenticated',USER,S2);
    assert.equal((await db.query('select public.is_current_user_admin() allowed')).rows[0].allowed,true);
    const downgraded=await setAccess(db,'empleado',true);
    await claims(db,'authenticated',USER,S2);
    await assert.rejects(create(),/workshop_access_revoked/);
    await claims(db,'service_role');await allow(db,S3,downgraded.revision);
    await claims(db,'authenticated',USER,S3);
    assert.equal((await db.query('select public.is_current_user_admin() allowed')).rows[0].allowed,false);
    await assert.rejects(db.query("update public.profiles set role='admin' where id=$1",[USER]),/permission denied/);
    // Auth sign out removes auth.sessions; the JWT remains unexpired but denied.
    await db.exec('reset role');await db.query('delete from auth.sessions where id=$1',[S3]);
    await claims(db,'authenticated',USER,S3);
    await assert.rejects(create(),/workshop_access_revoked/);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int n from public.formatos')).rows[0].n,1);
    const tables=(await db.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity")).rows[0].n;
    const guards=(await db.query("select count(*)::int n from pg_policies where schemaname='public' and policyname='workshop_member_access' and permissive='RESTRICTIVE'")).rows[0].n;
    assert.equal(guards,tables);
    const unguarded=await db.query("select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and p.prorettype not in ('trigger'::regtype,'event_trigger'::regtype) and p.proname<>'get_email_by_username' and p.prosrc not like '%private.require_workshop_member()%'");
    assert.deepEqual(unguarded.rows,[]);
  }finally{await db.close();}
});

test('sessions cannot be granted across users/revisions and the client cannot use service RPCs',async()=>{
  const db=await fixture();try{
    const access=await setAccess(db,'empleado',true);
    await assert.rejects(allow(db,S1,access.revision+1),/member_access_changed/);
    await db.exec('reset role');await db.query('update auth.sessions set user_id=$1 where id=$2',[OTHER,S1]);
    await claims(db,'service_role');await assert.rejects(allow(db,S1,access.revision),/member_access_changed/);
    await claims(db,'authenticated');
    await assert.rejects(db.query('select public.platform_member_access($1)',[USER]),/permission denied/);
    await assert.rejects(db.query('select public.platform_set_member_access($1,$2,\'admin\',true)',[WORKSHOP,USER]),/permission denied/);
    await assert.rejects(db.query('select * from private.workshop_member_sessions'),/permission denied/);
    await claims(db,'service_role');
    await assert.rejects(db.query('select public.platform_set_member_access($1,$2,\'empleado\',true)',[OTHER,USER]),/invalid_member_access/);
  }finally{await db.close();}
});

test('installation acceptance refuses a later RPC that bypasses session guards',async()=>{
  const db=await fixture();try{
    await db.exec('create function public.qa_unguarded_rpc() returns boolean language sql as $$select true$$');
    await assert.rejects(db.exec(templates().acceptance),/workshop member RPC guard missing/);
    await db.exec('rollback');
    await db.exec('drop function public.qa_unguarded_rpc();drop policy workshop_member_access on public.formatos');
    await assert.rejects(db.exec(templates().acceptance),/workshop member policy missing/);
  }finally{await db.close();}
});
