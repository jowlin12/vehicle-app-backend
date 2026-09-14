'use strict';

const crypto = require('node:crypto');
const { reject } = require('./errors');
const { findUser } = require('./provisioning');

// Global administrators enter a workshop as their own operational user, never
// as the owner. Their account has no shared password: every entry mints a
// session server-side with the workshop's service credentials, and actions stay
// attributable to the administrator inside the workshop.
function createAdminAccess({ makeServiceClient, makePublicClient }) {
  if (typeof makeServiceClient !== 'function' || typeof makePublicClient !== 'function') {
    throw new Error('El acceso de administradores requiere clientes Supabase.');
  }

  async function ensureUser(db, email, operationalUserId) {
    if (operationalUserId) {
      const { data, error } = await db.auth.admin.getUserById(operationalUserId);
      if (error || !data?.user?.email) {
        reject(503, 'operational_auth_unavailable', 'No fue posible leer tu usuario en el taller.');
      }
      return data.user;
    }
    const existing = await findUser(db.auth, email);
    if (existing) return existing;
    const created = await db.auth.admin.createUser({
      email,
      password: crypto.randomBytes(32).toString('base64url'),
      email_confirm: true,
      user_metadata: { full_name: 'Administrador de plataforma', vehicleapp_role: 'platform_admin' },
    });
    if (created.error || !created.data?.user) {
      reject(503, 'admin_creation_failed', 'No fue posible crear tu acceso en el taller.');
    }
    return created.data.user;
  }

  async function enter({ connection, email, operationalUserId = null }) {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalized) reject(503, 'admin_unavailable', 'Tu cuenta central no tiene un correo válido.');
    const db = makeServiceClient(connection);
    const user = await ensureUser(db, normalized, operationalUserId);
    const profile = await db.from('profiles').update({ role: 'admin' }).eq('id', user.id);
    if (profile.error) reject(503, 'admin_profile_failed', 'No fue posible asignarte como administrador del taller.');

    const link = await db.auth.admin.generateLink({ type: 'magiclink', email: user.email });
    const tokenHash = link.data?.properties?.hashed_token;
    if (link.error || !tokenHash) reject(503, 'admin_session_failed', 'No fue posible abrir tu sesión en el taller.');
    const verified = await makePublicClient(connection).auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
    const session = verified.data?.session;
    if (verified.error || !session?.refresh_token || session.user?.id !== user.id) {
      reject(503, 'admin_session_failed', 'No fue posible abrir tu sesión en el taller.');
    }
    return Object.freeze({
      operationalUserId: user.id,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at ?? null,
    });
  }

  return Object.freeze({ enter });
}

module.exports = { createAdminAccess };
