'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { reject } = require('./errors');

const SCHEMA_VERSION = '20260914.1';
const MIGRATION_FILES = [
  '20260913225816_workshop_baseline.sql',
  '20260913225307_installation_contract.sql',
  '20260913230822_workshop_access_guards.sql',
];

function templates(directory = path.join(__dirname, 'template')) {
  return {
    migrations: MIGRATION_FILES.map(file => ({
      version: file.slice(0, 14),
      name: file,
      sql: fs.readFileSync(path.join(directory, file), 'utf8'),
    })),
    acceptance: fs.readFileSync(path.join(directory, 'verify-orders.sql'), 'utf8'),
  };
}

function migrationTransaction(migration) {
  const begin = /\bbegin\s*;/i.exec(migration.sql);
  const last = migration.sql.toLowerCase().lastIndexOf('commit;');
  if (!begin || last <= begin.index) throw new Error(`Migración sin transacción: ${migration.name}`);
  const body = migration.sql.slice(begin.index + begin[0].length, last);
  const version = migration.version.replace(/[^0-9]/g, '');
  return `begin;\n${body}\ninsert into public.vehicleapp_schema_migrations(version, name)\n` +
    `values ('${version}', '${migration.name.replaceAll("'", "''")}');\ncommit;`;
}

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload.flatMap(rowsFrom);
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return rowsFrom(payload.data);
  if (Array.isArray(payload.result)) return rowsFrom(payload.result);
  if (Array.isArray(payload.rows)) return payload.rows;
  return [payload];
}

async function findUser(auth, email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await auth.admin.listUsers({ page, perPage: 100 });
    if (error) reject(503, 'operational_auth_unavailable', 'No fue posible consultar los usuarios del taller.');
    const user = data.users.find(value => value.email?.toLowerCase() === email);
    if (user || data.users.length < 100) return user || null;
  }
  reject(409, 'user_lookup_limit', 'No fue posible localizar el usuario en la instalación.');
}

function createProvisioner({ fetchImpl = global.fetch, makeServiceClient, template = templates() }) {
  if (typeof fetchImpl !== 'function' || typeof makeServiceClient !== 'function') {
    throw new Error('El aprovisionador requiere HTTP y un cliente Supabase.');
  }

  async function management(connection, pathname, options = {}) {
    let response;
    try {
      response = await fetchImpl(`https://api.supabase.com${pathname}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${connection.managementToken}`,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      reject(503, 'supabase_management_unavailable', 'Supabase no respondió durante la instalación.');
    }
    if (!response.ok) {
      reject(response.status === 401 || response.status === 403 ? 403 : 503,
        'supabase_management_rejected',
        'Supabase rechazó las credenciales o la operación de instalación.');
    }
    if (response.status === 204) return {};
    try { return await response.json(); }
    catch { reject(503, 'supabase_management_invalid', 'Supabase devolvió una respuesta no válida.'); }
  }

  const query = (connection, sql, parameters) => management(
    connection,
    `/v1/projects/${connection.projectRef}/database/query`,
    { method: 'POST', body: JSON.stringify({ query: sql, ...(parameters ? { parameters } : {}) }) },
  );

  async function verifyProject(connection) {
    const project = await management(connection, `/v1/projects/${connection.projectRef}`, { method: 'GET' });
    const returnedRef = project.ref || project.id;
    if (returnedRef !== connection.projectRef) {
      reject(409, 'project_mismatch', 'El token no corresponde al proyecto seleccionado.');
    }
    const db = makeServiceClient(connection);
    const { error } = await db.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) reject(403, 'service_role_rejected', 'La clave service_role no corresponde al proyecto.');
    return db;
  }

  async function prepareSchema(connection) {
    const preflight = rowsFrom(await query(connection, `
      select to_regclass('public.vehicleapp_schema_migrations') is not null as has_ledger,
        coalesce(json_agg(tablename order by tablename)
          filter (where tablename <> 'vehicleapp_schema_migrations'), '[]'::json) as tables
      from pg_tables where schemaname='public';`))[0] || {};
    const tables = Array.isArray(preflight.tables) ? preflight.tables : [];
    if (tables.length && preflight.has_ledger !== true) {
      reject(409, 'project_not_empty', 'El proyecto contiene tablas que no fueron instaladas por VehicleApp.');
    }
    await query(connection, `create table if not exists public.vehicleapp_schema_migrations (
      version text primary key, name text not null, applied_at timestamptz not null default now()
    ); revoke all on public.vehicleapp_schema_migrations from public, anon, authenticated;
    grant select, insert on public.vehicleapp_schema_migrations to service_role;`);

    for (const migration of template.migrations) {
      const applied = rowsFrom(await query(connection,
        'select exists(select 1 from public.vehicleapp_schema_migrations where version=$1) as applied;',
        [migration.version]))[0]?.applied === true;
      if (!applied) await query(connection, migrationTransaction(migration));
    }
  }

  async function ensureOwner(db, email, password) {
    let user = await findUser(db.auth, email);
    if (!user) {
      const result = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: 'Administrador del taller' },
      });
      if (result.error || !result.data?.user) {
        reject(503, 'owner_creation_failed', 'No fue posible crear el administrador del taller.');
      }
      user = result.data.user;
    }
    const profile = await db.from('profiles').update({ role: 'admin' }).eq('id', user.id);
    if (profile.error) reject(503, 'owner_profile_failed', 'No fue posible asignar el administrador del taller.');
    return user.id;
  }

  async function provision({ connection, workshopId, ownerEmail, ownerPassword }) {
    const db = await verifyProject(connection);
    await prepareSchema(connection);
    await query(connection, `do $$ begin
      if exists(select 1 from public.vehicleapp_installation where singleton
        and installation_id <> '${workshopId}'::uuid) then
        raise exception 'installation_mismatch';
      end if;
      insert into public.vehicleapp_installation(singleton, installation_id, schema_version,
        verified_at, orders_enabled)
      values (true, '${workshopId}'::uuid, '${SCHEMA_VERSION}', null, true)
      on conflict(singleton) do update set schema_version=excluded.schema_version;
    end $$;`);
    const operationalUserId = await ensureOwner(db, ownerEmail, ownerPassword);
    const acceptance = rowsFrom(await query(connection, template.acceptance))
      .find(row => row?.acceptance)?.acceptance;
    if (!acceptance || Number(acceptance.formatos) !== 1 || Number(acceptance.servicios) !== 1 ||
        Number(acceptance.repuestos) !== 1 || Number(acceptance.receipts) !== 3) {
      reject(409, 'acceptance_failed', 'La instalación no superó la prueba de órdenes.');
    }
    await query(connection, `update public.vehicleapp_installation
      set verified_at=now(), schema_version='${SCHEMA_VERSION}'
      where singleton and installation_id='${workshopId}'::uuid;`);
    return { operationalUserId, schemaVersion: SCHEMA_VERSION };
  }

  return Object.freeze({ provision });
}

module.exports = { SCHEMA_VERSION, createProvisioner, findUser, migrationTransaction, rowsFrom, templates };
