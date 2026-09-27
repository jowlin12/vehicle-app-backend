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
It intentionally does not import `database.js` or `facturatech-service.js`, so
activating the control plane cannot redirect or interrupt the original workshop
backend or its invoicing provider. Workshop photos reuse the standalone
`drive-service.js` module and the deployment's own `GOOGLE_DRIVE_*` variables.

When `PLATFORM_ENABLED=true`, the platform requires a parseable central Supabase
URL, a non-empty service-role key and a `PLATFORM_CONNECTION_ENCRYPTION_KEY` that
decodes to 32 bytes. If a value is missing or invalid, or the central URL matches
the operational URL, only `/api/platform` returns `503 platform_unavailable`;
the health check and legacy API continue to start. The platform prefix stays
reserved so its credentials cannot fall through to legacy routes.

Creating a workshop also provisions its private Drive tree under
`GOOGLE_DRIVE_APP_FOLDER_ID/Talleres/<nombre · id-corto>`. The operation is
idempotent: the workshop folder is located by its `vehicleAppWorkshopFolder`
property, so renaming a workshop updates that folder instead of creating a
duplicate. Each workshop receives `Vehículos`, customer/electronic/supplier
invoice folders, `Documentos`, `Configuración` and `Reportes`.

## Managed workshop team

`GET/POST /api/platform/workshops/:id/members` lists or registers workers for
global administrators. Registration accepts a real email, name, initial password
and `employee`/`admin` role. Existing central accounts keep their passwords;
unrelated operational accounts are never adopted or promoted. The legacy shop
retains its existing administration.

Apply central migration `20260926231429_team_member_registration.sql` before
enabling this backend in the test environment. It binds each idempotency key to
its actor, workshop and normalized input, and commits the membership and result
atomically. It never stores passwords. Auth identities created before an
interruption can be recovered only with matching protected provenance.

`POST /api/platform/workshops/:id/member-access` verifies the caller's active
membership, linked operational profile and matching role before minting a
session for that exact operational identity. It rechecks membership after Auth
and returns tokens with `Cache-Control: no-store`. This does not revoke previously
issued JWTs: role editing and immediate deactivation still require operational
RLS/RPC coverage and are not implemented by these routes.

Flutter uses central Auth for credential changes in managed workshops and
operational Auth for legacy. Profile name/username stay in the workshop. PKCE
verifiers and persistent central sessions are stored under separate project keys.

## Workshop photos

A platform workshop does not send its session to the original workshop backend.
It uploads and reads photos through:

- `POST /api/platform/workshops/:id/drive/upload`
- `GET /api/platform/workshops/:id/drive/files/:fileId`
- `DELETE /api/platform/workshops/:id/drive/files/:fileId`

The route validates the operational token against that workshop's Supabase
project and requires an active `admin`/`empleado` profile. Every uploaded file
carries a `vehicleAppWorkshop` Drive custom property; uploads, reads and
deletions of a file that belongs to another workshop are rejected. The platform
deployment therefore needs the same `GOOGLE_DRIVE_*` variables as the original
backend.

New platform uploads use server-generated names. Vehicle photos follow
`foto_<PLACA>_<CATEGORIA>_<UTC>_<ID>.ext`; supplier invoices follow
`factura-proveedor_<PLACA>_<PROVEEDOR>_<UTC>_<ID>.ext`. The upload request ID
keeps retries stable and prevents files from being lost among camera-generated
names.

## Facturatech per workshop (local demo path)

Global administrators configure the fiscal profile through
`GET/PUT /api/platform/workshops/:id/facturatech-profile`. The route rejects the
legacy workshop, hashes the submitted provider password with SHA-256, encrypts
the profile with the platform secret box, and never returns its credentials.
Only the `demo` environment is accepted.

Managed invoice requests use the operational session for the selected workshop.
`POST /api/platform/workshops/:id/electronic-invoices/preview` requires Orders,
the paid `electronic_invoices` module, and a workshop administrator. It reads the
order, services, and parts from that workshop's database and calculates the
invoice there; caller-supplied totals and line items are ignored. The backend
reserves the number in the central control plane, stores the submitted invoice in
the operational workshop database, and calls only the configured demo profile.

`POST .../electronic-invoices/:transactionId/confirm` and
`GET .../electronic-invoices/:transactionId/status` verify that the reservation
belongs to the selected workshop before consulting Facturatech. A lost or
ambiguous upload is recorded as `uncertain`; the same order is blocked from being
sent again until reconciled. The provider transaction ID and bounded status are
kept centrally, while invoice contents remain in the operational workshop
project. Provider response messages are not copied into fiscal records.

Central migrations for encrypted profiles, number reservations, the commercial
module, and durable submission states are local under
`platform-control/supabase/migrations/`. The workshop entitlement migration is
local under `workshop-template/supabase/migrations/`. None has been applied to a
remote project. Route tests use synthetic workshop data and a mocked Facturatech
service; no real provider call or deployment has been performed. The managed
Flutter wizard now passes its workshop session and clearly identifies demo
results. PDF retrieval/storage and a real sandbox acceptance test remain open.
Reconcile migration history before any Preview application; never apply these
changes to Production.

## Installation defaults

`20260914030000_workshop_installation_defaults.sql` completes the schema with
the singleton `factura_v2_config`, the explicit `app_settings` defaults (photo
bypass disabled) and the hourly `finalizar-formatos-liquidados` cron job. It is
idempotent and additive; a workshop installed before this migration keeps its
business rows and receives only the missing defaults.

`20260917185322_orders_write_gate.sql` adds a database trigger to `formatos`,
`servicios` and `repuestos` in newly installed workshops. When the private
installation's `orders_enabled` flag is false or its row is missing, inserts,
updates and deletes fail even through the direct Supabase client and the
offline mutation RPC. Existing rows remain readable and unchanged; enabling
the flag again permits pending writes to retry. The gate also affects background
jobs that modify these tables.

`20260925221818_orders_paused_offline_defer.sql` makes the offline RPC return
`deferred` for format, service and part mutations while `orders_enabled` is false.
The local outbox retains these operations and retries them after reactivation.

The platform admin route `PUT /api/platform/workshops/:id/modules/orders`
synchronizes the central `modules` list and the operational flag. For a managed
installation behind the current schema, it applies pending versioned template
migrations first. After an ambiguous central write, it reads the saved module
state before deciding whether to accept the change or restore the prior
operational flag. The original `legacy-existing-v1` workshop is rejected by
this route and is never upgraded through it.

Managed installations now support three commercial modules: `orders`,
`supplier_invoices`, and `settlements`. The latter two require Órdenes. Plans,
manual receipt review, module switches and operational expiry fields use the
same module names. Customer invoices belong to Órdenes; they are distinct from
supplier invoice uploads.

The current template version is `20260926.5`. Its settlements migration guards
the eight payroll tables and the existing write RPCs. Paused/expired settlements
return `deferred` from the offline wrapper before recording a mutation receipt;
renewal can replay the same ID without duplication. Existing payroll history
remains readable. Scheduled finalization of already committed settlements keeps
its previous behavior and is still subject to the orders write gate. No new
client privileges are granted.

The central migration `20260926221008_subscription_settlements_module.sql` adds
Liquidaciones to plans and approval validation without rewriting approved
snapshots. It is applied to the central test project; the operational migration
remains local, with embedded PostgreSQL coverage. Complete Preview deployment
and device acceptance before rollout. Production is unchanged.

`POST /api/platform/workshops/:id/admin-access` also supports a registered
`legacy-existing-v1` workshop for authenticated global platform administrators.
It mints a session for the administrator's own operational identity and records
the central membership; it does not run migrations, alter the workshop schema,
change modules, or enable subscription billing. The endpoint remains unavailable
to workshop members who are not global administrators. Clients talking to an
older Preview backend retain the existing workshop-login fallback.

For production packaging, keep every SQL file under `platform/template` in sync
with the matching source migration in `workshop-template/supabase/migrations/`.

## Member roles and session revocation (local implementation)

Global administrators can change a linked worker's employee/admin role and
activate/deactivate the account through `PUT /api/platform/workshops/:id/members/:userId`.
Owners and global administrators are protected. The central migration
`20260926231003_team_member_access_changes.sql` binds the actor, target and desired
state to a request key. While a change is pending the membership cannot mint a
new operational session; the same key resumes an interrupted write between the
two databases. The team response exposes a pending request for recovery after
closing the dialog. No passwords or tokens are stored in that request.

The operational migration `20260926174523_workshop_member_session_guards.sql`
adds private access revisions and session grants bound to real `auth.sessions`.
A changed role/active flag invalidates all prior grants when the operational
transaction commits, including after reactivation and refresh of an old JWT.
Session authorization locks the revision and verifies the Auth user, preventing
entry races. Existing managed identities remain compatible until linked; the
legacy workshop is never upgraded by these routes.

Restrictive policies cover existing RLS tables. Wrappers retain original RPC
OIDs, signatures, grants and invoker/definer security, but check member access
before reading, writing or returning an idempotency receipt. The private
implementation is not exposed through the Data API. New tables/RPCs added by
future migrations must retain this coverage: `verify-orders.sql` rejects missing
member policies or unguarded public RPCs before marking the installation ready.

The client checks its own `workshop_access_status` on entry, foreground resume
and every 30 seconds while foregrounded. Only a confirmed denial closes the
operational runtime; network failures preserve offline work. Previously cached
information cannot be remotely erased on an offline device. Pending writes keep
their operation IDs and are deferred, rather than requiring conflict review,
when the database explicitly returns `workshop_access_revoked`. Other permission
errors remain reviewable. Remote API/Realtime and real Auth acceptance are still
pending Preview deployment; these migrations have not been applied remotely.

## Workshop dictation (local implementation, 2026-09-26)

`POST /api/platform/workshops/:id/voz/extraer-formato` uses the workshop's
operational JWT, an active profile and central membership with matching roles.
It requires Orders under the effective plan and revalidates access before
returning the extraction. Catalog reads use the operational publishable client
and RLS; client choices and model suggestions must belong to that workshop.
Vehicle lines must match the selected brand. No business records are written.

Catalog queries and providers share a nine-second abort signal. Input context
is bounded; provider errors are sanitized and responses use `no-store`.
Flutter limits the whole request to twelve seconds and falls back to its local
parser without forwarding a managed-workshop token to the legacy backend.
Classic and registered legacy workshops retain the existing endpoint.

The Groq engine was exercised with synthetic dictation through Preview's runtime
environment, successfully extracting brand, line, plate, year, odometer and
service. The new route is still not deployed: Preview does not currently deliver
the central service key or connection encryption key. No Production deployment
or connected database changes were performed.
