'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createAdminAccess } = require('./admin-access');
const { createTeam } = require('./team');
const { createConnectionResolver } = require('./connections');
const { createProvisioner } = require('./provisioning');
const { createSecretBox } = require('./secrets');
const { createControlStore } = require('./store');
const { createPlatformRouter } = require('./router');
const { createWorkshopDriveRouter } = require('./drive');
const { createWorkshopVoiceRouter } = require('./voice');
const driveService = require('../drive-service');

function mountPlatform(app, env = process.env) {
  // Always reserve this prefix so central tokens cannot enter legacy routes.
  if (env.PLATFORM_ENABLED !== 'true') {
    app.use('/api/platform', (req, res) => res.status(503).json({
      code: 'platform_disabled', error: 'La plataforma de talleres aún no está activada.',
    }));
    return;
  }

  const centralUrl = typeof env.PLATFORM_SUPABASE_URL === 'string'
    ? env.PLATFORM_SUPABASE_URL.trim()
    : '';
  const serviceKey = typeof env.PLATFORM_SUPABASE_SERVICE_KEY === 'string'
    ? env.PLATFORM_SUPABASE_SERVICE_KEY.trim()
    : '';
  const operationalUrl = typeof env.SUPABASE_URL === 'string'
    ? env.SUPABASE_URL.trim()
    : '';
  let secretBox;
  try {
    if (!centralUrl || !serviceKey || !env.PLATFORM_CONNECTION_ENCRYPTION_KEY ||
        centralUrl.replace(/\/+$/, '') === operationalUrl.replace(/\/+$/, '')) {
      throw new Error('Invalid platform configuration.');
    }
    const parsedCentralUrl = new URL(centralUrl);
    if (!['http:', 'https:'].includes(parsedCentralUrl.protocol)) {
      throw new Error('Invalid platform URL.');
    }
    secretBox = createSecretBox(env.PLATFORM_CONNECTION_ENCRYPTION_KEY);
  } catch (_) {
    // Platform misconfiguration must not prevent the legacy API from starting.
    // Keep the prefix reserved so central credentials can never reach legacy routes.
    app.use('/api/platform', (req, res) => res.status(503).json({
      code: 'platform_unavailable',
      error: 'La plataforma no está disponible por configuración.',
    }));
    return;
  }

  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const central = createClient(centralUrl, serviceKey, options);
  const store = createControlStore(central);
  const resolveConnection = createConnectionResolver({ store, secretBox, env });
  const makeServiceClient = connection => createClient(
    connection.url,
    connection.serviceRoleKey,
    options,
  );
  const makePublicClient = connection => createClient(connection.url, connection.publishableKey, options);
  const makeTokenClient = (connection, token) => createClient(connection.url, connection.publishableKey, {
    ...options, global: { headers: { Authorization: `Bearer ${token}` } },
  });
  app.use('/api/platform', createWorkshopDriveRouter({
    store,
    resolveConnection,
    makeClient: makeTokenClient,
    drive: driveService,
  }));
  app.use('/api/platform', createWorkshopVoiceRouter({
    store, resolveConnection, makeClient: makeTokenClient,
  }));
  app.use('/api/platform', createPlatformRouter({
    auth: central.auth,
    store,
    secretBox,
    resolveConnection,
    provisioner: createProvisioner({ makeServiceClient }),
    adminAccess: createAdminAccess({ makeServiceClient, makePublicClient }),
    team: createTeam({ centralAuth: central.auth, store, makeServiceClient, makePublicClient }),
    makeClient: makeTokenClient,
    drive: driveService,
    storage: central.storage,
  }));
}

module.exports = { mountPlatform };
