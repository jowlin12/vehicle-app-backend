'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProvisioner, migrationTransaction } = require('./provisioning');

const connection = {
  projectRef: 'abcdefghijklmnopqrst',
  url: 'https://abcdefghijklmnopqrst.supabase.co',
  publishableKey: 'sb_publishable_example_key',
  serviceRoleKey: 'service-role-secret',
  managementToken: 'management-token-secret',
};

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('migration wrapper records the version inside the same transaction', () => {
  const sql = migrationTransaction({ version: '20260914010101', name: 'test.sql', sql: 'begin;\ncreate table sample(id int);\ncommit;' });
  assert.match(sql, /^begin;/);
  assert.match(sql, /create table sample/);
  assert.match(sql, /vehicleapp_schema_migrations/);
  assert.match(sql, /commit;$/);
});

test('provisioning validates, installs, creates owner and verifies a rollback acceptance', async () => {
  const queries = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer management-token-secret');
    if (options.method === 'GET') return response({ ref: connection.projectRef });
    const body = JSON.parse(options.body);
    queries.push(body.query);
    if (body.query.includes("to_regclass('public.vehicleapp_installation')")) {
      return response([{ has_installation: false }]);
    }
    if (body.query.includes('to_regclass')) return response([{ has_ledger: false, tables: [] }]);
    if (body.query.includes('select exists')) return response([{ applied: false }]);
    if (body.query.includes('as acceptance')) {
      return response([{ acceptance: { formatos: 1, servicios: 1, repuestos: 1, receipts: 3 } }]);
    }
    return response([]);
  };
  let listCalls = 0;
  const db = {
    auth: { admin: {
      listUsers: async () => ({ data: { users: listCalls++ ? [] : [] }, error: null }),
      createUser: async () => ({ data: { user: { id: '90000000-0000-4000-8000-000000000001' } }, error: null }),
    } },
    from: table => {
      assert.equal(table, 'profiles');
      return { update: values => ({ eq: async () => {
        assert.equal(values.role, 'admin');
        return { error: null };
      } }) };
    },
  };
  const provisioner = createProvisioner({
    fetchImpl,
    makeServiceClient: input => {
      assert.equal(input.serviceRoleKey, 'service-role-secret');
      return db;
    },
    template: {
      migrations: [
        { version: '20260914010101', name: 'one.sql', sql: 'begin; create table one(id int); commit;' },
        { version: '20260914010102', name: 'two.sql', sql: 'begin; create table two(id int); commit;' },
      ],
      acceptance: 'select json_build_object() as acceptance',
    },
  });
  const result = await provisioner.provision({
    connection,
    workshopId: '80000000-0000-4000-8000-000000000001',
    ownerEmail: 'owner@example.com',
    ownerPassword: 'temporary-password',
  });
  assert.equal(result.operationalUserId, '90000000-0000-4000-8000-000000000001');
  assert.equal(queries.filter(sql => sql.includes('vehicleapp_schema_migrations(version')).length, 2);
  assert.equal(queries.some(sql => sql.includes('verified_at=now()')), true);
});

test('provisioning rejects a non-empty project before applying VehicleApp', async () => {
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return response({ ref: connection.projectRef });
    return response([{ has_ledger: false, tables: ['customer_data'] }]);
  };
  const provisioner = createProvisioner({
    fetchImpl,
    makeServiceClient: () => ({ auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } } }),
    template: { migrations: [], acceptance: '' },
  });
  await assert.rejects(provisioner.provision({
    connection,
    workshopId: '80000000-0000-4000-8000-000000000001',
    ownerEmail: 'owner@example.com',
    ownerPassword: 'temporary-password',
  }), error => error.code === 'project_not_empty');
});

test('provisioning rejects a project linked to another workshop before running migrations', async () => {
  const queries = [];
  const foreignWorkshopId = '80000000-0000-4000-8000-000000000002';
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return response({ ref: connection.projectRef });
    const query = JSON.parse(options.body).query;
    queries.push(query);
    if (query.includes("to_regclass('public.vehicleapp_installation')")) {
      return response([{ has_installation: true }]);
    }
    if (query.includes('select installation_id::text')) {
      return response([{ installation_id: foreignWorkshopId, schema_version: '20260914.1' }]);
    }
    throw new Error('La validación debía detenerse antes de preparar el esquema.');
  };
  const provisioner = createProvisioner({
    fetchImpl,
    makeServiceClient: () => ({ auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } } }),
    template: { migrations: [{ version: '20260914010101', name: 'one.sql', sql: 'begin; create table one(id int); commit;' }], acceptance: '' },
  });
  await assert.rejects(provisioner.provision({
    connection,
    workshopId: '80000000-0000-4000-8000-000000000001',
    ownerEmail: 'owner@example.com',
    ownerPassword: 'temporary-password',
  }), error => error.code === 'installation_mismatch');
  assert.equal(queries.length, 2);
  assert.equal(queries.some(query => query.includes('insert into public.vehicleapp_schema_migrations')), false);
});

test('upgrade rejects a project linked to another workshop before running migrations', async () => {
  const queries = [];
  const foreignWorkshopId = '80000000-0000-4000-8000-000000000002';
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return response({ ref: connection.projectRef });
    const query = JSON.parse(options.body).query;
    queries.push(query);
    if (query.includes("to_regclass('public.vehicleapp_installation')")) {
      return response([{ has_installation: true }]);
    }
    if (query.includes('select installation_id::text')) {
      return response([{ installation_id: foreignWorkshopId, schema_version: '20260914.1' }]);
    }
    throw new Error('La validación debía detenerse antes de preparar el esquema.');
  };
  const provisioner = createProvisioner({
    fetchImpl,
    makeServiceClient: () => ({ auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } } }),
    template: { migrations: [{ version: '20260914010101', name: 'one.sql', sql: 'begin; create table one(id int); commit;' }], acceptance: '' },
  });
  await assert.rejects(provisioner.upgrade({
    connection,
    workshopId: '80000000-0000-4000-8000-000000000001',
  }), error => error.code === 'installation_mismatch');
  assert.equal(queries.length, 2);
  assert.equal(queries.some(query => query.includes('insert into public.vehicleapp_schema_migrations')), false);
});

test('upgrade applies missing migrations only after confirming the registered workshop', async () => {
  const queries = [];
  const workshopId = '80000000-0000-4000-8000-000000000001';
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return response({ ref: connection.projectRef });
    const query = JSON.parse(options.body).query;
    queries.push(query);
    if (query.includes("to_regclass('public.vehicleapp_installation')")) {
      return response([{ has_installation: true }]);
    }
    if (query.includes('select installation_id::text')) {
      return response([{ installation_id: workshopId, schema_version: '20260914.1' }]);
    }
    if (query.includes("to_regclass('public.vehicleapp_schema_migrations')")) {
      return response([{ has_ledger: true, tables: ['vehicleapp_installation'] }]);
    }
    if (query.includes('select exists')) return response([{ applied: false }]);
    return response([]);
  };
  const db = {
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
    from: table => {
      assert.equal(table, 'vehicleapp_installation');
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { installation_id: workshopId, schema_version: '20260927.1' },
              error: null,
            }),
          }),
        }),
      };
    },
  };
  const provisioner = createProvisioner({
    fetchImpl,
    makeServiceClient: () => db,
    template: {
      migrations: [{ version: '20260927010101', name: 'one.sql', sql: 'begin; create table one(id int); commit;' }],
      acceptance: '',
    },
  });
  const result = await provisioner.upgrade({ connection, workshopId });
  assert.deepEqual(result, { schemaVersion: '20260927.1' });
  const identityQuery = queries.findIndex(query => query.includes('select installation_id::text'));
  const migrationQuery = queries.findIndex(query => query.includes('create table one'));
  assert.ok(identityQuery >= 0 && migrationQuery > identityQuery);
});
