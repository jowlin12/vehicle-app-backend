'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createConnectionResolver } = require('./connections');
const { createProvisioner } = require('./provisioning');
const { createSecretBox } = require('./secrets');
const { createControlStore } = require('./store');
const { createPlatformRouter } = require('./router');

function mountPlatform(app, env = process.env) {
  // Always reserve this prefix so central tokens cannot enter legacy routes.
  if (env.PLATFORM_ENABLED !== 'true') {
    app.use('/api/platform', (req, res) => res.status(503).json({
      code: 'platform_disabled', error: 'La plataforma de talleres aún no está activada.',
    }));
    return;
  }
  if (!env.PLATFORM_SUPABASE_URL || !env.PLATFORM_SUPABASE_SERVICE_KEY ||
      env.PLATFORM_SUPABASE_URL.replace(/\/$/, '') === (env.SUPABASE_URL || '').replace(/\/$/, '')) {
    throw new Error('La plataforma requiere una base central independiente.');
  }
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const central = createClient(env.PLATFORM_SUPABASE_URL, env.PLATFORM_SUPABASE_SERVICE_KEY, options);
  const store = createControlStore(central);
  const secretBox = createSecretBox(env.PLATFORM_CONNECTION_ENCRYPTION_KEY);
  const resolveConnection = createConnectionResolver({ store, secretBox, env });
  const makeServiceClient = connection => createClient(
    connection.url,
    connection.serviceRoleKey,
    options,
  );
  app.use('/api/platform', createPlatformRouter({
    auth: central.auth,
    store,
    secretBox,
    resolveConnection,
    provisioner: createProvisioner({ makeServiceClient }),
    makeClient: (connection, token) => createClient(connection.url, connection.publishableKey, {
      ...options, global: { headers: { Authorization: `Bearer ${token}` } },
    }),
  }));
}

module.exports = { mountPlatform };
