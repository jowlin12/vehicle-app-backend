'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPlatformRouter } = require('./router');
const { SCHEMA_VERSION } = require('./provisioning');
const ADMIN = '10000000-0000-4000-8000-000000000001';
const WORKER = '20000000-0000-4000-8000-000000000001';
const WORKSHOP = '80000000-0000-4000-8000-000000000001';
const OTHER = '80000000-0000-4000-8000-000000000002';
const OP = '40000000-0000-4000-8000-000000000001';
const KEY = '70000000-0000-4000-8000-000000000001';
const body = { fullName: 'Trabajador QA', email: 'worker@example.invalid', password: 'initial-qa-password', role: 'employee' };
async function fixture(run) {
  let actor = ADMIN, active = true, legacy = false, revoke = false, version = SCHEMA_VERSION, entryVersion;
  const calls = [];
  const member = () => ({ user_id: WORKER, operational_user_id: OP, role: 'employee', active: true });
  const row = () => ({ id: WORKSHOP, name: 'Taller QA', status: 'ready', connection_ref: 'abcdefghijklmnopqrst',
    schema_version: legacy ? 'legacy-existing-v1' : version, modules: ['orders'] });
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: actor } } }) },
    store: { isAdmin: async id => id === ADMIN,
      membership: async (id, workshop) => id === WORKER && workshop === WORKSHOP && active ? member() : null,
      get: async id => id === WORKSHOP ? row() : null,
      updateSchemaVersion: async (_, updated) => { version=updated;return row(); } },
    provisioner: {upgrade: async()=>({schemaVersion:SCHEMA_VERSION})},
    resolveConnection: async () => ({ url: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'public-key' }),
    team: { list: async () => { calls.push('list'); return []; },
      change: async input=>{calls.push(input);return {userId:input.userId,role:input.role,active:input.active};},
      register: async input => { calls.push(input); return { userId: WORKER, role: input.role }; },
      enter: async ({workshop}) => { calls.push('enter');entryVersion=workshop.schema_version; if (revoke) active = false;
        return { operationalUserId: OP, accessToken: 'test-access', refreshToken: 'test-refresh' }; } },
  });
  const app = express(); app.use('/api/platform', router);
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/platform/workshops`;
  const request = (suffix, method = 'GET', data = body, workshop = WORKSHOP) => fetch(`${base}/${workshop}/${suffix}`, {
    method, headers: { Authorization: 'Bearer central-session', 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
    ...(method === 'GET' ? {} : { body: JSON.stringify(data) }),
  });
  try { await run({ request, calls, actor: value => { actor = value; }, legacy: () => { legacy = true; }, revoke: () => { revoke = true; }, oldSchema:()=>{version='20260926.4';}, entryVersion:()=>entryVersion }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('team administration is global-only and does not accept caller-supplied actor or connection', async () => fixture(async f => {
  f.actor(WORKER);
  assert.equal((await f.request('members')).status, 403);
  assert.equal((await f.request('members', 'POST')).status, 403);
  assert.equal(f.calls.length, 0);
  f.actor(ADMIN);
  const response = await f.request('members', 'POST', { ...body, actor: WORKER, workshop: { id: OTHER }, connection: { url: 'https://attacker.invalid' } });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls[0].actor, ADMIN);
  assert.equal(f.calls[0].workshop.id, WORKSHOP);
  assert.equal(f.calls[0].connection.url, 'https://abcdefghijklmnopqrst.supabase.co');
  assert.equal((await f.request('members', 'POST', { ...body, role: 'owner' })).status, 400);
  assert.equal((await f.request('members', 'POST', body, OTHER)).status, 404);
  f.legacy();
  assert.equal((await f.request('members', 'POST')).status, 409);
  assert.equal(f.calls.length, 1);
}));

test('member entry is scoped to its active membership and rechecks revocation before returning tokens', async () => fixture(async f => {
  f.actor(WORKER);
  assert.equal((await f.request('member-access', 'POST', {}, OTHER)).status, 404);
  const response = await f.request('member-access', 'POST', { userId: ADMIN, role: 'admin' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).userId, OP);
  f.revoke();
  const denied = await f.request('member-access', 'POST');
  assert.equal(denied.status, 403);
  assert.equal(JSON.stringify(await denied.json()).includes('test-refresh'), false);
}));

test('legacy member entry preserves the operational login fallback', async () => fixture(async f => {
  f.actor(WORKER); f.legacy();
  const response = await f.request('member-access', 'POST');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'member_link_required');
  assert.deepEqual(f.calls, []);
}));

test('first entry after an upgrade returns the schema that enables client revocation checks',async()=>fixture(async f=>{
  f.actor(WORKER);f.oldSchema();
  const response=await f.request('member-access','POST');
  assert.equal(response.status,200);
  assert.equal((await response.json()).workshop.schemaVersion,SCHEMA_VERSION);
  assert.equal(f.entryVersion(),SCHEMA_VERSION);
}));

test('permission edit is global-only, validates its target, and refuses legacy changes',async()=>fixture(async f=>{
  f.actor(WORKER);
  assert.equal((await f.request(`members/${WORKER}`,'PUT',{role:'admin',active:true})).status,403);
  f.actor(ADMIN);
  const r=await f.request(`members/${WORKER}`,'PUT',{role:'admin',active:false,actor:WORKER});
  assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
  assert.equal(f.calls[0].actor,ADMIN);assert.equal(f.calls[0].userId,WORKER);assert.equal(f.calls[0].active,false);
  assert.equal((await f.request(`members/${WORKER}`,'PUT',{role:'owner',active:true})).status,400);
  f.legacy();assert.equal((await f.request(`members/${WORKER}`,'PUT',{role:'admin',active:true})).status,409);
  assert.equal(f.calls.length,1);
}));
