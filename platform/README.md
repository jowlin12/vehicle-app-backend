# VehicleApp platform control

This module is disabled unless `PLATFORM_ENABLED=true`. It keeps the legacy
backend and the current workshop connection unchanged while the multi-workshop
path is validated.

Global administrators register a Supabase project created for a customer. The
server validates the project reference, encrypts the service-role and management
credentials with AES-256-GCM, applies the versioned workshop template, creates
the first operational administrator and runs a rollback-only order acceptance
before marking the installation ready.

The Flutter client only receives the project URL and publishable key after the
central membership check. `service_role`, management tokens and database
passwords must never be compiled into the app or returned by an endpoint.

Deploy `platform-server.js` with `vercel.platform.json` as a separate service.
It intentionally does not import `database.js` or any invoice/Drive provider,
so activating the control plane cannot redirect or interrupt the original
workshop backend.

For production packaging, keep every SQL file under `platform/template` in sync
with the matching source migration in the Flutter repository. The tests compare
the packaged files with those sources in the development monorepo.
