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
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id));
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    create function auth.jwt() returns jsonb language sql as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create schema storage;
    create table storage.buckets(id text primary key, name text not null, public boolean not null,
      file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null);
    alter table storage.objects enable row level security;
    grant usage on schema auth, public to authenticated, anon, service_role;
    grant usage on schema storage to authenticated, service_role;
    grant insert, select on storage.objects to authenticated;
    grant all on storage.objects to service_role;
    grant select, insert, update on storage.buckets to service_role;
    grant select on auth.users to service_role;`);
  return db;
}

test('central schema: atomic registration, retry, conflict and no direct client access', async () => {
  const db = await database();
  try {
    await db.exec(migration('platform-control/supabase/migrations/20260913225303_platform_control.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260914010000_managed_workshop_connections.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260914011500_platform_control_indexes.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260919212618_adopt_existing_workshop_preview.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260926055141_manual_subscription_billing.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260926055149_subscription_module_entitlements.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260927054139_facturatech_workshop_profiles.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260927055332_facturatech_idempotent_number_reservations.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260927070133_facturatech_submission_state.sql'));
    const fiscalTable = await db.query(`select c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='platform_facturatech_profiles'`);
    assert.equal(fiscalTable.rows[0]?.relrowsecurity, true);
    const reservationTables = await db.query(`select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname in (
        'platform_facturatech_number_series', 'platform_facturatech_number_reservations'
      ) order by c.relname`);
    assert.deepEqual(reservationTables.rows.map(row => [row.relname, row.relrowsecurity]), [
      ['platform_facturatech_number_reservations', true],
      ['platform_facturatech_number_series', true],
    ]);
    await db.query('insert into auth.users(id) values($1),($2)', [admin, owner]);
    await db.query('insert into platform_admins(user_id) values($1)', [admin]);
    await db.exec('set role service_role');
    const register = (name = 'Taller sintético') => db.query(
      'select (public.platform_register_workshop($1,$2,$3,$4,$5,$6)).*',
      [admin, requestId, name, owner, 'test-a', ['orders']]);
    const first = (await register()).rows[0];
    assert.equal(first.status, 'pending');
    assert.equal((await register()).rows[0].id, first.id);
    assert.equal((await db.query('select count(*)::int as count from platform_memberships')).rows[0].count, 1);
    await db.query(`update platform_workshops set status='ready', schema_version='managed-v1'
      where id=$1`, [first.id]);
    const fiscalCiphertext = 'v1.encrypted-facturatech-profile';
    await db.query(`insert into platform_facturatech_profiles(workshop_id,
      configuration_ciphertext,updated_by) values($1,$2,$3)`, [first.id, fiscalCiphertext, admin]);
    assert.equal((await db.query(`select configuration_ciphertext
      from platform_facturatech_profiles where workshop_id=$1`, [first.id])).rows[0].configuration_ciphertext,
    fiscalCiphertext);

    const reserve = (workshopId, idempotencyKey, sourceFingerprint, requestFingerprint,
      prefix = 'MT', resolution = 'RES-001', rangeStart = 1, rangeEnd = 12) => db.query(
      `select public.platform_reserve_facturatech_number(
        $1,$2,$3,$4,$5,$6,$7,$8
      ) as result`, [workshopId, idempotencyKey, sourceFingerprint, requestFingerprint,
        prefix, resolution, rangeStart, rangeEnd]);
    const fp = digit => digit.repeat(64);
    const firstNumber = (await reserve(first.id, 'invoice-0001', fp('a'), fp('b'))).rows[0].result;
    assert.equal(firstNumber.created, true);
    assert.equal(firstNumber.number, 1);
    const retry = (await reserve(first.id, 'invoice-0001', fp('a'), fp('b'))).rows[0].result;
    assert.equal(retry.created, false);
    assert.equal(retry.id, firstNumber.id);
    assert.equal(retry.number, 1);
    await assert.rejects(reserve(first.id, 'invoice-0001', fp('a'), fp('c')), /idempotency_conflict/);

    const claim = async () => (await db.query(
      'select public.platform_claim_facturatech_submission($1,$2,$3) as result',
      [first.id, 'invoice-0001', fp('b')],
    )).rows[0].result;
    const firstClaim = await claim();
    assert.equal(firstClaim.claimed, true);
    assert.equal(firstClaim.state, 'submitting');
    const duplicateClaim = await claim();
    assert.equal(duplicateClaim.claimed, false);
    assert.equal(duplicateClaim.state, 'submitting');

    const recordSubmission = async (state, transactionId = null, providerStatus = null) =>
      (await db.query(`select public.platform_record_facturatech_submission(
        $1,$2,$3,$4,$5,$6
      ) as result`, [first.id, 'invoice-0001', fp('b'), state, transactionId, providerStatus]))
        .rows[0].result;
    const uncertain = await recordSubmission('uncertain', 'provider-tx-1', 'RECEIVED');
    assert.equal(uncertain.state, 'uncertain');
    assert.equal(uncertain.transactionId, 'provider-tx-1');
    assert.equal((await claim()).claimed, false);
    const submitted = await recordSubmission('submitted', 'provider-tx-1', '201');
    assert.equal(submitted.state, 'submitted');
    assert.equal((await claim()).state, 'submitted');
    await assert.rejects(recordSubmission('validated', 'provider-tx-other', '201'),
      /facturatech_transaction_conflict/);

    const concurrent = await Promise.all(Array.from({length: 11}, (_, index) => {
      const sequence = String(index + 2).padStart(4, '0');
      return reserve(first.id, `invoice-${sequence}`, fp((index + 1).toString(16)),
        fp((index + 2).toString(16)));
    }));
    const concurrentNumbers = concurrent.map(result => result.rows[0].result.number).sort((a, b) => a - b);
    assert.deepEqual(concurrentNumbers, Array.from({length: 11}, (_, index) => index + 2));
    await assert.rejects(reserve(first.id, 'invoice-0013', fp('c'), fp('d')), /facturatech_numbering_exhausted/);
    const extendedRange = (await reserve(first.id, 'invoice-0014', fp('d'), fp('e'),
      'MT', 'RES-001', 1, 13)).rows[0].result;
    assert.equal(extendedRange.number, 13);
    const simultaneousRetry = await Promise.all(Array.from({length: 5}, () =>
      reserve(first.id, 'invoice-0014', fp('d'), fp('e'))));
    assert.ok(simultaneousRetry.every(result => result.rows[0].result.id === extendedRange.id));
    assert.ok(simultaneousRetry.every(result => result.rows[0].result.created === false));
    const jumpedRange = (await reserve(first.id, 'invoice-0015', fp('e'), fp('f'),
      'MT', 'RES-002', 20, 21)).rows[0].result;
    assert.equal(jumpedRange.number, 20);
    await assert.rejects(reserve(first.id, 'invoice-0016', fp('f'), fp('a'),
      'MT', 'RES-002', 1, 19), /facturatech_numbering_exhausted/);

    const second = (await db.query(
      'select (public.platform_register_workshop($1,$2,$3,$4,$5,$6)).*',
      [admin, '20000000-0000-4000-8000-000000000002', 'Taller aislado', owner,
        'test-b', ['orders']],
    )).rows[0];
    await db.query(`update platform_workshops set status='ready', schema_version='managed-v1'
      where id=$1`, [second.id]);
    await db.query(`insert into platform_facturatech_profiles(workshop_id,
      configuration_ciphertext,updated_by) values($1,$2,$3)`, [second.id, fiscalCiphertext, admin]);
    const independent = (await reserve(second.id, 'invoice-second', fp('a'), fp('b'))).rows[0].result;
    assert.equal(independent.number, 1);
    await db.query(`update platform_workshops set schema_version='legacy-existing-v1'
      where id=$1`, [second.id]);
    const legacyRetry = (await reserve(second.id, 'invoice-second', fp('a'), fp('b'))).rows[0].result;
    assert.equal(legacyRetry.id, independent.id);
    await assert.rejects(reserve(second.id, 'invoice-legacy-new', fp('c'), fp('d')),
      /facturatech_workshop_unavailable/);
    await db.query(`insert into platform_workshop_connections(workshop_id, connection_ref,
      project_ref, project_url, publishable_key, service_role_secret,
      management_token_secret, created_by) values($1,$2,$2,$3,$4,$5,$6,$7)`, [
      first.id, 'abcdefghijklmnopqrst', 'https://abcdefghijklmnopqrst.supabase.co',
      'sb_publishable_example_key', 'v1.encrypted.service', 'v1.encrypted.management', admin,
    ]);
    await assert.rejects(register('Otro nombre'), /idempotency_conflict/);
    assert.equal((await db.query('select count(*)::int as count from platform_memberships')).rows[0].count, 2);
    await assert.rejects(db.query('select public.platform_register_workshop($1,$2,$3,$4,$5,$6)',
      [owner, requestId, 'No autorizado', owner, 'test-b', ['orders']]), /platform_admin_required/);
    await db.exec('reset role; set role authenticated');
    await assert.rejects(db.query('select * from public.platform_workshops'), /permission denied/);
    await assert.rejects(db.query('select * from public.platform_workshop_connections'), /permission denied/);
    await assert.rejects(db.query('select * from public.platform_plans'), /permission denied/);
    await assert.rejects(db.query('select * from public.platform_subscription_requests'), /permission denied/);
    await assert.rejects(db.query('select * from public.platform_facturatech_profiles'), /permission denied/);
    await assert.rejects(db.query('select * from public.platform_facturatech_number_series'), /permission denied/);
    await assert.rejects(db.query('select * from public.platform_facturatech_number_reservations'), /permission denied/);
    await assert.rejects(db.query(`select public.platform_claim_facturatech_submission(
      null,null,null
    )`), /permission denied/);
    await assert.rejects(db.query(`select public.platform_reserve_facturatech_number(
      null,null,null,null,null,null,null,null
    )`), /permission denied/);
    await assert.rejects(register(), /permission denied/);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.platform_facturatech_profiles'), /permission denied/);
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
    ['workshop-template/supabase/migrations/20260925221818_orders_paused_offline_defer.sql',
      'Backend/platform/template/20260925221818_orders_paused_offline_defer.sql'],
    ['workshop-template/supabase/migrations/20260926034159_orders_subscription_expiry.sql',
      'Backend/platform/template/20260926034159_orders_subscription_expiry.sql'],
    ['workshop-template/supabase/migrations/20260926120000_supplier_invoices_module.sql',
      'Backend/platform/template/20260926120000_supplier_invoices_module.sql'],
    ['workshop-template/supabase/migrations/20260926120001_gate_customer_invoices_by_orders_module.sql',
      'Backend/platform/template/20260926120001_gate_customer_invoices_by_orders_module.sql'],
    ['workshop-template/supabase/migrations/20260926163134_settlements_module.sql',
      'Backend/platform/template/20260926163134_settlements_module.sql'],
    ['workshop-template/verify-orders.sql', 'Backend/platform/template/verify-orders.sql'],
    ['workshop-template/supabase/migrations/20260926174523_workshop_member_session_guards.sql',
      'Backend/platform/template/20260926174523_workshop_member_session_guards.sql'],
    ['workshop-template/supabase/migrations/20260927041754_advance_managed_schema_version_20260926_5.sql',
      'Backend/platform/template/20260927041754_advance_managed_schema_version_20260926_5.sql'],
    ['workshop-template/supabase/migrations/20260927064629_electronic_invoices_module.sql',
      'Backend/platform/template/20260927064629_electronic_invoices_module.sql'],
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
    await db.exec(migration('workshop-template/supabase/migrations/20260925221818_orders_paused_offline_defer.sql'));
    await db.exec(migration('workshop-template/supabase/migrations/20260926034159_orders_subscription_expiry.sql'));
    await db.exec(migration('workshop-template/supabase/migrations/20260926120000_supplier_invoices_module.sql'));
    await db.exec(migration('workshop-template/supabase/migrations/20260926120001_gate_customer_invoices_by_orders_module.sql'));
    await db.exec(migration('workshop-template/supabase/migrations/20260926163134_settlements_module.sql'));
    await db.exec(migration('workshop-template/supabase/migrations/20260926174523_workshop_member_session_guards.sql'));
    await db.exec(migration('workshop-template/supabase/migrations/20260927041754_advance_managed_schema_version_20260926_5.sql'));
    await db.exec(migration('workshop-template/supabase/migrations/20260927064629_electronic_invoices_module.sql'));
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
    await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
    await assert.rejects(db.query('select public.vehicleapp_installation_contract()'), /workshop_access_revoked/);

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
    const deferred = await db.query('select public.apply_offline_mutation($1,$2,$3,$4::jsonb) as result',
      ['72000000-0000-4000-8000-000000000011', 'format.create', 'format:QA9999', payload]);
    assert.equal(deferred.rows[0].result.status, 'deferred');
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
    await db.exec('reset role; set role authenticated;');
    await db.query(`update public.formatos
      set costo_mano_obra=40000, costo_total=40000 where id=$1`, [formatId]);
    const invoiceKey = (await db.query(
      'select clave_key from public.formatos where id=$1', [formatId],
    )).rows[0].clave_key;
    const invoiceId = (await db.query(
      'select id from public.facturas where id_formato=$1', [invoiceKey],
    )).rows[0].id;
    await db.query(
      `select public.registrar_abono_v2(1000, current_date, $1, 'REGISTRADO_APP')`,
      [invoiceKey],
    );
    await db.exec('reset role; update public.vehicleapp_installation set orders_enabled=false; set role authenticated;');
    assert.equal((await db.query('select count(*)::int as count from public.formatos where id=$1',
      [formatId])).rows[0].count, 1);
    await assert.rejects(db.query('update public.formatos set nombre_cliente=$1 where id=$2',
      ['No permitido', formatId]), /orders_module_disabled/);
    await assert.rejects(db.query('delete from public.formatos where id=$1',
      [formatId]), /orders_module_disabled/);

    await db.exec(`reset role;
      update public.vehicleapp_installation set orders_enabled=true,
        orders_expires_at='2000-01-01T00:00:00Z';
      set role authenticated;`);
    const expired = await db.query('select public.apply_offline_mutation($1,$2,$3,$4::jsonb) as result',
      ['72000000-0000-4000-8000-000000000012', 'format.create', 'format:QA9998', payload]);
    assert.equal(expired.rows[0].result.status, 'deferred');
    await assert.rejects(db.query("insert into public.formatos(placa) values('QA9998')"), /orders_module_disabled/);

    const supplierPayload = JSON.stringify({ data: {
      id_formato: formatId,
      proveedor: 'Proveedor QA',
      monto: 50000,
      fecha: '2026-09-26T10:00:00Z',
      url_imagen: 'https://drive.example/receipt.jpg',
      created_at: '2026-09-26T10:00:00Z',
    } });
    const supplierDeferred = await db.query(
      'select public.apply_offline_mutation($1,$2,$3,$4::jsonb) as result',
      ['72000000-0000-4000-8000-000000000013', 'supplier_invoice.create', 'supplier-invoice:QA', supplierPayload],
    );
    assert.equal(supplierDeferred.rows[0].result.status, 'deferred');
    await db.exec('reset role; set role anon;');
    await assert.rejects(
      db.query('select count(*) from public.facturas_proveedores'),
      /permission denied/,
    );
    await db.exec('reset role; set role authenticated;');
    await assert.rejects(db.query("insert into public.facturas_proveedores(id_formato,proveedor,monto) values($1::uuid,'Proveedor QA',50000)",
      [formatId]), /supplier_invoices_module_disabled/);
    assert.equal((await db.query('select count(*)::int as count from public.facturas_proveedores')).rows[0].count, 0);

    await db.exec(`reset role;
      update public.vehicleapp_installation set supplier_invoices_enabled=true,
        supplier_invoices_expires_at='2099-01-01T00:00:00Z';
      set role authenticated;`);
    const supplierApplied = await db.query(
      'select public.apply_offline_mutation($1,$2,$3,$4::jsonb) as result',
      ['72000000-0000-4000-8000-000000000013', 'supplier_invoice.create', 'supplier-invoice:QA', supplierPayload],
    );
    assert.equal(supplierApplied.rows[0].result.status, 'applied');
    assert.equal((await db.query('select count(*)::int as count from public.facturas_proveedores')).rows[0].count, 1);

    await db.exec(`reset role;
      update public.vehicleapp_installation set supplier_invoices_expires_at='2000-01-01T00:00:00Z';
      set role authenticated;`);
    assert.equal((await db.query('select count(*)::int as count from public.facturas_proveedores')).rows[0].count, 0);
    await assert.rejects(db.query("insert into public.facturas_proveedores(id_formato,proveedor,monto) values($1::uuid,'Proveedor vencido',50000)",
      [formatId]), /supplier_invoices_module_disabled/);
    const supplierExpired = await db.query(
      'select public.apply_offline_mutation($1,$2,$3,$4::jsonb) as result',
      ['72000000-0000-4000-8000-000000000014', 'supplier_invoice.create', 'supplier-invoice:QA-expired', supplierPayload],
    );
    assert.equal(supplierExpired.rows[0].result.status, 'deferred');

    assert.equal((await db.query('select public.orders_module_active() as active')).rows[0].active, false);
    assert.equal((await db.query('select count(*)::int as count from public.facturas')).rows[0].count, 0);
    assert.equal((await db.query('select count(*)::int as count from public.abonos')).rows[0].count, 0);
    await assert.rejects(
      db.query('select * from public.listar_facturas_v2($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        ['PENDIENTE', null, null, null, false, 'all', 25, 0, null]),
      /orders_module_disabled/,
    );
    await assert.rejects(
      db.query('select public.obtener_factura_v2($1)', [invoiceId]),
      /orders_module_disabled/,
    );
    await assert.rejects(
      db.query('select * from public.crear_o_actualizar_factura_desde_formato($1)', [invoiceKey]),
      /orders_module_disabled/,
    );
    await assert.rejects(
      db.query(
        `select public.registrar_abono_v2(1000, current_date, $1, 'REGISTRADO_APP')`,
        [invoiceKey],
      ),
      /orders_module_disabled/,
    );
    for (const [index, kind] of [
      'invoice.payment_create', 'invoice.payment_delete', 'invoice.delete', 'invoice.detach',
    ].entries()) {
      const queued = await db.query(
        'select public.apply_offline_mutation($1,$2,$3,$4::jsonb) as result',
        [`72000000-0000-4000-8000-${String(index + 21).padStart(12, '0')}`,
          kind, `invoice:deferred:${kind}`, '{}'],
      );
      assert.equal(queued.rows[0].result.status, 'deferred', `${kind} stays queued`);
    }

    await db.exec(`reset role;
      update public.vehicleapp_installation set orders_enabled=true,
        orders_expires_at='2000-01-01T00:00:00Z';
      set role authenticated;`);
    assert.equal((await db.query('select public.orders_module_active() as active')).rows[0].active, false);
    const expiredInvoicePayment = await db.query(
      'select public.apply_offline_mutation($1,$2,$3,$4::jsonb) as result',
      ['72000000-0000-4000-8000-000000000025', 'invoice.payment_create', 'invoice:expired', '{}'],
    );
    assert.equal(expiredInvoicePayment.rows[0].result.status, 'deferred');

    await db.exec(`reset role;
      update public.vehicleapp_installation set orders_enabled=true,
        orders_expires_at='2099-01-01T00:00:00Z';
      set role authenticated;`);
    assert.equal((await db.query('select public.orders_module_active() as active')).rows[0].active, true);
    assert.equal((await db.query('select count(*)::int as count from public.facturas')).rows[0].count, 1);
    assert.equal((await db.query('select count(*)::int as count from public.abonos')).rows[0].count, 1);
    assert.equal((await db.query(
      'select count(*)::int as count from public.listar_facturas_v2($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [null, null, null, null, false, 'all', 25, 0, null],
    )).rows[0].count, 1);
  } finally { await db.close(); }
});

test('manual subscriptions keep receipts private and grant only approved plan time', async () => {
  const db = await database();
  const adminId = '10000000-0000-4000-8000-000000000011';
  const ownerId = '10000000-0000-4000-8000-000000000012';
  const outsiderId = '10000000-0000-4000-8000-000000000013';
  const requestId = '90000000-0000-4000-8000-000000000011';
  try {
    await db.exec(migration('platform-control/supabase/migrations/20260913225303_platform_control.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260914010000_managed_workshop_connections.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260914011500_platform_control_indexes.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260919212618_adopt_existing_workshop_preview.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260926055141_manual_subscription_billing.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260926055149_subscription_module_entitlements.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260926221008_subscription_settlements_module.sql'));
    await db.exec(migration('platform-control/supabase/migrations/20260927064629_subscription_electronic_invoices_module.sql'));
    await db.query('insert into auth.users(id) values($1),($2),($3)', [adminId, ownerId, outsiderId]);
    await db.query('insert into platform_admins(user_id) values($1)', [adminId]);
    await db.exec('set role service_role');
    const workshop = (await db.query(
      `select (public.platform_register_workshop($1,$2,$3,$4,$5,$6)).*`,
      [adminId, '90000000-0000-4000-8000-000000000012', 'Plan QA', ownerId, 'subscription-qa', []],
    )).rows[0];
    const workshopId = workshop.id;
    const receiptPath = `${workshopId}/${requestId}.jpg`;
    await db.query("update platform_workshops set status='ready', schema_version='managed-v1' where id=$1", [workshopId]);
    assert.deepEqual(workshop.modules, []);
    assert.equal(workshop.subscription_required, true);

    await db.exec(`insert into storage.objects(bucket_id, name)
      values ('platform-payment-receipts', '${receiptPath}')`);
    const planId = 'a0000000-0000-4000-8000-000000000011';
    await db.query(`insert into platform_plans(id,code,name,price_cop,duration_days,modules,created_by)
      values($1,'basico','Plan básico',50000,30,array['orders','supplier_invoices','settlements','electronic_invoices']::text[],$2)`, [planId, adminId]);
    const submitted = (await db.query(
      'select public.platform_submit_subscription_request($1,$2,$3,$4,$5,$6) as result',
      [workshopId, requestId, ownerId, planId, receiptPath, 'TRX-123'],
    )).rows[0].result;
    assert.equal(submitted.created, true);
    assert.equal(submitted.request.status, 'pending');
    assert.equal(submitted.request.plan_snapshot.duration_days, 30);
    assert.deepEqual(submitted.workshop.review_modules, ['electronic_invoices', 'orders', 'settlements', 'supplier_invoices']);
    assert.deepEqual(submitted.workshop.modules, ['electronic_invoices', 'orders', 'settlements', 'supplier_invoices']);
    assert.ok(Date.parse(submitted.workshop.review_access_until) > Date.now());
    await assert.rejects(db.query(
      'select public.platform_submit_subscription_request($1,$2,$3,$4,$5,$6)',
      [workshopId, '90000000-0000-4000-8000-000000000099', outsiderId, planId,
        `${workshopId}/90000000-0000-4000-8000-000000000099.jpg`, ''],
    ), /subscription_manager_required/);
    await assert.rejects(db.query(
      'select public.platform_submit_subscription_request($1,$2,$3,$4,$5,$6)',
      [workshopId, '90000000-0000-4000-8000-000000000098', ownerId, planId,
        `${workshopId}/90000000-0000-4000-8000-000000000098.svg`, ''],
    ), /invalid_subscription_receipt_path/);

    const claimed = (await db.query(
      'select public.platform_claim_subscription_request($1,$2,$3) as request',
      [requestId, adminId, 'approve'],
    )).rows[0].request;
    assert.equal(claimed.status, 'reviewing');
    assert.ok(Date.parse(claimed.active_until) > Date.now());
    const finalized = (await db.query(
      'select public.platform_finish_subscription_request($1,$2,$3,$4) as result',
      [requestId, adminId, 'approve', 'Transferencia verificada'],
    )).rows[0].result;
    assert.equal(finalized.request.status, 'approved');
    assert.deepEqual(finalized.workshop.modules, ['electronic_invoices', 'orders', 'settlements', 'supplier_invoices']);
    assert.deepEqual(finalized.workshop.paid_modules, ['electronic_invoices', 'orders', 'settlements', 'supplier_invoices']);
    assert.deepEqual(finalized.workshop.review_modules, []);
    assert.equal(finalized.workshop.active_plan_id, planId);
    assert.ok(Date.parse(finalized.workshop.paid_until) > Date.now());
    assert.equal(finalized.workshop.review_access_until, null);

    const ordersOnlyPlanId = 'a0000000-0000-4000-8000-000000000012';
    await db.query(`insert into platform_plans(id,code,name,price_cop,duration_days,modules,created_by)
      values($1,'ordenes','Solo órdenes',30000,30,array['orders']::text[],$2)`, [ordersOnlyPlanId, adminId]);
    await assert.rejects(db.query(
      'select public.platform_submit_subscription_request($1,$2,$3,$4,$5,$6)',
      [workshopId, '90000000-0000-4000-8000-000000000022', ownerId, ordersOnlyPlanId,
        `${workshopId}/90000000-0000-4000-8000-000000000022.jpg`, ''],
    ), /subscription_plan_change_waits_until_expiry/);

    const paidUntil = finalized.workshop.paid_until;
    const rejectedRequestId = '90000000-0000-4000-8000-000000000021';
    const rejectedPath = `${workshopId}/${rejectedRequestId}.jpg`;
    const renewal = (await db.query(
      'select public.platform_submit_subscription_request($1,$2,$3,$4,$5,$6) as result',
      [workshopId, rejectedRequestId, ownerId, planId, rejectedPath, 'TRX-456'],
    )).rows[0].result;
    assert.ok(Date.parse(renewal.workshop.review_access_until) > Date.now());
    const rejectionClaim = (await db.query(
      'select public.platform_claim_subscription_request($1,$2,$3) as request',
      [rejectedRequestId, adminId, 'reject'],
    )).rows[0].request;
    assert.equal(rejectionClaim.status, 'reviewing');
    const rejected = (await db.query(
      'select public.platform_finish_subscription_request($1,$2,$3,$4) as result',
      [rejectedRequestId, adminId, 'reject', 'No aparece en cuenta'],
    )).rows[0].result;
    assert.equal(rejected.request.status, 'rejected');
    const afterRejection = (await db.query(
      'select paid_until, review_access_until, modules, paid_modules, review_modules from platform_workshops where id=$1', [workshopId],
    )).rows[0];
    assert.equal(new Date(afterRejection.paid_until).getTime(), Date.parse(paidUntil));
    assert.equal(afterRejection.review_access_until, null);
    assert.deepEqual(afterRejection.modules, ['electronic_invoices', 'orders', 'settlements', 'supplier_invoices']);
    assert.deepEqual(afterRejection.paid_modules, ['electronic_invoices', 'orders', 'settlements', 'supplier_invoices']);
    assert.deepEqual(afterRejection.review_modules, []);

    await db.exec(`select set_config('request.jwt.claim.sub','${ownerId}',false);
      select set_config('request.jwt.claim.role','authenticated',false);
      set role authenticated;`);
    assert.equal((await db.query(`select count(*)::int as count from storage.objects
      where bucket_id='platform-payment-receipts' and name=$1`, [receiptPath])).rows[0].count, 1);
    await db.exec(`reset role;
      select set_config('request.jwt.claim.sub','${outsiderId}',false);
      set role authenticated;`);
    assert.equal((await db.query(`select count(*)::int as count from storage.objects
      where bucket_id='platform-payment-receipts' and name=$1`, [receiptPath])).rows[0].count, 0);
    await db.exec('reset role');
    await assert.rejects(db.query(
      'select public.platform_claim_subscription_request($1,$2,$3)', [requestId, outsiderId, 'approve'],
    ), /platform_admin_required/);
  } finally { await db.close(); }
});
