'use strict';

const { reject } = require('./errors');

function checked(result) {
  if (['member_already_registered', 'protected_member', 'team_workshop_unavailable', 'member_change_pending', 'member_changed', 'member_link_required'].includes(result.error?.message)) {
    reject(409, result.error.message, 'El acceso o el taller cambió. Actualiza el equipo antes de reintentar.');
  }
  if (result.error?.message === 'idempotency_conflict') reject(409, 'idempotency_conflict', 'La solicitud ya fue utilizada con otros datos.');
  if (result.error?.message === 'subscription_plan_change_waits_until_expiry') {
    reject(409, result.error.message, 'Tu plan sigue activo. Puedes renovar un plan con los mismos módulos; podrás cambiar de módulos cuando venza.');
  }
  if (result.error?.message === 'facturatech_workshop_unavailable') {
    reject(409, result.error.message, 'La facturación electrónica de este taller todavía no está disponible.');
  }
  if (result.error?.message === 'facturatech_numbering_exhausted') {
    reject(409, result.error.message, 'La numeración autorizada se agotó o ya no incluye el siguiente consecutivo.');
  }
  if (result.error?.message === 'facturatech_invalid_reservation') {
    reject(400, result.error.message, 'La solicitud de numeración fiscal no tiene un formato válido.');
  }
  if (result.error?.message === 'facturatech_invalid_submission') {
    reject(400, result.error.message, 'La solicitud de emisión no tiene un formato válido.');
  }
  if (result.error?.message === 'facturatech_reservation_not_found') {
    reject(409, result.error.message, 'No se encontró la reserva de esta factura.');
  }
  if (['facturatech_submission_state_conflict', 'facturatech_transaction_conflict',
    'facturatech_source_already_reserved'].includes(result.error?.message)) {
    reject(409, result.error.message, 'Esta orden ya tiene una emisión iniciada y requiere conciliación.');
  }
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
    async updateSchemaVersion(id, version) {
      const result = checked(await db.from('platform_workshops')
        .update({ schema_version: version })
        .eq('id', id).eq('status', 'ready').select('*').maybeSingle());
      if (!result) reject(409, 'workshop_changed', 'El taller cambió mientras se actualizaba su instalación.');
      return result;
    },
    async setModuleEnabled(id, module, enabled) {
      const current = await this.get(id);
      if (!current || current.status !== 'ready') {
        reject(409, 'workshop_not_ready', 'El taller debe estar disponible para cambiar sus módulos.');
      }
      const modules = new Set(current.modules || []);
      if (enabled) modules.add(module);
      else modules.delete(module);
      const result = checked(await db.from('platform_workshops')
        .update({ modules: [...modules].sort() })
        .eq('id', id).eq('status', 'ready').select('*').maybeSingle());
      if (!result) reject(409, 'workshop_changed', 'El taller cambió mientras se actualizaban sus módulos.');
      return result;
    },
    async setOrdersEnabled(id, enabled) {
      return this.setModuleEnabled(id, 'orders', enabled);
    },
    async setSubscriptionRequired(id, required) {
      const current = await this.get(id);
      if (!current || current.status !== 'ready' || current.schema_version === 'legacy-existing-v1') {
        reject(409, 'subscription_workshop_unavailable', 'Solo se puede cobrar un plan a un taller gestionado y verificado.');
      }
      const result = checked(await db.from('platform_workshops')
        .update({ subscription_required: required })
        .eq('id', id).eq('status', 'ready').select('*').maybeSingle());
      if (!result) reject(409, 'workshop_changed', 'El taller cambió mientras se actualizaba su plan.');
      return result;
    },
    async updateDocumentProfile(id, documentProfile) {
      const result = checked(await db.from('platform_workshops')
        .update({ document_profile: documentProfile })
        .eq('id', id).select('*').maybeSingle());
      if (!result) reject(404, 'workshop_not_found', 'Taller no disponible.');
      return result;
    },
    async getFacturatechProfile(id) {
      return checked(await db.from('platform_facturatech_profiles')
        .select('workshop_id, configuration_ciphertext, updated_by, updated_at')
        .eq('workshop_id', id).maybeSingle());
    },
    async saveFacturatechProfile(id, actor, ciphertext) {
      return checked(await db.from('platform_facturatech_profiles').upsert({
        workshop_id: id,
        configuration_ciphertext: ciphertext,
        updated_by: actor,
        updated_at: new Date().toISOString(),
      }, {onConflict: 'workshop_id'}).select(
        'workshop_id, configuration_ciphertext, updated_by, updated_at',
      ).single());
    },
    async reserveFacturatechNumber(workshopId, input) {
      return checked(await db.rpc('platform_reserve_facturatech_number', {
        p_workshop_id: workshopId,
        p_idempotency_key: input.idempotencyKey,
        p_source_fingerprint: input.sourceFingerprint,
        p_request_fingerprint: input.requestFingerprint,
        p_prefix: input.numbering.prefijo,
        p_resolution: input.numbering.resolucion,
        p_range_start: input.numbering.rangoDesde,
        p_range_end: input.numbering.rangoHasta,
      }));
    },
    async claimFacturatechSubmission(workshopId, input) {
      return checked(await db.rpc('platform_claim_facturatech_submission', {
        p_workshop_id: workshopId,
        p_idempotency_key: input.idempotencyKey,
        p_request_fingerprint: input.requestFingerprint,
      }));
    },
    async recordFacturatechSubmission(workshopId, input) {
      return checked(await db.rpc('platform_record_facturatech_submission', {
        p_workshop_id: workshopId,
        p_idempotency_key: input.idempotencyKey,
        p_request_fingerprint: input.requestFingerprint,
        p_state: input.state,
        p_transaction_id: input.transactionId ? String(input.transactionId) : null,
        p_provider_status: input.providerStatus ? String(input.providerStatus) : null,
      }));
    },
    async facturatechReservationByTransaction(workshopId, transactionId) {
      return checked(await db.from('platform_facturatech_number_reservations')
        .select('workshop_id, idempotency_key, request_fingerprint, prefix, invoice_number, submission_state, transaction_id, provider_status')
        .eq('workshop_id', workshopId).eq('transaction_id', transactionId).maybeSingle());
    },
    async listPlans({ activeOnly = false } = {}) {
      let query = db.from('platform_plans').select('*').order('price_cop').order('name');
      if (activeOnly) query = query.eq('active', true);
      return checked(await query);
    },
    async savePlan(actor, input) {
      const values = {
        code: input.code,
        name: input.name,
        description: input.description,
        price_cop: input.priceCop,
        duration_days: input.durationDays,
        modules: [...input.modules],
        active: input.active,
        updated_at: new Date().toISOString(),
      };
      if (input.id) values.id = input.id;
      else values.created_by = actor;
      return checked(await db.from('platform_plans').upsert(values, {
        onConflict: input.id ? 'id' : 'code',
      }).select('*').single());
    },
    async getPaymentSettings() {
      return checked(await db.from('platform_payment_settings').select('*')
        .eq('singleton', true).maybeSingle());
    },
    async savePaymentSettings(actor, values) {
      return checked(await db.from('platform_payment_settings').upsert({
        singleton: true,
        bank_name: values.bankName,
        account_type: values.accountType,
        account_number: values.accountNumber,
        account_holder: values.accountHolder,
        holder_document: values.holderDocument,
        instructions: values.instructions,
        review_grace_hours: values.reviewGraceHours,
        updated_at: new Date().toISOString(),
        updated_by: actor,
      }, { onConflict: 'singleton' }).select('*').single());
    },
    async submitSubscriptionRequest(input) {
      const result = await db.rpc('platform_submit_subscription_request', {
        p_workshop_id: input.workshopId,
        p_request_id: input.requestId,
        p_requester: input.requester,
        p_plan_id: input.planId,
        p_receipt_path: input.receiptPath,
        p_payment_reference: input.paymentReference,
      });
      if (result.error?.message === 'subscription_request_idempotency_conflict') {
        reject(409, 'subscription_request_conflict', 'La solicitud ya fue utilizada con otros datos.');
      }
      if (result.error?.code === '23505') {
        reject(409, 'subscription_request_pending', 'Ya hay un comprobante pendiente de revisión para este taller.');
      }
      return checked(result);
    },
    async listSubscriptionRequests({ workshopId, statuses, limit = 100 } = {}) {
      let query = db.from('platform_subscription_requests')
        .select('*, platform_workshops(id,name,status,schema_version,subscription_required,modules,paid_until,review_access_until), platform_plans(id,code,name)')
        .order('submitted_at', { ascending: false }).limit(limit);
      if (workshopId) query = query.eq('workshop_id', workshopId);
      if (statuses?.length) query = query.in('status', statuses);
      return checked(await query);
    },
    async getSubscriptionRequest(id) {
      return checked(await db.from('platform_subscription_requests').select('*')
        .eq('id', id).maybeSingle());
    },
    async claimSubscriptionRequest(id, reviewer, decision) {
      return checked(await db.rpc('platform_claim_subscription_request', {
        p_request_id: id, p_reviewer: reviewer, p_decision: decision,
      }));
    },
    async finishSubscriptionRequest(id, reviewer, decision, note) {
      return checked(await db.rpc('platform_finish_subscription_request', {
        p_request_id: id, p_reviewer: reviewer, p_decision: decision,
        p_review_note: note,
      }));
    },
    async releaseSubscriptionReview(id, reviewer) {
      return checked(await db.rpc('platform_release_subscription_review', {
        p_request_id: id, p_reviewer: reviewer,
      }));
    },
    async hasOpenSubscriptionRequest(workshopId) {
      const rows = checked(await db.from('platform_subscription_requests').select('id')
        .eq('workshop_id', workshopId).in('status', ['pending', 'reviewing']).limit(1));
      return rows.length > 0;
    },
    async linkMember(workshopId, userId, operationalUserId, role) {
      return checked(await db.from('platform_memberships').upsert({
        workshop_id: workshopId, user_id: userId, operational_user_id: operationalUserId,
        role, active: true,
      }, { onConflict: 'workshop_id,user_id' }).select('*').single());
    },
    async teamMembers(workshopId) {
      return checked(await db.from('platform_memberships').select('*')
        .eq('workshop_id', workshopId).order('user_id').limit(101));
    },
    async pendingTeamChanges(workshopId) {
      return checked(await db.from('platform_team_changes').select('request_key,user_id,role,active')
        .eq('workshop_id',workshopId).is('completed_at',null));
    },
    async beginTeamChange(actor,key,workshopId,userId,role,active) {
      return checked(await db.rpc('platform_begin_team_change', {p_actor:actor,p_key:key,
        p_workshop:workshopId,p_user:userId,p_role:role,p_active:active}));
    },
    async completeTeamChange(actor,key) {
      return checked(await db.rpc('platform_complete_team_change',{p_actor:actor,p_key:key}));
    },
    async teamMember(workshopId, userId) {
      return checked(await db.from('platform_memberships').select('*')
        .eq('workshop_id', workshopId).eq('user_id', userId).maybeSingle());
    },
    async beginTeamMember(actor, key, workshopId, input) {
      return checked(await db.rpc('platform_begin_team_member', {
        p_actor: actor, p_key: key, p_workshop: workshopId,
        p_email: input.email, p_name: input.fullName, p_role: input.role,
      }));
    },
    async completeTeamMember(actor, key, userId, operationalUserId) {
      return checked(await db.rpc('platform_complete_team_member', {
        p_actor: actor, p_key: key, p_user: userId, p_operational: operationalUserId,
      }));
    },
  };
}

module.exports = { createControlStore };
