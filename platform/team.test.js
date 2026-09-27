'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTeam } = require('./team');
const { PlatformError } = require('./errors');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const ACTOR = '10000000-0000-4000-8000-000000000001';
const OWNER = '20000000-0000-4000-8000-000000000001';
const USER = '30000000-0000-4000-8000-000000000001';
const OP = '40000000-0000-4000-8000-000000000001';
const WORKSHOP = '80000000-0000-4000-8000-000000000001';
const KEY = '70000000-0000-4000-8000-000000000001';
const input = { actor: ACTOR, key: KEY, workshop: { id: WORKSHOP, owner_user_id: OWNER },
  connection: { projectRef: 'abcdefghijklmnopqrst' }, email: 'worker@example.invalid',
  fullName: 'Trabajador QA', password: 'initial-qa-password', role: 'employee' };

function fixture() {
  const requests = new Map(), members = new Map(), users = [], operational = [], profiles = new Map(), access = new Map(), changes = new Map();
  const counters = { centralCreated: 0, operationalCreated: 0, profileWrites: 0, sessions: 0 };
  let failCommit = false;
  const auth = (list, id, counter) => ({ admin: {
    listUsers: async () => ({ data: { users: list }, error: null }),
    getUserById: async id => ({ data: { user: list.find(user => user.id === id) }, error: null }),
    createUser: async data => {
      counters[counter]++;
      const user = { id, ...data };
      list.push(user);
      if (list === operational) profiles.set(id, { id, username: 'trabajador.qa', is_active: true, role: 'empleado' });
      return { data: { user }, error: null };
    },
    generateLink: async () => { counters.sessions++; return { data: { properties: { hashed_token: 'hash' } }, error: null }; },
  } });
  const centralAuth = auth(users, USER, 'centralCreated');
  const db = { auth: auth(operational, OP, 'operationalCreated'), rpc: async (name,args) => {
    if(name==='platform_member_access') return {data:access.get(args.p_user)};
    if(name==='platform_set_member_access') {
      const old=access.get(args.p_user);
      const row={role:args.p_role,active:args.p_active,revision:(old?.revision||0)+(!old||old.role!==args.p_role||old.active!==args.p_active?1:0)};
      access.set(args.p_user,row); Object.assign(profiles.get(args.p_user),{role:row.role,is_active:row.active});
      return {data:row};
    }
    assert.equal(name,'platform_allow_member_session');
    assert.equal(args.p_revision,access.get(args.p_user).revision);
    return {data:null};
  }, from: table => {
    assert.equal(table, 'profiles');
    return {
      select: () => ({ eq: (_, id) => ({ maybeSingle: async () => ({ data: profiles.get(id), error: null }) }),
        in: async (_, ids) => ({ data: ids.map(id => profiles.get(id)).filter(Boolean), error: null }) }),
      update: values => ({ eq: (_, id) => ({ select: () => ({ single: async () => {
        counters.profileWrites++; Object.assign(profiles.get(id), values);
        return { data: profiles.get(id), error: null };
      } }) }) }),
    };
  } };
  const store = {
    isAdmin: async id => id === ACTOR,
    membership: async id => members.get(id)?.active ? members.get(id) : null,
    teamMember: async (_, id) => members.get(id),
    teamMembers: async () => [...members.values()],
    pendingTeamChanges: async () => [...changes.values()].filter(r=>!r.completed_at),
    beginTeamChange: async(actor,key,workshop,user,role,active)=>{
      const old=changes.get(key);
      if(old) { if(old.role!==role||old.active!==active)throw new PlatformError(409,'idempotency_conflict','Solicitud distinta.'); return old; }
      const member=members.get(user); member.active=false;
      const row={actor,request_key:key,workshop_id:workshop,user_id:user,operational_user_id:member.operational_user_id,role,active};
      changes.set(key,row); return row;
    },
    completeTeamChange: async(_,key)=>{
      if(failCommit){failCommit=false;throw new Error('synthetic commit interruption');}
      const row=changes.get(key); row.completed_at='now';
      Object.assign(members.get(row.user_id),{role:row.role,active:row.active});return row;
    },
    beginTeamMember: async (actor, key, workshopId, data) => {
      const old = requests.get(key);
      if (old) {
        for (const [field, value] of Object.entries({ actor, workshop_id: workshopId,
          email: data.email, full_name: data.fullName, role: data.role })) {
          if (old[field] !== value) throw new PlatformError(409, 'idempotency_conflict', 'Solicitud distinta.');
        }
        return old;
      }
      const request = { actor, request_key: key, workshop_id: workshopId,
        email: data.email, full_name: data.fullName, role: data.role };
      requests.set(key, request); return request;
    },
    completeTeamMember: async (_, key, userId, operationalUserId) => {
      if (failCommit) { failCommit = false; throw new Error('synthetic commit interruption'); }
      const request = requests.get(key);
      Object.assign(request, { user_id: userId, operational_user_id: operationalUserId, completed_at: 'now' });
      members.set(userId, { user_id: userId, operational_user_id: operationalUserId, role: request.role, active: true });
      return request;
    },
  };
  const team = createTeam({ centralAuth, store, makeServiceClient: () => db,
    makePublicClient: () => ({ auth: { verifyOtp: async () => ({ data: { session: {
      access_token: `test.${Buffer.from(JSON.stringify({session_id:'50000000-0000-4000-8000-000000000001'})).toString('base64url')}.signature`, refresh_token: 'test-refresh', user: { id: OP },
    } }, error: null }) } }) });
  return { team, counters, users, operational, profiles, requests, members,access,changes,
    failCommit: () => { failCommit = true; } };
}

test('worker registration reuses an existing central account and retries without duplicate identities', async () => {
  const f = fixture();
  f.users.push({ id: USER, email: input.email, password: 'existing-qa-password' });
  f.failCommit();
  await assert.rejects(f.team.register(input), /synthetic commit/);
  const member = await f.team.register(input);
  const again = await f.team.register(input);
  assert.deepEqual(again, member);
  assert.equal(f.counters.centralCreated, 0);
  assert.equal(f.counters.operationalCreated, 1);
  assert.equal(f.users[0].password, 'existing-qa-password');
  assert.notEqual(f.operational[0].password, input.password);
  assert.equal(member.role, 'employee');
  assert.equal(f.profiles.get(OP).role, 'empleado');
  assert.equal(f.members.size, 1);
  assert.equal('password' in f.requests.get(KEY), false);
  await assert.rejects(f.team.register({ ...input, role: 'admin' }), error => error.code === 'idempotency_conflict');
});

test('a new form can finish a previously interrupted registration with identical account data', async () => {
  const f = fixture(); f.failCommit();
  await assert.rejects(f.team.register(input));
  const member = await f.team.register({ ...input, key: '70000000-0000-4000-8000-000000000002' });
  assert.equal(member.active, true);
  assert.equal(f.counters.centralCreated, 1);
  assert.equal(f.counters.operationalCreated, 1);
});

test('an unrelated operational account is never adopted or promoted', async () => {
  const f = fixture(); f.operational.push({ id: OP, email: input.email });
  await assert.rejects(f.team.register({ ...input, role: 'admin' }), error => error.code === 'operational_email_in_use');
  assert.equal(f.counters.profileWrites, 0);
  assert.equal(f.members.size, 0);
});

test('registration never reactivates an inactive membership or writes its profile', async () => {
  const f = fixture();
  await f.team.register(input);
  f.members.get(USER).active = false;
  const writes = f.counters.profileWrites;
  await assert.rejects(f.team.register({ ...input, key: '70000000-0000-4000-8000-000000000002' }),
    error => error.code === 'member_already_registered');
  assert.equal(f.members.get(USER).active, false);
  assert.equal(f.counters.profileWrites, writes);
  assert.equal(f.counters.operationalCreated, 1);
});

test('member entry uses its linked identity and refuses inactive or mismatched operational roles', async () => {
  const f = fixture(); const member = await f.team.register(input);
  const membership = f.members.get(member.userId);
  const session = await f.team.enter({ workshop:input.workshop,membership, connection: input.connection });
  assert.equal(session.operationalUserId, OP);
  assert.equal(f.profiles.get(OP).role, 'empleado');
  f.profiles.get(OP).is_active = false;
  await assert.rejects(f.team.enter({ workshop:input.workshop,membership, connection: input.connection }), error => error.code === 'member_access_disabled');
  f.profiles.get(OP).is_active = true;
  await assert.rejects(f.team.enter({ workshop:input.workshop,membership: { ...membership, role: 'admin' }, connection: input.connection }), error => error.code === 'member_access_disabled');
  assert.equal(f.counters.sessions, 1);
  assert.equal(JSON.stringify(await f.team.list({ workshop: input.workshop, connection: input.connection })).includes('test-refresh'), false);
});

test('permission change is fail-closed between projects and retry does not revoke twice',async()=>{
  const f=fixture();await f.team.register(input);
  const key='70000000-0000-4000-8000-000000000003';
  const change={...input,key,userId:USER,role:'admin',active:true};
  f.failCommit(); await assert.rejects(f.team.change(change),/synthetic commit/);
  assert.equal(f.members.get(USER).active,false);
  assert.equal(f.access.get(OP).role,'admin');
  const revision=f.access.get(OP).revision;
  const pending=await f.team.list(input);
  assert.equal(pending[0].pendingChange.requestKey,key);
  const result=await f.team.change(change);
  assert.equal(result.active,true);assert.equal(result.role,'admin');
  assert.equal(f.access.get(OP).revision,revision);
  assert.deepEqual(await f.team.change(change),result);
  await assert.rejects(f.team.change({...change,role:'employee'}),e=>e.code==='idempotency_conflict');
});

test('central registration binds input and commits exactly one protected membership with service-only access', async () => {
  const db = new PGlite();
  const root = path.resolve(__dirname, '../..');
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text);
      grant usage on schema public to service_role,authenticated,anon;`);
    await db.exec(fs.readFileSync(path.join(root, 'platform-control/supabase/migrations/20260913225303_platform_control.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(root, 'platform-control/supabase/migrations/20260926231429_team_member_registration.sql'), 'utf8'));
    await db.query('insert into auth.users(id) values($1),($2),($3)', [ACTOR, OWNER, USER]);
    await db.query('insert into public.platform_admins(user_id) values($1)', [ACTOR]);
    await db.query(`insert into public.platform_workshops(id,name,connection_ref,owner_user_id,status,schema_version,created_by,request_key)
      values($1,'Taller QA','qa',$2,'ready','20260926.4',$3,$4)`, [WORKSHOP,OWNER,ACTOR,KEY]);
    await db.exec('set role service_role');
    const begin = (role = 'employee') => db.query('select public.platform_begin_team_member($1,$2,$3,$4,$5,$6) as request',
      [ACTOR,KEY,WORKSHOP,input.email,input.fullName,role]);
    await begin(); await begin();
    await assert.rejects(begin('admin'), /idempotency_conflict/);
    await assert.rejects(db.query('select public.platform_complete_team_member($1,$2,$3,$4)', [ACTOR,KEY,OWNER,OP]), /protected_member/);
    const complete = () => db.query('select public.platform_complete_team_member($1,$2,$3,$4)', [ACTOR,KEY,USER,OP]);
    await complete(); await complete();
    assert.equal((await db.query('select count(*)::int n from public.platform_memberships')).rows[0].n, 1);
    await assert.rejects(db.query('select public.platform_complete_team_member($1,$2,$3,$4)', [ACTOR,KEY,USER,WORKSHOP]), /idempotency_conflict/);
    await db.exec('set role authenticated');
    await assert.rejects(begin(), /permission denied/);
    await assert.rejects(db.query('select * from public.platform_team_requests'), /permission denied/);
    await db.exec('set role anon');
    await assert.rejects(begin(), /permission denied/);
  } finally { await db.close(); }
});
