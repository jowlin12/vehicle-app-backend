'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const express = require('express');
const { createPlatformRouter, validSubscriptionReceiptImage } = require('./router');
const { SCHEMA_VERSION } = require('./provisioning');
const { createSecretBox } = require('./secrets');

const ADMIN_ID = '10000000-0000-4000-8000-000000000001';
const OWNER_ID = '20000000-0000-4000-8000-000000000001';
const WORKSHOP_ID = '80000000-0000-4000-8000-000000000001';
const REQUEST_ID = '70000000-0000-4000-8000-000000000001';
const PROJECT_REF = 'abcdefghijklmnopqrst';

test('la firma del archivo debe coincidir con la extensión y el MIME declarado', () => {
  const jpeg = Buffer.alloc(64);
  jpeg.set([0xff, 0xd8, 0xff]);
  jpeg.set([0xff, 0xd9], jpeg.length - 2);
  const png = Buffer.alloc(64);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(0, png.length - 12);
  png.write('IEND', png.length - 8, 'ascii');
  const webp = Buffer.alloc(26);
  webp.write('RIFF', 0, 'ascii');
  webp.writeUInt32LE(webp.length - 8, 4);
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8L', 12, 'ascii');
  webp.writeUInt32LE(5, 16);
  webp[20] = 0x2f;

  assert.equal(validSubscriptionReceiptImage(jpeg, 'jpg', 'image/jpeg'), true);
  assert.equal(validSubscriptionReceiptImage(jpeg, 'webp', 'image/webp'), false);
  assert.equal(validSubscriptionReceiptImage(png, 'png', 'image/png'), true);
  assert.equal(validSubscriptionReceiptImage(webp, 'webp', 'image/webp'), true);
  assert.equal(validSubscriptionReceiptImage(jpeg.subarray(0, 20), 'jpg', 'image/jpeg'), false);
  assert.equal(validSubscriptionReceiptImage(png.subarray(0, 20), 'png', 'image/png'), false);
  assert.equal(validSubscriptionReceiptImage(webp.subarray(0, 20), 'webp', 'image/webp'), false);
  assert.equal(validSubscriptionReceiptImage(Buffer.from('not an image'), 'jpg', 'image/jpeg'), false);
});

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
        assert.deepEqual(input.modules, []);
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

test('un plan admite módulos comercializables y valida sus dependencias', async () => {
  const saved = [];
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    store: {
      isAdmin: async () => true,
      savePlan: async (_adminId, plan) => {
        saved.push(plan);
        return { id: 'a0000000-0000-4000-8000-000000000001', ...plan };
      },
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const headers = {
      Authorization: 'Bearer admin-session',
      'Content-Type': 'application/json',
    };
    for (const module of ['supplier_invoices', 'settlements', 'electronic_invoices']) {
      const invalid = await fetch(`${base}/api/platform/billing/plans`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          code: 'solo', name: 'Módulo sin Órdenes', priceCop: 50000,
          durationDays: 30, modules: [module],
        }),
      });
      assert.equal(invalid.status, 400);
    }
    assert.equal(saved.length, 0);

    const valid = await fetch(`${base}/api/platform/billing/plans`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'completo', name: 'Completo', priceCop: 80000,
        durationDays: 30, modules: ['orders', 'supplier_invoices', 'settlements', 'electronic_invoices'],
      }),
    });
    assert.equal(valid.status, 201);
    const body = await valid.json();
    assert.deepEqual(body.plan.modules, ['electronic_invoices', 'orders', 'settlements', 'supplier_invoices']);
    assert.deepEqual(saved[0].modules, ['electronic_invoices', 'orders', 'settlements', 'supplier_invoices']);
  });
});

test('no desactiva el último plan de Órdenes si hay talleres con suscripción requerida', async () => {
  const planId = 'a0000000-0000-4000-8000-000000000001';
  const otherPlanId = 'b0000000-0000-4000-8000-000000000001';
  const plan = { id: planId, active: true, modules: ['orders'] };
  const workshop = { id: WORKSHOP_ID, status: 'ready', subscription_required: true };

  for (const scenario of [
    { plans: [plan], expectedStatus: 409 },
    { plans: [plan, { id: otherPlanId, active: true, modules: ['orders'] }], expectedStatus: 200 },
  ]) {
    const saved = [];
    const router = createPlatformRouter({
      auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
      store: {
        isAdmin: async () => true,
        list: async () => [workshop],
        listPlans: async () => scenario.plans,
        savePlan: async (_adminId, input) => {
          saved.push(input);
          return { id: planId, ...input };
        },
      },
    });
    const app = express();
    app.use('/api/platform', router);

    await withServer(app, async base => {
      const response = await fetch(`${base}/api/platform/billing/plans/${planId}`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer admin-session',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code: 'basico', name: 'Básico', priceCop: 50000,
          durationDays: 30, active: false, modules: ['orders'],
        }),
      });
      assert.equal(response.status, scenario.expectedStatus);
      if (response.status === 409) {
        assert.equal((await response.json()).code, 'subscription_plan_required');
      }
    });

    assert.equal(saved.length, scenario.expectedStatus === 200 ? 1 : 0);
  }
});

test('la cuenta de transferencia no admite datos bancarios obligatorios vacíos', async () => {
  const saved = [];
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    store: {
      isAdmin: async () => true,
      savePaymentSettings: async (_adminId, settings) => {
        saved.push(settings);
        return {
          bank_name: settings.bankName,
          account_type: settings.accountType,
          account_number: settings.accountNumber,
          account_holder: settings.accountHolder,
          holder_document: settings.holderDocument,
          instructions: settings.instructions,
          review_grace_hours: settings.reviewGraceHours,
        };
      },
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const headers = {
      Authorization: 'Bearer admin-session',
      'Content-Type': 'application/json',
    };
    const incomplete = await fetch(`${base}/api/platform/billing/payment-settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        bankName: 'Banco de prueba', accountType: 'Ahorros', accountNumber: '  ',
        accountHolder: 'Taller Norte', holderDocument: '', instructions: '',
        reviewGraceHours: 72,
      }),
    });
    assert.equal(incomplete.status, 400);
    assert.equal((await incomplete.json()).code, 'invalid_payment_settings');
    assert.equal(saved.length, 0);

    const valid = await fetch(`${base}/api/platform/billing/payment-settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        bankName: ' Banco de prueba ', accountType: 'Ahorros', accountNumber: ' 12345 ',
        accountHolder: ' Taller Norte ', holderDocument: '', instructions: '',
        reviewGraceHours: 72,
      }),
    });
    assert.equal(valid.status, 200);
    assert.equal(saved[0].bankName, 'Banco de prueba');
    assert.equal(saved[0].accountNumber, '12345');
    assert.equal(saved[0].accountHolder, 'Taller Norte');
  });
});

test('el propietario envía el comprobante y recibe solo el acceso provisional', async () => {
  let receiptBytes = Buffer.alloc(64);
  receiptBytes.set([0xff, 0xd8, 0xff]);
  receiptBytes.set([0xff, 0xd9], receiptBytes.length - 2);
  const future = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const calls = [];
  const row = {
    id: WORKSHOP_ID,
    name: 'Taller Norte',
    status: 'ready',
    connection_ref: PROJECT_REF,
    modules: [],
    schema_version: SCHEMA_VERSION,
    subscription_required: true,
    paid_until: null,
    review_access_until: null,
  };
  const submittedWorkshop = {
    ...row,
    modules: ['orders', 'supplier_invoices'],
    review_modules: ['orders', 'supplier_invoices'],
    review_access_until: future,
  };
  const moduleAccess = new Map();
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: OWNER_ID } }, error: null }) },
    store: {
      isAdmin: async () => false,
      membership: async () => ({ role: 'owner', active: true }),
      get: async () => row,
      hasOpenSubscriptionRequest: async () => true,
      listPlans: async () => [{ id: 'a0000000-0000-4000-8000-000000000001' }],
      submitSubscriptionRequest: async input => {
        calls.push(['submit', input]);
        return {
          created: true,
          request: { id: REQUEST_ID, status: 'pending', receipt_path: `${WORKSHOP_ID}/${REQUEST_ID}.jpg` },
          workshop: submittedWorkshop,
        };
      },
    },
    resolveConnection: async () => ({ url: `https://${PROJECT_REF}.supabase.co` }),
    provisioner: {
      getModuleAccess: async ({ module }) => moduleAccess.get(module) || {
        enabled: false,
        expiresAt: null,
      },
      setModuleAccess: async input => {
        calls.push(['access', input]);
        moduleAccess.set(input.module, {
          enabled: input.enabled,
          expiresAt: input.expiresAt,
        });
      },
    },
    storage: {
      from: bucket => {
        assert.equal(bucket, 'platform-payment-receipts');
        return {
          list: async (folder, options) => {
            assert.equal(folder, WORKSHOP_ID);
            assert.equal(options.search, `${REQUEST_ID}.jpg`);
            return { data: [{ name: `${REQUEST_ID}.jpg`, metadata: { size: receiptBytes.length, mimetype: 'image/jpeg' } }], error: null };
          },
          download: async path => {
            assert.equal(path, `${WORKSHOP_ID}/${REQUEST_ID}.jpg`);
            return { data: new Blob([receiptBytes]), error: null };
          },
        };
      },
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const response = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/subscription-requests`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-session', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: REQUEST_ID,
        planId: 'a0000000-0000-4000-8000-000000000001',
        extension: 'jpg',
        paymentReference: 'TRX-123',
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.request.status, 'pending');
    assert.equal('receipt_path' in body.request, false);
    assert.deepEqual(body.workshop.modules, ['orders', 'supplier_invoices']);
    assert.equal(calls[0][0], 'submit');
    assert.equal(calls[1][0], 'access');
    assert.equal(calls[1][1].module, 'orders');
    assert.equal(calls[1][1].enabled, true);
    assert.equal(calls[1][1].expiresAt, future);
    assert.equal(calls[2][1].module, 'supplier_invoices');
    assert.equal(calls[2][1].enabled, true);
    assert.equal(calls[2][1].expiresAt, future);

    const submissionsBeforeInvalidImage = calls.filter(([operation]) => operation === 'submit').length;
    receiptBytes = Buffer.from('not an image');
    const invalidImage = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/subscription-requests`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-session', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: REQUEST_ID,
        planId: 'a0000000-0000-4000-8000-000000000001',
        extension: 'jpg',
        paymentReference: 'TRX-123',
      }),
    });
    assert.equal(invalidImage.status, 400);
    assert.equal((await invalidImage.json()).code, 'invalid_subscription_receipt');
    assert.equal(calls.filter(([operation]) => operation === 'submit').length, submissionsBeforeInvalidImage);
  });
});

test('los módulos respetan dependencias y el cambio a plan requerido cierra el acceso', async () => {
  const row = {
    id: WORKSHOP_ID,
    name: 'Taller Norte',
    status: 'ready',
    connection_ref: PROJECT_REF,
    modules: ['orders'],
    schema_version: SCHEMA_VERSION,
    subscription_required: false,
    paid_until: null,
    review_access_until: null,
    paid_modules: [],
    review_modules: [],
  };
  const access = new Map([
    ['orders', { enabled: true, expiresAt: null }],
    ['supplier_invoices', { enabled: false, expiresAt: null }],
    ['settlements', { enabled: false, expiresAt: null }],
    ['electronic_invoices', { enabled: false, expiresAt: null }],
  ]);
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    store: {
      isAdmin: async () => true,
      membership: async () => null,
      get: async () => row,
      hasOpenSubscriptionRequest: async () => false,
      listPlans: async () => [{ active: true, modules: ['orders'] }],
      getPaymentSettings: async () => ({
        bank_name: 'Banco de prueba',
        account_type: 'Ahorros',
        account_number: '12345',
        account_holder: 'Taller Norte',
      }),
      setModuleEnabled: async (_id, module, enabled) => {
        row.modules = enabled
          ? [...new Set([...row.modules, module])].sort()
          : row.modules.filter(item => item !== module);
        return row;
      },
      setSubscriptionRequired: async (_id, required) => {
        row.subscription_required = required;
        return row;
      },
    },
    resolveConnection: async () => ({ url: `https://${PROJECT_REF}.supabase.co` }),
    provisioner: {
      getModuleAccess: async ({ module }) => access.get(module),
      setModuleAccess: async ({ module, enabled, expiresAt }) => {
        access.set(module, { enabled, expiresAt });
      },
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const enableSupplierInvoices = await fetch(
      `${base}/api/platform/workshops/${WORKSHOP_ID}/modules/supplier_invoices`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin-session', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    );
    assert.equal(enableSupplierInvoices.status, 200);
    assert.deepEqual((await enableSupplierInvoices.json()).workshop.modules,
      ['orders', 'supplier_invoices']);

    const enableSettlements = await fetch(
      `${base}/api/platform/workshops/${WORKSHOP_ID}/modules/settlements`,
      { method: 'PUT', headers: { Authorization:'Bearer admin-session','Content-Type':'application/json' },
        body: JSON.stringify({enabled:true}) },
    );
    assert.equal(enableSettlements.status, 200);
    assert.deepEqual((await enableSettlements.json()).workshop.modules,
      ['orders','settlements','supplier_invoices']);

    const enableElectronicInvoices = await fetch(
      `${base}/api/platform/workshops/${WORKSHOP_ID}/modules/electronic_invoices`,
      { method: 'PUT', headers: { Authorization:'Bearer admin-session','Content-Type':'application/json' },
        body: JSON.stringify({enabled:true}) },
    );
    assert.equal(enableElectronicInvoices.status, 200);
    assert.deepEqual((await enableElectronicInvoices.json()).workshop.modules,
      ['electronic_invoices','orders','settlements','supplier_invoices']);

    const disableOrders = await fetch(
      `${base}/api/platform/workshops/${WORKSHOP_ID}/modules/orders`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin-session', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
    );
    assert.equal(disableOrders.status, 409);
    assert.equal((await disableOrders.json()).code, 'module_dependency');

    const requireSubscription = await fetch(
      `${base}/api/platform/workshops/${WORKSHOP_ID}/subscription-required`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin-session', 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: true }),
      },
    );
    assert.equal(requireSubscription.status, 200);
    const body = await requireSubscription.json();
    assert.equal(body.workshop.subscriptionRequired, true);
    assert.deepEqual(body.workshop.modules, []);
    assert.deepEqual([...access.values()], [
      { enabled: false, expiresAt: null },
      { enabled: false, expiresAt: null },
      { enabled: false, expiresAt: null },
      { enabled: false, expiresAt: null },
    ]);
  });
});

test('no exige un plan si falta un plan activo o una cuenta de transferencia', async () => {
  const validPlan = { active: true, modules: ['orders'] };
  const validSettings = {
    bank_name: 'Banco de prueba',
    account_type: 'Ahorros',
    account_number: '12345',
    account_holder: 'Taller Norte',
  };
  const scenarios = [
    { plans: [], settings: validSettings },
    { plans: [validPlan], settings: { ...validSettings, account_number: '  ' } },
  ];

  for (const scenario of scenarios) {
    const row = {
      id: WORKSHOP_ID,
      name: 'Taller Norte',
      status: 'ready',
      connection_ref: PROJECT_REF,
      modules: ['orders'],
      schema_version: SCHEMA_VERSION,
      subscription_required: false,
      paid_until: null,
      review_access_until: null,
      paid_modules: [],
      review_modules: [],
    };
    let changed = false;
    let connected = false;
    const router = createPlatformRouter({
      auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
      store: {
        isAdmin: async () => true,
        membership: async () => null,
        get: async () => row,
        listPlans: async () => scenario.plans,
        getPaymentSettings: async () => scenario.settings,
        setSubscriptionRequired: async (_id, required) => {
          changed = true;
          row.subscription_required = required;
          return row;
        },
      },
      resolveConnection: async () => {
        connected = true;
        return { url: `https://${PROJECT_REF}.supabase.co` };
      },
      provisioner: {
        getModuleAccess: async () => ({ enabled: true, expiresAt: null }),
        setModuleAccess: async () => {},
      },
    });
    const app = express();
    app.use('/api/platform', router);

    await withServer(app, async base => {
      const response = await fetch(
        `${base}/api/platform/workshops/${WORKSHOP_ID}/subscription-required`,
        {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer admin-session',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ required: true }),
        },
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'billing_setup_incomplete');
    });

    assert.equal(changed, false);
    assert.equal(connected, false);
    assert.equal(row.subscription_required, false);
  }
});

test('solo un administrador global puede crear, revisar y firmar recibos', async () => {
  let capturedSignedPath;
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    store: {
      isAdmin: async id => id === ADMIN_ID,
      listSubscriptionRequests: async () => [{
        id: REQUEST_ID,
        receipt_path: `${WORKSHOP_ID}/${REQUEST_ID}.png`,
        status: 'pending',
        platform_workshops: { name: 'Taller Norte' },
      }],
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path, seconds) => {
          capturedSignedPath = path;
          assert.equal(seconds, 300);
          return { data: { signedUrl: 'https://storage.example/signed-receipt' }, error: null };
        },
      }),
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const response = await fetch(`${base}/api/platform/subscriptions/review`, {
      headers: { Authorization: 'Bearer admin-session' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.requests[0].receiptUrl, 'https://storage.example/signed-receipt');
    assert.equal('receipt_path' in body.requests[0], false);
    assert.equal(capturedSignedPath, `${WORKSHOP_ID}/${REQUEST_ID}.png`);
  });
});

test('libera la revisión si no se puede conectar a la base operativa del taller', async () => {
  const released = [];
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    store: {
      isAdmin: async () => true,
      claimSubscriptionRequest: async () => ({
        id: REQUEST_ID,
        workshop_id: WORKSHOP_ID,
        plan_snapshot: { modules: ['orders'] },
        active_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      get: async () => ({
        id: WORKSHOP_ID,
        connection_ref: PROJECT_REF,
        schema_version: 'vehicleapp.orders.v1',
        paid_until: null,
        paid_modules: [],
        modules: ['orders'],
      }),
      getSubscriptionRequest: async () => ({ status: 'reviewing' }),
      releaseSubscriptionReview: async (...args) => released.push(args),
    },
    resolveConnection: async () => { throw new Error('tenant database unavailable'); },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const response = await fetch(`${base}/api/platform/subscriptions/${REQUEST_ID}/review`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'platform_unavailable');
  });

  assert.deepEqual(released, [[REQUEST_ID, ADMIN_ID]]);
});

function subscriptionReviewHarness({
  modules,
  paidModules,
  paidUntil,
  reviewModules,
  reviewUntil,
  planModules,
  activeUntil,
}) {
  const workshop = {
    id: WORKSHOP_ID,
    name: 'Taller Norte',
    status: 'ready',
    connection_ref: PROJECT_REF,
    schema_version: SCHEMA_VERSION,
    modules: [...modules],
    subscription_required: true,
    active_plan_id: null,
    paid_until: paidUntil,
    paid_modules: [...paidModules],
    review_access_until: reviewUntil,
    review_modules: [...reviewModules],
  };
  const request = {
    id: REQUEST_ID,
    workshop_id: WORKSHOP_ID,
    plan_id: 'a0000000-0000-4000-8000-000000000001',
    plan_snapshot: { name: 'Plan prueba', modules: [...planModules], duration_days: 30 },
    receipt_path: `${WORKSHOP_ID}/${REQUEST_ID}.jpg`,
    status: 'pending',
    active_until: activeUntil,
  };
  const moduleAccess = new Map([
    ['orders', { enabled: modules.includes('orders'), expiresAt: reviewUntil || paidUntil }],
    ['supplier_invoices', {
      enabled: modules.includes('supplier_invoices'),
      expiresAt: reviewUntil || null,
    }],
    ['settlements', {
      enabled: modules.includes('settlements'),
      expiresAt: paidUntil || reviewUntil || null,
    }],
    ['electronic_invoices', {
      enabled: modules.includes('electronic_invoices'),
      expiresAt: paidUntil || reviewUntil || null,
    }],
  ]);
  const accessWrites = [];
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    store: {
      isAdmin: async id => id === ADMIN_ID,
      claimSubscriptionRequest: async (id, reviewer, decision) => {
        assert.equal(id, REQUEST_ID);
        assert.equal(reviewer, ADMIN_ID);
        assert.ok(['approve', 'reject'].includes(decision));
        request.status = 'reviewing';
        return { ...request };
      },
      get: async id => {
        assert.equal(id, WORKSHOP_ID);
        return structuredClone(workshop);
      },
      hasOpenSubscriptionRequest: async () =>
        ['pending', 'reviewing'].includes(request.status),
      finishSubscriptionRequest: async (id, reviewer, decision, note) => {
        assert.equal(id, REQUEST_ID);
        assert.equal(reviewer, ADMIN_ID);
        assert.equal(note, 'Revisado desde prueba');
        request.status = decision === 'approve' ? 'approved' : 'rejected';
        request.review_note = note;
        if (decision === 'approve') {
          workshop.active_plan_id = request.plan_id;
          workshop.modules = [...request.plan_snapshot.modules];
          workshop.paid_modules = [...request.plan_snapshot.modules];
          workshop.paid_until = request.active_until;
          workshop.review_access_until = null;
          workshop.review_modules = [];
        } else {
          workshop.modules = [...workshop.paid_modules];
          workshop.review_access_until = null;
          workshop.review_modules = [];
        }
        return {
          request: { ...request },
          workshop: decision === 'approve' ? structuredClone(workshop) : null,
        };
      },
      getSubscriptionRequest: async () => ({ ...request }),
      releaseSubscriptionReview: async () => { request.status = 'pending'; },
    },
    resolveConnection: async ref => {
      assert.equal(ref, PROJECT_REF);
      return { url: `https://${PROJECT_REF}.supabase.co` };
    },
    provisioner: {
      getModuleAccess: async ({ module }) => ({ ...moduleAccess.get(module) }),
      setModuleAccess: async input => {
        accessWrites.push({ ...input });
        moduleAccess.set(input.module, {
          enabled: input.enabled,
          expiresAt: input.expiresAt,
        });
      },
    },
  });
  return { router, workshop, request, moduleAccess, accessWrites };
}

test('la renovación mantiene el vencimiento propio de cada módulo', async () => {
  const paidUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const reviewUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const row = {
    id: WORKSHOP_ID,
    name: 'Taller Norte',
    status: 'ready',
    connection_ref: PROJECT_REF,
    schema_version: SCHEMA_VERSION,
    modules: ['orders', 'supplier_invoices', 'settlements'],
    subscription_required: true,
    paid_until: paidUntil,
    paid_modules: ['orders', 'settlements'],
    review_access_until: reviewUntil,
    review_modules: ['supplier_invoices'],
  };
  const writes = [];
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: OWNER_ID } }, error: null }) },
    store: {
      isAdmin: async () => false,
      membership: async () => ({ role: 'owner', active: true }),
      get: async () => row,
      hasOpenSubscriptionRequest: async () => true,
      listSubscriptionRequests: async () => [],
      getPaymentSettings: async () => null,
    },
    resolveConnection: async () => ({ url: `https://${PROJECT_REF}.supabase.co` }),
    provisioner: {
      getModuleAccess: async () => ({ enabled: false, expiresAt: null }),
      setModuleAccess: async input => writes.push(input),
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const response = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/subscription`, {
      headers: { Authorization: 'Bearer owner-session' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.workshop.modules, ['orders', 'settlements', 'supplier_invoices']);
  });

  assert.deepEqual(
    writes.map(({ module, enabled, expiresAt }) => ({ module, enabled, expiresAt })),
    [
      { module: 'orders', enabled: true, expiresAt: paidUntil },
      { module: 'supplier_invoices', enabled: true, expiresAt: reviewUntil },
      { module: 'settlements', enabled: true, expiresAt: paidUntil },
      { module: 'electronic_invoices', enabled: false, expiresAt: null },
    ],
  );
});

test('la activación administrativa conserva el vencimiento propio del módulo', async () => {
  const paidUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const reviewUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const row = {
    id: WORKSHOP_ID,
    name: 'Taller Norte',
    status: 'ready',
    connection_ref: PROJECT_REF,
    schema_version: SCHEMA_VERSION,
    modules: ['orders', 'supplier_invoices'],
    subscription_required: true,
    paid_until: paidUntil,
    paid_modules: ['orders'],
    review_access_until: reviewUntil,
    review_modules: ['supplier_invoices'],
  };
  const writes = [];
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    store: {
      isAdmin: async () => true,
      membership: async () => null,
      get: async () => row,
      hasOpenSubscriptionRequest: async () => true,
      setModuleEnabled: async () => row,
    },
    resolveConnection: async () => ({ url: `https://${PROJECT_REF}.supabase.co` }),
    provisioner: {
      getModuleAccess: async () => ({ enabled: false, expiresAt: null }),
      setModuleAccess: async input => writes.push(input),
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    for (const [module, expectedExpiry] of [
      ['supplier_invoices', reviewUntil],
      ['orders', paidUntil],
    ]) {
      const response = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/modules/${module}`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer admin-session',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(response.status, 200);
      assert.equal(writes.at(-1).module, module);
      assert.equal(writes.at(-1).expiresAt, expectedExpiry);
    }
  });
});

test('aprobar transferencia activa los módulos con los días pagados del plan', async () => {
  const reviewUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const activeUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const harness = subscriptionReviewHarness({
    modules: ['orders', 'settlements'],
    paidModules: [],
    paidUntil: null,
    reviewModules: ['orders', 'settlements'],
    reviewUntil,
    planModules: ['orders', 'settlements'],
    activeUntil,
  });
  const app = express();
  app.use('/api/platform', harness.router);

  await withServer(app, async base => {
    const response = await fetch(`${base}/api/platform/subscriptions/${REQUEST_ID}/review`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve', note: 'Revisado desde prueba' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.request.status, 'approved');
    assert.equal(body.workshop.paidUntil, activeUntil);
    assert.equal(body.workshop.reviewAccessUntil, null);
    assert.deepEqual(body.workshop.modules, ['orders', 'settlements']);
  });

  assert.equal(harness.request.status, 'approved');
  assert.equal(harness.moduleAccess.get('orders').enabled, true);
  assert.equal(harness.moduleAccess.get('orders').expiresAt, activeUntil);
  assert.equal(harness.moduleAccess.get('supplier_invoices').enabled, false);
  assert.equal(harness.moduleAccess.get('supplier_invoices').expiresAt, null);
  assert.equal(harness.moduleAccess.get('settlements').enabled, true);
  assert.equal(harness.moduleAccess.get('settlements').expiresAt, activeUntil);
});

test('el perfil del documento solo puede editarlo un administrador global', async () => {
  const row = {
    id: WORKSHOP_ID,
    name: 'Taller Norte',
    status: 'ready',
    schema_version: SCHEMA_VERSION,
    document_profile: {},
  };
  let saved;
  const router = createPlatformRouter({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    store: {
      isAdmin: async id => id === ADMIN_ID,
      membership: async () => null,
      get: async () => row,
      updateDocumentProfile: async (_id, profile) => {
        saved = profile;
        row.document_profile = profile;
        return row;
      },
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const headers = {
      Authorization: 'Bearer admin-session',
      'Content-Type': 'application/json',
    };
    const before = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/document-profile`, {headers});
    assert.equal(before.status, 200);
    assert.equal((await before.json()).documentProfile.issuerName, 'Taller Norte');

    const after = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/document-profile`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({documentProfile: {
        templateKey: 'compact-v1', issuerName: 'Taller Norte S.A.S.',
        taxId: '900123456', address: 'Calle 1', city: 'Cúcuta', phone: '3001234567',
        email: 'facturas@example.com', paymentInstructions: 'Banco\nCuenta 123',
        thankYouMessage: 'Gracias por su visita.',
      }}),
    });
    assert.equal(after.status, 200);
    assert.equal((await after.json()).documentProfile.templateKey, 'compact-v1');
  });

  assert.equal(saved.issuerName, 'Taller Norte S.A.S.');
  assert.equal(saved.paymentInstructions, 'Banco\nCuenta 123');
});

test('el perfil Facturatech del taller se cifra, conserva sus credenciales y nunca las devuelve', async () => {
  const row = {
    id: WORKSHOP_ID,
    name: 'Taller Norte',
    status: 'ready',
    schema_version: SCHEMA_VERSION,
  };
  const secretBox = createSecretBox(Buffer.alloc(32, 7).toString('hex'));
  let saved = null;
  let globalAdmin = true;
  const router = createPlatformRouter({
    auth: {getUser: async () => ({data: {user: {id: ADMIN_ID}}, error: null})},
    secretBox,
    store: {
      isAdmin: async () => globalAdmin,
      membership: async () => null,
      get: async () => row,
      getFacturatechProfile: async () => saved,
      saveFacturatechProfile: async (id, actor, ciphertext) => {
        saved = {
          workshop_id: id,
          configuration_ciphertext: ciphertext,
          updated_by: actor,
          updated_at: '2026-09-27T05:00:00.000Z',
        };
        return saved;
      },
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const url = `${base}/api/platform/workshops/${WORKSHOP_ID}/facturatech-profile`;
    const headers = {Authorization: 'Bearer admin-session', 'Content-Type': 'application/json'};
    const empty = await fetch(url, {headers});
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).facturatechProfile, {configured: false});
    assert.match(empty.headers.get('cache-control'), /no-store/i);

    const input = {
      environment: 'demo',
      issuer: {
        tipoPersona: '1', nit: '900123456', dv: '7', razonSocial: 'Taller Norte S.A.S.',
        nombreComercial: 'Taller Norte', direccion: 'Calle 1 #2-3', codigoCiudad: '54001',
        ciudad: 'Cúcuta', departamento: 'Norte de Santander', codigoDepto: '54', pais: 'CO',
        telefono: '300 123 4567', responsabilidad: 'R-99-PN', regimen: '49',
      },
      numbering: {prefijo: 'tn', resolucion: '18760000001', rangoDesde: 1, rangoHasta: 5000},
      credentials: {username: 'sandbox-user', password: 'sandbox-password'},
    };
    const put = await fetch(url, {
      method: 'PUT', headers, body: JSON.stringify({facturatechProfile: input}),
    });
    assert.equal(put.status, 200);
    const response = await put.json();
    assert.equal(response.facturatechProfile.environment, 'demo');
    assert.equal(response.facturatechProfile.credentialsConfigured, true);
    assert.equal(JSON.stringify(response).includes('sandbox-user'), false);
    assert.equal(JSON.stringify(response).includes('sandbox-password'), false);
    assert.match(put.headers.get('cache-control'), /no-store/i);

    const storedPlaintext = secretBox.open(saved.configuration_ciphertext);
    assert.equal(storedPlaintext.includes('sandbox-password'), false);
    assert.equal(JSON.parse(storedPlaintext).credentials.passwordHash.length, 64);

    const edit = await fetch(url, {
      method: 'PUT', headers,
      body: JSON.stringify({facturatechProfile: {
        environment: 'demo',
        issuer: {...input.issuer, razonSocial: 'Taller Norte SAS'},
        numbering: input.numbering,
      }}),
    });
    assert.equal(edit.status, 200);
    assert.equal(secretBox.open(saved.configuration_ciphertext).includes('sandbox-password'), false);

    globalAdmin = false;
    const forbidden = await fetch(url, {headers});
    assert.equal(forbidden.status, 403);
  });
});

test('el perfil Facturatech no adopta la configuración del taller legacy', async () => {
  const router = createPlatformRouter({
    auth: {getUser: async () => ({data: {user: {id: ADMIN_ID}}, error: null})},
    store: {
      isAdmin: async () => true,
      membership: async () => null,
      get: async () => ({
        id: WORKSHOP_ID, name: 'Taller actual', status: 'ready',
        schema_version: 'legacy-existing-v1',
      }),
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const response = await fetch(
      `${base}/api/platform/workshops/${WORKSHOP_ID}/facturatech-profile`,
      {headers: {Authorization: 'Bearer admin-session'}},
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'facturatech_profile_unavailable');
  });
});

test('legacy platform admins can fetch public connection and link only an operational admin', async () => {
  const legacy = {
    id: WORKSHOP_ID,
    name: 'Taller actual',
    status: 'ready',
    connection_ref: PROJECT_REF,
    schema_version: 'legacy-existing-v1',
    modules: ['orders'],
    subscription_required: false,
  };
  let operationalRole = 'admin';
  const linked = [];
  const router = createPlatformRouter({
    auth: {getUser: async () => ({data: {user: {id: ADMIN_ID}}, error: null})},
    store: {
      isAdmin: async () => true,
      membership: async () => null,
      get: async () => legacy,
      linkMember: async (...args) => linked.push(args),
    },
    resolveConnection: async ref => {
      assert.equal(ref, PROJECT_REF);
      return {
        url: `https://${PROJECT_REF}.supabase.co`,
        publishableKey: 'sb_publishable_legacy_public_key',
        serviceRoleKey: 'must-not-be-returned',
      };
    },
    makeClient: () => ({
      auth: {getUser: async () => ({data: {user: {id: OWNER_ID}}, error: null})},
      from: table => ({
        select: () => ({
          eq: () => ({maybeSingle: async () => table === 'profiles'
            ? {data: {role: operationalRole}, error: null}
            : {data: null, error: null}}),
        }),
      }),
    }),
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const headers = {Authorization: 'Bearer admin-session'};
    const connection = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/connection`, {headers});
    assert.equal(connection.status, 200);
    const response = await connection.json();
    assert.equal(response.url, `https://${PROJECT_REF}.supabase.co`);
    assert.equal(response.publishableKey, 'sb_publishable_legacy_public_key');
    assert.equal(JSON.stringify(response).includes('must-not-be-returned'), false);

    const link = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/link-session`, {
      method: 'POST',
      headers: {...headers, 'X-Workshop-Authorization': 'Bearer operational-session'},
    });
    assert.equal(link.status, 200);
    assert.deepEqual(linked, [[WORKSHOP_ID, ADMIN_ID, OWNER_ID, 'admin']]);

    operationalRole = 'empleado';
    const employeeLink = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/link-session`, {
      method: 'POST',
      headers: {...headers, 'X-Workshop-Authorization': 'Bearer operational-session'},
    });
    assert.equal(employeeLink.status, 403);
    assert.equal((await employeeLink.json()).code, 'workshop_admin_required');
    assert.equal(linked.length, 1);

    legacy.schema_version = SCHEMA_VERSION;
    const managedConnection = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/connection`, {headers});
    assert.equal(managedConnection.status, 403);
    assert.equal((await managedConnection.json()).code, 'membership_required');
  });
});

test('la cotización multitaller toma formato, servicios e importes de la base del taller', async () => {
  const format = {
    clave_key: 'F-123', folio: 'FL-123', fecha_entrada: '2026-09-26',
    nombre_cliente: 'Cliente real', costo_mano_obra: 160000, costo_total: 660000,
  };
  const parts = [{descripcion: 'Repuesto de prueba', cantidad: 1, costo_unitario: 500000, created_at: '2026-09-26'}];
  const services = [{servicio: 'Servicio de prueba', precio_mano_obra: 160000, created_at: '2026-09-26'}];
  const rpcCalls = [];
  const quoteCalls = [];
  const dataByTable = {repuestos: parts, servicios: services};
  const db = {
    auth: {getUser: async () => ({data: {user: {id: OWNER_ID}}, error: null})},
    from(table) {
      const builder = {
        select() { return this; },
        eq() { return this; },
        is() { return this; },
        order() { return this; },
        maybeSingle: async () => table === 'formatos'
          ? {data: format, error: null}
          : {data: {role: 'admin', is_active: true, deleted_at: null}, error: null},
        then(resolve, rejectPromise) {
          return Promise.resolve({data: dataByTable[table] || [], error: null}).then(resolve, rejectPromise);
        },
      };
      return builder;
    },
    rpc: async (name, args) => {
      rpcCalls.push({name, args});
      return {data: {}, error: null};
    },
  };
  const row = {
    id: WORKSHOP_ID, name: 'Taller Norte', status: 'ready',
    connection_ref: PROJECT_REF, schema_version: SCHEMA_VERSION,
    modules: ['orders'], subscription_required: false, document_profile: {},
  };
  const filePath = `/api/platform/workshops/${WORKSHOP_ID}/drive/files/privatePdf123`;
  const router = createPlatformRouter({
    auth: {getUser: async () => ({data: {user: {id: ADMIN_ID}}, error: null})},
    store: {
      isAdmin: async id => id === ADMIN_ID,
      membership: async () => ({operational_user_id: OWNER_ID}),
      get: async () => row,
    },
    resolveConnection: async () => ({url: `https://${PROJECT_REF}.supabase.co`}),
    makeClient: (_connection, token) => {
      assert.equal(token, 'operational-session');
      return db;
    },
    quoteGenerator: async input => {
      quoteCalls.push(input);
      return {fileId: 'privatePdf123', filePath};
    },
  });
  const app = express();
  app.use('/api/platform', router);

  await withServer(app, async base => {
    const response = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/documents/customer-quote`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer central-session',
        'X-Workshop-Authorization': 'Bearer operational-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        formatKey: 'F-123',
        formato: {clave_key: 'F-FAKE', nombre_cliente: 'Dato manipulado'},
        repuestos: [], servicios: [], costos: {total: 1},
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).invoiceUrl, filePath);

    dataByTable.servicios = [{servicio: 'Servicio de prueba', precio_mano_obra: null}];
    const pendingPrices = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/documents/customer-quote`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer central-session',
        'X-Workshop-Authorization': 'Bearer operational-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({formatKey: 'F-123'}),
    });
    assert.equal(pendingPrices.status, 409);
    assert.equal((await pendingPrices.json()).code, 'quote_prices_pending');
  });

  assert.equal(quoteCalls.length, 1);
  assert.equal(quoteCalls[0].format.nombre_cliente, 'Cliente real');
  assert.deepEqual(quoteCalls[0].repuestos, parts);
  assert.deepEqual(quoteCalls[0].servicios, services);
  assert.equal(quoteCalls[0].format.costo_total, 660000);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'adjuntar_factura_pdf_v2');
  assert.deepEqual(rpcCalls[0].args, {p_id_formato: 'F-123', p_factura_pdf: filePath});
});

function electronicInvoiceFixture({modules = ['orders', 'electronic_invoices'], uploadThrows = false, pdfResponse = null} = {}) {
  const fiscalProfile = {
    version: 1,
    environment: 'demo',
    issuer: {
      tipoPersona: '1', nit: '900123456', dv: '7', razonSocial: 'Taller Norte SAS',
      nombreComercial: 'Taller Norte', direccion: 'Calle 1 #2-3', codigoCiudad: '54001',
      ciudad: 'Cúcuta', departamento: 'Norte de Santander', codigoDepto: '54', pais: 'CO',
      telefono: '300 123 4567', responsabilidad: 'R-99-PN', regimen: '49', email: '',
    },
    numbering: {prefijo: 'TN', resolucion: 'RES-TEST-1', rangoDesde: 1, rangoHasta: 100},
    credentials: {username: 'sandbox-user', passwordHash: 'a'.repeat(64)},
  };
  const format = {
    clave_key: 'F-123', folio: 'K-18', nombre_cliente: 'Cliente real',
    placa: 'ABC123', marca: 'Nissan', modelo: 2020,
    costo_mano_obra: 160000, costo_total: 660000,
  };
  const dataByTable = {
    repuestos: [{id: 'part-1', descripcion: 'Filtro de aceite', cantidad: 1,
      costo_unitario: 500000, created_at: '2026-09-26'}],
    servicios: [{servicio: 'Cambio de filtro', precio_mano_obra: 160000,
      created_at: '2026-09-26'}],
  };
  let invoiceRecord = null;
  let claims = 0;
  let state = 'reserved';
  let transactionId = null;
  let uploads = 0;
  let statusCalls = 0;
  let pdfDownloads = 0;
  const invoicePdfUploads = [];
  const generated = [];
  const recorded = [];
  const db = {
    auth: {getUser: async token => token === 'operational-session'
      ? {data: {user: {id: OWNER_ID}}, error: null}
      : {data: null, error: new Error('invalid')}},
    from(table) {
      const builder = {
        selection: null,
        inserted: null,
        filter: null,
        select(value) { this.selection = value; return this; },
        eq(column, value) { this.filter = {column, value}; return this; },
        is() { return this; },
        order() { return this; },
        insert(value) { this.inserted = value; return this; },
        update(value) { this.updated = value; return this; },
        async maybeSingle() {
          if (table === 'profiles') return {data: {role: 'admin', is_active: true, deleted_at: null}, error: null};
          if (table === 'formatos') return {data: format, error: null};
          if (table === 'facturas_electronicas') {
            return {data: invoiceRecord?.transaction_id === this.filter?.value ? invoiceRecord : null, error: null};
          }
          return {data: null, error: null};
        },
        async single() {
          if (this.updated) {
            invoiceRecord = {...invoiceRecord, ...this.updated};
            return {data: invoiceRecord, error: null};
          }
          invoiceRecord = {id: 42, ...this.inserted};
          return {data: invoiceRecord, error: null};
        },
        then(resolve, rejectPromise) {
          return Promise.resolve({data: dataByTable[table] || [], error: null}).then(resolve, rejectPromise);
        },
      };
      return builder;
    },
  };
  const row = {
    id: WORKSHOP_ID, name: 'Taller Norte', status: 'ready', connection_ref: PROJECT_REF,
    schema_version: SCHEMA_VERSION, modules, subscription_required: false,
  };
  const router = createPlatformRouter({
    auth: {getUser: async () => ({data: {user: {id: ADMIN_ID}}, error: null})},
    secretBox: {open: () => JSON.stringify(fiscalProfile)},
    store: {
      isAdmin: async () => true,
      membership: async () => ({operational_user_id: OWNER_ID}),
      get: async id => id === WORKSHOP_ID ? row : null,
      getFacturatechProfile: async () => ({configuration_ciphertext: 'encrypted-profile'}),
      reserveFacturatechNumber: async (_id, input) => ({
        created: claims === 0, prefix: 'TN', number: 1, idempotencyKey: input.idempotencyKey,
      }),
      claimFacturatechSubmission: async (_id, input) => {
        claims += 1;
        if (state === 'reserved') { state = 'submitting'; return {claimed: true, state}; }
        return {claimed: false, state, transactionId};
      },
      recordFacturatechSubmission: async (_id, input) => {
        state = input.state;
        transactionId = input.transactionId || transactionId;
        recorded.push(input);
        return {state, transactionId};
      },
      facturatechReservationByTransaction: async (_id, id) => id === transactionId
        ? {idempotency_key: 'invoice-F-123', request_fingerprint: 'f'.repeat(64), submission_state: state}
        : null,
    },
    resolveConnection: async () => ({url: `https://${PROJECT_REF}.supabase.co`}),
    makeClient: () => db,
    drive: {
      async uploadPrivateFile(input) {
        invoicePdfUploads.push(input);
        return {id: 'electronic-invoice-pdf-42'};
      },
      async fileAppProperties() {
        return {
          vehicleAppWorkshop: WORKSHOP_ID,
          vehicleAppDocument: 'electronic_invoice',
          vehicleAppInvoice: '42',
        };
      },
      async downloadPrivateFile() {
        return {data: Readable.from(Buffer.from('%PDF-1.4\n%%EOF'))};
      },
    },
    facturatechServiceFactory: configuration => {
      assert.equal(configuration.environment, 'demo');
      return {
        calcularTotales(items, rate) {
          generated.push({items, rate});
          const baseGravable = items.reduce((sum, item) => sum + item.cantidad * item.precioUnitario, 0);
          const iva = baseGravable * rate / 100;
          return {baseGravable, iva, total: baseGravable + iva};
        },
        generarXmlLayout(customer, items, totals, number, reference) {
          generated.push({customer, items, totals, number, reference});
          return 'SYNTHETIC-LAYOUT';
        },
        async uploadInvoiceFileLayout() {
          uploads += 1;
          if (uploadThrows) throw new Error('ambiguous provider response');
          transactionId = 'provider-transaction-42';
          return {success: true, transactionId, code: '201'};
        },
        async documentStatusFile() {
          statusCalls += 1;
          return {success: true, status: '202', message: 'Respuesta para Cliente 12345678'};
        },
        async getCUFEFile() {
          return {success: true, cufe: 'CUFE-DEMO-123'};
        },
        async downloadPDFFile() {
          pdfDownloads += 1;
          return pdfResponse || {
            success: true,
            pdfBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
          };
        },
      };
    },
  });
  const app = express();
  app.use('/api/platform', router);
  return {
    app, generated, recorded, invoicePdfUploads,
    get uploads() { return uploads; },
    get statusCalls() { return statusCalls; },
    get pdfDownloads() { return pdfDownloads; },
    get state() { return state; },
    get invoiceRecord() { return invoiceRecord; },
  };
}

test('la emisión demo gestionada calcula con la orden operativa y un reintento no vuelve a enviar', async () => {
  const f = electronicInvoiceFixture();
  await withServer(f.app, async base => {
    const send = () => fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/preview`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer central-session',
        'X-Workshop-Authorization': 'Bearer operational-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        formatKey: 'F-123', incluirIva: true,
        cliente: {
          tipoPersona: '2', tipoDocumento: 'CC', tipoDocumentoDian: '31',
          numeroDocumento: '12345678', dv: '', razonSocial: 'Cliente Demo',
          nombreComercial: 'Cliente Demo', direccion: 'Carrera 1 #2-3',
          codigoCiudad: '54001', ciudad: 'Cúcuta', departamento: 'Norte de Santander',
          codigoDepto: '54', telefono: '', email: '', responsabilidad: 'R-99-PN', regimen: '49',
        },
        items: [{descripcion: 'No confiar en este precio', cantidad: 100, precioUnitario: 1}],
        manoDeObra: 1,
      }),
    });
    const first = await send();
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.data.transactionId, 'provider-transaction-42');
    assert.deepEqual(body.data.totales, {baseGravable: 660000, iva: 125400, total: 785400});
    assert.equal(JSON.stringify(body).includes('12345678'), false);

    const retry = await send();
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).data.transactionId, 'provider-transaction-42');
  });
  assert.equal(f.uploads, 1);
  assert.deepEqual(f.generated[0].items.map(item => [item.codigo, item.precioUnitario]), [
    ['part-1', 500000], ['MO001', 160000],
  ]);
  assert.equal(f.generated[1].number, 1);
  assert.equal(f.state, 'submitted');
});

test('confirmar y consultar concilian solo el taller dueño y no guardan mensajes fiscales del proveedor', async () => {
  const f = electronicInvoiceFixture();
  await withServer(f.app, async base => {
    const headers = {
      Authorization: 'Bearer central-session',
      'X-Workshop-Authorization': 'Bearer operational-session',
      'Content-Type': 'application/json',
    };
    const preview = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/preview`, {
      method: 'POST', headers,
      body: JSON.stringify({
        formatKey: 'F-123', incluirIva: false,
        cliente: {
          tipoPersona: '2', tipoDocumento: 'CC', numeroDocumento: '12345678', dv: '',
          razonSocial: 'Cliente Demo', nombreComercial: 'Cliente Demo', direccion: 'Carrera 1',
          codigoCiudad: '54001', ciudad: 'Cúcuta', departamento: 'Norte de Santander',
          codigoDepto: '54', telefono: '', email: '', responsabilidad: 'R-99-PN', regimen: '49',
        },
      }),
    });
    assert.equal(preview.status, 200);

    const confirm = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/provider-transaction-42/confirm`, {
      method: 'POST', headers,
    });
    assert.equal(confirm.status, 200);
    const confirmed = await confirm.json();
    assert.equal(confirmed.data.estado, 'VALIDADA');
    assert.equal(confirmed.data.cufe, 'CUFE-DEMO-123');
    assert.equal(confirmed.data.pdfUrl,
      `/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/provider-transaction-42/pdf/electronic-invoice-pdf-42`);

    const pdf = await fetch(`${base}${confirmed.data.pdfUrl}`, {headers});
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store');
    assert.equal(await pdf.text(), '%PDF-1.4\n%%EOF');
    const centralSessionRequired = await fetch(`${base}${confirmed.data.pdfUrl}`, {
      headers: {'X-Workshop-Authorization': 'Bearer operational-session'},
    });
    assert.equal(centralSessionRequired.status, 401);

    const status = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/provider-transaction-42/status`, {headers});
    assert.equal(status.status, 200);

    const otherWorkshop = '80000000-0000-4000-8000-000000000002';
    const crossWorkshop = await fetch(`${base}/api/platform/workshops/${otherWorkshop}/electronic-invoices/provider-transaction-42/status`, {headers});
    assert.equal(crossWorkshop.status, 404);
  });

  assert.equal(f.uploads, 1);
  assert.equal(f.statusCalls, 2);
  assert.equal(f.pdfDownloads, 1);
  assert.equal(f.invoicePdfUploads.length, 1);
  assert.equal(f.invoicePdfUploads[0].root, 'invoices');
  assert.equal(f.invoicePdfUploads[0].folderPath, 'facturas_electronicas/TN-1');
  assert.equal(f.invoicePdfUploads[0].appProperties.vehicleAppWorkshop, WORKSHOP_ID);
  assert.equal(f.invoicePdfUploads[0].appProperties.vehicleAppDocument, 'electronic_invoice');
  assert.equal(f.invoiceRecord.pdf_url,
    `/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/provider-transaction-42/pdf/electronic-invoice-pdf-42`);
  assert.equal(f.state, 'validated');
  assert.equal(f.invoiceRecord.response_code, '202');
  assert.equal(f.invoiceRecord.response_message, 'Validada en el ambiente demo.');
  assert.equal(f.invoiceRecord.response_message.includes('12345678'), false);
});

test('ignora un recurso que no sea PDF y conserva la factura validada para reintentar la descarga', async () => {
  const f = electronicInvoiceFixture({pdfResponse: {success: true, pdfBase64: 'bm90IGEgcGRm'}});
  await withServer(f.app, async base => {
    const headers = {
      Authorization: 'Bearer central-session',
      'X-Workshop-Authorization': 'Bearer operational-session',
    };
    await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/preview`, {
      method: 'POST',
      headers: {...headers, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        formatKey: 'F-123', incluirIva: false,
        cliente: {
          tipoPersona: '2', tipoDocumento: 'CC', numeroDocumento: '12345678', dv: '',
          razonSocial: 'Cliente Demo', direccion: 'Carrera 1',
        },
      }),
    });
    const status = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/provider-transaction-42/status`, {headers});
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.data.estado, 'VALIDADA');
    assert.equal(body.data.pdfUrl, null);
  });
  assert.equal(f.invoicePdfUploads.length, 0);
  assert.equal(f.invoiceRecord.estado, 'VALIDADA');
});

test('el módulo, la membresía y el perfil fiscal bloquean emisión antes de contactar al proveedor', async () => {
  const f = electronicInvoiceFixture({modules: ['orders']});
  await withServer(f.app, async base => {
    const response = await fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/preview`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer central-session',
        'X-Workshop-Authorization': 'Bearer operational-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({formatKey: 'F-123', incluirIva: false, cliente: {}}),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'module_disabled');
  });
  assert.equal(f.uploads, 0);
});

test('una respuesta incierta queda bloqueada y el mismo pedido nunca repite la carga', async () => {
  const f = electronicInvoiceFixture({uploadThrows: true});
  await withServer(f.app, async base => {
    const send = () => fetch(`${base}/api/platform/workshops/${WORKSHOP_ID}/electronic-invoices/preview`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer central-session',
        'X-Workshop-Authorization': 'Bearer operational-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        formatKey: 'F-123', incluirIva: false,
        cliente: {
          tipoPersona: '2', tipoDocumento: 'CC', numeroDocumento: '12345678', dv: '',
          razonSocial: 'Cliente Demo', nombreComercial: 'Cliente Demo', direccion: 'Carrera 1',
          codigoCiudad: '54001', ciudad: 'Cúcuta', departamento: 'Norte de Santander',
          codigoDepto: '54', telefono: '', email: '', responsabilidad: 'R-99-PN', regimen: '49',
        },
      }),
    });
    assert.equal((await send()).status, 503);
    const retry = await send();
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).code, 'facturatech_reconciliation_required');
  });
  assert.equal(f.uploads, 1);
  assert.equal(f.state, 'uncertain');
});

test('rechazar renovación retira solo módulos provisionales y conserva el plan pagado', async () => {
  const paidUntil = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const reviewUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const harness = subscriptionReviewHarness({
    modules: ['orders', 'supplier_invoices', 'settlements'],
    paidModules: ['orders'],
    paidUntil,
    reviewModules: ['orders', 'supplier_invoices', 'settlements'],
    reviewUntil,
    planModules: ['orders', 'supplier_invoices', 'settlements'],
    activeUntil: null,
  });
  const app = express();
  app.use('/api/platform', harness.router);

  await withServer(app, async base => {
    const response = await fetch(`${base}/api/platform/subscriptions/${REQUEST_ID}/review`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'reject', note: 'Revisado desde prueba' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.request.status, 'rejected');
    assert.equal(body.workshop.paidUntil, paidUntil);
    assert.equal(body.workshop.reviewAccessUntil, null);
    assert.deepEqual(body.workshop.modules, ['orders']);
  });

  assert.equal(harness.request.status, 'rejected');
  assert.equal(harness.moduleAccess.get('orders').enabled, true);
  assert.equal(harness.moduleAccess.get('orders').expiresAt, paidUntil);
  assert.equal(harness.moduleAccess.get('supplier_invoices').enabled, false);
  assert.equal(harness.moduleAccess.get('supplier_invoices').expiresAt, null);
  assert.equal(harness.moduleAccess.get('settlements').enabled, false);
  assert.equal(harness.moduleAccess.get('settlements').expiresAt, null);
});
