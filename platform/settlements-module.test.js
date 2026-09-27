'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');
const { templates, migrationTransaction } = require('./provisioning');

const ADMIN = '10000000-0000-4000-8000-000000000001';
const WORKSHOP = '80000000-0000-4000-8000-000000000001';
const CREATE = '72000000-0000-4000-8000-000000000031';
const REMOVE = '72000000-0000-4000-8000-000000000032';
const FUTURE = '2099-01-01T00:00:00Z';

async function fixture() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id));
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    create function auth.jwt() returns jsonb language sql as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth, public to authenticated, anon, service_role;
    create publication supabase_realtime;
    create table public.vehicleapp_schema_migrations(version text primary key,name text not null,applied_at timestamptz default now());`);
  for (const migration of templates().migrations) {
    await db.exec(migrationTransaction(migration));
    // Reapply before the later session-access migration changes this contract.
    if(migration.name.endsWith('_settlements_module.sql')) await db.exec(migration.sql);
  }
  await db.query('insert into auth.users(id,email) values($1,$2)', [ADMIN, 'qa@example.invalid']);
  await db.query("update public.profiles set role='admin',is_active=true where id=$1", [ADMIN]);
  await db.query(`insert into public.vehicleapp_installation(singleton,installation_id,schema_version,orders_enabled)
    values(true,$1,'test',true)`, [WORKSHOP]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ADMIN]);
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
  await db.exec('set role authenticated');
  return db;
}

async function moduleAccess(db, enabled, expiry = FUTURE, orders = true) {
  await db.exec('reset role');
  await db.query(`update public.vehicleapp_installation set settlements_enabled=$1,
    settlements_expires_at=$2,orders_enabled=$3`, [enabled, expiry, orders]);
  await db.exec('set role authenticated');
}

async function mutation(db, id, kind, payload) {
  return (await db.query('select public.apply_offline_mutation($1,$2,$3,$4::jsonb) as result',
    [id, kind, `qa:${kind}`, JSON.stringify(payload)])).rows[0].result;
}

test('settlements preserve history, defer paused/expired writes, and replay once after renewal', async () => {
  const db = await fixture();
  try {
    const format = (await db.query(`insert into public.formatos(folio,placa,fecha_entrada,estado,created_at,is_development,created_by,costo_mano_obra)
      values('QA-1','QA1234',current_date,'ACTIVO',now(),false,$1,100000) returning id`, [ADMIN])).rows[0];
    const payload = { start_date: '2030-01-07', end_date: '2030-01-13', wage_fund_percentage: 20,
      items: [{ format_id: format.id, adjusted_amount: 50000, is_advance: true }],
      workers: [{ worker_name:'Trabajador QA',percentage_share:100,payment_amount:10000 }], total_bonus: 0, deferrals: [] };
    assert.equal((await mutation(db, CREATE, 'settlement.create', payload)).status, 'deferred');
    for (const [index, kind] of ['settlement.delete','settlement.restore','weekly_goal.set','weekly_goal.clear'].entries()) {
      const result = await mutation(db, `72000000-0000-4000-8000-${String(40+index).padStart(12,'0')}`, kind, {});
      assert.equal(result.status, 'deferred', kind);
    }
    await assert.rejects(db.query('select public.close_weekly_settlement($1,$2,$3,$4::jsonb,$5::jsonb)',
      [payload.start_date,payload.end_date,20,'[]','[]']), /settlements_module_disabled/);
    await assert.rejects(db.query('select public.restore_weekly_settlement($1)', [WORKSHOP]), /settlements_module_disabled/);
    // This maintenance RPC already has no client EXECUTE grant; preserve it.
    await assert.rejects(db.query('select public.recalculate_settlement_totals($1)', [WORKSHOP]), /permission denied/);
    await assert.rejects(db.query('select public.set_weekly_labor_goal($1,$2,$3)',
      [payload.start_date,payload.end_date,100000]), /settlements_module_disabled/);
    assert.equal((await db.query('select count(*)::int as n from public.offline_mutation_receipts')).rows[0].n, 0);

    await moduleAccess(db, true);
    const created = await mutation(db, CREATE, 'settlement.create', payload);
    assert.equal(created.status, 'applied');
    await mutation(db, CREATE, 'settlement.create', payload);
    const settlement = (await db.query('select id,total_labor_liquidated,wage_fund_total from public.weekly_settlements')).rows[0];
    assert.equal(Number(settlement.total_labor_liquidated), 50000);
    assert.equal(Number(settlement.wage_fund_total), 10000);
    assert.equal(Number((await db.query('select payment_amount from public.settlement_worker_payments')).rows[0].payment_amount), 10000);
    assert.equal((await db.query('select count(*)::int as n from public.weekly_settlements')).rows[0].n, 1);

    await moduleAccess(db, false);
    assert.equal((await db.query('select count(*)::int as n from public.weekly_settlements')).rows[0].n, 1);
    assert.equal((await mutation(db, REMOVE, 'settlement.delete', { id:settlement.id })).status, 'deferred');
    await assert.rejects(db.query('update public.weekly_settlements set total_bonus=1 where id=$1', [settlement.id]), /settlements_module_disabled/);
    await assert.rejects(db.query('select public.delete_weekly_settlement($1,false)', [settlement.id]), /settlements_module_disabled/);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.weekly_settlements'), /permission denied/);
    await db.exec('reset role; set role authenticated');
    await assert.rejects(db.query('truncate public.weekly_settlements cascade'), /permission denied/);

    await moduleAccess(db, true, '2000-01-01T00:00:00Z');
    assert.equal((await mutation(db, REMOVE, 'settlement.delete', { id:settlement.id })).status, 'deferred');
    await moduleAccess(db, true, FUTURE, false);
    assert.equal((await mutation(db, REMOVE, 'settlement.delete', { id:settlement.id })).status, 'deferred');

    await moduleAccess(db, true);
    assert.equal((await mutation(db, REMOVE, 'settlement.delete', { id:settlement.id })).status, 'applied');
    await mutation(db, REMOVE, 'settlement.delete', { id:settlement.id });
    assert.ok((await db.query('select deleted_at from public.weekly_settlements where id=$1',[settlement.id])).rows[0].deleted_at);
    assert.equal((await db.query('select count(*)::int as n from public.offline_mutation_receipts')).rows[0].n, 2);
  } finally { await db.close(); }
});
