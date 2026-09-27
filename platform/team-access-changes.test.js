'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const A='10000000-0000-4000-8000-000000000001',U='20000000-0000-4000-8000-000000000001',O='20000000-0000-4000-8000-000000000002',
  W='80000000-0000-4000-8000-000000000001',OP='40000000-0000-4000-8000-000000000001',K='70000000-0000-4000-8000-000000000001',K2='70000000-0000-4000-8000-000000000002';
test('central permission changes serialize, bind retries, protect owner/admin, and commit only the intended member',async()=>{
  const db=new PGlite();try{
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text);grant usage on schema public to authenticated,anon,service_role;');
    for(const name of ['20260913225303_platform_control.sql','20260926231003_team_member_access_changes.sql'])
      await db.exec(fs.readFileSync(path.join(root,'platform-control/supabase/migrations',name),'utf8'));
    await db.query('insert into auth.users(id) values($1),($2),($3)',[A,U,O]);
    await db.query('insert into public.platform_admins(user_id) values($1)',[A]);
    await db.query(`insert into public.platform_workshops(id,name,connection_ref,owner_user_id,status,schema_version,created_by,request_key)
      values($1,'QA','test',$2,'ready','20260926.5',$3,$4)`,[W,O,A,K]);
    await db.query(`insert into public.platform_memberships(workshop_id,user_id,operational_user_id,role)
      values($1,$2,$3,'employee'),($1,$4,$5,'owner'),($1,$6,$7,'admin')`,[W,U,OP,O,O,A,A]);
    await db.exec('set role service_role');
    const begin=(key=K,user=U,role='admin',active=true,actor=A)=>db.query('select public.platform_begin_team_change($1,$2,$3,$4,$5,$6) change',[actor,key,W,user,role,active]);
    await assert.rejects(begin(K,O),/protected_member/);await assert.rejects(begin(K,A),/protected_member/);
    await assert.rejects(begin(K,U,'admin',true,U),/platform_admin_required/);
    await begin();await begin();
    assert.equal((await db.query('select active from public.platform_memberships where user_id=$1',[U])).rows[0].active,false);
    await assert.rejects(begin(K,U,'employee'),/idempotency_conflict/);
    await assert.rejects(begin(K2),/member_change_pending/);
    await db.query('select public.platform_complete_team_change($1,$2)',[A,K]);
    await db.query('select public.platform_complete_team_change($1,$2)',[A,K]);
    assert.deepEqual((await db.query('select role,active from public.platform_memberships where user_id=$1',[U])).rows[0],{role:'admin',active:true});
    await begin(K2,U,'admin',false);await db.query('select public.platform_complete_team_change($1,$2)',[A,K2]);
    assert.equal((await db.query('select active from public.platform_memberships where user_id=$1',[U])).rows[0].active,false);
    await db.exec('set role authenticated');
    await assert.rejects(begin(),/permission denied/);
    await assert.rejects(db.query('select * from public.platform_team_changes'),/permission denied/);
  }finally{await db.close();}
});
