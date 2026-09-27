'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mountPlatform } = require('./index');

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const validEnvironment = {
  PLATFORM_ENABLED: 'true',
  PLATFORM_SUPABASE_URL: 'https://central-test.supabase.co',
  PLATFORM_SUPABASE_SERVICE_KEY: 'test-service-role-key',
  PLATFORM_CONNECTION_ENCRYPTION_KEY: encryptionKey,
};

async function withServer(app, callback) {
  const server = await new Promise(resolve => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

function appWithLegacyRoute(environment) {
  const app = express();
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  mountPlatform(app, environment);
  app.get('/api/legacy-probe', (req, res) => res.json({ route: 'legacy' }));
  return app;
}

const invalidEnvironments = [
  ['falta la URL central', { ...validEnvironment, PLATFORM_SUPABASE_URL: '' }],
  ['falta la clave de servicio central', {
    ...validEnvironment,
    PLATFORM_SUPABASE_SERVICE_KEY: '',
  }],
  ['falta la clave de cifrado', {
    ...validEnvironment,
    PLATFORM_CONNECTION_ENCRYPTION_KEY: '',
  }],
  ['la URL central no es válida', {
    ...validEnvironment,
    PLATFORM_SUPABASE_URL: 'not-a-url',
  }],
  ['la clave de cifrado no tiene 32 bytes', {
    ...validEnvironment,
    PLATFORM_CONNECTION_ENCRYPTION_KEY: 'invalid-key',
  }],
  ['la base central coincide con la operativa', {
    ...validEnvironment,
    SUPABASE_URL: 'https://central-test.supabase.co/',
  }],
];

for (const [caseName, environment] of invalidEnvironments) {
  test(`la configuración incompleta (${caseName}) no interrumpe la API existente`, async () => {
    const app = appWithLegacyRoute(environment);

    await withServer(app, async baseUrl => {
      const [platformResponse, healthResponse, legacyResponse] = await Promise.all([
        fetch(`${baseUrl}/api/platform/billing/catalog`),
        fetch(`${baseUrl}/health`),
        fetch(`${baseUrl}/api/legacy-probe`),
      ]);

      assert.equal(platformResponse.status, 503);
      assert.deepEqual(await platformResponse.json(), {
        code: 'platform_unavailable',
        error: 'La plataforma no está disponible por configuración.',
      });
      assert.equal(healthResponse.status, 200);
      assert.deepEqual(await healthResponse.json(), { status: 'ok' });
      assert.equal(legacyResponse.status, 200);
      assert.deepEqual(await legacyResponse.json(), { route: 'legacy' });
    });
  });
}

test('la configuración válida mantiene montadas las rutas de plataforma', async () => {
  const app = appWithLegacyRoute(validEnvironment);

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/platform/billing/catalog`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      code: 'session_required',
      error: 'Inicia sesión nuevamente.',
    });
    // Operational routes must precede the central-session router.
    const voice = await fetch(`${baseUrl}/api/platform/workshops/80000000-0000-4000-8000-000000000001/voz/extraer-formato`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcripcion: 'QA' }),
    });
    assert.equal(voice.status, 401);
    assert.deepEqual(await voice.json(), {
      code: 'session_required', error: 'Inicia sesión nuevamente en el taller.',
    });
  });
});
