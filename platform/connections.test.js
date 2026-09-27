'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionResolver } = require('./connections');

const PROJECT_REF = 'abcdefghijklmnopqrst';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const PUBLISHABLE_KEY = 'sb_publishable_connection_test_key_000000';
const SERVICE_ROLE_KEY = 'server-service-role-secret';
const MANAGEMENT_TOKEN = 'server-management-token-secret';

function connectionRow({ serviceSecret = null, managementSecret = null } = {}) {
  return {
    project_ref: PROJECT_REF,
    connection_ref: PROJECT_REF,
    project_url: PROJECT_URL,
    publishable_key: PUBLISHABLE_KEY,
    service_role_secret: serviceSecret,
    management_token_secret: managementSecret,
  };
}

function resolver({ row = connectionRow(), entries = {}, open = value => value, extraEnv = {} } = {}) {
  return createConnectionResolver({
    store: { connection: async ref => ref === PROJECT_REF ? row : null },
    secretBox: { open },
    env: { WORKSHOP_CONNECTIONS_JSON: JSON.stringify(entries), ...extraEnv },
  });
}

function legacyEntry() {
  return {
    projectRef: PROJECT_REF,
    url: PROJECT_URL,
    publishableKey: PUBLISHABLE_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
    managementToken: MANAGEMENT_TOKEN,
  };
}

test('legacy fallback supplies server credentials when the exact managed row lacks them', async () => {
  const resolveConnection = resolver({ entries: { [PROJECT_REF]: legacyEntry() } });

  const connection = await resolveConnection(PROJECT_REF, { requireSecrets: true });

  assert.equal(connection.projectRef, PROJECT_REF);
  assert.equal(connection.serviceRoleKey, SERVICE_ROLE_KEY);
  assert.equal(connection.managementToken, MANAGEMENT_TOKEN);
});

test('legacy fallback remains available when no central connection row exists', async () => {
  const resolveConnection = createConnectionResolver({
    store: { connection: async () => null },
    secretBox: { open: value => value },
    env: { WORKSHOP_CONNECTIONS_JSON: JSON.stringify({ [PROJECT_REF]: legacyEntry() }) },
  });

  const connection = await resolveConnection(PROJECT_REF, { requireSecrets: true });

  assert.equal(connection.serviceRoleKey, SERVICE_ROLE_KEY);
  assert.equal(connection.managementToken, MANAGEMENT_TOKEN);
});

test('the exact legacy Supabase project can mint admin access with its service key only', async () => {
  const resolveConnection = resolver({ extraEnv: {
    SUPABASE_URL: PROJECT_URL,
    SUPABASE_SERVICE_KEY: SERVICE_ROLE_KEY,
  } });

  const connection = await resolveConnection(PROJECT_REF, { requireServiceRoleKey: true });

  assert.equal(connection.projectRef, PROJECT_REF);
  assert.equal(connection.serviceRoleKey, SERVICE_ROLE_KEY);
  assert.equal(connection.managementToken, undefined);
});

test('legacy service credentials do not connect to a different workshop project', async () => {
  const otherRef = 'zyxwvutsrqponmlkjihg';
  const resolveConnection = resolver({ extraEnv: {
    SUPABASE_URL: `https://${otherRef}.supabase.co`,
    SUPABASE_SERVICE_KEY: SERVICE_ROLE_KEY,
  } });

  await assert.rejects(
    resolveConnection(PROJECT_REF, { requireServiceRoleKey: true }),
    error => error.code === 'connection_secrets_unavailable' && error.status === 503,
  );
});

test('managed service key takes precedence over the legacy key without requiring a management token', async () => {
  const resolveConnection = resolver({
    row: connectionRow({ serviceSecret: 'sealed-service' }),
    open: value => `opened:${value}`,
    extraEnv: { SUPABASE_URL: PROJECT_URL, SUPABASE_SERVICE_KEY: SERVICE_ROLE_KEY },
  });

  const connection = await resolveConnection(PROJECT_REF, { requireServiceRoleKey: true });

  assert.equal(connection.serviceRoleKey, 'opened:sealed-service');
  assert.equal(connection.managementToken, undefined);
});

test('public resolution never exposes secrets from the server-side fallback registry', async () => {
  const resolveConnection = resolver({ entries: { [PROJECT_REF]: legacyEntry() } });

  const connection = await resolveConnection(PROJECT_REF);

  assert.equal(connection.publishableKey, PUBLISHABLE_KEY);
  assert.equal('serviceRoleKey' in connection, false);
  assert.equal('managementToken' in connection, false);
});

test('missing credentials without an exact allowlisted fallback fail with a safe platform error', async () => {
  const resolveConnection = resolver();

  await assert.rejects(
    resolveConnection(PROJECT_REF, { requireSecrets: true }),
    error => error.code === 'connection_secrets_unavailable' && error.status === 503,
  );
});

test('a partially populated managed connection does not fall back to environment credentials', async () => {
  const resolveConnection = resolver({
    row: connectionRow({ serviceSecret: 'sealed-service' }),
    entries: { [PROJECT_REF]: legacyEntry() },
  });

  await assert.rejects(
    resolveConnection(PROJECT_REF, { requireSecrets: true }),
    error => error.code === 'connection_secrets_unavailable' && error.status === 503,
  );
});

test('valid encrypted managed credentials keep precedence over the legacy fallback', async () => {
  const resolveConnection = resolver({
    row: connectionRow({ serviceSecret: 'sealed-service', managementSecret: 'sealed-management' }),
    entries: { [PROJECT_REF]: legacyEntry() },
    open: value => `opened:${value}`,
  });

  const connection = await resolveConnection(PROJECT_REF, { requireSecrets: true });

  assert.equal(connection.serviceRoleKey, 'opened:sealed-service');
  assert.equal(connection.managementToken, 'opened:sealed-management');
});

test('an invalid non-empty managed secret does not fall back to environment credentials', async () => {
  const resolveConnection = resolver({
    row: connectionRow({ serviceSecret: 'invalid-sealed-service', managementSecret: 'sealed-management' }),
    entries: { [PROJECT_REF]: legacyEntry() },
    open: value => {
      if (value === 'invalid-sealed-service') throw new Error('invalid ciphertext');
      return value;
    },
  });

  await assert.rejects(
    resolveConnection(PROJECT_REF, { requireSecrets: true }),
    /invalid ciphertext/,
  );
});

test('unknown workshops cannot use the allowlisted legacy connection', async () => {
  const resolveConnection = resolver({ entries: { [PROJECT_REF]: legacyEntry() } });

  await assert.rejects(
    resolveConnection('zyxwvutsrqponmlkjihg', { requireSecrets: true }),
    error => error.code === 'connection_unavailable' && error.status === 503,
  );
});
