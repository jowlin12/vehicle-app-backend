'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');
const { templates, migrationTransaction } = require('./provisioning');

const USER = '10000000-0000-4000-8000-000000000001';
const WORKSHOP = '80000000-0000-4000-8000-000000000001';

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
  for (const migration of templates().migrations) await db.exec(migrationTransaction(migration));
  await db.query('insert into auth.users(id,email) values($1,$2)', [USER, 'qa@example.invalid']);
  await db.query("update public.profiles set role='admin',is_active=true where id=$1", [USER]);
  await db.query(`insert into public.vehicleapp_installation(
      singleton,installation_id,schema_version,orders_enabled
    ) values(true,$1,'test',true)`, [WORKSHOP]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [USER]);
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
  await db.exec('set role authenticated');
  return db;
}

test('electronic invoices require an active module for writes and preserve history when paused', async () => {
  const db = await fixture();
  try {
    const formatId = '71000000-0000-4000-8000-000000000001';
    await db.query(`insert into public.formatos(
        id,folio,fecha_entrada,estado,created_at,is_development,created_by,clave_key,placa
      ) values($1,'QA-1',current_date,'ACTIVO',now(),false,$2,'qa-format-key','QA1234')`, [formatId, USER]);

    await assert.rejects(db.query(`insert into public.facturas_electronicas(
      transaction_id,id_formato,prefijo,numero_factura,estado,total
    ) values('qa-inactive','qa-format-key','QA',1,'PREVIEW',100)`),
    /electronic_invoices_module_disabled/);
    assert.equal((await db.query(
      'select public.electronic_invoices_module_active() as active',
    )).rows[0].active, false);

    await db.exec('reset role');
    await db.query(`update public.vehicleapp_installation set
      electronic_invoices_enabled=true,
      electronic_invoices_expires_at='2099-01-01T00:00:00Z' where singleton`);
    await db.exec('set role authenticated');
    assert.equal((await db.query(
      'select public.electronic_invoices_module_active() as active',
    )).rows[0].active, true);
    const invoice = (await db.query(`insert into public.facturas_electronicas(
      transaction_id,id_formato,prefijo,numero_factura,estado,total
    ) values('qa-active','qa-format-key','QA',1,'PREVIEW',100) returning id`)).rows[0];

    await db.exec('reset role');
    await db.query(`update public.vehicleapp_installation set
      electronic_invoices_expires_at='2000-01-01T00:00:00Z' where singleton`);
    await db.exec('set role authenticated');
    assert.equal((await db.query(
      'select count(*)::int as n from public.facturas_electronicas where id=$1',
      [invoice.id],
    )).rows[0].n, 1);
    await assert.rejects(db.query(
      'update public.facturas_electronicas set response_message=$1 where id=$2',
      ['No permitido', invoice.id],
    ), /electronic_invoices_module_disabled/);
    await assert.rejects(db.query(
      'delete from public.facturas_electronicas where id=$1', [invoice.id],
    ), /electronic_invoices_module_disabled/);
    await assert.rejects(db.query('truncate public.facturas_electronicas'), /permission denied/);
  } finally { await db.close(); }
});
