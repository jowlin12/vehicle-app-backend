'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAdminAccess } = require('./admin-access');
const { createPlatformRouter } = require('./router');

const connection = Object.freeze({
  projectRef: 'abcdefghijklmnopqrst',
  url: 'https://abcdefghijklmnopqrst.supabase.co',
  publishableKey: 'sb_publishable_example_key',
  serviceRoleKey: 'service-role-secret',
  managementToken: 'management-token-secret',
});
const ADMIN_ID = '10000000-0000-4000-8000-000000000001';
const WORKSHOP_ID = '80000000-0000-4000-8000-000000000001';
const OPERATIONAL_ID = '90000000-0000-4000-8000-000000000001';

function fakeWorkshopDb({ users = [], created = [], roles = [] } = {}) {
  return {
    auth: { admin: {
      listUsers: async () => ({ data: { users }, error: null }),
      getUserById: async id => ({ data: { user: users.find(user => user.id === id) || null }, error: null }),
      createUser: async input => {
        created.push(input);
        const user = { id: OPERATIONAL_ID, email: input.email };
        users.push(user);
        return { data: { user }, error: null };
      },
      generateLink: async input => ({ data: { properties: { hashed_token: `hash-for-${input.email}` } }, error: null }),
    } },
    from: table => {
      assert.equal(table, 'profiles');
      return { update: values => ({ eq: async (column, id) => {
        roles.push({ id, role: values.role });
        return { error: null };
      } }) };
    },
  };
}

function publicClient(expectedUserId) {
  return () => ({ auth: { verifyOtp: async ({ token_hash: hash, type }) => {
    assert.equal(type, 'magiclink');
    assert.match(hash, /^hash-for-/);
    return {
      data: { session: {
        access_token: 'access', refresh_token: 'refresh', expires_at: 123, user: { id: expectedUserId },
      } },
      error: null,
    };
  } } });
}

test('admin access creates the administrator own operational user without a shared password', async () => {
  const created = [];
  const roles = [];
  const access = createAdminAccess({
    makeServiceClient: input => {
      assert.equal(input.serviceRoleKey, 'service-role-secret');
      return fakeWorkshopDb({ created, roles });
    },
    makePublicClient: publicClient(OPERATIONAL_ID),
  });
  const entry = await access.enter({ connection, email: 'Admin@Example.com' });
  assert.equal(entry.operationalUserId, OPERATIONAL_ID);
  assert.equal(entry.refreshToken, 'refresh');
  assert.equal(created.length, 1);
  assert.equal(created[0].email, 'admin@example.com');
  assert.equal(created[0].user_metadata.vehicleapp_role, 'platform_admin');
  assert.ok(created[0].password.length >= 40);
  assert.deepEqual(roles, [{ id: OPERATIONAL_ID, role: 'admin' }]);
});

test('admin access reuses the operational user already linked to the membership', async () => {
  const created = [];
  const users = [{ id: OPERATIONAL_ID, email: 'admin@example.com' }];
  const access = createAdminAccess({
    makeServiceClient: () => fakeWorkshopDb({ users, created }),
    makePublicClient: publicClient(OPERATIONAL_ID),
  });
  const entry = await access.enter({ connection, email: 'admin@example.com', operationalUserId: OPERATIONAL_ID });
  assert.equal(entry.operationalUserId, OPERATIONAL_ID);
  assert.equal(created.length, 0);
});

test('admin access rejects a session minted for a different user', async () => {
  const access = createAdminAccess({
    makeServiceClient: () => fakeWorkshopDb({ users: [{ id: OPERATIONAL_ID, email: 'admin@example.com' }] }),
    makePublicClient: publicClient('someone-else'),
  });
  await assert.rejects(access.enter({ connection, email: 'admin@example.com' }),
    error => error.code === 'admin_session_failed');
});

async function withRouter({ isAdmin, membership = null }, run) {
  const linked = [];
  const router = createPlatformRouter({
    auth: {
      getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }),
      admin: { getUserById: async () => ({ data: { user: { id: ADMIN_ID, email: 'admin@example.com' } }, error: null }) },
    },
    store: {
      isAdmin: async () => isAdmin,
      membership: async () => membership,
      get: async () => ({ id: WORKSHOP_ID, name: 'Taller', status: 'ready', connection_ref: connection.projectRef, modules: ['orders'] }),
      linkMember: async (...args) => { linked.push(args); },
    },
    resolveConnection: async (ref, options) => {
      assert.equal(ref, connection.projectRef);
      assert.equal(options.requireSecrets, true);
      return connection;
    },
    adminAccess: { enter: async input => {
      assert.equal(input.email, 'admin@example.com');
      return { operationalUserId: OPERATIONAL_ID, accessToken: 'access', refreshToken: 'refresh', expiresAt: 123 };
    } },
  });
  const app = express();
  app.use('/api/platform', router);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/platform`;
    await run(base, linked);
  } finally {
    server.close();
  }
}

const post = (url) => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer central-token' } });

test('admin-access route lets a global administrator enter without membership', async () => {
  await withRouter({ isAdmin: true }, async (base, linked) => {
    const response = await post(`${base}/workshops/${WORKSHOP_ID}/admin-access`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.userId, OPERATIONAL_ID);
    assert.equal(body.session.refreshToken, 'refresh');
    assert.equal(body.publishableKey, connection.publishableKey);
    assert.equal(JSON.stringify(body).includes('service-role-secret'), false);
    assert.equal(JSON.stringify(body).includes('management-token-secret'), false);
    assert.deepEqual(linked, [[WORKSHOP_ID, ADMIN_ID, OPERATIONAL_ID, 'admin']]);
  });
});

test('admin-access route keeps the existing membership role', async () => {
  const membership = { role: 'owner', operational_user_id: OPERATIONAL_ID, active: true };
  await withRouter({ isAdmin: true, membership }, async (base, linked) => {
    const response = await post(`${base}/workshops/${WORKSHOP_ID}/admin-access`);
    assert.equal(response.status, 200);
    assert.equal(linked[0][3], 'owner');
  });
});

test('admin-access route rejects workshop members that are not global administrators', async () => {
  const membership = { role: 'employee', operational_user_id: OPERATIONAL_ID, active: true };
  await withRouter({ isAdmin: false, membership }, async (base, linked) => {
    const response = await post(`${base}/workshops/${WORKSHOP_ID}/admin-access`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'platform_admin_required');
    assert.equal(linked.length, 0);
  });
});
