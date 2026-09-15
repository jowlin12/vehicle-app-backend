'use strict';

// Verifies that an installed workshop is schema-identical to the reviewed
// template and that the parity tool detects every drift category it claims to
// detect: missing, different, extra and dangerous.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');
const {
  compare,
  formatReport,
  snapshot,
  summarize,
} = require('./schema-inventory');
const { migrationTransaction, templates } = require('./provisioning');

const root = path.resolve(__dirname, '../..');
const migration = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const LEDGER = `create table public.vehicleapp_schema_migrations (
  version text primary key, name text not null, applied_at timestamptz not null default now()
);`;

async function database() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    create function auth.jwt() returns jsonb language sql as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth, public to authenticated, anon, service_role;
    grant select on auth.users to service_role;
    create publication supabase_realtime;`);
  return db;
}

async function reference() {
  const db = await database();
  await db.exec(LEDGER);
  await db.exec(migration('workshop-template/supabase/migrations/20260913225816_workshop_baseline.sql'));
  await db.exec(migration('supabase/migrations/20260913225307_installation_contract.sql'));
  await db.exec(migration('workshop-template/supabase/migrations/20260913230822_workshop_access_guards.sql'));
  await db.exec(migration('workshop-template/supabase/migrations/20260914030000_workshop_installation_defaults.sql'));
  return db;
}

async function provisioned() {
  const db = await database();
  await db.exec(LEDGER);
  for (const entry of templates().migrations) await db.exec(migrationTransaction(entry));
  return db;
}

async function withDrift(statement) {
  const db = await provisioned();
  await db.exec(statement);
  return snapshot(db);
}

test('an installed workshop matches the reviewed template', async () => {
  const expectedDb = await reference();
  const actualDb = await provisioned();
  try {
    const expected = await snapshot(expectedDb);
    const actual = await snapshot(actualDb);
    const result = compare(expected, actual);
    assert.equal(result.missing.length, 0, formatReport(result));
    assert.equal(result.different.length, 0, formatReport(result));
    assert.equal(result.dangerous.length, 0, formatReport(result));
    assert.equal(result.extra.length, 0, formatReport(result));
    assert.ok(result.ok.length > 500, `inventario demasiado pequeño: ${result.ok.length}`);
    const counts = kind => [...expected.values()].filter(item => item.kind === kind).length;
    assert.deepEqual(
      {
        table: counts('table'),
        policy: counts('policy'),
        function: counts('function'),
        trigger: counts('trigger'),
        sequence: counts('sequence'),
        rls_enabled: [...expected.values()]
          .filter(item => item.kind === 'rls' && item.def.startsWith('enabled=true')).length,
      },
      { table: 37, policy: 100, function: 104, trigger: 48, sequence: 8, rls_enabled: 36 },
    );
  } finally {
    await expectedDb.close();
    await actualDb.close();
  }
});

test('installation defaults keep the same values in both paths', async () => {
  const expectedDb = await reference();
  const actualDb = await provisioned();
  try {
    const query = `select
      (select count(*)::int from public.factura_v2_config) as cutover_rows,
      (select value from public.app_settings where key = 'admin_bypass_photos') as bypass,
      (select count(*)::int from public.vehicleapp_schema_migrations) as ledger`;
    const expected = (await expectedDb.query(query)).rows[0];
    const actual = (await actualDb.query(query)).rows[0];
    assert.deepEqual(expected, { cutover_rows: 1, bypass: false, ledger: 1 });
    assert.deepEqual(
      { cutover_rows: actual.cutover_rows, bypass: actual.bypass, ledger: 4 },
      { cutover_rows: 1, bypass: false, ledger: 4 },
    );
  } finally {
    await expectedDb.close();
    await actualDb.close();
  }
});

test('installation defaults are idempotent when pg_cron is unavailable', async () => {
  const db = await provisioned();
  try {
    const defaults = migration(
      'workshop-template/supabase/migrations/20260914030000_workshop_installation_defaults.sql',
    );
    await db.exec(defaults);
    await db.exec(defaults);
    const result = (await db.query(`select
      (select count(*)::int from public.factura_v2_config) as cutover_rows,
      (select count(*)::int from public.app_settings where key in (
        'ready_settlement_workflow_enabled',
        'allow_employee_view_finalized',
        'admin_bypass_photos'
      )) as settings,
      (select count(*)::int from public.vehicleapp_schema_migrations
        where version = '20260914030000') as ledger_rows,
      exists(select 1 from pg_namespace where nspname = 'cron') as cron_schema`)).rows[0];
    assert.deepEqual(result, {
      cutover_rows: 1,
      settings: 3,
      ledger_rows: 1,
      cron_schema: false,
    });
  } finally {
    await db.close();
  }
});

test('detects a missing policy as dangerous', async () => {
  const expected = await snapshot(await reference());
  const actual = await withDrift('drop policy app_settings_admin on public.app_settings;');
  const result = compare(expected, actual);
  assert.ok(result.missing.some(item => item.key.endsWith('.app_settings.app_settings_admin')));
  assert.ok(result.dangerous.some(item => item.key.endsWith('.app_settings.app_settings_admin')));
  assert.equal(summarize(result).clean, false);
});

test('detects disabled RLS as dangerous', async () => {
  const expected = await snapshot(await reference());
  const actual = await withDrift('alter table public.formatos disable row level security;');
  const result = compare(expected, actual);
  assert.ok(result.different.some(item => item.kind === 'rls' && item.key === 'public.formatos'));
  assert.ok(result.dangerous.some(item => item.kind === 'rls' && item.key === 'public.formatos'));
});

test('detects a function that lost its fixed search_path', async () => {
  const db = await provisioned();
  let expected;
  let actual;
  try {
    expected = await snapshot(db);
    const picked = (await db.query(`select p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.proconfig is not null
      order by p.proname limit 1`)).rows[0].signature;
    await db.exec(`alter function ${picked} set search_path = public;`);
    actual = await snapshot(db);
  } finally {
    await db.close();
  }
  const result = compare(expected, actual);
  assert.ok(result.different.some(item => item.kind === 'function'));
  assert.ok(result.dangerous.some(item => item.kind === 'function'));
});

test('detects an anonymous grant and a legitimate extra object', async () => {
  const expected = await snapshot(await reference());
  const actual = await withDrift(
    'grant execute on function public.is_current_user_admin() to anon; ' +
      'create table public.legit_extra(id integer); ' +
      'alter table public.legit_extra enable row level security;',
  );
  const result = compare(expected, actual);
  assert.ok(result.extra.some(item => item.kind === 'grant' && item.key.startsWith('anon|')));
  assert.ok(result.dangerous.some(item => item.kind === 'grant' && item.key.startsWith('anon|')));
  const extraTable = result.extra.find(item => item.kind === 'table' && item.key === 'public.legit_extra');
  assert.ok(extraTable);
  assert.ok(!result.dangerous.some(item => item.key === 'public.legit_extra'));
});

test('detects an unexpected SECURITY DEFINER function as dangerous', async () => {
  const expected = await snapshot(await reference());
  const actual = await withDrift(`create function public.unexpected_privileged()
    returns integer language sql security definer set search_path = '' as $$ select 1 $$;`);
  const result = compare(expected, actual);
  assert.ok(
    result.extra.some(
      item => item.kind === 'function' && item.key === 'public.unexpected_privileged()',
    ),
  );
  assert.ok(
    result.dangerous.some(
      item => item.kind === 'function' && item.key === 'public.unexpected_privileged()',
    ),
  );
});

test('detects a dropped function without flagging it dangerous', async () => {
  const db = await provisioned();
  let expected;
  let actual;
  let signature;
  try {
    expected = await snapshot(db);
    signature = (await db.query(`select p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.proname = 'buscar_servicios_frecuentes'
      limit 1`)).rows[0].signature;
    await db.exec(`drop function ${signature};`);
    actual = await snapshot(db);
  } finally {
    await db.close();
  }
  const result = compare(expected, actual);
  const missing = result.missing.find(item => item.kind === 'function' && item.key.includes('buscar_servicios_frecuentes'));
  assert.ok(missing, `firma eliminada: ${signature}`);
  assert.ok(!result.dangerous.some(item => item.key.includes('buscar_servicios_frecuentes')));
});
