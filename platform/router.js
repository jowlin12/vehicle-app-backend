'use strict';

const crypto = require('node:crypto');
const express = require('express');
const FacturatechService = require('../facturatech-service');
const {workshopFileName} = require('../drive-service');
const { PlatformError, reject } = require('./errors');
const { normalizeConnection } = require('./connections');
const { SCHEMA_VERSION } = require('./provisioning');
const { createCustomerQuotePdf } = require('./customer-quote');
const {
  normalizeFacturatechProfileInput,
  parseStoredFacturatechProfile,
  publicFacturatechProfile,
} = require('./facturatech-profile');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODULES = new Set(['orders', 'supplier_invoices', 'settlements', 'electronic_invoices']);
const ORDER_DEPENDENTS = ['supplier_invoices', 'settlements', 'electronic_invoices'];
const MODULE_LABELS = Object.freeze({
  orders: 'Órdenes',
  supplier_invoices: 'Facturas de proveedores',
  settlements: 'Liquidaciones',
  electronic_invoices: 'Facturación electrónica',
});
const DOCUMENT_TEMPLATE_KEYS = new Set(['standard-v1', 'compact-v1']);
const RECEIPT_BUCKET = 'platform-payment-receipts';
const RECEIPT_LIMIT = 10 * 1024 * 1024;
const RECEIPT_MIME_BY_EXTENSION = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
});
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIAN_DOCUMENT_TYPES = Object.freeze({CC: '13', NIT: '31', CE: '22', PP: '41', TI: '12', DIE: '42'});
const MAX_ELECTRONIC_PDF_BYTES = 10 * 1024 * 1024;

async function archiveWorkshopElectronicInvoicePdf({drive, row, invoice, facturatech}) {
  if (typeof drive?.uploadPrivateFile !== 'function' ||
      typeof facturatech?.downloadPDFFile !== 'function') return null;

  try {
    const downloaded = await facturatech.downloadPDFFile(invoice.prefijo, invoice.numero_factura);
    if (!downloaded?.success || typeof downloaded.pdfBase64 !== 'string') return null;
    const encoded = downloaded.pdfBase64
      .replace(/^data:application\/pdf;base64,/i, '')
      .replace(/\s/g, '');
    if (!encoded || encoded.length > 14_000_000 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return null;
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length || buffer.length > MAX_ELECTRONIC_PDF_BYTES ||
        buffer.subarray(0, 5).toString('ascii') !== '%PDF-') return null;

    const documentKey = `${String(invoice.prefijo || '').trim()}-${String(invoice.numero_factura || '').trim()}`;
    const invoiceId = String(invoice.id || '');
    const transactionId = String(invoice.transaction_id || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(documentKey) ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(invoiceId) ||
        !/^[A-Za-z0-9._:-]{1,100}$/.test(transactionId)) return null;
    const folderPath = `facturas_electronicas/${documentKey}`;
    const uploadRequestId = `invoice-${invoiceId}`;
    const file = await drive.uploadPrivateFile({
      buffer,
      fileName: workshopFileName({
        root: 'invoices', folderPath, mimeType: 'application/pdf', uploadRequestId,
      }),
      mimeType: 'application/pdf',
      folderPath,
      root: 'invoices',
      uploadRequestId,
      appProperties: {
        vehicleAppWorkshop: row.id,
        vehicleAppDocument: 'electronic_invoice',
        vehicleAppInvoice: invoiceId,
      },
      workshop: {id: row.id, name: row.name},
    });
    if (typeof file?.id !== 'string' || !/^[A-Za-z0-9_-]{5,200}$/.test(file.id)) return null;
    return `/api/platform/workshops/${row.id}/electronic-invoices/${encodeURIComponent(transactionId)}/pdf/${encodeURIComponent(file.id)}`;
  } catch (_) {
    // PDF retrieval is recoverable: status checks can retry without re-emitting.
    return null;
  }
}

function invoiceText(value, field, maxLength, {optional = false} = {}) {
  if (optional && value == null) return '';
  if (typeof value !== 'string') reject(400, 'invalid_invoice_customer', 'Revisa los datos fiscales del cliente.');
  const normalized = value.trim();
  if ((!optional && !normalized) || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    reject(400, 'invalid_invoice_customer', `Revisa el campo ${field} del cliente.`);
  }
  return normalized;
}

function normalizeInvoiceCustomer(input) {
  const fields = new Set([
    'tipoPersona', 'tipoDocumento', 'tipoDocumentoDian', 'numeroDocumento', 'dv',
    'razonSocial', 'nombreComercial', 'direccion', 'codigoCiudad', 'ciudad',
    'departamento', 'codigoDepto', 'telefono', 'email', 'responsabilidad', 'regimen',
  ]);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !fields.has(key))) {
    reject(400, 'invalid_invoice_customer', 'Los datos fiscales del cliente no tienen un formato válido.');
  }
  const customer = {
    tipoPersona: invoiceText(input.tipoPersona, 'tipo de persona', 1),
    tipoDocumento: invoiceText(input.tipoDocumento, 'tipo de documento', 10).toUpperCase(),
    numeroDocumento: invoiceText(input.numeroDocumento, 'documento', 20),
    dv: invoiceText(input.dv, 'dígito de verificación', 1, {optional: true}),
    razonSocial: invoiceText(input.razonSocial, 'razón social', 200),
    nombreComercial: invoiceText(input.nombreComercial, 'nombre comercial', 200, {optional: true}),
    direccion: invoiceText(input.direccion, 'dirección', 240),
    codigoCiudad: invoiceText(input.codigoCiudad, 'código de ciudad', 10, {optional: true}) || '54001',
    ciudad: invoiceText(input.ciudad, 'ciudad', 100, {optional: true}) || 'Cúcuta',
    departamento: invoiceText(input.departamento, 'departamento', 100, {optional: true}) || 'Norte de Santander',
    codigoDepto: invoiceText(input.codigoDepto, 'código de departamento', 10, {optional: true}) || '54',
    telefono: invoiceText(input.telefono, 'teléfono', 40, {optional: true}),
    email: invoiceText(input.email, 'correo', 150, {optional: true}),
    responsabilidad: invoiceText(input.responsabilidad, 'responsabilidad fiscal', 50, {optional: true}) || 'R-99-PN',
    regimen: invoiceText(input.regimen, 'régimen', 20, {optional: true}) || '49',
  };
  if (!['1', '2'].includes(customer.tipoPersona) ||
      !Object.hasOwn(DIAN_DOCUMENT_TYPES, customer.tipoDocumento) ||
      !/^[A-Za-z0-9.-]{4,20}$/.test(customer.numeroDocumento) ||
      (customer.tipoDocumento === 'NIT' && !/^\d$/.test(customer.dv)) ||
      (customer.email && !EMAIL.test(customer.email))) {
    reject(400, 'invalid_invoice_customer', 'Revisa el documento, tipo de persona y correo del cliente.');
  }
  customer.tipoDocumentoDian = DIAN_DOCUMENT_TYPES[customer.tipoDocumento];
  customer.nombreComercial ||= customer.razonSocial;
  return customer;
}

function invoiceFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function facturatechProviderStatus(value, maxLength = 40) {
  if (typeof value !== 'string') return null;
  const status = value.trim();
  return status.length > 0 && status.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(status)
    ? status
    : null;
}

function validSubscriptionReceiptImage(bytes, extension, mime) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 ||
      RECEIPT_MIME_BY_EXTENSION[extension] !== mime) return false;
  if (mime === 'image/jpeg') {
    return bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9;
  }
  if (mime === 'image/png') {
    return bytes.length >= 20 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
      bytes.readUInt32BE(bytes.length - 12) === 0 &&
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND';
  }
  if (mime === 'image/webp') {
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.readUInt32LE(4) + 8 !== bytes.length ||
        bytes.toString('ascii', 8, 12) !== 'WEBP') return false;
    let offset = 12;
    let hasImageFrame = false;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) return false;
      const type = bytes.toString('ascii', offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const data = offset + 8;
      const end = data + size + (size & 1);
      if (end > bytes.length) return false;
      if (type === 'VP8 ' && size >= 10 &&
          bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
        hasImageFrame = true;
      } else if (type === 'VP8L' && size >= 5 && bytes[data] === 0x2f) {
        hasImageFrame = true;
      }
      offset = end;
    }
    return offset === bytes.length && hasImageFrame;
  }
  return false;
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) reject(400, 'invalid_id', 'Identificador inválido.');
  return value;
}

function bearer(value) {
  if (typeof value !== 'string' || !/^Bearer \S+$/.test(value)) reject(401, 'session_required', 'Inicia sesión nuevamente.');
  return value.slice(7);
}

function publicWorkshop(row, { canManageSubscription = false } = {}) {
  const storedModules = Array.isArray(row.modules)
    ? [...new Set(row.modules.filter(module => MODULES.has(module)))].sort()
    : [];
  const paidUntil = row.paid_until || null;
  const reviewAccessUntil = row.review_access_until || null;
  const paidActive = paidUntil != null && Date.parse(paidUntil) > Date.now();
  const reviewActive = reviewAccessUntil != null && Date.parse(reviewAccessUntil) > Date.now();
  const paidModules = Array.isArray(row.paid_modules) ? row.paid_modules : storedModules;
  const reviewModules = Array.isArray(row.review_modules) ? row.review_modules : storedModules;
  const entitlements = new Set([
    ...(paidActive ? paidModules : []),
    ...(reviewActive ? reviewModules : []),
  ].filter(module => MODULES.has(module)));
  const modules = row.subscription_required
    ? storedModules.filter(module => entitlements.has(module))
    : storedModules;
  if (!modules.includes('orders')) {
    for (const dependent of ORDER_DEPENDENTS) {
      const index = modules.indexOf(dependent);
      if (index >= 0) modules.splice(index, 1);
    }
  }
  const subscriptionAccessUntil = [paidUntil, reviewAccessUntil]
    .filter(value => value && Date.parse(value) > Date.now())
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  return {
    id: row.id, name: row.name, status: row.status,
    projectRef: row.connection_ref,
    modules, schemaVersion: row.schema_version,
    lastError: row.last_error,
    subscriptionRequired: row.subscription_required === true,
    activePlanId: row.active_plan_id || null,
    paidUntil,
    reviewAccessUntil,
    subscriptionAccessUntil,
    canManageSubscription,
  };
}

function moduleAccessExpiry(row, module, { hasOpenRequest = false, now = Date.now() } = {}) {
  const paidUntil = row.paid_until && Date.parse(row.paid_until) > now
    ? row.paid_until : null;
  const reviewUntil = hasOpenRequest && row.review_access_until &&
    Date.parse(row.review_access_until) > now ? row.review_access_until : null;
  const storedModules = Array.isArray(row.modules) ? row.modules : [];
  const paidModules = Array.isArray(row.paid_modules) ? row.paid_modules : storedModules;
  const reviewModules = Array.isArray(row.review_modules) ? row.review_modules : storedModules;
  const expiries = [
    paidUntil && paidModules.includes(module) ? paidUntil : null,
    reviewUntil && reviewModules.includes(module) ? reviewUntil : null,
  ].filter(Boolean);
  return expiries.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function publicPlan(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    price_cop: row.price_cop,
    duration_days: row.duration_days,
    modules: Array.isArray(row.modules) ? [...row.modules].filter(module => MODULES.has(module)) : [],
    active: row.active,
  };
}

function publicPaymentSettings(row) {
  if (!row) return null;
  return {
    bank_name: row.bank_name,
    account_type: row.account_type,
    account_number: row.account_number,
    account_holder: row.account_holder,
    holder_document: row.holder_document,
    instructions: row.instructions,
    review_grace_hours: row.review_grace_hours,
  };
}

function hasConfiguredPaymentAccount(settings) {
  return Boolean(settings) &&
    ['bank_name', 'account_type', 'account_number', 'account_holder']
      .every(field => typeof settings[field] === 'string' && settings[field].trim());
}

function documentProfileValue(source, field, maxLength, {
  multiline = false,
  strict = false,
  fallback = '',
} = {}) {
  const value = source[field];
  if (value == null && !strict) return fallback;
  if (typeof value !== 'string') {
    if (strict) reject(400, 'invalid_document_profile', 'Revisa los datos de la plantilla del taller.');
    return fallback;
  }
  const normalized = value.trim();
  const controlCharacters = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (normalized.length > maxLength || controlCharacters.test(normalized)) {
    if (strict) reject(400, 'invalid_document_profile', 'Revisa la longitud o el formato de los datos de la plantilla.');
    return fallback;
  }
  return normalized;
}

function normalizeDocumentProfile(input, workshopName, { strict = false } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (strict && (input == null || typeof input !== 'object' || Array.isArray(input))) {
    reject(400, 'invalid_document_profile', 'La plantilla del taller no tiene un formato válido.');
  }
  const templateKey = source.templateKey || 'standard-v1';
  if (!DOCUMENT_TEMPLATE_KEYS.has(templateKey)) {
    if (strict) reject(400, 'invalid_document_template', 'Selecciona una plantilla disponible.');
  }
  const issuerName = documentProfileValue(source, 'issuerName', 120, {
    strict,
    fallback: workshopName || 'Taller',
  }) || workshopName || 'Taller';
  const profile = {
    templateKey: DOCUMENT_TEMPLATE_KEYS.has(templateKey) ? templateKey : 'standard-v1',
    issuerName,
    taxId: documentProfileValue(source, 'taxId', 32, {strict}),
    address: documentProfileValue(source, 'address', 180, {strict}),
    city: documentProfileValue(source, 'city', 80, {strict}),
    phone: documentProfileValue(source, 'phone', 40, {strict}),
    email: documentProfileValue(source, 'email', 150, {strict}),
    paymentInstructions: documentProfileValue(source, 'paymentInstructions', 800, {strict, multiline: true}),
    thankYouMessage: documentProfileValue(source, 'thankYouMessage', 300, {strict, multiline: true}),
  };
  if (profile.email && !EMAIL.test(profile.email)) {
    if (strict) reject(400, 'invalid_document_email', 'El correo de la plantilla no es válido.');
    profile.email = '';
  }
  return profile;
}

function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    reject(400, 'invalid_temporary_password', 'La contraseña temporal debe tener entre 10 y 128 caracteres.');
  }
  return value;
}

function createPlatformRouter({ auth, store, secretBox, resolveConnection, makeClient, provisioner, adminAccess, team, drive, storage, quoteGenerator = createCustomerQuotePdf, facturatechServiceFactory = configuration => new FacturatechService(configuration) }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.use(asyncRoute(async (req, res, next) => {
    const { data, error } = await auth.getUser(bearer(req.headers.authorization));
    if (error || !data?.user) reject(401, 'invalid_session', 'La sesión central no es válida.');
    req.platformUser = data.user.id;
    req.platformAdmin = await store.isAdmin(data.user.id);
    next();
  }));

  function admin(req) {
    if (!req.platformAdmin) reject(403, 'platform_admin_required', 'Se requiere un administrador de la plataforma.');
  }

  async function workshop(req, requireReady = true) {
    const id = uuid(req.params.id);
    // Administrators can manage metadata; operational data still needs membership.
    const membership = await store.membership(req.platformUser, id);
    if (!membership && !req.platformAdmin) reject(404, 'workshop_not_found', 'Taller no disponible.');
    const row = await store.get(id);
    if (!row) reject(404, 'workshop_not_found', 'Taller no disponible.');
    if (requireReady && row.status !== 'ready') reject(409, 'workshop_not_ready', 'El taller aún no está disponible.');
    return { row, membership };
  }

  async function subscriptionManager(req) {
    const context = await workshop(req, false);
    if (!req.platformAdmin && !['owner', 'admin'].includes(context.membership?.role)) {
      reject(403, 'subscription_manager_required', 'Solo el propietario o un administrador del taller puede gestionar sus planes.');
    }
    if (context.row.schema_version === 'legacy-existing-v1') {
      reject(409, 'subscription_workshop_unavailable', 'El taller actual conserva su instalación independiente y aún no admite cobros desde la plataforma.');
    }
    return context;
  }

  async function ensureManagedSchema(row, connection) {
    if (row.schema_version === SCHEMA_VERSION) return row;
    const upgraded = await provisioner.upgrade({ connection, workshopId: row.id });
    return store.updateSchemaVersion(row.id, upgraded.schemaVersion);
  }

  async function restoreModuleAccess(connection, workshopId, previous) {
    let failed = false;
    for (const state of [...previous].reverse()) {
      try {
        await provisioner.setModuleAccess({
          connection,
          workshopId,
          module: state.module,
          enabled: state.enabled,
          expiresAt: state.expiresAt,
        });
      } catch (_) {
        failed = true;
      }
    }
    return !failed;
  }

  async function reconcileModuleAccess(row, connection, enabledModules, expiresAt) {
    const currentRow = await ensureManagedSchema(row, connection);
    const previous = await Promise.all([...MODULES].map(async module => ({
      module,
      ...await provisioner.getModuleAccess({ connection, workshopId: row.id, module }),
    })));
    try {
      for (const module of MODULES) {
        const enabled = enabledModules.has(module);
        await provisioner.setModuleAccess({
          connection,
          workshopId: row.id,
          module,
          enabled,
          expiresAt: enabled
            ? (expiresAt instanceof Map ? expiresAt.get(module) || null : expiresAt)
            : null,
        });
      }
    } catch (error) {
      if (!await restoreModuleAccess(connection, row.id, previous)) {
        reject(503, 'module_state_reconciliation_required', 'No fue posible confirmar el acceso de todos los módulos. Revisa el estado del taller antes de volver a intentarlo.');
      }
      throw error;
    }
    return { row: currentRow, previous };
  }

  async function syncSubscriptionAccess(row) {
    if (!row.subscription_required || row.schema_version === 'legacy-existing-v1') return row;
    const [hasOpenRequest, connection] = await Promise.all([
      store.hasOpenSubscriptionRequest(row.id),
      resolveConnection(row.connection_ref, { requireSecrets: true }),
    ]);
    const currentRow = await ensureManagedSchema(row, connection);
    const enabledModules = new Set(publicWorkshop(currentRow).modules);
    const expiresAt = new Map([...enabledModules].map(module => [
      module,
      moduleAccessExpiry(currentRow, module, { hasOpenRequest }),
    ]));
    const synchronized = await reconcileModuleAccess(
      currentRow, connection, enabledModules, expiresAt,
    );
    return synchronized.row;
  }

  async function syncUnrestrictedModuleAccess(row) {
    if (row.schema_version === 'legacy-existing-v1') return row;
    const connection = await resolveConnection(row.connection_ref, { requireSecrets: true });
    const currentRow = await ensureManagedSchema(row, connection);
    return (await reconcileModuleAccess(
      currentRow, connection, new Set(currentRow.modules || []), null,
    )).row;
  }

  function privateRequestView(row) {
    const { receipt_path, requested_by, reviewed_by, ...safe } = row;
    return safe;
  }

  async function operational(req, { prepare = false } = {}) {
    const context = await workshop(req, !prepare);
    if (!context.membership?.operational_user_id) reject(403, 'membership_required', 'Falta vincular tu usuario operativo.');
    const connection = await resolveConnection(context.row.connection_ref);
    const token = bearer(req.headers['x-workshop-authorization']);
    const db = makeClient(connection, token);
    const { data, error } = await db.auth.getUser(token);
    if (error || data?.user?.id !== context.membership.operational_user_id) {
      reject(403, 'wrong_workshop_session', 'La sesión no corresponde a tu usuario de este taller.');
    }
    return { ...context, db, userId: data.user.id };
  }

  router.get('/session', (req, res) => res.json({ userId: req.platformUser, isPlatformAdmin: req.platformAdmin }));
  router.get('/workshops', asyncRoute(async (req, res) => {
    const rows = await store.list(req.platformUser, req.platformAdmin);
    const workshops = await Promise.all(rows.map(async row => {
      const membership = req.platformAdmin ? null : await store.membership(req.platformUser, row.id);
      return publicWorkshop(row, {
        canManageSubscription: req.platformAdmin || ['owner', 'admin'].includes(membership?.role),
      });
    }));
    res.json({ workshops });
  }));

  router.get('/workshops/:id/document-profile', asyncRoute(async (req, res) => {
    admin(req);
    const { row } = await workshop(req, false);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'document_profile_unavailable', 'Este taller conserva su instalación anterior y aún no admite plantillas desde la plataforma.');
    }
    res.set('Cache-Control', 'no-store');
    res.json({ documentProfile: normalizeDocumentProfile(row.document_profile, row.name) });
  }));

  router.put('/workshops/:id/document-profile', asyncRoute(async (req, res) => {
    admin(req);
    const { row } = await workshop(req, false);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'document_profile_unavailable', 'Este taller conserva su instalación anterior y aún no admite plantillas desde la plataforma.');
    }
    const profile = normalizeDocumentProfile(req.body?.documentProfile, row.name, { strict: true });
    const updated = await store.updateDocumentProfile(row.id, profile);
    res.json({ documentProfile: normalizeDocumentProfile(updated.document_profile, updated.name) });
  }));

  router.get('/workshops/:id/facturatech-profile', asyncRoute(async (req, res) => {
    admin(req);
    const {row} = await workshop(req, false);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'facturatech_profile_unavailable', 'El taller actual conserva su configuración fiscal independiente.');
    }
    const saved = await store.getFacturatechProfile(row.id);
    let profile = null;
    if (saved?.configuration_ciphertext) {
      try {
        profile = parseStoredFacturatechProfile(secretBox.open(saved.configuration_ciphertext));
      } catch (_) {
        reject(503, 'facturatech_profile_unavailable', 'No fue posible recuperar la configuración fiscal del taller.');
      }
    }
    res.set('Cache-Control', 'no-store');
    res.json({facturatechProfile: publicFacturatechProfile(profile, saved?.updated_at || null)});
  }));

  router.put('/workshops/:id/facturatech-profile', asyncRoute(async (req, res) => {
    admin(req);
    const {row} = await workshop(req, false);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'facturatech_profile_unavailable', 'El taller actual conserva su configuración fiscal independiente.');
    }
    const saved = await store.getFacturatechProfile(row.id);
    let existing = null;
    if (saved?.configuration_ciphertext) {
      try {
        existing = parseStoredFacturatechProfile(secretBox.open(saved.configuration_ciphertext));
      } catch (_) {
        reject(503, 'facturatech_profile_unavailable', 'No fue posible recuperar la configuración fiscal del taller.');
      }
    }
    const profile = normalizeFacturatechProfileInput(req.body?.facturatechProfile, existing);
    const encrypted = secretBox.seal(JSON.stringify(profile));
    const updated = await store.saveFacturatechProfile(row.id, req.platformUser, encrypted);
    res.set('Cache-Control', 'no-store');
    res.json({facturatechProfile: publicFacturatechProfile(profile, updated.updated_at)});
  }));

  router.get('/billing/catalog', asyncRoute(async (req, res) => {
    const [plans, settings] = await Promise.all([
      store.listPlans({ activeOnly: !req.platformAdmin }),
      store.getPaymentSettings(),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ plans: plans.map(publicPlan), paymentSettings: publicPaymentSettings(settings) });
  }));

  router.post('/billing/plans', asyncRoute(async (req, res) => {
    admin(req);
    const { code, name, description = '', priceCop, durationDays, active = true } = req.body || {};
    const modules = [...new Set(Array.isArray(req.body?.modules) ? req.body.modules : ['orders'])].sort();
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(code) ||
        typeof name !== 'string' || !name.trim() || name.trim().length > 80 ||
        typeof description !== 'string' || description.length > 500 ||
        !Number.isSafeInteger(priceCop) || priceCop <= 0 ||
        !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 366 ||
        typeof active !== 'boolean' || !modules.length || modules.some(module => !MODULES.has(module)) ||
        (ORDER_DEPENDENTS.some(module => modules.includes(module)) && !modules.includes('orders'))) {
      reject(400, 'invalid_subscription_plan', 'Revisa el nombre, precio, duración y estado del plan.');
    }
    const plan = await store.savePlan(req.platformUser, {
      code, name: name.trim(), description: description.trim(), priceCop,
      durationDays, active, modules,
    });
    res.status(201).json({ plan: publicPlan(plan) });
  }));

  router.put('/billing/plans/:id', asyncRoute(async (req, res) => {
    admin(req);
    const id = uuid(req.params.id);
    const { code, name, description = '', priceCop, durationDays, active } = req.body || {};
    const modules = [...new Set(Array.isArray(req.body?.modules) ? req.body.modules : ['orders'])].sort();
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(code) ||
        typeof name !== 'string' || !name.trim() || name.trim().length > 80 ||
        typeof description !== 'string' || description.length > 500 ||
        !Number.isSafeInteger(priceCop) || priceCop <= 0 ||
        !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 366 ||
        typeof active !== 'boolean' || !modules.length || modules.some(module => !MODULES.has(module)) ||
        (ORDER_DEPENDENTS.some(module => modules.includes(module)) && !modules.includes('orders'))) {
      reject(400, 'invalid_subscription_plan', 'Revisa el nombre, precio, duración y estado del plan.');
    }
    const [workshops, activePlans] = await Promise.all([
      store.list(req.platformUser, true),
      store.listPlans({ activeOnly: true }),
    ]);
    const hasSubscribedWorkshops = workshops.some(workshop =>
      workshop.status === 'ready' && workshop.subscription_required === true);
    const keepsOrdersPlan = (active && modules.includes('orders')) || activePlans.some(plan =>
      plan.id !== id && plan.active === true && Array.isArray(plan.modules) &&
      plan.modules.includes('orders'));
    if (hasSubscribedWorkshops && !keepsOrdersPlan) {
      reject(409, 'subscription_plan_required', 'Mantén al menos un plan activo de Órdenes mientras haya talleres con suscripción requerida.');
    }
    const plan = await store.savePlan(req.platformUser, {
      id, code, name: name.trim(), description: description.trim(), priceCop,
      durationDays, active, modules,
    });
    res.json({ plan: publicPlan(plan) });
  }));

  router.put('/billing/payment-settings', asyncRoute(async (req, res) => {
    admin(req);
    const body = req.body || {};
    const limits = {
      bankName: 100, accountType: 50, accountNumber: 80,
      accountHolder: 120, holderDocument: 40, instructions: 1000,
    };
    for (const [field, limit] of Object.entries(limits)) {
      if (typeof body[field] !== 'string' || body[field].length > limit) {
        reject(400, 'invalid_payment_settings', 'Revisa los datos de la cuenta de transferencia.');
      }
    }
    if (['bankName', 'accountType', 'accountNumber', 'accountHolder']
      .some(field => !body[field].trim())) {
      reject(400, 'invalid_payment_settings', 'Completa el banco, tipo y número de cuenta, y el titular.');
    }
    if (!Number.isInteger(body.reviewGraceHours) || body.reviewGraceHours < 1 || body.reviewGraceHours > 168) {
      reject(400, 'invalid_payment_settings', 'El plazo provisional debe estar entre 1 y 168 horas.');
    }
    const settings = await store.savePaymentSettings(req.platformUser, {
      ...body,
      bankName: body.bankName.trim(),
      accountType: body.accountType.trim(),
      accountNumber: body.accountNumber.trim(),
      accountHolder: body.accountHolder.trim(),
    });
    res.set('Cache-Control', 'no-store');
    res.json({ paymentSettings: publicPaymentSettings(settings) });
  }));

  router.put('/workshops/:id/subscription-required', asyncRoute(async (req, res) => {
    admin(req);
    let { row } = await workshop(req, false);
    if (typeof req.body?.required !== 'boolean') {
      reject(400, 'invalid_subscription_state', 'Indica si este taller debe tener un plan.');
    }
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'subscription_workshop_unavailable', 'La instalación actual no admite todavía este control comercial.');
    }
    if (row.subscription_required === req.body.required) {
      return res.json({ workshop: publicWorkshop(row) });
    }
    if (req.body.required) {
      const [plans, paymentSettings] = await Promise.all([
        store.listPlans({ activeOnly: true }),
        store.getPaymentSettings(),
      ]);
      const hasOrdersPlan = plans.some(plan =>
        plan.active === true && Array.isArray(plan.modules) && plan.modules.includes('orders'));
      if (!hasOrdersPlan || !hasConfiguredPaymentAccount(paymentSettings)) {
        reject(409, 'billing_setup_incomplete', 'Configura un plan activo de Órdenes y los datos de transferencia antes de exigir una suscripción.');
      }
    }
    const connection = await resolveConnection(row.connection_ref, { requireSecrets: true });
    row = await ensureManagedSchema(row, connection);
    let previousAccess = [];
    if (req.body.required) {
      const closed = await reconcileModuleAccess(row, connection, new Set(), null);
      row = closed.row;
      previousAccess = closed.previous;
    }
    let updated;
    try {
      updated = await store.setSubscriptionRequired(row.id, req.body.required);
    } catch (error) {
      if (req.body.required) {
        await restoreModuleAccess(connection, row.id, previousAccess);
      }
      throw error;
    }
    try {
      if (req.body.required) {
        updated = await syncSubscriptionAccess(updated);
      } else {
        updated = await syncUnrestrictedModuleAccess(updated);
      }
    } catch (_) {
      reject(503, 'subscription_reconciliation_required', 'El taller cambió de modalidad, pero falta sincronizar su acceso operativo. Revisa su estado antes de volver a abrirlo.');
    }
    res.json({ workshop: publicWorkshop(updated) });
  }));

  router.get('/workshops/:id/subscription', asyncRoute(async (req, res) => {
    const { row } = await subscriptionManager(req);
    const synchronized = await syncSubscriptionAccess(row);
    const [requests, settings] = await Promise.all([
      store.listSubscriptionRequests({ workshopId: row.id, limit: 20 }),
      store.getPaymentSettings(),
    ]);
    res.json({
      workshop: publicWorkshop(synchronized),
      requests: requests.map(privateRequestView),
      paymentSettings: publicPaymentSettings(settings),
    });
  }));

  router.post('/workshops/:id/subscription-requests', asyncRoute(async (req, res) => {
    const { row } = await subscriptionManager(req);
    const paymentSettings = await store.getPaymentSettings();
    if (!hasConfiguredPaymentAccount(paymentSettings)) {
      reject(409, 'billing_setup_incomplete', 'El administrador global aún no ha completado los datos para recibir transferencias.');
    }
    if (!storage?.from) reject(503, 'receipt_storage_unavailable', 'Los comprobantes no están disponibles por ahora.');
    const requestId = uuid(req.body?.requestId);
    const planId = uuid(req.body?.planId);
    const rawPaymentReference = req.body?.paymentReference;
    if (rawPaymentReference != null && typeof rawPaymentReference !== 'string') {
      reject(400, 'invalid_payment_reference', 'La referencia de transferencia no es válida.');
    }
    const paymentReference = typeof rawPaymentReference === 'string'
      ? rawPaymentReference.trim() : '';
    if ([...paymentReference].length > 120) {
      reject(400, 'invalid_payment_reference', 'La referencia de transferencia no puede superar 120 caracteres.');
    }
    const extension = typeof req.body?.extension === 'string' ? req.body.extension.toLowerCase() : '';
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension)) {
      reject(400, 'invalid_subscription_receipt', 'Adjunta una imagen JPG, PNG o WebP.');
    }
    const receiptPath = `${row.id}/${requestId}.${extension}`;
    const fileName = `${requestId}.${extension}`;
    const receiptBucket = storage.from(RECEIPT_BUCKET);
    const listed = await receiptBucket.list(row.id, { limit: 100, search: fileName });
    const object = (listed.data || []).find(file => file.name === fileName);
    const metadata = object?.metadata || {};
    const size = Number(metadata.size);
    const mime = metadata.mimetype || metadata.contentType;
    if (listed.error || !object || !Number.isFinite(size) || size < 1 || size > RECEIPT_LIMIT ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      reject(400, 'subscription_receipt_not_found', 'No se encontró un comprobante válido. Vuelve a adjuntar la imagen.');
    }
    const downloaded = await receiptBucket.download(receiptPath);
    if (downloaded.error || !downloaded.data ||
        typeof downloaded.data.arrayBuffer !== 'function') {
      reject(503, 'receipt_storage_unavailable', 'No se pudo comprobar el archivo subido. Inténtalo de nuevo.');
    }
    if (downloaded.data.size !== size || downloaded.data.size < 1 ||
        downloaded.data.size > RECEIPT_LIMIT) {
      reject(400, 'invalid_subscription_receipt', 'El comprobante está incompleto o supera el tamaño permitido.');
    }
    const receiptBytes = Buffer.from(await downloaded.data.arrayBuffer());
    if (receiptBytes.length !== size || !validSubscriptionReceiptImage(receiptBytes, extension, mime)) {
      reject(400, 'invalid_subscription_receipt', 'El formato del archivo no coincide con una imagen JPG, PNG o WebP válida.');
    }
    const plans = await store.listPlans({ activeOnly: true });
    if (!plans.some(plan => plan.id === planId)) {
      reject(409, 'subscription_plan_unavailable', 'El plan seleccionado ya no está disponible.');
    }
    const result = await store.submitSubscriptionRequest({
      workshopId: row.id,
      requestId,
      requester: req.platformUser,
      planId,
      receiptPath,
      paymentReference,
    });
    const synchronized = await syncSubscriptionAccess(result.workshop);
    res.status(result.created ? 201 : 200).json({
      request: privateRequestView(result.request),
      workshop: publicWorkshop(synchronized),
      created: result.created,
    });
  }));

  router.get('/subscriptions/review', asyncRoute(async (req, res) => {
    admin(req);
    if (!storage?.from) reject(503, 'receipt_storage_unavailable', 'Los comprobantes no están disponibles por ahora.');
    const requests = await store.listSubscriptionRequests({
      statuses: ['pending', 'reviewing'], limit: 100,
    });
    const reviewed = await Promise.all(requests.map(async request => {
      const signed = await storage.from(RECEIPT_BUCKET).createSignedUrl(request.receipt_path, 300);
      if (signed.error || !signed.data?.signedUrl) {
        reject(503, 'receipt_preview_unavailable', 'No fue posible abrir un comprobante.');
      }
      return { ...privateRequestView(request), receiptUrl: signed.data.signedUrl };
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ requests: reviewed });
  }));

  router.post('/subscriptions/:id/review', asyncRoute(async (req, res) => {
    admin(req);
    const id = uuid(req.params.id);
    const decision = req.body?.decision;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!['approve', 'reject'].includes(decision) || note.length > 1000) {
      reject(400, 'invalid_subscription_decision', 'La decisión o su nota no son válidas.');
    }
    const claimed = await store.claimSubscriptionRequest(id, req.platformUser, decision);
    let previousAccess = [];
    let workshopRow;
    let connection;
    try {
      workshopRow = await store.get(claimed.workshop_id);
      if (!workshopRow || workshopRow.schema_version === 'legacy-existing-v1') {
        reject(409, 'subscription_workshop_unavailable', 'El taller ya no admite este plan.');
      }
      connection = await resolveConnection(workshopRow.connection_ref, { requireSecrets: true });
      const validPaidUntil = workshopRow.paid_until &&
        Date.parse(workshopRow.paid_until) > Date.now()
        ? workshopRow.paid_until : null;
      const decisionExpiry = decision === 'approve'
        ? claimed.active_until : validPaidUntil;
      const paidModules = new Set(workshopRow.paid_modules || []);
      const enabledModules = decision === 'approve'
        ? new Set(claimed.plan_snapshot?.modules || ['orders'])
        : new Set(validPaidUntil
          ? (workshopRow.modules || []).filter(module => paidModules.has(module))
          : []);
      const access = await reconcileModuleAccess(
        workshopRow, connection, enabledModules, decisionExpiry,
      );
      previousAccess = access.previous;
      const finished = await store.finishSubscriptionRequest(id, req.platformUser, decision, note);
      const updatedWorkshop = finished.workshop || await store.get(workshopRow.id);
      const synchronized = await syncSubscriptionAccess(updatedWorkshop);
      res.json({ request: privateRequestView(finished.request), workshop: publicWorkshop(synchronized) });
    } catch (error) {
      const current = await store.getSubscriptionRequest(id).catch(() => null);
      if (decision === 'approve' && current?.status === 'approved') {
        const updatedWorkshop = await store.get(workshopRow.id);
        try {
          const synchronized = await syncSubscriptionAccess(updatedWorkshop);
          return res.json({ request: privateRequestView(current), workshop: publicWorkshop(synchronized) });
        } catch (_) {
          reject(503, 'subscription_reconciliation_required', 'El pago quedó aprobado, pero falta sincronizar el acceso del taller. Actualiza su estado antes de volver a revisarlo.');
        }
      }
      if (decision === 'reject' && current?.status === 'rejected') {
        reject(503, 'subscription_reconciliation_required', 'El rechazo quedó guardado, pero falta cerrar el acceso provisional en la base del taller. Actualiza el estado del taller antes de reabrirlo.');
      }
      if (previousAccess.length &&
          !await restoreModuleAccess(connection, workshopRow.id, previousAccess)) {
        reject(503, 'subscription_reconciliation_required', 'No fue posible confirmar el acceso del taller. Revisa el plan antes de volver a intentarlo.');
      }
      await store.releaseSubscriptionReview(id, req.platformUser).catch(() => null);
      throw error;
    }
  }));

  router.post('/workshops', asyncRoute(async (req, res) => {
    admin(req);
    const key = uuid(req.headers['idempotency-key']);
    const { name, ownerEmail, ownerPassword, project, modules = [] } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
        !Array.isArray(modules) || modules.some(value => !MODULES.has(value))) {
      reject(400, 'invalid_workshop', 'Nombre o módulos inválidos.');
    }
    const email = typeof ownerEmail === 'string' ? ownerEmail.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) reject(400, 'invalid_owner_email', 'Correo del propietario inválido.');
    password(ownerPassword);
    const connection = normalizeConnection({
      projectRef: project?.ref,
      url: project?.url,
      publishableKey: project?.publishableKey,
      serviceRoleKey: project?.serviceRoleKey,
      managementToken: project?.managementToken,
    }, { requireSecrets: true });
    let ownerUserId = await store.ownerByEmail(email, { required: false });
    if (!ownerUserId) {
      const created = await auth.admin.createUser({
        email,
        password: ownerPassword,
        email_confirm: true,
        user_metadata: { full_name: name.trim(), vehicleapp_role: 'workshop_owner' },
      });
      if (created.error || !created.data?.user) {
        reject(503, 'central_owner_creation_failed', 'No fue posible crear el acceso central del propietario.');
      }
      ownerUserId = created.data.user.id;
    }
    const row = await store.register(req.platformUser, key, {
      name: name.trim(), ownerUserId, connectionRef: connection.projectRef,
      // New commercial workshops receive modules only through an approved plan.
      modules: [],
    });
    await store.saveConnection(req.platformUser, row.id, {
      projectRef: connection.projectRef,
      url: connection.url,
      publishableKey: connection.publishableKey,
      serviceRoleSecret: secretBox.seal(connection.serviceRoleKey),
      managementTokenSecret: secretBox.seal(connection.managementToken),
    });
    if (typeof drive?.ensureWorkshopStructure !== 'function') {
      reject(503, 'drive_not_configured', 'No fue posible preparar los documentos del taller.');
    }
    await drive.ensureWorkshopStructure({ id: row.id, name: row.name });
    res.status(201).json({ workshop: publicWorkshop(row) });
  }));

  router.post('/workshops/:id/provision', asyncRoute(async (req, res) => {
    admin(req);
    const { row } = await workshop(req, false);
    if (!['pending', 'failed'].includes(row.status)) {
      if (row.status === 'ready') return res.json({ workshop: publicWorkshop(row) });
      reject(409, 'invalid_state', 'El taller no se puede instalar en este estado.');
    }
    const ownerPassword = password(req.body?.ownerPassword);
    const owner = await auth.admin.getUserById(row.owner_user_id);
    const ownerEmail = owner.data?.user?.email?.toLowerCase();
    if (owner.error || !ownerEmail) reject(503, 'owner_unavailable', 'No fue posible leer al propietario.');
    await store.markConnection(row.id, { status: 'installing', last_error: null });
    try {
      const connection = await resolveConnection(row.connection_ref, { requireSecrets: true });
      const installed = await provisioner.provision({
        connection, workshopId: row.id, ownerEmail, ownerPassword,
      });
      await store.linkMember(row.id, row.owner_user_id, installed.operationalUserId, 'owner');
      const ready = await store.markReady(row.id, installed.schemaVersion);
      await store.markConnection(row.id, {
        status: 'ready', schema_version: installed.schemaVersion, last_error: null,
        last_health_check_at: new Date().toISOString(), provisioned_at: new Date().toISOString(),
      });
      res.json({ workshop: publicWorkshop(ready) });
    } catch (error) {
      await store.markFailed(row.id, error.code || 'provision_failed');
      throw error;
    }
  }));

  router.put('/workshops/:id/connection', asyncRoute(async (req, res) => {
    admin(req);
    const { row } = await workshop(req, false);
    if (!['pending', 'failed'].includes(row.status)) {
      reject(409, 'connection_locked', 'Solo se puede cambiar una conexión antes de habilitar el taller.');
    }
    const connection = normalizeConnection({
      projectRef: req.body?.ref,
      url: req.body?.url,
      publishableKey: req.body?.publishableKey,
      serviceRoleKey: req.body?.serviceRoleKey,
      managementToken: req.body?.managementToken,
    }, { requireSecrets: true });
    if (connection.projectRef !== row.connection_ref) {
      reject(409, 'project_change_rejected', 'La reparación debe conservar el proyecto registrado.');
    }
    await store.saveConnection(req.platformUser, row.id, {
      projectRef: connection.projectRef,
      url: connection.url,
      publishableKey: connection.publishableKey,
      serviceRoleSecret: secretBox.seal(connection.serviceRoleKey),
      managementTokenSecret: secretBox.seal(connection.managementToken),
    });
    res.json({ workshop: publicWorkshop(row), configured: true });
  }));

  async function changeModule(req, res, module) {
    admin(req);
    if (!MODULES.has(module)) reject(404, 'module_not_found', 'El módulo solicitado no está disponible.');
    let { row } = await workshop(req);
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      reject(400, 'invalid_module_state', `Indica si ${MODULE_LABELS[module]} debe estar activo.`);
    }
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'legacy_module_control_unavailable', 'Este taller conserva su instalación actual y todavía no admite cambios de módulos.');
    }
    const connection = await resolveConnection(row.connection_ref, { requireSecrets: true });
    row = await ensureManagedSchema(row, connection);
    if (ORDER_DEPENDENTS.includes(module) && enabled && !(row.modules || []).includes('orders')) {
      reject(409, 'module_dependency', `Activa Órdenes antes de ${MODULE_LABELS[module]}.`);
    }
    if (module === 'orders' && !enabled && ORDER_DEPENDENTS.some(dependent => (row.modules || []).includes(dependent))) {
      reject(409, 'module_dependency', 'Desactiva los módulos dependientes antes de Órdenes.');
    }
    const hasOpenRequest = row.subscription_required
      ? await store.hasOpenSubscriptionRequest(row.id) : false;
    const moduleExpiry = moduleAccessExpiry(row, module, { hasOpenRequest });
    if (enabled && row.subscription_required && !moduleExpiry) {
      reject(403, 'subscription_payment_required', `Aprueba un plan que incluya ${MODULE_LABELS[module]} antes de activarlo.`);
    }
    const previousEnabled = (row.modules || []).includes(module);
    const previousAccess = row.subscription_required
      ? await provisioner.getModuleAccess({ connection, workshopId: row.id, module }) : null;
    await provisioner.setModuleAccess({
      connection, workshopId: row.id, module, enabled,
      expiresAt: row.subscription_required && enabled ? moduleExpiry : null,
    });
    try {
      const updated = await store.setModuleEnabled(row.id, module, enabled);
      res.json({ workshop: publicWorkshop(updated) });
    } catch (error) {
      // A timeout can happen after the central update committed. Read the
      // authoritative row before compensating the operational database.
      let current;
      try {
        current = await store.get(row.id);
      } catch (_) {
        reject(503, 'module_state_reconciliation_required', 'No fue posible confirmar el cambio de módulo. Revisa el estado del taller antes de volver a intentarlo.');
      }
      const currentEnabled = current?.modules?.includes(module);
      if (current?.id !== row.id || typeof currentEnabled !== 'boolean') {
        reject(503, 'module_state_reconciliation_required', 'No fue posible confirmar el cambio de módulo. Revisa el estado del taller antes de volver a intentarlo.');
      }
      if (currentEnabled === enabled) {
        return res.json({ workshop: publicWorkshop(current) });
      }
      if (currentEnabled !== previousEnabled) {
        reject(503, 'module_state_reconciliation_required', 'El módulo cambió durante la operación. Revisa el estado del taller antes de volver a intentarlo.');
      }
      try {
        if (previousAccess) {
          await provisioner.setModuleAccess({
            connection, workshopId: row.id, module,
            enabled: previousAccess.enabled, expiresAt: previousAccess.expiresAt,
          });
        } else {
          await provisioner.setModuleEnabled({
            connection, workshopId: row.id, module, enabled: previousEnabled,
          });
        }
      } catch (_) {
        reject(503, 'module_state_reconciliation_required', 'No fue posible confirmar el cambio de módulo. Revisa el estado del taller antes de volver a intentarlo.');
      }
      throw error;
    }
  }

  router.put('/workshops/:id/modules/orders', asyncRoute(async (req, res) =>
    changeModule(req, res, 'orders')));
  router.put('/workshops/:id/modules/:module', asyncRoute(async (req, res) =>
    changeModule(req, res, req.params.module)));

  router.get('/workshops/:id/connection', asyncRoute(async (req, res) => {
    const { row, membership } = await workshop(req, false);
    const legacyPlatformAdmin = req.platformAdmin && row.schema_version === 'legacy-existing-v1';
    if (!membership && !legacyPlatformAdmin) {
      reject(403, 'membership_required', 'Necesitas una membresía en este taller.');
    }
    if (!['pending', 'failed', 'ready'].includes(row.status)) reject(403, 'workshop_suspended', 'Taller suspendido.');
    const connection = await resolveConnection(row.connection_ref);
    res.json({ workshop: publicWorkshop(row), url: connection.url,
      publishableKey: connection.publishableKey });
  }));

  // Self-link proves possession of both sessions, without copying passwords,
  // generating tokens or letting an admin impersonate an operational user.
  router.post('/workshops/:id/link-session', asyncRoute(async (req, res) => {
    const { row, membership } = await workshop(req, false);
    const legacyPlatformAdmin = req.platformAdmin && row.schema_version === 'legacy-existing-v1';
    if ((!membership && !legacyPlatformAdmin) || row.status === 'suspended') {
      reject(403, 'membership_required', 'Membresía no disponible.');
    }
    const token = bearer(req.headers['x-workshop-authorization']);
    const db = makeClient(await resolveConnection(row.connection_ref), token);
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) reject(401, 'invalid_workshop_session', 'Sesión operativa inválida.');
    const profile = await db.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
    if (profile.error || !['admin', 'empleado'].includes(profile.data?.role)) reject(403, 'profile_required', 'Usuario operativo no autorizado.');
    if (legacyPlatformAdmin && profile.data.role !== 'admin') {
      reject(403, 'workshop_admin_required', 'La cuenta del taller debe tener rol de administrador.');
    }
    // Owner must prove workshop administration. Employee cannot self-upgrade.
    if (membership?.role === 'owner' && profile.data.role !== 'admin') reject(403, 'owner_required', 'El propietario debe ser administrador del taller.');
    if (membership?.operational_user_id && membership.operational_user_id !== data.user.id) reject(409, 'already_linked', 'La membresía ya está vinculada a otro usuario.');
    await store.linkMember(row.id, req.platformUser, data.user.id, legacyPlatformAdmin ? 'admin' : membership.role);
    res.json({ linked: true });
  }));

  async function managedTeam(req) {
    admin(req);
    let { row } = await workshop(req);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'legacy_team_unavailable', 'El equipo del taller actual conserva su administración existente.');
    }
    const connection = await resolveConnection(row.connection_ref, { requireSecrets: true });
    row = await ensureManagedSchema(row, connection);
    return { workshop: row, connection };
  }

  router.get('/workshops/:id/members', asyncRoute(async (req, res) => {
    const context = await managedTeam(req);
    const members = await team.list(context);
    res.set('Cache-Control', 'no-store');
    res.json({ members });
  }));

  router.post('/workshops/:id/members', asyncRoute(async (req, res) => {
    admin(req);
    const key = uuid(req.headers['idempotency-key']);
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    const role = body.role ?? 'employee';
    if (!EMAIL.test(email) || email.length > 254 || fullName.length < 2 || fullName.length > 120
      || !['employee', 'admin'].includes(role)) {
      reject(400, 'invalid_member', 'Revisa el nombre, correo y rol del trabajador.');
    }
    password(body.password);
    const context = await managedTeam(req);
    const member = await team.register({ ...context, actor: req.platformUser, key,
      email, fullName, role, password: body.password });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ member });
  }));

  router.post('/workshops/:id/member-access', asyncRoute(async (req, res) => {
    const { row, membership } = await workshop(req);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'member_link_required', 'Este taller conserva su inicio de sesión operativo.');
    }
    if (!membership) reject(403, 'membership_required', 'No tienes un acceso activo a este taller.');
    const connection = await resolveConnection(row.connection_ref, { requireSecrets: true });
    const currentRow = await ensureManagedSchema(row,connection);
    const entry = await team.enter({ workshop:currentRow,membership,connection });
    // Membership is checked again after the Auth request, before returning tokens.
    const current = await store.membership(req.platformUser, row.id);
    if (!current || current.operational_user_id !== entry.operationalUserId || current.role !== membership.role) {
      reject(403, 'membership_required', 'Tu acceso al taller cambió.');
    }
    res.set('Cache-Control', 'no-store');
    res.json({ workshop: publicWorkshop(currentRow), url: connection.url,
      publishableKey: connection.publishableKey, userId: entry.operationalUserId,
      session: { accessToken: entry.accessToken, refreshToken: entry.refreshToken, expiresAt: entry.expiresAt } });
  }));

  router.put('/workshops/:id/members/:userId', asyncRoute(async (req,res)=>{
    admin(req);
    const userId=uuid(req.params.userId),key=uuid(req.headers['idempotency-key']);
    const {role,active}=req.body||{};
    if (!['employee','admin'].includes(role) || typeof active!=='boolean') reject(400,'invalid_member','Revisa el rol y el estado del acceso.');
    const context=await managedTeam(req);
    const member=await team.change({...context,actor:req.platformUser,key,userId,role,active});
    res.set('Cache-Control','no-store'); res.json({member});
  }));

  // Global administrators enter as their own operational user, not the owner's.
  // The session is minted server-side, so no workshop password is shared.
  router.post('/workshops/:id/admin-access', asyncRoute(async (req, res) => {
    admin(req);
    const { row, membership } = await workshop(req, false);
    if (row.status === 'suspended') reject(403, 'workshop_suspended', 'Taller suspendido.');
    const central = await auth.admin.getUserById(req.platformUser);
    if (central.error || !central.data?.user?.email) {
      reject(503, 'admin_unavailable', 'No fue posible leer tu cuenta central.');
    }
    const connection = await resolveConnection(row.connection_ref, { requireServiceRoleKey: true });
    const entry = await adminAccess.enter({
      connection,
      email: central.data.user.email,
      operationalUserId: membership?.operational_user_id || null,
    });
    await store.linkMember(row.id, req.platformUser, entry.operationalUserId, membership?.role || 'admin');
    res.set('Cache-Control', 'no-store');
    res.json({
      workshop: publicWorkshop(row),
      url: connection.url,
      publishableKey: connection.publishableKey,
      userId: entry.operationalUserId,
      session: {
        accessToken: entry.accessToken,
        refreshToken: entry.refreshToken,
        expiresAt: entry.expiresAt,
      },
    });
  }));

  router.post('/workshops/:id/prepare', asyncRoute(async (req, res) => {
    admin(req);
    const { row, db } = await operational(req, { prepare: true });
    if (row.status === 'ready') return res.json({ workshop: publicWorkshop(row) });
    if (!['pending', 'failed'].includes(row.status)) reject(409, 'invalid_state', 'El taller no se puede preparar en este estado.');
    const { data, error } = await db.rpc('vehicleapp_installation_contract');
    if (error || data?.contract !== 'vehicleapp.orders.v1' || data?.installation_id !== row.id || data?.ready !== true) {
      await store.markFailed(row.id, 'schema_not_verified');
      reject(409, 'schema_not_verified', 'La base no tiene el contrato operativo verificado para este taller.');
    }
    const ready = await store.markReady(row.id, data.schema_version);
    res.json({ workshop: publicWorkshop(ready) });
  }));

  router.get('/workshops/:id/orders', asyncRoute(async (req, res) => {
    const { row, db } = await operational(req);
    if (!publicWorkshop(row).modules.includes('orders')) reject(403, 'module_disabled', 'El módulo de órdenes no está activo en este plan.');
    const { data, error } = await db.from('formatos').select('*, servicios(*), repuestos(*)')
      .is('deleted_at', null).order('created_at', { ascending: false }).limit(50);
    if (error) reject(503, 'orders_unavailable', 'No fue posible consultar las órdenes.');
    res.json({ orders: data });
  }));

  router.post('/workshops/:id/electronic-invoices/preview', asyncRoute(async (req, res) => {
    const { row, db, userId } = await operational(req);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'electronic_invoice_workshop_unavailable', 'Este taller conserva su facturación independiente.');
    }
    const modules = publicWorkshop(row).modules;
    if (!modules.includes('orders') || !modules.includes('electronic_invoices')) {
      reject(403, 'module_disabled', 'El plan debe tener activos Órdenes y Facturación electrónica.');
    }

    const { data: actor, error: actorError } = await db.from('profiles')
      .select('role, is_active, deleted_at').eq('id', userId).maybeSingle();
    if (actorError) reject(503, 'profile_unavailable', 'No fue posible verificar tu perfil del taller.');
    if (!actor || actor.deleted_at || actor.is_active !== true ||
        String(actor.role || '').toLowerCase() !== 'admin') {
      reject(403, 'workshop_admin_required', 'Solo un administrador del taller puede emitir facturas electrónicas.');
    }

    const formatKey = req.body?.formatKey;
    const includeVat = req.body?.incluirIva;
    if (typeof formatKey !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(formatKey) ||
        typeof includeVat !== 'boolean') {
      reject(400, 'invalid_electronic_invoice_request', 'Indica un formato válido y si la factura lleva IVA.');
    }
    const customer = normalizeInvoiceCustomer(req.body?.cliente);

    const savedProfile = await store.getFacturatechProfile(row.id);
    if (!savedProfile?.configuration_ciphertext) {
      reject(409, 'facturatech_profile_required', 'Configura el emisor y la numeración demo de este taller antes de emitir.');
    }
    let fiscalProfile;
    try {
      fiscalProfile = parseStoredFacturatechProfile(secretBox.open(savedProfile.configuration_ciphertext));
    } catch (_) {
      reject(503, 'facturatech_profile_unavailable', 'No fue posible recuperar el perfil fiscal del taller.');
    }
    if (fiscalProfile.environment !== 'demo') {
      reject(409, 'facturatech_environment_locked', 'La emisión gestionada está limitada al ambiente demo.');
    }

    const { data: format, error: formatError } = await db.from('formatos')
      .select('clave_key, folio, fecha_entrada, nombre_cliente, placa, marca, modelo, costo_mano_obra, costo_total')
      .eq('clave_key', formatKey).is('deleted_at', null).maybeSingle();
    if (formatError) reject(503, 'format_unavailable', 'No fue posible consultar la orden del taller.');
    if (!format) reject(404, 'format_not_found', 'La orden no está disponible en este taller.');

    const [partsResult, servicesResult] = await Promise.all([
      db.from('repuestos').select('id, descripcion, cantidad, costo_unitario, created_at')
        .eq('id_repuesto', format.folio).is('deleted_at', null).order('created_at', {ascending: true}),
      db.from('servicios').select('servicio, precio_mano_obra, created_at')
        .eq('formato_folio', format.folio).is('deleted_at', null).order('created_at', {ascending: true}),
    ]);
    if (partsResult.error || servicesResult.error) {
      reject(503, 'format_details_unavailable', 'No fue posible consultar los valores de la orden.');
    }
    const parts = partsResult.data || [];
    const labor = Number(format.costo_mano_obra || 0);
    if (!Number.isFinite(labor) || labor < 0 ||
        parts.some(item => !Number.isInteger(Number(item.cantidad)) || Number(item.cantidad) < 1 ||
          !Number.isFinite(Number(item.costo_unitario)) || Number(item.costo_unitario) < 0 ||
          typeof item.descripcion !== 'string' || !item.descripcion.trim())) {
      reject(409, 'invoice_prices_invalid', 'Revisa los precios, cantidades y descripciones de la orden antes de emitir.');
    }

    const ivaRate = includeVat ? 19 : 0;
    const items = parts.map((item, index) => ({
      codigo: String(item.id || `ITEM${index + 1}`),
      descripcion: item.descripcion.trim(),
      cantidad: Number(item.cantidad),
      precioUnitario: Number(item.costo_unitario),
      porcentajeIva: ivaRate,
    }));
    if (labor > 0) items.push({
      codigo: 'MO001', descripcion: 'Mano de obra', cantidad: 1,
      precioUnitario: labor, porcentajeIva: ivaRate,
    });
    if (!items.length) reject(409, 'invoice_items_required', 'La orden no tiene servicios ni repuestos valorizados.');

    const source = {
      formatKey,
      order: {folio: format.folio, labor},
      parts: parts.map(item => [item.id, item.descripcion, Number(item.cantidad), Number(item.costo_unitario)]),
      services: (servicesResult.data || []).map(item => [item.servicio, item.precio_mano_obra]),
    };
    const sourceFingerprint = invoiceFingerprint(source);
    const profileFingerprint = invoiceFingerprint({
      environment: fiscalProfile.environment,
      issuer: fiscalProfile.issuer,
      numbering: fiscalProfile.numbering,
      credentials: fiscalProfile.credentials,
    });
    const requestFingerprint = invoiceFingerprint({
      sourceFingerprint, profileFingerprint, customer, includeVat,
    });
    const idempotencyKey = `invoice-${formatKey}`;

    const facturatech = facturatechServiceFactory(fiscalProfile);
    const totals = facturatech.calcularTotales(items, ivaRate);
    const reservation = await store.reserveFacturatechNumber(row.id, {
      idempotencyKey, sourceFingerprint, requestFingerprint,
      numbering: fiscalProfile.numbering,
    });
    if (!Number.isSafeInteger(Number(reservation?.number)) || Number(reservation.number) < 1) {
      reject(503, 'facturatech_reservation_unavailable', 'No fue posible reservar de forma segura el número fiscal.');
    }
    const invoiceNumber = Number(reservation.number);
    const layout = facturatech.generarXmlLayout(
      customer, items, totals, invoiceNumber, `Orden: ${format.folio || formatKey}`,
    );
    const claim = await store.claimFacturatechSubmission(row.id, {
      idempotencyKey, requestFingerprint,
    });

    let transactionId = claim.transactionId || null;
    if (!claim.claimed) {
      if (claim.state !== 'submitted' || !transactionId) {
        reject(409, 'facturatech_reconciliation_required', 'Esta orden ya inició una emisión. Consulta su estado antes de volver a intentarlo.');
      }
      const existing = await db.from('facturas_electronicas').select('*')
        .eq('transaction_id', transactionId).maybeSingle();
      if (existing.error) reject(503, 'electronic_invoice_unavailable', 'La emisión existe, pero no fue posible recuperar su registro.');
      if (existing.data) {
        res.set('Cache-Control', 'no-store');
        return res.json({success: true, data: {
          transactionId,
          numeroFactura: `${reservation.prefix}${invoiceNumber}`,
          pdfUrl: existing.data.pdf_url,
          status: existing.data.estado?.toLowerCase() || 'procesando',
          totales: {baseGravable: Number(existing.data.base_gravable), iva: Number(existing.data.iva), total: Number(existing.data.total)},
          facturaId: existing.data.id,
        }});
      }
      // The provider accepted the document but the first operational insert
      // failed. The exact same request can recover that row without resubmitting.
    } else {
      let upload;
      try {
        upload = await facturatech.uploadInvoiceFileLayout(layout);
      } catch (_) {
        await store.recordFacturatechSubmission(row.id, {
          idempotencyKey, requestFingerprint, state: 'uncertain',
        });
        reject(503, 'facturatech_reconciliation_required', 'Facturatech no confirmó el resultado. El número quedó reservado y requiere conciliación; no vuelvas a emitir la orden.');
      }
      if (!upload?.success || !upload.transactionId) {
        const uncertain = upload?.ambiguous === true;
        await store.recordFacturatechSubmission(row.id, {
          idempotencyKey, requestFingerprint,
          state: uncertain ? 'uncertain' : 'rejected',
          transactionId: upload?.transactionId,
          providerStatus: facturatechProviderStatus(upload?.code),
        });
        if (uncertain) {
          reject(503, 'facturatech_reconciliation_required', 'Facturatech pudo recibir la factura, pero no confirmó el resultado. El número quedó reservado; no vuelvas a emitir la orden.');
        }
        reject(502, 'facturatech_rejected', 'Facturatech rechazó la factura demo. Revisa los datos fiscales y el contenido de la orden.');
      }
      transactionId = upload.transactionId;
      await store.recordFacturatechSubmission(row.id, {
        idempotencyKey, requestFingerprint, state: 'submitted',
        transactionId, providerStatus: facturatechProviderStatus(upload.code),
      });
    }

    const inserted = await db.from('facturas_electronicas').insert({
      id_formato: format.clave_key,
      transaction_id: transactionId,
      prefijo: reservation.prefix,
      numero_factura: String(invoiceNumber),
      estado: 'PREVIEW',
      adq_tipo_doc: customer.tipoDocumento,
      adq_numero_doc: customer.numeroDocumento,
      adq_razon_social: customer.razonSocial,
      adq_direccion: customer.direccion,
      adq_ciudad: customer.ciudad,
      adq_email: customer.email || null,
      adq_tipo_persona: customer.tipoPersona,
      base_gravable: totals.baseGravable,
      iva: totals.iva,
      total: totals.total,
      response_code: '201',
      response_message: 'Recibida en el ambiente demo.',
    }).select('id, transaction_id, prefijo, numero_factura, pdf_url, estado, base_gravable, iva, total').single();
    if (inserted.error || !inserted.data) {
      reject(503, 'electronic_invoice_persistence_required', 'Facturatech recibió la factura demo, pero falta guardar su registro en este taller. No vuelvas a emitir la orden; reintenta para recuperar el mismo envío.');
    }
    res.set('Cache-Control', 'no-store');
    res.json({success: true, message: 'Factura recibida en el ambiente demo.', data: {
      transactionId: inserted.data.transaction_id,
      numeroFactura: `${inserted.data.prefijo}${inserted.data.numero_factura}`,
      pdfUrl: inserted.data.pdf_url,
      status: 'procesando',
      totales: {baseGravable: totals.baseGravable, iva: totals.iva, total: totals.total},
      facturaId: inserted.data.id,
    }});
  }));

  async function refreshWorkshopElectronicInvoice(req, res) {
    const {row, db} = await operational(req);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'electronic_invoice_workshop_unavailable', 'Este taller conserva su facturación independiente.');
    }
    const modules = publicWorkshop(row).modules;
    if (!modules.includes('orders') || !modules.includes('electronic_invoices')) {
      reject(403, 'module_disabled', 'El plan debe tener activos Órdenes y Facturación electrónica.');
    }
    const transactionId = req.params.transactionId;
    if (typeof transactionId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(transactionId)) {
      reject(400, 'invalid_transaction_id', 'El identificador de transacción no es válido.');
    }
    const reservation = await store.facturatechReservationByTransaction(row.id, transactionId);
    if (!reservation) reject(404, 'electronic_invoice_not_found', 'La factura no existe en este taller.');
    if (!['submitted', 'uncertain', 'validated'].includes(reservation.submission_state)) {
      reject(409, 'facturatech_reconciliation_required', 'La emisión todavía requiere conciliación.');
    }
    const {data: invoice, error: invoiceError} = await db.from('facturas_electronicas')
      .select('*').eq('transaction_id', transactionId).maybeSingle();
    if (invoiceError) reject(503, 'electronic_invoice_unavailable', 'No fue posible consultar la factura de este taller.');
    if (!invoice) reject(409, 'electronic_invoice_persistence_required', 'La emisión fue aceptada, pero su registro del taller requiere recuperación.');

    const savedProfile = await store.getFacturatechProfile(row.id);
    if (!savedProfile?.configuration_ciphertext) {
      reject(409, 'facturatech_profile_required', 'El perfil demo del taller ya no está disponible.');
    }
    let fiscalProfile;
    try {
      fiscalProfile = parseStoredFacturatechProfile(secretBox.open(savedProfile.configuration_ciphertext));
    } catch (_) {
      reject(503, 'facturatech_profile_unavailable', 'No fue posible recuperar el perfil fiscal del taller.');
    }
    const facturatech = facturatechServiceFactory(fiscalProfile);
    let statusResult;
    try {
      statusResult = await facturatech.documentStatusFile(transactionId);
    } catch (_) {
      reject(503, 'facturatech_status_unavailable', 'Facturatech no respondió la consulta. Puedes volver a consultar sin emitir otra factura.');
    }
    if (!statusResult?.success) {
      reject(502, 'facturatech_status_unavailable', 'Facturatech no confirmó el estado. Puedes volver a consultar sin emitir otra factura.');
    }

    let cufe = invoice.cufe || null;
    if (!cufe) {
      try {
        const result = await facturatech.getCUFEFile(invoice.prefijo, invoice.numero_factura);
        if (result?.success && typeof result.cufe === 'string') cufe = result.cufe;
      } catch (_) {
        // CUFE may not exist until the provider finishes validation.
      }
    }
    const state = cufe ? 'VALIDADA' : 'PROCESANDO';
    const providerStatus = facturatechProviderStatus(statusResult.status);
    const expectedPdfPrefix = `/api/platform/workshops/${row.id}/electronic-invoices/${encodeURIComponent(transactionId)}/pdf/`;
    const storedPdfId = typeof invoice.pdf_url === 'string' && invoice.pdf_url.startsWith(expectedPdfPrefix)
      ? invoice.pdf_url.slice(expectedPdfPrefix.length)
      : '';
    let pdfUrl = /^[A-Za-z0-9_-]{5,200}$/.test(storedPdfId) ? invoice.pdf_url : null;
    if (cufe && !pdfUrl) {
      pdfUrl = await archiveWorkshopElectronicInvoicePdf({drive, row, invoice, facturatech});
    }
    const update = await db.from('facturas_electronicas').update({
      estado: state,
      cufe,
      pdf_url: pdfUrl,
      response_code: facturatechProviderStatus(statusResult.status, 10),
      response_message: cufe
        ? 'Validada en el ambiente demo.'
        : 'En procesamiento en el ambiente demo.',
      fecha_validacion: cufe ? new Date().toISOString() : null,
    }).eq('id', invoice.id).select('*').single();
    if (update.error || !update.data) {
      reject(503, 'electronic_invoice_unavailable', 'Se consultó el estado, pero no fue posible actualizarlo en este taller.');
    }
    if (cufe) {
      await store.recordFacturatechSubmission(row.id, {
        idempotencyKey: reservation.idempotency_key,
        requestFingerprint: reservation.request_fingerprint,
        state: 'validated', transactionId,
        providerStatus: providerStatus || 'VALIDATED',
      });
    }
    res.set('Cache-Control', 'no-store');
    res.json({success: true, data: {
      id: update.data.id,
      transactionId,
      numeroFactura: `${invoice.prefijo}${invoice.numero_factura}`,
      cufe,
      pdfUrl: update.data.pdf_url || null,
      estado: state,
      totales: {
        baseGravable: Number(update.data.base_gravable || 0),
        iva: Number(update.data.iva || 0),
        total: Number(update.data.total || 0),
      },
    }});
  }

  router.post('/workshops/:id/electronic-invoices/:transactionId/confirm', asyncRoute(refreshWorkshopElectronicInvoice));
  router.get('/workshops/:id/electronic-invoices/:transactionId/status', asyncRoute(refreshWorkshopElectronicInvoice));

  router.get('/workshops/:id/electronic-invoices/:transactionId/pdf/:fileId', asyncRoute(async (req, res) => {
    const {row, db} = await operational(req);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'electronic_invoice_workshop_unavailable', 'Este taller conserva su facturación independiente.');
    }
    const modules = publicWorkshop(row).modules;
    if (!modules.includes('orders') || !modules.includes('electronic_invoices')) {
      reject(403, 'module_disabled', 'El plan debe tener activos Órdenes y Facturación electrónica.');
    }
    const transactionId = req.params.transactionId;
    const fileId = req.params.fileId;
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(transactionId) ||
        !/^[A-Za-z0-9_-]{5,200}$/.test(fileId)) {
      reject(400, 'invalid_electronic_invoice_file', 'La ruta del PDF no es válida.');
    }
    if (typeof drive?.fileAppProperties !== 'function' ||
        typeof drive?.downloadPrivateFile !== 'function') {
      reject(503, 'electronic_invoice_pdf_unavailable', 'No fue posible recuperar el PDF privado.');
    }
    const {data: invoice, error} = await db.from('facturas_electronicas')
      .select('id, transaction_id, pdf_url, estado, cufe')
      .eq('transaction_id', transactionId).maybeSingle();
    if (error) reject(503, 'electronic_invoice_unavailable', 'No fue posible consultar la factura de este taller.');
    if (!invoice || invoice.estado !== 'VALIDADA' || !invoice.cufe) {
      reject(404, 'electronic_invoice_not_found', 'La factura validada no está disponible en este taller.');
    }
    const expectedPdfUrl = `/api/platform/workshops/${row.id}/electronic-invoices/${encodeURIComponent(transactionId)}/pdf/${encodeURIComponent(fileId)}`;
    if (invoice.pdf_url !== expectedPdfUrl) {
      reject(404, 'electronic_invoice_pdf_not_found', 'El PDF no está asociado a esta factura del taller.');
    }
    const properties = await drive.fileAppProperties(fileId);
    if (properties.vehicleAppWorkshop !== row.id ||
        properties.vehicleAppDocument !== 'electronic_invoice' ||
        properties.vehicleAppInvoice !== String(invoice.id)) {
      reject(403, 'file_not_owned', 'El PDF no pertenece a esta factura del taller.');
    }
    const file = await drive.downloadPrivateFile(fileId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="factura-electronica.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return file.data.pipe(res);
  }));

  router.post('/workshops/:id/documents/customer-quote', asyncRoute(async (req, res) => {
    const { row, db, userId } = await operational(req);
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'document_generation_unavailable', 'Este taller aún usa la generación de documentos anterior.');
    }
    if (!publicWorkshop(row).modules.includes('orders')) {
      reject(403, 'module_disabled', 'El módulo de órdenes no está activo en este plan.');
    }
    const formatKey = req.body?.formatKey;
    if (typeof formatKey !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(formatKey)) {
      reject(400, 'invalid_format_key', 'El folio del formato no es válido.');
    }
    const { data: actor, error: actorError } = await db.from('profiles')
      .select('role, is_active, deleted_at').eq('id', userId).maybeSingle();
    if (actorError) reject(503, 'profile_unavailable', 'No fue posible verificar tu perfil del taller.');
    if (!actor || actor.deleted_at || actor.is_active === false || String(actor.role || '').toLowerCase() !== 'admin') {
      reject(403, 'workshop_admin_required', 'Solo un administrador del taller puede generar una cotización.');
    }

    const { data: format, error: formatError } = await db.from('formatos')
      .select('clave_key, folio, fecha_entrada, nombre_cliente, telefono_contacto, placa, marca, tipo_vehiculo, modelo, kilometraje, observaciones, costo_mano_obra, costo_total')
      .eq('clave_key', formatKey).is('deleted_at', null).maybeSingle();
    if (formatError) reject(503, 'format_unavailable', 'No fue posible consultar el formato del taller.');
    if (!format) reject(404, 'format_not_found', 'El formato no está disponible en este taller.');

    const [partsResult, servicesResult] = await Promise.all([
      db.from('repuestos').select('descripcion, cantidad, costo_unitario, costo_total_linea, created_at')
        .eq('id_repuesto', format.folio).is('deleted_at', null).order('created_at', { ascending: true }),
      db.from('servicios').select('servicio, precio_mano_obra, created_at')
        .eq('formato_folio', format.folio).is('deleted_at', null).order('created_at', { ascending: true }),
    ]);
    if (partsResult.error || servicesResult.error) {
      reject(503, 'format_details_unavailable', 'No fue posible consultar los servicios y repuestos del formato.');
    }

    const hasMissingPrice = value => value == null || value === '' ||
      !Number.isFinite(Number(value)) || Number(value) < 0;
    if ((partsResult.data || []).some(item => hasMissingPrice(item.costo_unitario)) ||
        (servicesResult.data || []).some(item => hasMissingPrice(item.precio_mano_obra))) {
      reject(409, 'quote_prices_pending', 'Completa el precio de los servicios y repuestos antes de generar la cotización.');
    }

    let document;
    try {
      document = await quoteGenerator({
        workshop: { id: row.id, name: row.name },
        profile: normalizeDocumentProfile(row.document_profile, row.name),
        format,
        repuestos: partsResult.data || [],
        servicios: servicesResult.data || [],
        drive,
      });
    } catch (error) {
      console.error('[Platform quote] PDF generation failed:', error?.code || error?.name || 'error');
      reject(502, 'quote_generation_failed', 'No fue posible generar y guardar la cotización. Inténtalo nuevamente.');
    }
    const expectedPath = new RegExp(`^/api/platform/workshops/${row.id}/drive/files/[A-Za-z0-9_-]{5,200}$`);
    if (!document || typeof document.filePath !== 'string' || !expectedPath.test(document.filePath)) {
      reject(502, 'quote_file_invalid', 'La cotización no quedó guardada en el taller.');
    }
    const { error: attachError } = await db.rpc('adjuntar_factura_pdf_v2', {
      p_id_formato: format.clave_key,
      p_factura_pdf: document.filePath,
    });
    if (attachError) reject(409, 'quote_attach_failed', 'El PDF se generó, pero no pudo vincularse al formato.');
    res.set('Cache-Control', 'no-store');
    res.json({ invoiceUrl: document.filePath, fileId: document.fileId });
  }));

  router.post('/workshops/:id/mutations', asyncRoute(async (req, res) => {
    const { row, db } = await operational(req);
    if (!publicWorkshop(row).modules.includes('orders')) {
      return res.json({
        status: 'deferred',
        message: 'Órdenes está pausado. El cambio sigue guardado y se sincronizará al reactivarlo.',
      });
    }
    const { operationId, kind, entityKey, payload } = req.body || {};
    uuid(operationId);
    if (!['format.create', 'servicio.create', 'repuesto.create'].includes(kind) ||
        typeof entityKey !== 'string' || !entityKey || entityKey.length > 240 ||
        !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      reject(400, 'invalid_mutation', 'Operación no admitida en esta etapa.');
    }
    const { data, error } = await db.rpc('apply_offline_mutation', {
      p_operation_id: operationId, p_kind: kind, p_entity_key: entityKey, p_payload: payload,
    });
    if (error) reject(409, 'mutation_rejected', 'La base rechazó la operación.');
    res.json(data);
  }));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const expected = error instanceof PlatformError;
    res.status(expected ? error.status : 503).json({
      code: expected ? error.code : 'platform_unavailable',
      error: expected ? error.message : 'La plataforma no está disponible.',
    });
  });
  return router;
}

module.exports = { createPlatformRouter, publicWorkshop, validSubscriptionReceiptImage };
