'use strict';

const { reject } = require('./errors');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Uses the selected workshop's publishable client and RLS, never a service key.
function createWorkshopOperationalAccess({ store, resolveConnection, makeClient }) {
  if (typeof store?.get !== 'function' || typeof store?.operationalMembership !== 'function' ||
      typeof resolveConnection !== 'function' || typeof makeClient !== 'function') {
    throw new Error('El acceso operativo requiere el registro de talleres.');
  }
  return async function operational(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer \S+$/.test(header)) {
      reject(401, 'session_required', 'Inicia sesión nuevamente en el taller.');
    }
    const token = header.slice(7), id = req.params.id;
    if (!UUID.test(id || '')) reject(400, 'invalid_id', 'Identificador inválido.');
    const row = await store.get(id);
    if (!row || row.status !== 'ready') reject(404, 'workshop_not_found', 'Taller no disponible.');
    const db = makeClient(await resolveConnection(row.connection_ref), token);
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) reject(401, 'invalid_session', 'La sesión del taller no es válida.');
    const profile = await db.from('profiles').select('role, is_active, deleted_at')
      .eq('id', data.user.id).maybeSingle();
    if (profile.error) reject(503, 'profile_unavailable', 'No fue posible verificar tu perfil.');
    const role = String(profile.data?.role || '').toLowerCase();
    if (!profile.data || profile.data.deleted_at || profile.data.is_active !== true ||
        !['admin', 'empleado'].includes(role)) {
      reject(403, 'profile_required', 'Tu usuario no puede usar esta función en el taller.');
    }
    const membership = await store.operationalMembership(row.id, data.user.id);
    if (!membership || membership.active !== true) {
      reject(403, 'membership_required', 'Tu acceso a este taller no está activo.');
    }
    const expectedRole = membership.role === 'employee' ? 'empleado' : 'admin';
    if (!['owner', 'admin', 'employee'].includes(membership.role) || role !== expectedRole) {
      reject(403, 'member_access_changed', 'Tu acceso cambió. Vuelve a entrar al taller.');
    }
    return { row, userId: data.user.id, membership, db };
  };
}

module.exports = { createWorkshopOperationalAccess };
