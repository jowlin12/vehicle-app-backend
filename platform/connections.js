'use strict';

const { reject } = require('./errors');

const PROJECT_REF = /^[a-z0-9]{20}$/;

function normalizeConnection(entry, { requireSecrets = false } = {}) {
  if (!entry || typeof entry !== 'object') {
    reject(503, 'connection_unavailable', 'La conexión del taller no está configurada.');
  }
  let url;
  try { url = new URL(entry.url || entry.project_url); }
  catch { reject(503, 'invalid_connection', 'La conexión guardada no es válida.'); }
  const projectRef = entry.projectRef || entry.project_ref || entry.connection_ref;
  const expectedHost = `${projectRef}.supabase.co`;
  if (!PROJECT_REF.test(projectRef || '') || url.protocol !== 'https:' ||
      url.hostname !== expectedHost || url.username || url.password || url.search ||
      url.hash || (url.port && url.port !== '443') ||
      (url.pathname !== '/' && url.pathname !== '')) {
    reject(503, 'invalid_connection', 'La conexión guardada no corresponde al proyecto Supabase.');
  }
  const publishableKey = entry.publishableKey || entry.publishable_key;
  if (typeof publishableKey !== 'string' || publishableKey.length < 20) {
    reject(503, 'invalid_connection', 'La instalación no tiene una clave pública válida.');
  }
  const result = { projectRef, url: url.origin, publishableKey };
  if (requireSecrets) {
    if (!entry.serviceRoleKey || !entry.managementToken) {
      reject(503, 'connection_secrets_unavailable', 'Faltan credenciales para instalar el taller.');
    }
    result.serviceRoleKey = entry.serviceRoleKey;
    result.managementToken = entry.managementToken;
  }
  return Object.freeze(result);
}

function environmentRegistry(env = process.env) {
  let entries;
  try { entries = JSON.parse(env.WORKSHOP_CONNECTIONS_JSON || '{}'); }
  catch { throw new Error('WORKSHOP_CONNECTIONS_JSON no es un objeto JSON válido.'); }
  if (!entries || Array.isArray(entries) || typeof entries !== 'object') {
    throw new Error('WORKSHOP_CONNECTIONS_JSON debe ser un objeto.');
  }
  const registry = new Map();
  for (const [ref, entry] of Object.entries(entries)) {
    let projectRef = entry.projectRef;
    if (!projectRef) {
      try { projectRef = new URL(entry.url).hostname.split('.')[0]; } catch { projectRef = ''; }
    }
    registry.set(ref, normalizeConnection({ ...entry, projectRef }));
  }
  return registry;
}

// Connections enrolled by a platform administrator live in the central
// registry. Environment entries remain a compatibility fallback for the
// original workshop while this additive path is rolled out.
function createConnectionResolver({ store, secretBox, env = process.env }) {
  const fallback = environmentRegistry(env);
  return async function resolveConnection(ref, { requireSecrets = false } = {}) {
    const managed = await store.connection(ref);
    if (!managed) {
      const legacy = fallback.get(ref);
      if (legacy && !requireSecrets) return legacy;
      reject(503, 'connection_unavailable', 'La conexión del taller no está configurada.');
    }
    const connection = {
      ...managed,
      ...(requireSecrets ? {
        serviceRoleKey: secretBox.open(managed.service_role_secret),
        managementToken: secretBox.open(managed.management_token_secret),
      } : {}),
    };
    return normalizeConnection(connection, { requireSecrets });
  };
}

module.exports = { createConnectionResolver, normalizeConnection };
