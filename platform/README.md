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

Creating a workshop also provisions its private Drive tree under
`GOOGLE_DRIVE_APP_FOLDER_ID/Talleres/<nombre · id-corto>`. The operation is
idempotent: the workshop folder is located by its `vehicleAppWorkshopFolder`
property, so renaming a workshop updates that folder instead of creating a
duplicate. Each workshop receives `Vehículos`, customer/electronic/supplier
invoice folders, `Documentos`, `Configuración` and `Reportes`.

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
jobs that modify these tables. It is not connected to the central module list
yet, and it does not enforce other future paid modules. Do not apply it to the
original workshop until its contract, jobs and rollback have been tested.

For production packaging, keep every SQL file under `platform/template` in sync
with the matching source migration in the Flutter repository. The tests compare
the packaged files with those sources in the development monorepo.
