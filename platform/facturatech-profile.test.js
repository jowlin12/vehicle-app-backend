'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  normalizeFacturatechProfileInput,
  parseStoredFacturatechProfile,
  publicFacturatechProfile,
} = require('./facturatech-profile');

function validInput(overrides = {}) {
  return {
    environment: 'demo',
    issuer: {
      tipoPersona: '1', nit: '900123456', dv: '7', razonSocial: 'Taller Norte S.A.S.',
      nombreComercial: 'Taller Norte', direccion: 'Calle 1 #2-3', codigoCiudad: '54001',
      ciudad: 'Cúcuta', departamento: 'Norte de Santander', codigoDepto: '54', pais: 'CO',
      telefono: '300 123 4567', responsabilidad: 'R-99-PN', regimen: '49',
      email: 'facturas@example.com',
    },
    numbering: {prefijo: 'tn', resolucion: '18760000001', rangoDesde: 1, rangoHasta: 5000},
    credentials: {username: 'sandbox-user', password: 'sandbox-password'},
    ...overrides,
  };
}

test('normaliza perfil fiscal de sandbox y guarda solo el hash que exige el proveedor', () => {
  const profile = normalizeFacturatechProfileInput(validInput());
  assert.equal(profile.version, 1);
  assert.equal(profile.environment, 'demo');
  assert.equal(profile.numbering.prefijo, 'TN');
  assert.equal(profile.credentials.passwordHash,
    crypto.createHash('sha256').update('sandbox-password').digest('hex'));
  assert.equal(Object.hasOwn(profile.credentials, 'password'), false);
});

test('rechaza datos fiscales incompletos, rango inválido y credenciales parciales', () => {
  const missingNit = validInput();
  delete missingNit.issuer.nit;
  assert.throws(() => normalizeFacturatechProfileInput(missingNit), error => error.code === 'invalid_facturatech_profile');

  assert.throws(() => normalizeFacturatechProfileInput(validInput({
    numbering: {prefijo: 'TN', resolucion: 'R-1', rangoDesde: 8, rangoHasta: 7},
  })), error => error.code === 'invalid_facturatech_numbering');

  assert.throws(() => normalizeFacturatechProfileInput(validInput({
    credentials: {username: 'sandbox-user'},
  })), error => error.code === 'invalid_facturatech_credentials');
});

test('no permite guardar el entorno productivo ni devolver credenciales', () => {
  assert.throws(() => normalizeFacturatechProfileInput(validInput({environment: 'pro'})),
    error => error.code === 'facturatech_production_locked');
  const profile = normalizeFacturatechProfileInput(validInput());
  const response = publicFacturatechProfile(profile, '2026-09-27T00:00:00.000Z');
  assert.equal(response.credentialsConfigured, true);
  assert.equal(JSON.stringify(response).includes('sandbox-user'), false);
  assert.equal(JSON.stringify(response).includes(profile.credentials.passwordHash), false);
  assert.equal(JSON.stringify(response).includes('sandbox-password'), false);
});

test('una edición sin contraseña conserva la credencial cifrada ya registrada', () => {
  const original = normalizeFacturatechProfileInput(validInput());
  const edited = normalizeFacturatechProfileInput({
    environment: 'demo', issuer: {...original.issuer, razonSocial: 'Taller Norte SAS'},
    numbering: original.numbering,
  }, original);
  assert.deepEqual(edited.credentials, original.credentials);
  assert.equal(edited.issuer.razonSocial, 'Taller Norte SAS');
});

test('rechaza una configuración cifrada dañada o de una versión desconocida', () => {
  assert.throws(() => parseStoredFacturatechProfile('{'), SyntaxError);
  assert.throws(() => parseStoredFacturatechProfile(JSON.stringify({version: 99})), /invalid/i);
});
