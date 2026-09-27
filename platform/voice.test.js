'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createWorkshopVoiceRouter, voiceInput, safeVoiceResult, extractVoice } = require('./voice');
const A = '80000000-0000-4000-8000-000000000001';
const B = '80000000-0000-4000-8000-000000000002';

async function fixture(run, { providers, timeoutMs = 9000 } = {}) {
  const state = { active: true, profileActive: true, profileRole: 'empleado', memberRole: 'employee', revokedAfter: false, module: true, expired: false, legacy: false, failedCatalog: false };
  const calls = [], queries = [];
  const rows = id => ({ id, status: 'ready', connection_ref: id === A ? 'project-a' : 'project-b',
    schema_version: state.legacy ? 'legacy-existing-v1' : '20260926.5', modules: state.module ? ['orders'] : [],
    subscription_required: state.expired, paid_until: '2020-01-01T00:00:00Z' });
  const store = {
    get: async id => [A, B].includes(id) ? rows(id) : null,
    operationalMembership: async (id, user) => state.active && user === `user-${id === A ? 'a' : 'b'}`
      ? { active: true, role: state.memberRole } : null,
  };
  const makeClient = (connection, token) => ({
    auth: { getUser: async () => token === `token-${connection.ref === 'project-a' ? 'a' : 'b'}`
      ? { data: { user: { id: `user-${connection.ref === 'project-a' ? 'a' : 'b'}` } } }
      : { error: new Error('invalid') } },
    from(table) {
      let column, wanted, limit, signal;
      return {
        select(value) { column = value.split(',')[0]; return this; },
        eq() { return this; },
        in(_, values) { wanted = values; return this; },
        is(_, value) { assert.equal(value, null); return this; },
        abortSignal(value) { signal = value; return this; },
        order() { return this; },
        limit(value) { limit = value; return this; },
        maybeSingle: async () => ({ data: { role: state.profileRole, is_active: state.profileActive, deleted_at: null } }),
        then(resolve, reject) {
          queries.push({ table, ref: connection.ref, wanted, limit, hasSignal: !!signal });
          const brand = connection.ref === 'project-a' ? 'Nissan' : 'Toyota';
          const type = connection.ref === 'project-a' ? 'Sentra' : 'Corolla';
          const all = { marcas: [{ nombre: brand }], tipos_vehiculo: [{ nombre_tipo: type, marca_nombre: brand }],
            servicios: [{ servicio: 'Cambio de aceite' }] }[table];
          return Promise.resolve(state.failedCatalog ? { error: new Error('DB failed') }
            : { data: all.filter(row => !wanted || wanted.includes(row[column])).slice(0, limit) }).then(resolve, reject);
        },
      };
    },
  });
  const model = { nombre: 'fake', extraer: async context => {
    calls.push(context);
    if (state.revokedAfter) state.active = false;
    return { salida: { campos: { marca: 'Nissan', tipo_vehiculo: 'Sentra', cliente: 'Cliente QA',
      unsupported: 'DROP', telefono: null }, servicios: ['Cambio de aceite', 'Servicio ajeno'], confianza_baja: ['cliente', 'unsupported'] } };
  } };
  const router = createWorkshopVoiceRouter({ store, makeClient,
    resolveConnection: async ref => ({ ref }), providers: providers || (() => [model]), timeoutMs });
  const app = express(); app.use('/api/platform', router);
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (id = A, token = 'token-a', body = { transcripcion: 'Nissan Sentra del cliente QA' }) =>
    fetch(`${base}/api/platform/workshops/${id}/voz/extraer-formato`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  try { await run({ state, calls, queries, request }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('employee dictation uses its own RLS catalog and returns only verified suggestions', async () => fixture(async f => {
  const r = await f.request(A, 'token-a', { transcripcion: 'Frase QA', catalogo: {
    marcas: ['Nissan', 'Marca de otro taller'], tipos_vehiculo: ['Sentra', 'Otro vehículo'], servicios_frecuentes: ['Cambio de aceite', 'Servicio ajeno'],
  } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { campos: { marca: 'Nissan', tipo_vehiculo: 'Sentra', cliente: 'Cliente QA' },
    servicios: ['Cambio de aceite'], confianza_baja: ['cliente'] });
  assert.deepEqual(f.calls[0].catalogo, { marcas: ['Nissan'], tipos_vehiculo: ['Sentra'], servicios_frecuentes: ['Cambio de aceite'] });
  assert(f.queries.every(q => q.ref === 'project-a' && q.hasSignal && q.limit <= 100));
}));

test('a workshop A token cannot send a prompt through workshop B or an unknown workshop', async () => fixture(async f => {
  assert.equal((await f.request(B)).status, 401);
  assert.equal((await f.request('bad-id')).status, 400);
  assert.equal((await f.request('80000000-0000-4000-8000-000000000099')).status, 404);
  assert.equal((await f.request(A, null)).status, 401);
  assert.equal(f.calls.length, 0); assert.equal(f.queries.length, 0);
}));

test('revoked profiles, memberships, disabled/expired orders and legacy invoke no provider', async () => {
  for (const change of [{ profileActive: false }, { active: false }, { module: false }, { expired: true }, { legacy: true }]) {
    await fixture(async f => {
      Object.assign(f.state, change);
      assert.equal((await f.request()).status, change.legacy ? 409 : 403);
      assert.equal(f.calls.length, 0); assert.equal(f.queries.length, 0);
    });
  }
});

test('an access revoked during generation does not return catalog or extracted fields', async () => fixture(async f => {
  f.state.revokedAfter = true;
  const r = await f.request(); assert.equal(r.status, 403);
  assert.equal(JSON.stringify(await r.json()).includes('Cliente QA'), false);
  assert.equal(f.calls.length, 1);
}));

test('partially changed or unknown member roles cannot invoke dictation', async () => {
  for (const change of [{ profileRole: 'admin' }, { memberRole: 'admin' }, { memberRole: 'unknown' }, { profileActive: null }]) {
    await fixture(async f => {
      Object.assign(f.state, change);
      assert.equal((await f.request()).status, 403);
      assert.equal(f.calls.length, 0); assert.equal(f.queries.length, 0);
    });
  }
});

test('a failing provider falls back within the same deadline and verified catalog', async () => {
  const signal = AbortSignal.timeout(1000);
  const input = voiceInput({ transcripcion: 'Cliente QA' });
  const catalog = { marcas: [], tipos_vehiculo: [], servicios_frecuentes: ['Cambio de aceite'], typeBrands: [] };
  const calls = [];
  const result = await extractVoice(input, catalog, [
    { extraer: async () => { calls.push('failed'); throw new Error('PRIVATE'); } },
    { extraer: async (context, options) => {
      calls.push('success'); assert.equal(options.signal, signal);
      assert.deepEqual(context.catalogo.servicios_frecuentes, ['Cambio de aceite']);
      return { salida: { campos: { cliente: 'Cliente QA' }, servicios: ['Cambio de aceite', 'Ajeno'], confianza_baja: [] } };
    } },
  ], signal);
  assert.deepEqual(calls, ['failed', 'success']);
  assert.deepEqual(result, { campos: { cliente: 'Cliente QA' }, servicios: ['Cambio de aceite'], confianza_baja: [] });
});

test('invalid input, missing provider and failed catalog return recoverable errors without model use', async () => {
  await fixture(async f => {
    for (const transcripcion of ['', 'x'.repeat(2001), { malicious: true }]) {
      assert.equal((await f.request(A, 'token-a', { transcripcion })).status, 400);
    }
    f.state.failedCatalog = true;
    assert.equal((await f.request()).status, 503);
    assert.equal(f.calls.length, 0);
  });
  await fixture(async f => {
    assert.equal((await f.request()).status, 503); assert.equal(f.queries.length, 0);
  }, { providers: () => [] });
});

test('all providers failing or timing out never expose provider error text', async () => {
  await fixture(async f => {
    const r = await f.request(); assert.equal(r.status, 502);
    assert.equal(JSON.stringify(await r.json()).includes('PRIVATE'), false);
  }, { providers: () => [{ extraer: async () => { throw new Error('PRIVATE prompt and key'); } }] });
  await fixture(async f => assert.equal((await f.request()).status, 503), {
    timeoutMs: 20, providers: () => [{ extraer: async (_, { signal }) => new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) }],
  });
});

test('normalization bounds already-filled input, drops unknown data, and preserves field names', () => {
  const input = voiceInput({ transcripcion: ' QA ', ya_lleno: { trabajos: 'x'.repeat(10000), clave_control: 'CLAVE', malicious: 'PRIVATE' },
    faltantes: ['tipoVehiculo', 'cliente', 'malicious'] });
  assert.equal(input.ya_lleno.trabajos.length, 1000); assert.equal(input.ya_lleno.clave_control, 'CLAVE');
  assert.equal(input.ya_lleno.malicious, undefined); assert.deepEqual(input.faltantes, ['tipo_vehiculo', 'cliente']);
  const catalog = { marcas: ['Nissan', 'Toyota'], tipos_vehiculo: ['Sentra', 'Corolla'], servicios_frecuentes: [],
    typeBrands: [{ type: 'Sentra', brand: 'Nissan' }, { type: 'Corolla', brand: 'Toyota' }] };
  const output = { campos: { marca: 'Nissan', tipo_vehiculo: 'Corolla' }, servicios: [], confianza_baja: [] };
  assert.deepEqual(safeVoiceResult(output, catalog).campos, { marca: 'Nissan' });
  assert.deepEqual(safeVoiceResult({ ...output, campos: { tipo_vehiculo: 'Corolla' } }, catalog, 'Nissan').campos, {});
});
