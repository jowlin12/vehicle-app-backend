'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPlatformRouter } = require('./router');

const ADMIN_ID = '10000000-0000-4000-8000-000000000001';
const OWNER_ID = '20000000-0000-4000-8000-000000000001';
const WORKSHOP_ID = '80000000-0000-4000-8000-000000000001';
const REQUEST_ID = '70000000-0000-4000-8000-000000000001';
const PROJECT_REF = 'abcdefghijklmnopqrst';

async function withServer(app, run) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('crear un taller prepara su estructura de Drive de forma idempotente', async () => {
  const savedConnections = [];
  const preparedWorkshops = [];
  const row = {
    id: WORKSHOP_ID,
    name: 'Taller Norte',
    status: 'pending',
    connection_ref: PROJECT_REF,
    modules: ['orders'],
    schema_version: null,
    last_error: null,
  };
  const router = createPlatformRouter({
    auth: {
      getUser: async () => ({data: {user: {id: ADMIN_ID}}, error: null}),
      admin: {},
    },
    store: {
      isAdmin: async id => id === ADMIN_ID,
      ownerByEmail: async () => OWNER_ID,
      register: async (adminId, key, input) => {
        assert.equal(adminId, ADMIN_ID);
        assert.equal(key, REQUEST_ID);
        assert.equal(input.ownerUserId, OWNER_ID);
        return row;
      },
      saveConnection: async (...args) => savedConnections.push(args),
    },
    secretBox: {seal: value => `sealed:${value}`},
    drive: {
      ensureWorkshopStructure: async input => preparedWorkshops.push(input),
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const response = await fetch(`${base}/api/platform/workshops`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer central-session',
        'Content-Type': 'application/json',
        'Idempotency-Key': REQUEST_ID,
      },
      body: JSON.stringify({
        name: 'Taller Norte',
        ownerEmail: 'owner@example.com',
        ownerPassword: 'temporary-password',
        modules: ['orders'],
        project: {
          ref: PROJECT_REF,
          url: `https://${PROJECT_REF}.supabase.co`,
          publishableKey: 'sb_publishable_example_key',
          serviceRoleKey: 'service-role-secret',
          managementToken: 'management-token-secret',
        },
      }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).workshop.id, WORKSHOP_ID);
  });

  assert.equal(savedConnections.length, 1);
  assert.equal(savedConnections[0][0], ADMIN_ID);
  assert.equal(savedConnections[0][1], WORKSHOP_ID);
  assert.equal(savedConnections[0][2].serviceRoleSecret, 'sealed:service-role-secret');
  assert.deepEqual(preparedWorkshops, [{id: WORKSHOP_ID, name: 'Taller Norte'}]);
});
