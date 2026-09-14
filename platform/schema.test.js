'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');

const root = path.resolve(__dirname, '../..');
const migration = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const admin = '10000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000002';
const requestId = '20000000-0000-4000-8000-000000000001';

async function database() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    create function auth.jwt() returns jsonb language sql as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth, public to authenticated, anon, service_role;
    grant select on auth.users to service_role;`);
  return db;
}

test('central schema: atomic registration, retry, conflict and no direct client access', async () => {
  const db = await database();
  try {
    await db.exec(migration('platform-control/supabase/migrations/20260913225303_platform_control.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260914010000_managed_workshop_connections.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260914011500_platform_control_indexes.sql'));
    await db.query('insert into auth.users(id) values($1),($2)', [admin, owner]);
    await db.query('insert into platform_admins(user_id) values($1)', [admin]);
    await db.exec('set role service_role');
    const register = (name = 'Taller sintético') => db.query(
      'select (public.platform_register_workshop($1,$2,$3,$4,$5,$6)).*',
      [admin, requestId, name, owner, 'test-a', ['orders']]);
    const first = (await register()).rows[0];
    assert.equal(first.status, 'pending');
    assert.equal((await register()).rows[0].id, first.id);
    await db.query(`insert into platform_workshop_connections(workshop_id, connection_ref,
      project_ref, project_url, publishable_key, service_role_secret,
      management_token_secret, created_by) values($1,$2,$2,$3,$4,$5,$6,$7)`, [
      first.id, 'abcdefghijklmnopqrst', 'https://abcdefghijklmnopqrst.supabase.co',
      'sb_publishable_example_key', 'v1.encrypted.service', 'v1.encrypted.management', admin,
    ]);
    await assert.rejects(register('Otro nombre'), /idempotency_conflict/);
    assert.equal((await db.query('select count(*)::int as count from platform_memberships')).rows[0].count, 1);
    await assert.rejects(db.query('select public.platform_register_workshop($1,$2,$3,$4,$5,$6)',
      [owner, requestId, 'No autorizado', owner, 'test-b', ['orders']]), /platform_admin_required/);
    await db.exec('reset role; set role authenticated');
    await assert.rejects(db.query('select * from public.platform_workshops'), /permission denied/);
    await assert.rejects(db.query('select * from public.platform_workshop_connections'), /permission denied/);
    await assert.rejects(register(), /permission denied/);
  } finally { await db.close(); }
});

test('backend provisioning bundle matches the reviewed workshop template', () => {
  const pairs = [
    ['workshop-template/supabase/migrations/20260913225816_workshop_baseline.sql',
      'Backend/platform/template/20260913225816_workshop_baseline.sql'],
    ['supabase/migrations/20260913225307_installation_contract.sql',
      'Backend/platform/template/20260913225307_installation_contract.sql'],
    ['workshop-template/supabase/migrations/20260913230822_workshop_access_guards.sql',
      'Backend/platform/template/20260913230822_workshop_access_guards.sql'],
    ['workshop-template/verify-orders.sql', 'Backend/platform/template/verify-orders.sql'],
  ];
  for (const [source, packaged] of pairs) assert.equal(migration(packaged), migration(source));
});

test('workshop baseline installs in an empty embedded PostgreSQL', async () => {
  const db = await database();
  try {
    await db.exec('create publication supabase_realtime;');
    const sql = migration('workshop-template/supabase/migrations/20260913225816_workshop_baseline.sql');
    try { await db.exec(sql); } catch (error) {
      if (error.position) console.error(sql.slice(Number(error.position)-100, Number(error.position)+130));
      throw error;
    }
    await db.exec(migration('supabase/migrations/20260913225307_installation_contract.sql'));
    await db.exec(migration('workshop-template/supabase/migrations/20260913230822_workshop_access_guards.sql'));
    const result = await db.query("select count(*)::int as count from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
    assert.equal(result.rows[0].count, 36);
    const acceptance = await db.exec(migration('workshop-template/verify-orders.sql'));
    assert.deepEqual(acceptance.find(result => result.rows?.[0]?.acceptance)?.rows[0].acceptance,
      { formatos: 1, servicios: 1, repuestos: 1, receipts: 3 });
    assert.equal((await db.query('select count(*)::int as count from formatos')).rows[0].count, 0);
    await db.exec('set role authenticated');
    await assert.rejects(db.query("update profiles set role='admin'"), /permission denied/);
    assert.equal((await db.query('select public.vehicleapp_installation_contract() as contract')).rows[0].contract, null);
  } finally { await db.close(); }
});
