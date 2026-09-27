'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createControlStore } = require('./store');

test('explica que los módulos del plan no se pueden cambiar antes del vencimiento', async () => {
  const store = createControlStore({
    rpc: async () => ({
      data: null,
      error: { message: 'subscription_plan_change_waits_until_expiry' },
    }),
  });

  await assert.rejects(
    store.submitSubscriptionRequest({
      workshopId: '80000000-0000-4000-8000-000000000001',
      requestId: '90000000-0000-4000-8000-000000000001',
      requester: '70000000-0000-4000-8000-000000000001',
      planId: 'a0000000-0000-4000-8000-000000000001',
      receiptPath: '80000000-0000-4000-8000-000000000001/90000000-0000-4000-8000-000000000001.jpg',
      paymentReference: '',
    }),
    error =>
      error.status === 409 &&
      error.code === 'subscription_plan_change_waits_until_expiry' &&
      error.message.includes('mismos módulos'),
  );
});
