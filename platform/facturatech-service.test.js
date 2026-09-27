'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const FacturatechService = require('../facturatech-service');

function invoiceInput() {
  return {
    adquiriente: {
      tipoDocumento: 'NIT', numeroDocumento: '900000001', razonSocial: 'Cliente QA',
    },
    items: [{
      cantidad: 1, precioUnitario: 1000, porcentajeIva: 19, descripcion: 'Servicio QA',
    }],
    totales: {baseGravable: 1000, iva: 190, total: 1190},
    numeroFactura: 123,
    referencia: 'ORDEN-QA',
  };
}

function issuer(name, nit) {
  return {
    tipoPersona: '2', nit, dv: '1', razonSocial: name, nombreComercial: name,
    direccion: 'Dirección QA', codigoCiudad: '00001', ciudad: 'Ciudad QA',
    departamento: 'Departamento QA', codigoDepto: '00', pais: 'CO',
    telefono: '0000000000', responsabilidad: 'R-99-PN', regimen: '49',
  };
}

function passwordHash(character) {
  return character.repeat(64);
}

function fakeNumberingClient(rows, calls) {
  const query = {
    select() { return this; },
    eq(column, value) { calls.push({column, value}); return this; },
    order() { return this; },
    async limit() { return {data: rows, error: null}; },
  };
  return {from: table => { calls.push({table}); return query; }};
}

test('Facturatech instances keep issuer, credentials, environment, and numbering isolated', async () => {
  const issuerA = issuer('Emisor Alfa QA', '900000001');
  const serviceA = new FacturatechService({
    environment: 'demo',
    credentials: {username: 'alpha-qa-user', passwordHash: passwordHash('a')},
    issuer: issuerA,
    numbering: {prefijo: 'ALF', resolucion: 'RES-ALF-QA', rangoDesde: 120, rangoHasta: 999},
  });
  issuerA.razonSocial = 'Mutado después de crear la instancia';

  const serviceB = new FacturatechService({
    environment: 'pro',
    credentials: {username: 'beta-qa-user', passwordHash: passwordHash('b')},
    issuer: issuer('Emisor Beta QA', '900000002'),
    numbering: {prefijo: 'BET', resolucion: 'RES-BET-QA', rangoDesde: 820, rangoHasta: 999},
  });

  const input = invoiceInput();
  const layoutA = serviceA.generarXmlLayout(
    input.adquiriente, input.items, input.totales, input.numeroFactura, input.referencia,
  );
  const layoutB = serviceB.generarXmlLayout(
    input.adquiriente, input.items, input.totales, input.numeroFactura, input.referencia,
  );
  assert.match(layoutA, /ENC_2:900000001;/);
  assert.match(layoutA, /EMI_6:Emisor Alfa QA;/);
  assert.doesNotMatch(layoutA, /Emisor Beta QA|Mutado después/);
  assert.match(layoutB, /ENC_2:900000002;/);
  assert.match(layoutB, /EMI_6:Emisor Beta QA;/);
  assert.doesNotMatch(layoutB, /Emisor Alfa QA/);
  assert.match(serviceA.endpoint, /\/demo\/index\.php\?wsdl$/);
  assert.match(serviceB.endpoint, /\/pro\/index\.php\?wsdl$/);

  const calls = [];
  const [nextA, nextB] = await Promise.all([
    serviceA.obtenerSiguienteNumeroFactura(fakeNumberingClient([], calls)),
    serviceB.obtenerSiguienteNumeroFactura(fakeNumberingClient([{numero_factura: 821}], calls)),
  ]);
  assert.equal(nextA, 120);
  assert.equal(nextB, 822);
  assert.deepEqual(calls.filter(call => call.column === 'prefijo').map(call => call.value), ['ALF', 'BET']);
});

test('only supported Facturatech environments are accepted', () => {
  assert.throws(() => new FacturatechService({environment: 'https://example.invalid'}), /entorno/);
  assert.throws(() => new FacturatechService([]), /configuración/);
  assert.throws(() => new FacturatechService({credentials: {username: 'qa'}}), /emisor, numeración y credenciales/);
});

test('tenant configuration defaults to sandbox rather than inheriting a global fiscal environment', () => {
  const original = process.env.FACTURATECH_ENV;
  process.env.FACTURATECH_ENV = 'pro';
  try {
    const service = new FacturatechService({
      credentials: {username: 'sandbox-qa-user', passwordHash: passwordHash('c')},
      issuer: issuer('Sandbox QA', '900000004'),
      numbering: {prefijo: 'SBX', resolucion: 'RES-SBX-QA', rangoDesde: 1, rangoHasta: 999},
    });
    assert.equal(service.env, 'demo');
  } finally {
    if (original === undefined) delete process.env.FACTURATECH_ENV;
    else process.env.FACTURATECH_ENV = original;
  }
});

test('tenant-scoped numbering stays inside its authorized range and fails closed', async () => {
  const service = new FacturatechService({
    credentials: {username: 'range-qa-user', passwordHash: passwordHash('d')},
    issuer: issuer('Range QA', '900000003'),
    numbering: {prefijo: 'RNG', resolucion: 'RES-RNG-QA', rangoDesde: 30, rangoHasta: 32},
  });
  const calls = [];
  assert.equal(await service.obtenerSiguienteNumeroFactura(fakeNumberingClient([], calls)), 30);
  assert.equal(await service.obtenerSiguienteNumeroFactura(fakeNumberingClient([{numero_factura: 31}], calls)), 32);
  await assert.rejects(
    service.obtenerSiguienteNumeroFactura(fakeNumberingClient([{numero_factura: 32}], calls)),
    /No se pudo verificar el consecutivo fiscal/,
  );
  await assert.rejects(
    service.obtenerSiguienteNumeroFactura({
      from: () => ({select: () => ({eq: () => ({order: () => ({limit: async () => ({data: null, error: new Error('private database detail')})})})})}),
    }),
    /No se pudo verificar el consecutivo fiscal/,
  );
});

test('provider request logs never include credentials or invoice content', async () => {
  const service = new FacturatechService({
    credentials: {username: 'private-qa-user', passwordHash: passwordHash('e')},
    issuer: issuer('Private Issuer QA', '900000001'),
    numbering: {prefijo: 'PRV', resolucion: 'RES-PRV-QA', rangoDesde: 1, rangoHasta: 999},
  });
  const logged = [];
  const original = {log: console.log, warn: console.warn, error: console.error, post: axios.post};
  console.log = (...values) => logged.push(values.join(' '));
  console.warn = (...values) => logged.push(values.join(' '));
  console.error = (...values) => logged.push(values.join(' '));
  axios.post = async () => ({data: '<respuesta>OK</respuesta>'});
  try {
    await service.uploadInvoiceFileLayout('CONFIDENTIAL-LAYOUT-QA');
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    axios.post = original.post;
  }

  const output = logged.join('\n');
  for (const marker of ['private-qa-user', passwordHash('e'), 'CONFIDENTIAL-LAYOUT-QA']) {
    assert.equal(output.includes(marker), false);
  }
});

test('tenant invoice upload is not replayed when the provider response is ambiguous', async () => {
  const service = new FacturatechService({
    credentials: {username: 'ambiguous-qa-user', passwordHash: passwordHash('f')},
    issuer: issuer('Ambiguous Issuer QA', '900000005'),
    numbering: {prefijo: 'AMB', resolucion: 'RES-AMB-QA', rangoDesde: 1, rangoHasta: 999},
  });
  const original = {post: axios.post, error: console.error, log: console.log};
  let calls = 0;
  axios.post = async (_url, _body, options) => {
    calls += 1;
    assert.match(options.headers.SOAPAction, /FtechAction\.uploadInvoiceFileLayout/);
    const error = new Error('provider response unavailable');
    error.response = {status: 503};
    throw error;
  };
  console.error = () => {};
  console.log = () => {};
  try {
    await assert.rejects(service.uploadInvoiceFileLayout('SYNTHETIC-LAYOUT-QA'));
  } finally {
    axios.post = original.post;
    console.error = original.error;
    console.log = original.log;
  }
  assert.equal(calls, 1);
});

test('tenant invoice upload extracts the provider transaction id from the SOAP return object', async () => {
  const service = new FacturatechService({
    credentials: {username: 'transaction-id-qa-user', passwordHash: passwordHash('c')},
    issuer: issuer('Transaction ID Issuer QA', '900000006'),
    numbering: {prefijo: 'TX', resolucion: 'RES-TX-QA', rangoDesde: 1, rangoHasta: 99},
  });
  service._ejecutarSoap = async () => ({
    success: true,
    data: {uploadInvoiceFileLayoutResponse: {
      return: {success: 'true', code: '201', transaccionID: 'provider-transaction-42'},
    }},
  });
  const result = await service.uploadInvoiceFileLayout('SYNTHETIC-LAYOUT-QA');
  assert.equal(result.success, true);
  assert.equal(result.transactionId, 'provider-transaction-42');
});

test('tenant invoice upload treats a positive response without transaction id as ambiguous', async () => {
  const service = new FacturatechService({
    credentials: {username: 'transaction-id-qa-user', passwordHash: passwordHash('d')},
    issuer: issuer('Transaction ID Issuer QA', '900000007'),
    numbering: {prefijo: 'TX', resolucion: 'RES-TX-QA', rangoDesde: 1, rangoHasta: 99},
  });
  service._ejecutarSoap = async () => ({
    success: true,
    data: {uploadInvoiceFileLayoutResponse: {return: {success: 'true', code: '201'}}},
  });
  const result = await service.uploadInvoiceFileLayout('SYNTHETIC-LAYOUT-QA');
  assert.equal(result.success, false);
  assert.equal(result.ambiguous, true);
  assert.equal(Object.hasOwn(result, 'transactionId'), false);
});

test('status and invoice resources normalize the nested SOAP response fields', async () => {
  const service = new FacturatechService({
    credentials: {username: 'resource-qa-user', passwordHash: passwordHash('e')},
    issuer: issuer('Resource Issuer QA', '900000008'),
    numbering: {prefijo: 'RS', resolucion: 'RES-RS-QA', rangoDesde: 1, rangoHasta: 99},
  });
  service._ejecutarSoap = async method => {
    if (method.endsWith('documentStatusFile')) return {
      success: true,
      data: {return: {success: 'true', code: '201', status: 'VALIDATED', message: 'Documento aceptado'}},
    };
    if (method.endsWith('getCUFEFile')) return {
      success: true, data: {return: {success: 'true', code: '201', resourceData: 'CUFE-DEMO-42'}},
    };
    return {
      success: true, data: {return: {success: 'true', code: '201', resourceData: 'JVBERi0xLjQK'}},
    };
  };
  assert.deepEqual(await service.documentStatusFile('provider-tx-42'), {
    success: true, status: 'VALIDATED', message: 'Documento aceptado',
    data: {return: {success: 'true', code: '201', status: 'VALIDATED', message: 'Documento aceptado'}},
  });
  assert.deepEqual(await service.getCUFEFile('RS', 42), {success: true, cufe: 'CUFE-DEMO-42'});
  assert.deepEqual(await service.downloadPDFFile('RS', 42), {success: true, pdfBase64: 'JVBERi0xLjQK'});
});

test('legacy upload retry preserves the SOAP action and previous retry behavior', async () => {
  const service = new FacturatechService();
  const original = {post: axios.post, setTimeout: global.setTimeout, error: console.error, log: console.log};
  const actions = [];
  let calls = 0;
  axios.post = async (_url, _body, options) => {
    actions.push(options.headers.SOAPAction);
    calls += 1;
    if (calls === 1) {
      const error = new Error('temporary provider failure');
      error.response = {status: 503};
      throw error;
    }
    return {data: '<respuesta>OK</respuesta>'};
  };
  global.setTimeout = callback => {
    callback();
    return 0;
  };
  console.error = () => {};
  console.log = () => {};
  try {
    await service.uploadInvoiceFileLayout('SYNTHETIC-LEGACY-LAYOUT-QA');
  } finally {
    axios.post = original.post;
    global.setTimeout = original.setTimeout;
    console.error = original.error;
    console.log = original.log;
  }
  assert.equal(calls, 2);
  assert.equal(actions[0], actions[1]);
  assert.match(actions[1], /FtechAction\.uploadInvoiceFileLayout/);
});
