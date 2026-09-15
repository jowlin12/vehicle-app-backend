'use strict';

const express = require('express');
const { PlatformError, reject } = require('./errors');
const { vehiclePhotoFolderPath } = require('../drive-service');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const MAX_IMAGE_BYTES = 2800000;
const WORKSHOP_PROPERTY = 'vehicleAppWorkshop';

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function authorization(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer \S+$/.test(header)) {
    reject(401, 'session_required', 'Inicia sesión nuevamente en el taller.');
  }
  return header.slice(7);
}

// Photo traffic of a platform workshop is validated against that workshop
// database only. The legacy backend keeps using its own Supabase project, so a
// workshop session is never forwarded to another installation.
function createWorkshopDriveRouter({ store, resolveConnection, makeClient, drive }) {
  if (typeof store?.get !== 'function' || typeof store?.operationalMembership !== 'function' ||
      typeof resolveConnection !== 'function' ||
      typeof makeClient !== 'function' || typeof drive?.uploadPrivateFile !== 'function') {
    throw new Error('Las rutas de fotos requieren el registro de talleres y el servicio de Drive.');
  }
  const router = express.Router();
  const json = express.json({ limit: '4mb' });

  async function operational(req) {
    const token = authorization(req);
    const id = req.params.id;
    if (!UUID.test(id || '')) reject(400, 'invalid_id', 'Identificador inválido.');
    const row = await store.get(id);
    if (!row || row.status !== 'ready') reject(404, 'workshop_not_found', 'Taller no disponible.');
    const connection = await resolveConnection(row.connection_ref);
    const db = makeClient(connection, token);
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) reject(401, 'invalid_session', 'La sesión del taller no es válida.');
    const profile = await db.from('profiles').select('role, is_active, deleted_at')
      .eq('id', data.user.id).maybeSingle();
    if (profile.error) reject(503, 'profile_unavailable', 'No fue posible verificar tu perfil.');
    const role = String(profile.data?.role || '').toLowerCase();
    if (!profile.data || profile.data.deleted_at || profile.data.is_active === false ||
        !['admin', 'empleado'].includes(role)) {
      reject(403, 'profile_required', 'Tu usuario no puede administrar fotos en este taller.');
    }
    const membership = await store.operationalMembership(row.id, data.user.id);
    if (!membership) {
      reject(403, 'membership_required', 'Tu acceso a este taller no está activo.');
    }
    return { row, userId: data.user.id, membership };
  }

  async function assertOwned(fileId, row) {
    const properties = await drive.fileAppProperties(fileId);
    if (properties[WORKSHOP_PROPERTY] !== row.id) {
      reject(403, 'file_not_owned', 'La foto pertenece a otro taller.');
    }
  }

  router.post('/workshops/:id/drive/upload', json, asyncRoute(async (req, res) => {
    const { row } = await operational(req);
    const {
      base64, fileName, mimeType, folderPath, root, vehiclePlate, category, uploadRequestId,
    } = req.body || {};
    if (!base64 || !fileName || !root) {
      reject(400, 'incomplete_file', 'Datos de archivo incompletos.');
    }
    if (!ALLOWED_MIME.has(mimeType)) {
      reject(400, 'mime_not_allowed', 'Tipo de imagen no permitido.');
    }
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
      reject(413, 'file_too_large', 'La imagen excede el máximo de 2.8 MB.');
    }
    let resolvedFolderPath = folderPath;
    if (root === 'vehicles') {
      const legacySegments = typeof folderPath === 'string' ? folderPath.split('/') : [];
      resolvedFolderPath = vehiclePhotoFolderPath(
        vehiclePlate || legacySegments[0],
        category || (legacySegments.length === 2 ? legacySegments[1] : null),
      );
    }
    if (!resolvedFolderPath) {
      reject(400, 'folder_required', 'La ruta de almacenamiento es requerida.');
    }
    const file = await drive.uploadPrivateFile({
      buffer,
      fileName,
      mimeType,
      folderPath: resolvedFolderPath,
      root,
      uploadRequestId,
      appProperties: { [WORKSHOP_PROPERTY]: row.id },
    });
    res.status(201).json({
      fileId: file.id,
      folderPath: resolvedFolderPath,
      filePath: `/api/platform/workshops/${row.id}/drive/files/${file.id}`,
    });
  }));

  router.get('/workshops/:id/drive/files/:fileId', asyncRoute(async (req, res) => {
    const { row } = await operational(req);
    await assertOwned(req.params.fileId, row);
    const driveResponse = await drive.downloadPrivateFile(req.params.fileId);
    res.setHeader('Content-Type', driveResponse.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return driveResponse.data.pipe(res);
  }));

  router.delete('/workshops/:id/drive/files/:fileId', asyncRoute(async (req, res) => {
    const { row } = await operational(req);
    await assertOwned(req.params.fileId, row);
    await drive.deletePrivateFile(req.params.fileId);
    res.status(204).send();
  }));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const expected = error instanceof PlatformError;
    if (!expected) console.error('[Platform drive]', error.message);
    const status = expected ? error.status
      : (Number.isInteger(error?.statusCode) ? error.statusCode : 503);
    res.status(status).json({
      code: expected ? error.code : 'drive_unavailable',
      error: expected ? error.message : 'No fue posible completar la operación con la foto.',
    });
  });

  return router;
}

module.exports = { createWorkshopDriveRouter, WORKSHOP_PROPERTY };
