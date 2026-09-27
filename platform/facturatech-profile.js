'use strict';

const crypto = require('node:crypto');
const { reject } = require('./errors');

const PROFILE_VERSION = 1;
const ISSUER_FIELDS = Object.freeze([
  'tipoPersona', 'nit', 'dv', 'razonSocial', 'nombreComercial', 'direccion',
  'codigoCiudad', 'ciudad', 'departamento', 'codigoDepto', 'pais', 'telefono',
  'responsabilidad', 'regimen',
]);
const ISSUER_OPTIONAL_FIELDS = Object.freeze(['email']);
const PROFILE_FIELDS = new Set(['environment', 'issuer', 'numbering', 'credentials']);
const ISSUER_KEYS = new Set([...ISSUER_FIELDS, ...ISSUER_OPTIONAL_FIELDS]);
const NUMBERING_KEYS = new Set(['prefijo', 'resolucion', 'rangoDesde', 'rangoHasta']);
const CREDENTIAL_KEYS = new Set(['username', 'password']);
const PROFILE_CREDENTIAL_KEYS = new Set(['username', 'passwordHash']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function onlyKeys(value, allowed, code, message) {
  if (!isPlainObject(value) || Object.keys(value).some(key => !allowed.has(key))) {
    reject(400, code, message);
  }
}

function text(value, field, maxLength, {optional = false} = {}) {
  if (optional && value == null) return '';
  if (typeof value !== 'string') reject(400, 'invalid_facturatech_profile', 'Revisa los datos fiscales del taller.');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTERS.test(normalized)) {
    reject(400, 'invalid_facturatech_profile', `Revisa el campo fiscal ${field}.`);
  }
  return normalized;
}

function normalizeIssuer(input) {
  onlyKeys(input, ISSUER_KEYS, 'invalid_facturatech_profile', 'El perfil fiscal no tiene un formato válido.');
  const issuer = {};
  for (const field of ISSUER_FIELDS) {
    const limit = {
      tipoPersona: 1, nit: 15, dv: 1, razonSocial: 120, nombreComercial: 120,
      direccion: 180, codigoCiudad: 5, ciudad: 80, departamento: 80,
      codigoDepto: 2, pais: 2, telefono: 40, responsabilidad: 32, regimen: 12,
    }[field];
    issuer[field] = text(input[field], field, limit);
  }
  if (!['1', '2'].includes(issuer.tipoPersona) || !/^\d{5,15}$/.test(issuer.nit) ||
      !/^\d$/.test(issuer.dv) || !/^\d{5}$/.test(issuer.codigoCiudad) ||
      !/^\d{2}$/.test(issuer.codigoDepto) || issuer.pais !== 'CO' ||
      !/^[\d +().-]{3,40}$/.test(issuer.telefono)) {
    reject(400, 'invalid_facturatech_profile', 'Revisa el NIT, la ubicación y el teléfono del emisor.');
  }
  issuer.email = text(input.email, 'email', 150, {optional: true});
  if (issuer.email && !EMAIL.test(issuer.email)) {
    reject(400, 'invalid_facturatech_email', 'El correo del emisor no tiene un formato válido.');
  }
  return issuer;
}

function normalizeNumbering(input) {
  onlyKeys(input, NUMBERING_KEYS, 'invalid_facturatech_numbering', 'La numeración fiscal no tiene un formato válido.');
  const prefijo = text(input.prefijo, 'prefijo', 10).toUpperCase();
  const resolucion = text(input.resolucion, 'resolucion', 100);
  const {rangoDesde, rangoHasta} = input;
  if (!/^[A-Z0-9_-]+$/.test(prefijo) || typeof rangoDesde !== 'number' ||
      typeof rangoHasta !== 'number' || !Number.isSafeInteger(rangoDesde) ||
      !Number.isSafeInteger(rangoHasta) || rangoDesde < 1 || rangoHasta < rangoDesde ||
      rangoHasta > 2147483647) {
    reject(400, 'invalid_facturatech_numbering', 'Revisa el prefijo y el rango autorizado de facturación.');
  }
  return {prefijo, resolucion, rangoDesde, rangoHasta};
}

function normalizeFacturatechProfileInput(input, existingProfile = null) {
  onlyKeys(input, PROFILE_FIELDS, 'invalid_facturatech_profile', 'El perfil fiscal no tiene un formato válido.');
  const environment = input.environment == null
    ? (existingProfile?.environment || 'demo')
    : text(input.environment, 'environment', 10);
  if (environment !== 'demo') {
    reject(409, 'facturatech_production_locked', 'Facturatech productivo requiere una habilitación posterior.');
  }

  let credentials = existingProfile?.credentials || null;
  if (input.credentials != null) {
    onlyKeys(input.credentials, CREDENTIAL_KEYS, 'invalid_facturatech_credentials', 'Las credenciales fiscales no tienen un formato válido.');
    if (typeof input.credentials.username !== 'string' || typeof input.credentials.password !== 'string') {
      reject(400, 'invalid_facturatech_credentials', 'Ingresa el usuario y la contraseña de sandbox.');
    }
    const username = text(input.credentials.username, 'usuario Facturatech', 120);
    const password = text(input.credentials.password, 'contraseña Facturatech', 512);
    credentials = {
      username,
      passwordHash: crypto.createHash('sha256').update(password, 'utf8').digest('hex'),
    };
  }
  if (!credentials || typeof credentials.username !== 'string' ||
      !credentials.username.trim() || typeof credentials.passwordHash !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(credentials.passwordHash)) {
    reject(400, 'facturatech_credentials_required', 'Ingresa usuario y contraseña de sandbox para Facturatech.');
  }

  return {
    version: PROFILE_VERSION,
    environment,
    issuer: normalizeIssuer(input.issuer),
    numbering: normalizeNumbering(input.numbering),
    credentials: {
      username: credentials.username.trim(),
      passwordHash: credentials.passwordHash.toLowerCase(),
    },
  };
}

function parseStoredFacturatechProfile(plainText) {
  const profile = JSON.parse(plainText);
  if (!isPlainObject(profile) || profile.version !== PROFILE_VERSION ||
      profile.environment !== 'demo' || !isPlainObject(profile.issuer) ||
      !isPlainObject(profile.numbering) || !isPlainObject(profile.credentials) ||
      typeof profile.credentials.username !== 'string' || !profile.credentials.username.trim() ||
      typeof profile.credentials.passwordHash !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(profile.credentials.passwordHash)) {
    throw new Error('Stored Facturatech profile is invalid.');
  }
  if (Object.keys(profile).some(key => !new Set([...PROFILE_FIELDS, 'version']).has(key)) ||
      Object.keys(profile.credentials).some(key => !PROFILE_CREDENTIAL_KEYS.has(key))) {
    throw new Error('Stored Facturatech profile contains unsupported fields.');
  }
  return profile;
}

function publicFacturatechProfile(profile, updatedAt = null) {
  if (!profile) return {configured: false};
  return {
    configured: true,
    environment: profile.environment,
    issuer: {...profile.issuer},
    numbering: {...profile.numbering},
    credentialsConfigured: true,
    updatedAt,
  };
}

module.exports = {
  normalizeFacturatechProfileInput,
  parseStoredFacturatechProfile,
  publicFacturatechProfile,
};
