'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const express = require('express');
const { createWorkshopDriveRouter, WORKSHOP_PROPERTY } = require('./drive');

const workshopId = '80000000-0000-4000-8000-000000000001';
const connection = Object.freeze({
  projectRef: 'cpulwtgoqoyjoerttvkt',
  url: 'https://cpulwtgoqoyjoerttvkt.supabase.co',
  publishableKey: 'sb_publishable_test_key_0000000000',
});

function fakeDrive(overrides = {}) {
  const calls = { upload: [], download: [], remove: [], properties: [] };
  return {
    calls,
    async uploadPrivateFile(input) { calls.upload.push(input); return { id: 'drive-file-1' }; },
    async downloadPrivateFile(id) {
      calls.download.push(id);
      return { headers: { 'content-type': 'image/jpeg' }, data: Readable.from('image-bytes') };
    },
    async deletePrivateFile(id) { calls.remove.push(id); },
    async fileAppProperties(id) { calls.properties.push(id); return { [WORKSHOP_PROPERTY]: workshopId }; },
    ...overrides,
  };
}

function build({
  profile = { role: 'admin', is_active: true, deleted_at: null },
  membership = { role: 'admin', active: true },
  workshopStatus = 'ready',
  drive = fakeDrive(),
} = {}) {
  const store = {
    async get(id) {
      return id === workshopId
        ? { id, name: 'Taller Norte', status: workshopStatus, connection_ref: connection.projectRef }
        : null;
    },
    async operationalMembership(id, userId) {
      assert.equal(id, workshopId);
      assert.equal(userId, 'user-1');
      return membership;
    },
  };
  const resolveConnection = async () => connection;
  const makeClient = () => ({
    auth: {
      async getUser(token) {
        return token === 'valid-token'
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: new Error('invalid') };
      },
    },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: profile, error: null }; },
      };
    },
  });
  const router = createWorkshopDriveRouter({ store, resolveConnection, makeClient, drive });
  const app = express();
  app.use('/api/platform', router);
  return { app, drive };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const uploadBody = (extra = {}) => ({
  base64: Buffer.from('fake-image').toString('base64'),
  fileName: 'frontal.jpg',
  mimeType: 'image/jpeg',
  root: 'vehicles',
  vehiclePlate: 'ABC123',
  category: 'frontal',
  uploadRequestId: 'request-0001',
  ...extra,
});

test('uploads a workshop photo with its workshop property and relative path', async () => {
  const { app, drive } = build();
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/platform/workshops/${workshopId}/drive/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify(uploadBody()),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(body, {
      fileId: 'drive-file-1',
      folderPath: 'ABC123/frontal',
      filePath: `/api/platform/workshops/${workshopId}/drive/files/drive-file-1`,
    });
    assert.equal(drive.calls.upload.length, 1);
    assert.equal(drive.calls.upload[0].uploadRequestId, 'request-0001');
    assert.match(
      drive.calls.upload[0].fileName,
      /^foto_ABC123_frontal_\d{8}T\d{6}Z_request-0001\.jpg$/,
    );
    assert.deepEqual(drive.calls.upload[0].workshop, {
      id: workshopId,
      name: 'Taller Norte',
    });
    assert.deepEqual(drive.calls.upload[0].appProperties, { [WORKSHOP_PROPERTY]: workshopId });
  });
});

test('rejects an unknown workshop, a missing session and a non-operational role', async () => {
  const { app } = build({ profile: { role: 'invitado', is_active: true, deleted_at: null } });
  await withServer(app, async base => {
    const send = (id, headers = {}) => fetch(`${base}/api/platform/workshops/${id}/drive/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(uploadBody()),
    });
    assert.equal((await send(workshopId)).status, 401);
    assert.equal(
      (await send('not-a-uuid', { Authorization: 'Bearer valid-token' })).status,
      400,
    );
    assert.equal(
      (await send('80000000-0000-4000-8000-000000000099', { Authorization: 'Bearer valid-token' })).status,
      404,
    );
    assert.equal(
      (await send(workshopId, { Authorization: 'Bearer expired-token' })).status,
      401,
    );
    assert.equal(
      (await send(workshopId, { Authorization: 'Bearer valid-token' })).status,
      403,
    );
  });
});

test('rejects inactive or deleted operational profiles', async () => {
  for (const profile of [
    { role: 'admin', is_active: false, deleted_at: null },
    { role: 'empleado', is_active: true, deleted_at: '2026-01-01T00:00:00Z' },
  ]) {
    const { app } = build({ profile });
    await withServer(app, async base => {
      const response = await fetch(`${base}/api/platform/workshops/${workshopId}/drive/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify(uploadBody()),
      });
      assert.equal(response.status, 403, JSON.stringify(profile));
    });
  }
});

test('rejects revoked memberships and workshops that are not ready', async () => {
  for (const options of [
    { membership: null },
    { workshopStatus: 'failed' },
    { workshopStatus: 'suspended' },
  ]) {
    const { app } = build(options);
    await withServer(app, async base => {
      const response = await fetch(`${base}/api/platform/workshops/${workshopId}/drive/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify(uploadBody()),
      });
      assert.equal(response.status, options.membership === null ? 403 : 404);
    });
  }
});

test('rejects images with a disallowed type or size', async () => {
  const { app } = build();
  await withServer(app, async base => {
    const send = body => fetch(`${base}/api/platform/workshops/${workshopId}/drive/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify(body),
    });
    assert.equal((await send(uploadBody({ mimeType: 'application/pdf' }))).status, 400);
    assert.equal((await send(uploadBody({ base64: '' }))).status, 400);
    const oversized = Buffer.alloc(2800001, 1).toString('base64');
    assert.equal((await send(uploadBody({ base64: oversized }))).status, 413);
  });
});

test('serves and deletes only files that belong to the workshop', async () => {
  const owned = build();
  await withServer(owned.app, async base => {
    const response = await fetch(
      `${base}/api/platform/workshops/${workshopId}/drive/files/drive-file-1`,
      { headers: { Authorization: 'Bearer valid-token' } },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'image-bytes');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const deleted = await fetch(
      `${base}/api/platform/workshops/${workshopId}/drive/files/drive-file-1`,
      { method: 'DELETE', headers: { Authorization: 'Bearer valid-token' } },
    );
    assert.equal(deleted.status, 204);
    assert.deepEqual(owned.drive.calls.remove, ['drive-file-1']);
  });

  const foreign = build({
    drive: fakeDrive({
      async fileAppProperties() { return { [WORKSHOP_PROPERTY]: '10000000-0000-4000-8000-000000000009' }; },
    }),
  });
  await withServer(foreign.app, async base => {
    const response = await fetch(
      `${base}/api/platform/workshops/${workshopId}/drive/files/drive-file-1`,
      { headers: { Authorization: 'Bearer valid-token' } },
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'file_not_owned');
    assert.equal(foreign.drive.calls.download.length, 0);
  });
});
