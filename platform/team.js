'use strict';
const crypto = require('node:crypto');
const { reject } = require('./errors');
const { findUser } = require('./provisioning');

function createTeam({ centralAuth, store, makeServiceClient, makePublicClient }) {
  async function rpc(db,name,args) {
    const result = await db.rpc(name,args);
    if (result.error) reject(503,'member_access_update_failed',
      'No se completó el cambio de acceso. Reintenta la misma solicitud.');
    return result.data;
  }
  async function centralUser(email, password, fullName) {
    const existing = await findUser(centralAuth, email);
    if (existing) return existing; // Never reset an existing account's password.
    const created = await centralAuth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });
    if (created.error || !created.data?.user) {
      // A concurrent request may have created this exact email first.
      const concurrent = await findUser(centralAuth, email);
      if (concurrent) return concurrent;
      reject(503, 'member_auth_failed', 'No fue posible crear el acceso central.');
    }
    return created.data.user;
  }

  async function profile(db, id) {
    const result = await db.from('profiles')
      .select('id,full_name,username,role,is_active').eq('id', id).maybeSingle();
    if (result.error || !result.data) reject(503, 'member_profile_failed', 'No fue posible leer el perfil del taller.');
    return result.data;
  }

  function publicMember(member, user, row) {
    return { userId: member.user_id, operationalUserId: member.operational_user_id,
      email: user.email, fullName: row.full_name, username: row.username,
      role: member.role, active: member.active && row.is_active === true };
  }

  async function register({ actor, key, workshop, connection, email, fullName, password, role }) {
    const request = await store.beginTeamMember(actor, key, workshop.id, { email, fullName, role });
    const db = makeServiceClient(connection);
    if (request.completed_at) {
      const member = await store.membership(request.user_id, workshop.id);
      if (!member || member.operational_user_id !== request.operational_user_id) {
        reject(409, 'member_changed', 'El acceso cambió después de su creación. Actualiza el equipo.');
      }
      const user = await centralAuth.admin.getUserById(member.user_id);
      if (user.error || !user.data?.user) reject(503, 'member_auth_failed', 'No fue posible leer el acceso central.');
      return publicMember(member, user.data.user, await profile(db, member.operational_user_id));
    }
    const user = await centralUser(email, password, fullName);
    if (user.id === workshop.owner_user_id || await store.isAdmin(user.id)) {
      reject(409, 'protected_member', 'El propietario y los administradores globales conservan su acceso actual.');
    }
    if (await store.teamMember(workshop.id, user.id)) {
      reject(409, 'member_already_registered', 'Esta cuenta ya pertenece al taller.');
    }
    const marker = { request: key, workshop: workshop.id, email, fullName, role };
    let operational = await findUser(db.auth, email);
    if (!operational) {
      const created = await db.auth.admin.createUser({
        email, password: crypto.randomBytes(32).toString('base64url'), email_confirm: true,
        user_metadata: { full_name: fullName },
        app_metadata: { vehicleapp_team_registration: marker },
      });
      operational = created.data?.user || await findUser(db.auth, email);
      if (!operational) reject(503, 'member_operational_auth_failed', 'No fue posible crear el acceso al taller. Reintenta con los mismos datos.');
    }
    const savedMarker = operational.app_metadata?.vehicleapp_team_registration;
    if (!savedMarker?.request || ['workshop', 'email', 'fullName', 'role']
      .some(field => savedMarker[field] !== marker[field])) {
      reject(409, 'operational_email_in_use', 'Ese correo ya tiene otro acceso en el taller. No se modificó.');
    }
    const updated = await db.from('profiles').update({
      full_name: fullName, role: role === 'employee' ? 'empleado' : 'admin',
    }).eq('id', operational.id).select('id,full_name,username,role,is_active').single();
    if (updated.error || !updated.data) reject(503, 'member_profile_failed', 'No fue posible preparar el perfil. Reintenta con los mismos datos.');
    await rpc(db,'platform_set_member_access',{p_workshop:workshop.id,p_user:operational.id,
      p_role:updated.data.role,p_active:updated.data.is_active===true});
    const completed = await store.completeTeamMember(actor, key, user.id, operational.id);
    return publicMember({ ...completed, active: true }, user, updated.data);
  }

  async function list({ workshop, connection }) {
    const members = await store.teamMembers(workshop.id);
    const pending = await store.pendingTeamChanges(workshop.id);
    if (members.length > 100) reject(409, 'team_limit', 'El equipo requiere una consulta paginada.');
    if (!members.length) return [];
    const db = makeServiceClient(connection);
    const ids = members.map(member => member.operational_user_id).filter(Boolean);
    const profiles = ids.length ? await db.from('profiles')
      .select('id,full_name,username,role,is_active').in('id', ids) : { data: [] };
    if (profiles.error) reject(503, 'member_profile_failed', 'No fue posible consultar los perfiles del taller.');
    const result = [];
    for (let offset = 0; offset < members.length; offset += 10) {
      result.push(...await Promise.all(members.slice(offset, offset + 10).map(async member => {
        const user = await centralAuth.admin.getUserById(member.user_id);
        if (user.error || !user.data?.user) reject(503, 'member_auth_failed', 'No fue posible consultar el equipo central.');
        const row = profiles.data.find(item => item.id === member.operational_user_id)
          || { full_name: '', username: '', is_active: false };
        const change = pending.find(item=>item.user_id===member.user_id);
        return {...publicMember(member,user.data.user,row),
          canManage: member.role!=='owner' && member.user_id!==workshop.owner_user_id && !await store.isAdmin(member.user_id),
          pendingChange: change ? {requestKey:change.request_key,role:change.role,active:change.active} : null};
      })));
    }
    return result;
  }

  async function enter({ workshop, membership, connection }) {
    if (!membership?.active || !membership.operational_user_id) {
      reject(409, 'member_link_required', 'Tu acceso todavía necesita vincularse al taller.');
    }
    const db = makeServiceClient(connection);
    const row = await profile(db, membership.operational_user_id);
    const expectedRole = membership.role === 'employee' ? 'empleado' : 'admin';
    if (row.is_active !== true || row.role !== expectedRole) {
      reject(403, 'member_access_disabled', 'Tu acceso al taller está desactivado o requiere revisión.');
    }
    let access = await rpc(db,'platform_member_access',{p_user:membership.operational_user_id});
    if (!access) access = await rpc(db,'platform_set_member_access',{p_workshop:workshop.id,
      p_user:membership.operational_user_id,p_role:expectedRole,p_active:true});
    if (!access.active || access.role!==expectedRole) reject(403,'member_access_disabled','Tu acceso está desactivado.');
    const user = await db.auth.admin.getUserById(membership.operational_user_id);
    if (user.error || !user.data?.user?.email) reject(503, 'member_auth_failed', 'No fue posible leer tu acceso al taller.');
    const link = await db.auth.admin.generateLink({ type: 'magiclink', email: user.data.user.email });
    const hash = link.data?.properties?.hashed_token;
    if (link.error || !hash) reject(503, 'member_session_failed', 'No fue posible abrir tu sesión en el taller.');
    const verified = await makePublicClient(connection).auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
    const session = verified.data?.session;
    if (verified.error || !session?.refresh_token || session.user?.id !== membership.operational_user_id) {
      reject(503, 'member_session_failed', 'No fue posible verificar tu sesión en el taller.');
    }
    let sessionId;
    try { sessionId = JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url').toString()).session_id; }
    catch { reject(503,'member_session_failed','La sesión no tiene un identificador verificable.'); }
    if (!/^[0-9a-f-]{36}$/i.test(sessionId || '')) reject(503,'member_session_failed','La sesión no tiene un identificador verificable.');
    await rpc(db,'platform_allow_member_session',{p_user:membership.operational_user_id,p_session:sessionId,p_revision:access.revision});
    return { operationalUserId: session.user.id, accessToken: session.access_token,
      refreshToken: session.refresh_token, expiresAt: session.expires_at ?? null };
  }

  async function change({actor,key,workshop,connection,userId,role,active}) {
    const request = await store.beginTeamChange(actor,key,workshop.id,userId,role,active);
    const db = makeServiceClient(connection);
    if (!request.completed_at) {
      await rpc(db,'platform_set_member_access',{p_workshop:workshop.id,p_user:request.operational_user_id,
        p_role:role==='employee'?'empleado':'admin',p_active:active});
      await store.completeTeamChange(actor,key);
    }
    const member = await store.teamMember(workshop.id,userId);
    if (!member || member.role!==role || member.active!==active) reject(409,'member_changed','El acceso cambió después de esta solicitud.');
    const user = await centralAuth.admin.getUserById(userId);
    if (user.error || !user.data?.user) reject(503,'member_auth_failed','No se pudo consultar la cuenta.');
    return publicMember(member,user.data.user,await profile(db,member.operational_user_id));
  }
  return Object.freeze({ register, list, enter, change });
}
module.exports = { createTeam };
