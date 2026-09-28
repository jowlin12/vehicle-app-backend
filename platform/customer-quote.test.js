'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCustomerQuotePdf,
  downloadGeneratedPdf,
  renderCustomerQuoteHtml,
} = require('./customer-quote');

const WORKSHOP_ID = '80000000-0000-4000-8000-000000000001';

test('la plantilla usa datos del taller y escapa contenido controlado por el usuario', () => {
  const html = renderCustomerQuoteHtml({
    workshop: {id: WORKSHOP_ID, name: 'Taller Norte'},
    profile: {
      templateKey: 'compact-v1',
      issuerName: 'Taller <Norte>',
      paymentInstructions: 'Transferencia\nCuenta 123',
    },
    format: {
      clave_key: 'F-123',
      nombre_cliente: '<script>alert(1)</script>',
      fecha_entrada: '2026-09-26',
      marca: 'Nissan',
      tipo_vehiculo: 'Sentra',
      modelo: 2020,
      costo_mano_obra: 150000,
      costo_total: 450000,
    },
    repuestos: [{descripcion: 'Filtro <aceite>', cantidad: 2, costo_unitario: 150000}],
    servicios: [{servicio: 'Cambio de aceite', precio_mano_obra: 150000}],
  });

  assert.match(html, /Taller &lt;Norte&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /class="sheet compact"/);
  assert.match(html, /\$ 300\.000/);
  assert.match(html, /\$ 450\.000/);
});

test('genera el PDF y lo guarda bajo la carpeta privada del taller con clave idempotente', async () => {
  const uploaded = [];
  const requests = [];
  const httpClient = {
    post: async (url, body) => {
      requests.push({url, body});
      return {data: {data: {googleDrive: {directLink: 'https://drive.google.com/uc?export=download&id=file12345'}}}};
    },
    get: async (url, options) => {
      requests.push({url, options});
      return {
        status: 200,
        headers: {'content-type': 'application/pdf'},
        data: Buffer.from('%PDF-test-payload'),
      };
    },
  };
  const drive = {
    uploadPrivateFile: async file => {
      uploaded.push(file);
      return {id: 'privatePdf123'};
    },
  };
  const input = {
    workshop: {id: WORKSHOP_ID, name: 'Taller Norte'},
    profile: {templateKey: 'standard-v1', issuerName: 'Taller Norte'},
    format: {
      clave_key: 'F-123', fecha_entrada: '2026-09-26',
      costo_mano_obra: 80000, costo_total: 230000,
    },
    repuestos: [{descripcion: 'Batería', cantidad: 1, costo_unitario: 150000}],
    servicios: [{servicio: 'Diagnóstico', precio_mano_obra: 80000}],
    drive,
    httpClient,
  };

  const first = await createCustomerQuotePdf(input);
  const second = await createCustomerQuotePdf(input);

  assert.deepEqual(first, {
    fileId: 'privatePdf123',
    filePath: `/api/platform/workshops/${WORKSHOP_ID}/drive/files/privatePdf123`,
  });
  assert.equal(uploaded.length, 2);
  assert.equal(uploaded[0].root, 'invoices');
  assert.equal(uploaded[0].folderPath, 'cotizaciones/F-123');
  assert.equal(uploaded[0].mimeType, 'application/pdf');
  assert.equal(uploaded[0].appProperties.vehicleAppWorkshop, WORKSHOP_ID);
  assert.equal(uploaded[0].appProperties.vehicleAppDocument, 'customer_quote');
  assert.equal(uploaded[0].uploadRequestId, uploaded[1].uploadRequestId);
  assert.equal(uploaded[0].buffer.toString(), '%PDF-test-payload');
  assert.match(requests[0].body.html, /Taller Norte/);
  assert.match(requests[0].body.html,
    /<td>Batería<\/td><td class="number">1<\/td><td class="number">\$ 150\.000<\/td><td class="number">\$ 150\.000<\/td>/);
  assert.match(requests[0].body.html, /<span>Repuestos<\/span><strong>\$ 150\.000<\/strong>/);
  assert.match(requests[0].body.html, /<td>Diagnóstico<\/td>/);
});

test('no sigue redirecciones del PDF hacia orígenes ajenos a Google Drive', async () => {
  let calls = 0;
  const httpClient = {
    get: async () => {
      calls += 1;
      return {
        status: 302,
        headers: {location: 'http://127.0.0.1/latest/meta-data'},
        data: Buffer.alloc(0),
      };
    },
  };

  await assert.rejects(
    downloadGeneratedPdf('https://drive.google.com/uc?id=file12345', httpClient),
    /origen de archivo no permitido/,
  );
  assert.equal(calls, 1);
});
