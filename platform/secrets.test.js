'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSecretBox } = require('./secrets');
const { normalizeConnection } = require('./connections');

test('connection secrets are authenticated and never stored as plaintext', () => {
  const box = createSecretBox(Buffer.alloc(32, 7).toString('base64'));
  const envelope = box.seal('service-role-secret');
  assert.match(envelope, /^v1\./);
  assert.equal(envelope.includes('service-role-secret'), false);
  assert.equal(box.open(envelope), 'service-role-secret');
  assert.throws(() => box.open(`${envelope}x`));
});

test('a connection must match its exact Supabase project reference', () => {
  const connection = normalizeConnection({
    projectRef: 'abcdefghijklmnopqrst',
    url: 'https://abcdefghijklmnopqrst.supabase.co',
    publishableKey: 'sb_publishable_example_key',
    serviceRoleKey: 'service-role-secret',
    managementToken: 'management-token-secret',
  }, { requireSecrets: true });
  assert.equal(connection.projectRef, 'abcdefghijklmnopqrst');
  assert.throws(() => normalizeConnection({
    ...connection,
    url: 'https://tsrqponmlkjihgfedcba.supabase.co',
  }), /no corresponde/);
  for (const url of [
    'https://abcdefghijklmnopqrst.supabase.co/api',
    'https://abcdefghijklmnopqrst.supabase.co?redirect=otro',
    'https://usuario:secreto@abcdefghijklmnopqrst.supabase.co',
    'https://abcdefghijklmnopqrst.supabase.co:444',
  ]) {
    assert.throws(() => normalizeConnection({ ...connection, url }), /no corresponde/);
  }
});
