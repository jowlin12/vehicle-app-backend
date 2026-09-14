'use strict';

const express = require('express');
const { PlatformError, reject } = require('./errors');
const { normalizeConnection } = require('./connections');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODULES = new Set(['orders']); // Only this capability is enabled in increment 1.
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) reject(400, 'invalid_id', 'Identificador inválido.');
  return value;
}

function bearer(value) {
  if (typeof value !== 'string' || !/^Bearer \S+$/.test(value)) reject(401, 'session_required', 'Inicia sesión nuevamente.');
  return value.slice(7);
}

function publicWorkshop(row) {
  return {
    id: row.id, name: row.name, status: row.status,
    projectRef: row.connection_ref,
    modules: row.modules, schemaVersion: row.schema_version,
    lastError: row.last_error,
  };
}

function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    reject(400, 'invalid_temporary_password', 'La contraseña temporal debe tener entre 10 y 128 caracteres.');
  }
  return value;
}

function createPlatformRouter({ auth, store, secretBox, resolveConnection, makeClient, provisioner }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.use(asyncRoute(async (req, res, next) => {
    const { data, error } = await auth.getUser(bearer(req.headers.authorization));
    if (error || !data?.user) reject(401, 'invalid_session', 'La sesión central no es válida.');
    req.platformUser = data.user.id;
    req.platformAdmin = await store.isAdmin(data.user.id);
    next();
  }));

  function admin(req) {
    if (!req.platformAdmin) reject(403, 'platform_admin_required', 'Se requiere un administrador de la plataforma.');
  }

  async function workshop(req, requireReady = true) {
    const id = uuid(req.params.id);
    // Administrators can manage metadata; operational data still needs membership.
    const membership = await store.membership(req.platformUser, id);
    if (!membership && !req.platformAdmin) reject(404, 'workshop_not_found', 'Taller no disponible.');
    const row = await store.get(id);
    if (!row) reject(404, 'workshop_not_found', 'Taller no disponible.');
    if (requireReady && row.status !== 'ready') reject(409, 'workshop_not_ready', 'El taller aún no está disponible.');
    return { row, membership };
  }

  async function operational(req, { prepare = false } = {}) {
    const context = await workshop(req, !prepare);
    if (!context.membership?.operational_user_id) reject(403, 'membership_required', 'Falta vincular tu usuario operativo.');
    const connection = await resolveConnection(context.row.connection_ref);
    const token = bearer(req.headers['x-workshop-authorization']);
    const db = makeClient(connection, token);
    const { data, error } = await db.auth.getUser(token);
    if (error || data?.user?.id !== context.membership.operational_user_id) {
      reject(403, 'wrong_workshop_session', 'La sesión no corresponde a tu usuario de este taller.');
    }
    return { ...context, db };
  }

  router.get('/session', (req, res) => res.json({ userId: req.platformUser, isPlatformAdmin: req.platformAdmin }));
  router.get('/workshops', asyncRoute(async (req, res) => {
    res.json({ workshops: (await store.list(req.platformUser, req.platformAdmin)).map(publicWorkshop) });
  }));

  router.post('/workshops', asyncRoute(async (req, res) => {
    admin(req);
    const key = uuid(req.headers['idempotency-key']);
    const { name, ownerEmail, ownerPassword, project, modules = ['orders'] } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
        !Array.isArray(modules) || !modules.length || modules.some(value => !MODULES.has(value))) {
      reject(400, 'invalid_workshop', 'Nombre o módulos inválidos.');
    }
    const email = typeof ownerEmail === 'string' ? ownerEmail.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) reject(400, 'invalid_owner_email', 'Correo del propietario inválido.');
    password(ownerPassword);
    const connection = normalizeConnection({
      projectRef: project?.ref,
      url: project?.url,
      publishableKey: project?.publishableKey,
      serviceRoleKey: project?.serviceRoleKey,
      managementToken: project?.managementToken,
    }, { requireSecrets: true });
    let ownerUserId = await store.ownerByEmail(email, { required: false });
    if (!ownerUserId) {
      const created = await auth.admin.createUser({
        email,
        password: ownerPassword,
        email_confirm: true,
        user_metadata: { full_name: name.trim(), vehicleapp_role: 'workshop_owner' },
      });
      if (created.error || !created.data?.user) {
        reject(503, 'central_owner_creation_failed', 'No fue posible crear el acceso central del propietario.');
      }
      ownerUserId = created.data.user.id;
    }
    const row = await store.register(req.platformUser, key, {
      name: name.trim(), ownerUserId, connectionRef: connection.projectRef,
      modules: [...new Set(modules)].sort(),
    });
    await store.saveConnection(req.platformUser, row.id, {
      projectRef: connection.projectRef,
      url: connection.url,
      publishableKey: connection.publishableKey,
      serviceRoleSecret: secretBox.seal(connection.serviceRoleKey),
      managementTokenSecret: secretBox.seal(connection.managementToken),
    });
    res.status(201).json({ workshop: publicWorkshop(row) });
  }));

  router.post('/workshops/:id/provision', asyncRoute(async (req, res) => {
    admin(req);
    const { row } = await workshop(req, false);
    if (!['pending', 'failed'].includes(row.status)) {
      if (row.status === 'ready') return res.json({ workshop: publicWorkshop(row) });
      reject(409, 'invalid_state', 'El taller no se puede instalar en este estado.');
    }
    const ownerPassword = password(req.body?.ownerPassword);
    const owner = await auth.admin.getUserById(row.owner_user_id);
    const ownerEmail = owner.data?.user?.email?.toLowerCase();
    if (owner.error || !ownerEmail) reject(503, 'owner_unavailable', 'No fue posible leer al propietario.');
    await store.markConnection(row.id, { status: 'installing', last_error: null });
    try {
      const connection = await resolveConnection(row.connection_ref, { requireSecrets: true });
      const installed = await provisioner.provision({
        connection, workshopId: row.id, ownerEmail, ownerPassword,
      });
      await store.linkMember(row.id, row.owner_user_id, installed.operationalUserId, 'owner');
      const ready = await store.markReady(row.id, installed.schemaVersion);
      await store.markConnection(row.id, {
        status: 'ready', schema_version: installed.schemaVersion, last_error: null,
        last_health_check_at: new Date().toISOString(), provisioned_at: new Date().toISOString(),
      });
      res.json({ workshop: publicWorkshop(ready) });
    } catch (error) {
      await store.markFailed(row.id, error.code || 'provision_failed');
      throw error;
    }
  }));

  router.put('/workshops/:id/connection', asyncRoute(async (req, res) => {
    admin(req);
    const { row } = await workshop(req, false);
    if (!['pending', 'failed'].includes(row.status)) {
      reject(409, 'connection_locked', 'Solo se puede cambiar una conexión antes de habilitar el taller.');
    }
    const connection = normalizeConnection({
      projectRef: req.body?.ref,
      url: req.body?.url,
      publishableKey: req.body?.publishableKey,
      serviceRoleKey: req.body?.serviceRoleKey,
      managementToken: req.body?.managementToken,
    }, { requireSecrets: true });
    if (connection.projectRef !== row.connection_ref) {
      reject(409, 'project_change_rejected', 'La reparación debe conservar el proyecto registrado.');
    }
    await store.saveConnection(req.platformUser, row.id, {
      projectRef: connection.projectRef,
      url: connection.url,
      publishableKey: connection.publishableKey,
      serviceRoleSecret: secretBox.seal(connection.serviceRoleKey),
      managementTokenSecret: secretBox.seal(connection.managementToken),
    });
    res.json({ workshop: publicWorkshop(row), configured: true });
  }));

  router.get('/workshops/:id/connection', asyncRoute(async (req, res) => {
    const { row, membership } = await workshop(req, false);
    if (!membership) reject(403, 'membership_required', 'Necesitas una membresía en este taller.');
    if (!['pending', 'failed', 'ready'].includes(row.status)) reject(403, 'workshop_suspended', 'Taller suspendido.');
    const connection = await resolveConnection(row.connection_ref);
    res.json({ workshop: publicWorkshop(row), url: connection.url,
      publishableKey: connection.publishableKey });
  }));

  // Self-link proves possession of both sessions, without copying passwords,
  // generating tokens or letting an admin impersonate an operational user.
  router.post('/workshops/:id/link-session', asyncRoute(async (req, res) => {
    const { row, membership } = await workshop(req, false);
    if (!membership || row.status === 'suspended') reject(403, 'membership_required', 'Membresía no disponible.');
    const token = bearer(req.headers['x-workshop-authorization']);
    const db = makeClient(await resolveConnection(row.connection_ref), token);
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) reject(401, 'invalid_workshop_session', 'Sesión operativa inválida.');
    const profile = await db.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
    if (profile.error || !['admin', 'empleado'].includes(profile.data?.role)) reject(403, 'profile_required', 'Usuario operativo no autorizado.');
    // Owner must prove workshop administration. Employee cannot self-upgrade.
    if (membership.role === 'owner' && profile.data.role !== 'admin') reject(403, 'owner_required', 'El propietario debe ser administrador del taller.');
    if (membership.operational_user_id && membership.operational_user_id !== data.user.id) reject(409, 'already_linked', 'La membresía ya está vinculada a otro usuario.');
    await store.linkMember(row.id, req.platformUser, data.user.id, membership.role);
    res.json({ linked: true });
  }));

  router.post('/workshops/:id/prepare', asyncRoute(async (req, res) => {
    admin(req);
    const { row, db } = await operational(req, { prepare: true });
    if (row.status === 'ready') return res.json({ workshop: publicWorkshop(row) });
    if (!['pending', 'failed'].includes(row.status)) reject(409, 'invalid_state', 'El taller no se puede preparar en este estado.');
    const { data, error } = await db.rpc('vehicleapp_installation_contract');
    if (error || data?.contract !== 'vehicleapp.orders.v1' || data?.installation_id !== row.id || data?.ready !== true) {
      await store.markFailed(row.id, 'schema_not_verified');
      reject(409, 'schema_not_verified', 'La base no tiene el contrato operativo verificado para este taller.');
    }
    const ready = await store.markReady(row.id, data.schema_version);
    res.json({ workshop: publicWorkshop(ready) });
  }));

  router.get('/workshops/:id/orders', asyncRoute(async (req, res) => {
    const { row, db } = await operational(req);
    if (!row.modules.includes('orders')) reject(403, 'module_disabled', 'El módulo de órdenes está deshabilitado.');
    const { data, error } = await db.from('formatos').select('*, servicios(*), repuestos(*)')
      .is('deleted_at', null).order('created_at', { ascending: false }).limit(50);
    if (error) reject(503, 'orders_unavailable', 'No fue posible consultar las órdenes.');
    res.json({ orders: data });
  }));

  router.post('/workshops/:id/mutations', asyncRoute(async (req, res) => {
    const { row, db } = await operational(req);
    if (!row.modules.includes('orders')) reject(403, 'module_disabled', 'El módulo de órdenes está deshabilitado.');
    const { operationId, kind, entityKey, payload } = req.body || {};
    uuid(operationId);
    if (!['format.create', 'servicio.create', 'repuesto.create'].includes(kind) ||
        typeof entityKey !== 'string' || !entityKey || entityKey.length > 240 ||
        !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      reject(400, 'invalid_mutation', 'Operación no admitida en esta etapa.');
    }
    const { data, error } = await db.rpc('apply_offline_mutation', {
      p_operation_id: operationId, p_kind: kind, p_entity_key: entityKey, p_payload: payload,
    });
    if (error) reject(409, 'mutation_rejected', 'La base rechazó la operación.');
    res.json(data);
  }));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const expected = error instanceof PlatformError;
    res.status(expected ? error.status : 503).json({
      code: expected ? error.code : 'platform_unavailable',
      error: expected ? error.message : 'La plataforma no está disponible.',
    });
  });
  return router;
}

module.exports = { createPlatformRouter };
