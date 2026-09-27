'use strict';

const { reject } = require('./errors');

const PROJECT_REF = /^[a-z0-9]{20}$/;

function normalizeConnection(entry, { requireSecrets = false, requireServiceRoleKey = false } = {}) {
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
  if (requireSecrets || requireServiceRoleKey) {
    if (!entry.serviceRoleKey) {
      reject(503, 'connection_secrets_unavailable', 'Faltan credenciales para instalar el taller.');
    }
    result.serviceRoleKey = entry.serviceRoleKey;
  }
  if (requireSecrets) {
    if (!entry.managementToken) {
      reject(503, 'connection_secrets_unavailable', 'Faltan credenciales para instalar el taller.');
    }
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
    // Keep privileged values only inside this server-side registry. Public
    // callers still receive normalizeConnection's sanitized projection.
    const normalized = normalizeConnection({ ...entry, projectRef });
    registry.set(ref, Object.freeze({
      ...normalized,
      serviceRoleKey: entry.serviceRoleKey,
      managementToken: entry.managementToken,
    }));
  }
  return registry;
}

function legacyServiceConnection(ref, managed, env) {
  const projectUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_KEY;
  if (!projectUrl || !serviceRoleKey) return null;
  let url;
  try { url = new URL(projectUrl); } catch { return null; }
  if (url.hostname !== `${ref}.supabase.co`) return null;
  return { ...managed, url: projectUrl, projectRef: ref, serviceRoleKey };
}

// Connections enrolled by a platform administrator live in the central
// registry. Environment entries remain a compatibility fallback for the
// original workshop while this additive path is rolled out.
function createConnectionResolver({ store, secretBox, env = process.env }) {
  const fallback = environmentRegistry(env);
  return async function resolveConnection(ref, { requireSecrets = false, requireServiceRoleKey = false } = {}) {
    const managed = await store.connection(ref);
    if (!managed) {
      const legacy = fallback.get(ref);
      if (!legacy) {
        reject(503, 'connection_unavailable', 'La conexión del taller no está configurada.');
      }
      return normalizeConnection(legacy, { requireSecrets, requireServiceRoleKey });
    }

    if (!requireSecrets && !requireServiceRoleKey) return normalizeConnection(managed);

    if (requireServiceRoleKey && !requireSecrets) {
      if (managed.service_role_secret) {
        return normalizeConnection({
          ...managed,
          serviceRoleKey: secretBox.open(managed.service_role_secret),
        }, { requireServiceRoleKey: true });
      }
      const legacy = fallback.get(ref);
      if (legacy?.projectRef === ref && legacy.serviceRoleKey) {
        return normalizeConnection(legacy, { requireServiceRoleKey: true });
      }
      const legacyService = legacyServiceConnection(ref, managed, env);
      if (legacyService) return normalizeConnection(legacyService, { requireServiceRoleKey: true });
      reject(503, 'connection_secrets_unavailable', 'Faltan credenciales para instalar el taller.');
    }

    // The original workshop can already have a public connection row in the
    // central registry without encrypted credentials. Use an environment
    // fallback only for the exact ref explicitly present in the server-side
    // allowlist; never infer a destination or fall back after bad ciphertext.
    const hasServiceRoleSecret = Boolean(managed.service_role_secret);
    const hasManagementTokenSecret = Boolean(managed.management_token_secret);
    if (!hasServiceRoleSecret && !hasManagementTokenSecret) {
      const legacy = fallback.get(ref);
      if (legacy) return normalizeConnection(legacy, { requireSecrets: true });
    }
    if (!hasServiceRoleSecret || !hasManagementTokenSecret) {
      reject(503, 'connection_secrets_unavailable', 'Faltan credenciales para instalar el taller.');
    }

    const connection = {
      ...managed,
      serviceRoleKey: secretBox.open(managed.service_role_secret),
      managementToken: secretBox.open(managed.management_token_secret),
    };
    return normalizeConnection(connection, { requireSecrets: true });
  };
}

module.exports = { createConnectionResolver, normalizeConnection };
