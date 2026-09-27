'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createControlStore } = require('./store');

const workshopId = '80000000-0000-4000-8000-000000000001';

test('control store forwards only the workshop-scoped reservation contract', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push({name, args});
      return {data: {created: true, number: 42}, error: null};
    },
  };
  const store = createControlStore(db);
  const result = await store.reserveFacturatechNumber(workshopId, {
    idempotencyKey: 'invoice-order-42',
    sourceFingerprint: 'a'.repeat(64),
    requestFingerprint: 'b'.repeat(64),
    numbering: {
      prefijo: 'MT', resolucion: 'RES-42', rangoDesde: 1, rangoHasta: 99,
    },
  });

  assert.deepEqual(result, {created: true, number: 42});
  assert.deepEqual(calls, [{
    name: 'platform_reserve_facturatech_number',
    args: {
      p_workshop_id: workshopId,
      p_idempotency_key: 'invoice-order-42',
      p_source_fingerprint: 'a'.repeat(64),
      p_request_fingerprint: 'b'.repeat(64),
      p_prefix: 'MT',
      p_resolution: 'RES-42',
      p_range_start: 1,
      p_range_end: 99,
    },
  }]);
});

test('control store translates fiscal reservation failures to safe client errors', async () => {
  const cases = [
    ['idempotency_conflict', 409],
    ['facturatech_workshop_unavailable', 409],
    ['facturatech_numbering_exhausted', 409],
    ['facturatech_invalid_reservation', 400],
  ];

  for (const [message, status] of cases) {
    const store = createControlStore({
      async rpc() { return {data: null, error: {message}}; },
    });
    await assert.rejects(
      store.reserveFacturatechNumber(workshopId, {
        idempotencyKey: 'invoice-order-42',
        sourceFingerprint: 'a'.repeat(64),
        requestFingerprint: 'b'.repeat(64),
        numbering: {prefijo: 'MT', resolucion: 'RES-42', rangoDesde: 1, rangoHasta: 99},
      }),
      error => error.status === status && error.code === message,
      `expected a safe ${status} response for ${message}`,
    );
  }
});

test('control store uses the durable provider-submission state machine', async () => {
  const calls = [];
  const store = createControlStore({
    async rpc(name, args) {
      calls.push({name, args});
      return {data: {claimed: true, state: 'submitting'}, error: null};
    },
  });
  const claimed = await store.claimFacturatechSubmission(workshopId, {
    idempotencyKey: 'invoice-order-42', requestFingerprint: 'a'.repeat(64),
  });
  assert.deepEqual(claimed, {claimed: true, state: 'submitting'});
  const recorded = await store.recordFacturatechSubmission(workshopId, {
    idempotencyKey: 'invoice-order-42', requestFingerprint: 'a'.repeat(64),
    state: 'uncertain', transactionId: 'provider-tx-42', providerStatus: 'RECEIVED',
  });
  assert.deepEqual(recorded, {claimed: true, state: 'submitting'});
  assert.deepEqual(calls, [
    {
      name: 'platform_claim_facturatech_submission',
      args: {
        p_workshop_id: workshopId,
        p_idempotency_key: 'invoice-order-42',
        p_request_fingerprint: 'a'.repeat(64),
      },
    },
    {
      name: 'platform_record_facturatech_submission',
      args: {
        p_workshop_id: workshopId,
        p_idempotency_key: 'invoice-order-42',
        p_request_fingerprint: 'a'.repeat(64),
        p_state: 'uncertain',
        p_transaction_id: 'provider-tx-42',
        p_provider_status: 'RECEIVED',
      },
    },
  ]);
});

test('control store explains a previous or uncertain emission without retrying it', async () => {
  for (const message of [
    'facturatech_submission_state_conflict',
    'facturatech_transaction_conflict',
    'facturatech_source_already_reserved',
  ]) {
    const store = createControlStore({
      async rpc() { return {data: null, error: {message}}; },
    });
    await assert.rejects(
      store.claimFacturatechSubmission(workshopId, {
        idempotencyKey: 'invoice-order-42', requestFingerprint: 'a'.repeat(64),
      }),
      error => error.status === 409 && error.code === message,
    );
  }
});
