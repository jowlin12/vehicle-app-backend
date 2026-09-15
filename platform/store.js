'use strict';

const { reject } = require('./errors');

function checked(result) {
  if (result.error?.message === 'idempotency_conflict') reject(409, 'idempotency_conflict', 'La solicitud ya fue utilizada con otros datos.');
  if (result.error?.code === '23505') reject(409, 'already_registered', 'La instalación o membresía ya está registrada.');
  if (result.error) reject(503, 'control_unavailable', 'No fue posible consultar el registro de talleres.');
  return result.data;
}

function createControlStore(db) {
  return {
    async ownerByEmail(email, { required = true } = {}) {
      const id = checked(await db.rpc('platform_owner_by_email', { p_email: email }));
      if (!id && required) reject(400, 'owner_not_found', 'El propietario no tiene una cuenta central.');
      return id || null;
    },
    async isAdmin(userId) {
      return !!checked(await db.from('platform_admins').select('user_id')
        .eq('user_id', userId).eq('active', true).maybeSingle());
    },
    async list(userId, admin) {
      if (admin) return checked(await db.from('platform_workshops').select('*').order('created_at'));
      const rows = checked(await db.from('platform_memberships').select('workshop_id')
        .eq('user_id', userId).eq('active', true));
      if (!rows.length) return [];
      return checked(await db.from('platform_workshops').select('*')
        .in('id', rows.map(row => row.workshop_id)).order('created_at'));
    },
    async get(id) {
      return checked(await db.from('platform_workshops').select('*').eq('id', id).maybeSingle());
    },
    async connection(ref) {
      return checked(await db.from('platform_workshop_connections').select('*')
        .eq('connection_ref', ref).maybeSingle());
    },
    async saveConnection(actor, workshopId, input) {
      const workshop = await this.get(workshopId);
      if (!workshop || workshop.connection_ref !== input.projectRef) {
        reject(409, 'connection_mismatch', 'La conexión no corresponde al taller registrado.');
      }
      return checked(await db.from('platform_workshop_connections').upsert({
        workshop_id: workshopId,
        connection_ref: input.projectRef,
        project_ref: input.projectRef,
        project_url: input.url,
        publishable_key: input.publishableKey,
        service_role_secret: input.serviceRoleSecret,
        management_token_secret: input.managementTokenSecret,
        status: 'configured',
        schema_version: null,
        last_error: null,
        updated_at: new Date().toISOString(),
        created_by: actor,
      }, { onConflict: 'workshop_id' }).select('*').single());
    },
    async markConnection(id, values) {
      return checked(await db.from('platform_workshop_connections').update({
        ...values, updated_at: new Date().toISOString(),
      }).eq('workshop_id', id).select('*').single());
    },
    async membership(userId, workshopId) {
      return checked(await db.from('platform_memberships').select('*')
        .eq('user_id', userId).eq('workshop_id', workshopId).eq('active', true).maybeSingle());
    },
    async operationalMembership(workshopId, operationalUserId) {
      return checked(await db.from('platform_memberships').select('*')
        .eq('workshop_id', workshopId).eq('operational_user_id', operationalUserId)
        .eq('active', true).maybeSingle());
    },
    async register(actor, key, input) {
      return checked(await db.rpc('platform_register_workshop', {
        p_actor: actor, p_request_key: key, p_name: input.name,
        p_owner: input.ownerUserId, p_connection_ref: input.connectionRef,
        p_modules: input.modules,
      }));
    },
    async markReady(id, version) {
      const rows = checked(await db.from('platform_workshops')
        .update({ status: 'ready', schema_version: version, last_error: null })
        .eq('id', id).in('status', ['pending', 'failed']).select('*'));
      return rows[0] || this.get(id);
    },
    async markFailed(id, code) {
      checked(await db.from('platform_workshops').update({ status: 'failed', last_error: code })
        .eq('id', id).in('status', ['pending', 'failed']));
      const connection = await db.from('platform_workshop_connections').update({
        status: 'failed', last_error: code, updated_at: new Date().toISOString(),
      }).eq('workshop_id', id);
      if (connection.error && connection.error.code !== 'PGRST116') checked(connection);
    },
    async linkMember(workshopId, userId, operationalUserId, role) {
      return checked(await db.from('platform_memberships').upsert({
        workshop_id: workshopId, user_id: userId, operational_user_id: operationalUserId,
        role, active: true,
      }, { onConflict: 'workshop_id,user_id' }).select('*').single());
    },
  };
}

module.exports = { createControlStore };
