'use strict';

// Builds the expected schema inventory of a freshly installed workshop from
// the packaged template, using an embedded PostgreSQL. The JSON result is the
// reference for `schema-inventory.js compare`.
//
//   node platform/schema-baseline.js baseline.json

const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');
const { snapshot } = require('./schema-inventory');
const { migrationTransaction, templates } = require('./provisioning');

async function buildBaseline() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
      create function auth.jwt() returns jsonb language sql as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      grant usage on schema auth, public to authenticated, anon, service_role;
      grant select on auth.users to service_role;
      create publication supabase_realtime;
      create table public.vehicleapp_schema_migrations (
        version text primary key, name text not null, applied_at timestamptz not null default now()
      );`);
    for (const entry of templates().migrations) await db.exec(migrationTransaction(entry));
    const inventory = await snapshot(db);
    return [...inventory.values()];
  } finally {
    await db.close();
  }
}

/* istanbul ignore next */
async function main() {
  const target = process.argv[2] || 'schema-baseline.json';
  const inventory = await buildBaseline();
  fs.writeFileSync(path.resolve(target), `${JSON.stringify(inventory, null, 2)}\n`);
  process.stdout.write(`Inventario de la plantilla escrito en ${target} (${inventory.length} objetos).\n`);
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { buildBaseline };
