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
    ['workshop-template/supabase/migrations/20260914030000_workshop_installation_defaults.sql',
      'Backend/platform/template/20260914030000_workshop_installation_defaults.sql'],
    ['workshop-template/supabase/migrations/20260917185322_orders_write_gate.sql',
      'Backend/platform/template/20260917185322_orders_write_gate.sql'],
    ['workshop-template/verify-orders.sql', 'Backend/platform/template/verify-orders.sql'],
  ];
  for (const [source, packaged] of pairs) assert.equal(migration(packaged), migration(source));
  const packaged = fs.readdirSync(path.join(root, 'Backend/platform/template'))
    .filter(name => name.endsWith('.sql') && name !== 'verify-orders.sql')
    .sort();
  const declared = pairs.map(([, target]) => path.basename(target))
    .filter(name => name.endsWith('.sql') && name !== 'verify-orders.sql')
    .sort();
  assert.deepEqual(packaged, declared,
    'Toda copia empaquetada de la plantilla debe estar declarada y comparada.');
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
    await db.exec(migration('workshop-template/supabase/migrations/20260914030000_workshop_installation_defaults.sql'));
    await db.exec(migration('workshop-template/supabase/migrations/20260917185322_orders_write_gate.sql'));
    await db.query(`insert into public.vehicleapp_installation(singleton, installation_id, schema_version, orders_enabled)
      values(true, $1, 'test', true)`, ['80000000-0000-4000-8000-000000000001']);
    const result = await db.query("select count(*)::int as count from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
    assert.equal(result.rows[0].count, 36);
    const defaults = await db.query(`select
      (select count(*)::int from public.factura_v2_config) as cutover_rows,
      (select count(*)::int from public.app_settings) as settings_rows,
      (select value from public.app_settings where key='admin_bypass_photos') as bypass,
      (select count(*)::int from pg_namespace where nspname='cron') as cron_schema`);
    assert.deepEqual(defaults.rows[0], {
      cutover_rows: 1, settings_rows: 3, bypass: false, cron_schema: 0,
    });
    const acceptance = await db.exec(migration('workshop-template/verify-orders.sql'));
    assert.deepEqual(acceptance.find(result => result.rows?.[0]?.acceptance)?.rows[0].acceptance,
      { formatos: 1, servicios: 1, repuestos: 1, receipts: 3 });
    assert.equal((await db.query('select count(*)::int as count from formatos')).rows[0].count, 0);
    await db.exec('set role authenticated');
    await assert.rejects(db.query("update profiles set role='admin'"), /permission denied/);
    assert.equal((await db.query('select public.vehicleapp_installation_contract() as contract')).rows[0].contract, null);

    await db.exec('reset role');
    await db.query(`insert into auth.users(id, email, raw_user_meta_data)
      values($1, 'gate-test@example.invalid', '{}'::jsonb)`, ['71000000-0000-4000-8000-000000000002']);
    await db.query(`update public.profiles set role='admin' where id=$1`, ['71000000-0000-4000-8000-000000000002']);
    await db.exec(`update public.vehicleapp_installation set orders_enabled=false;
      select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000002',false);
      select set_config('request.jwt.claim.role','authenticated',false);
      set role authenticated;`);
    const payload = JSON.stringify({ data: {
      placa: 'QA9999', marca: 'QA', tipo_vehiculo: 'Prueba',
      nombre_cliente: 'Cliente sintético', tipo_formato: 'SERVICIO', estado: 'ACTIVO',
      costo_mano_obra: 0, costo_repuestos: 0,
    } });
    await assert.rejects(db.query('select public.apply_offline_mutation($1,$2,$3,$4::jsonb)',
      ['72000000-0000-4000-8000-000000000011', 'format.create', 'format:QA9999', payload]),
    /orders_module_disabled/);
    for (const statement of [
      "insert into public.formatos(placa) values('QA9999')",
      "insert into public.servicios(formato_folio, servicio) values('QA9999','Servicio QA')",
      "insert into public.repuestos(formato_folio, descripcion) values('QA9999','Repuesto QA')",
    ]) await assert.rejects(db.query(statement), /orders_module_disabled/);
    assert.equal((await db.query('select count(*)::int as count from public.formatos')).rows[0].count, 0);

    await db.exec('reset role; update public.vehicleapp_installation set orders_enabled=true; set role authenticated;');
    const resumed = await db.query('select public.apply_offline_mutation($1,$2,$3,$4::jsonb) as result',
      ['72000000-0000-4000-8000-000000000011', 'format.create', 'format:QA9999', payload]);
    assert.equal(resumed.rows[0].result.status, 'applied');
    const formatId = resumed.rows[0].result.result.id;
    await db.exec('reset role; update public.vehicleapp_installation set orders_enabled=false; set role authenticated;');
    assert.equal((await db.query('select count(*)::int as count from public.formatos where id=$1',
      [formatId])).rows[0].count, 1);
    await assert.rejects(db.query('update public.formatos set nombre_cliente=$1 where id=$2',
      ['No permitido', formatId]), /orders_module_disabled/);
    await assert.rejects(db.query('delete from public.formatos where id=$1',
      [formatId]), /orders_module_disabled/);
  } finally { await db.close(); }
});
