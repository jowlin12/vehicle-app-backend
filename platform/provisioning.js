'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { reject } = require('./errors');

const SCHEMA_VERSION = '20260927.1';
const MIGRATION_FILES = [
  '20260913225816_workshop_baseline.sql',
  '20260913225307_installation_contract.sql',
  '20260913230822_workshop_access_guards.sql',
  '20260914030000_workshop_installation_defaults.sql',
  '20260917185322_orders_write_gate.sql',
  '20260925221818_orders_paused_offline_defer.sql',
  '20260926034159_orders_subscription_expiry.sql',
  '20260926120000_supplier_invoices_module.sql',
  '20260926120001_gate_customer_invoices_by_orders_module.sql',
  '20260926163134_settlements_module.sql',
  '20260926174523_workshop_member_session_guards.sql',
  '20260927041754_advance_managed_schema_version_20260926_5.sql',
  '20260927064629_electronic_invoices_module.sql',
];
const MODULE_ACCESS_FIELDS = Object.freeze({
  orders: Object.freeze({ enabled: 'orders_enabled', expiresAt: 'orders_expires_at', label: 'Órdenes' }),
  supplier_invoices: Object.freeze({
    enabled: 'supplier_invoices_enabled',
    expiresAt: 'supplier_invoices_expires_at',
    label: 'Facturas de proveedores',
  }),
  settlements: Object.freeze({
    enabled: 'settlements_enabled',
    expiresAt: 'settlements_expires_at',
    label: 'Liquidaciones',
  }),
  electronic_invoices: Object.freeze({
    enabled: 'electronic_invoices_enabled',
    expiresAt: 'electronic_invoices_expires_at',
    label: 'Facturación electrónica',
  }),
});

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
    `values ('${version}', '${migration.name.replaceAll("'", "''")}')\n` +
    `on conflict (version) do nothing;\ncommit;`;
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

  async function verifyWorkshopInstallation(connection, workshopId, { required = false } = {}) {
    const hasInstallation = rowsFrom(await query(connection, `
      select to_regclass('public.vehicleapp_installation') is not null as has_installation;`))[0]
      ?.has_installation === true;
    if (!hasInstallation) {
      if (required) reject(409, 'managed_installation_missing',
        'La base no contiene una instalación registrada que se pueda actualizar.');
      return null;
    }

    const installation = rowsFrom(await query(connection, `
      select installation_id::text, schema_version
      from public.vehicleapp_installation where singleton;`))[0] || null;
    if (!installation) {
      if (required) reject(409, 'managed_installation_missing',
        'La base no contiene una instalación registrada que se pueda actualizar.');
      return null;
    }
    if (String(installation.installation_id).toLowerCase() !== String(workshopId).toLowerCase()) {
      reject(409, 'installation_mismatch', 'La base de datos ya está vinculada a otro taller.');
    }
    return installation;
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
    await verifyWorkshopInstallation(connection, workshopId);
    await prepareSchema(connection);
    await query(connection, `do $$ begin
      if exists(select 1 from public.vehicleapp_installation where singleton
        and installation_id <> '${workshopId}'::uuid) then
        raise exception 'installation_mismatch';
      end if;
      insert into public.vehicleapp_installation(singleton, installation_id, schema_version,
        verified_at, orders_enabled)
      values (true, '${workshopId}'::uuid, '${SCHEMA_VERSION}', null, false)
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

  async function upgrade({ connection, workshopId }) {
    const db = await verifyProject(connection);
    await verifyWorkshopInstallation(connection, workshopId, { required: true });
    await prepareSchema(connection);
    const { data, error } = await db.from('vehicleapp_installation')
      .select('installation_id, schema_version')
      .eq('singleton', true)
      .maybeSingle();
    if (error || data?.installation_id !== workshopId ||
        data?.schema_version !== SCHEMA_VERSION) {
      reject(409, 'installation_upgrade_failed', 'La instalación no quedó en la versión esperada.');
    }
    return { schemaVersion: data.schema_version };
  }

  async function getModuleAccess({ connection, workshopId, module }) {
    const fields = MODULE_ACCESS_FIELDS[module];
    if (!fields) reject(400, 'unsupported_module', 'El módulo no está disponible en esta versión.');
    const db = makeServiceClient(connection);
    const { data: current, error: readError } = await db.from('vehicleapp_installation')
      .select(`installation_id, verified_at, ${fields.enabled}, ${fields.expiresAt}`)
      .eq('singleton', true)
      .maybeSingle();
    if (readError || current?.installation_id !== workshopId || !current.verified_at) {
      reject(409, 'installation_not_managed', 'La base no es una instalación administrada y verificada.');
    }
    return {
      enabled: current[fields.enabled] === true,
      expiresAt: current[fields.expiresAt] || null,
    };
  }

  async function setModuleEnabled({ connection, workshopId, module, enabled }) {
    const fields = MODULE_ACCESS_FIELDS[module];
    if (!fields) reject(400, 'unsupported_module', 'El módulo no está disponible en esta versión.');
    const current = await getModuleAccess({ connection, workshopId, module });
    if (current.enabled === enabled && current.expiresAt == null) return { enabled };
    const db = makeServiceClient(connection);
    const { data, error } = await db.from('vehicleapp_installation')
      .update({ [fields.enabled]: enabled, [fields.expiresAt]: null })
      .eq('singleton', true)
      .eq('installation_id', workshopId)
      .select(`${fields.enabled}, ${fields.expiresAt}`)
      .maybeSingle();
    if (error || data?.[fields.enabled] !== enabled || data?.[fields.expiresAt] != null) {
      reject(503, 'module_update_failed', `No fue posible cambiar el módulo ${fields.label.toLowerCase()} del taller.`);
    }
    return { enabled };
  }

  async function setModuleAccess({ connection, workshopId, module, enabled, expiresAt }) {
    const fields = MODULE_ACCESS_FIELDS[module];
    if (!fields) reject(400, 'unsupported_module', 'El módulo no está disponible en esta versión.');
    if (typeof enabled !== 'boolean' ||
        (expiresAt != null && !Number.isFinite(Date.parse(expiresAt)))) {
      reject(400, 'invalid_module_access', 'El vencimiento del módulo no es válido.');
    }
    const db = makeServiceClient(connection);
    const current = await getModuleAccess({ connection, workshopId, module });
    const { data, error } = await db.from('vehicleapp_installation')
      .update({ [fields.enabled]: enabled, [fields.expiresAt]: expiresAt })
      .eq('singleton', true)
      .eq('installation_id', workshopId)
      .select(`${fields.enabled}, ${fields.expiresAt}`)
      .maybeSingle();
    const actualValue = data?.[fields.expiresAt];
    const actualExpiry = actualValue == null ? null : Date.parse(actualValue);
    const expectedExpiry = expiresAt == null ? null : Date.parse(expiresAt);
    const expiryMatches = expectedExpiry == null
      ? actualExpiry == null
      : Number.isFinite(actualExpiry) && Math.abs(actualExpiry - expectedExpiry) <= 1000;
    if (error || data?.[fields.enabled] !== enabled ||
        !expiryMatches) {
      reject(503, 'module_access_update_failed', `No fue posible actualizar el acceso al módulo ${fields.label.toLowerCase()}.`);
    }
    return { previous: current, enabled, expiresAt };
  }

  const setOrdersEnabled = input => setModuleEnabled({ ...input, module: 'orders' });
  const getOrdersAccess = input => getModuleAccess({ ...input, module: 'orders' });
  const setOrdersAccess = input => setModuleAccess({ ...input, module: 'orders' });

  return Object.freeze({
    provision,
    upgrade,
    setOrdersEnabled,
    getOrdersAccess,
    setOrdersAccess,
    getModuleAccess,
    setModuleEnabled,
    setModuleAccess,
    schemaVersion: SCHEMA_VERSION,
  });
}

module.exports = { SCHEMA_VERSION, createProvisioner, findUser, migrationTransaction, rowsFrom, templates };
