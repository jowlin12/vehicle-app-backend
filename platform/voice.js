'use strict';

const express = require('express');
const { PlatformError, reject } = require('./errors');
const { createWorkshopOperationalAccess } = require('./operational-access');
const { publicWorkshop } = require('./router');
const { CAMPOS, proveedoresDisponibles } = require('../voz-extraer');

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const LIMITS = { marcas: 60, tipos_vehiculo: 40, servicios_frecuentes: 25 };

function texts(value, limit, maxLength = 160) {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string')
    .map(item => item.trim()).filter(item => item.length > 0 && item.length <= maxLength))].slice(0, limit) : [];
}

function voiceInput(body) {
  const text = typeof body?.transcripcion === 'string' ? body.transcripcion.trim() : '';
  if (!text || text.length > 2000) reject(400, 'invalid_transcription', 'Dicta una frase de hasta 2000 caracteres.');
  const filled = {};
  let remaining = 3000;
  for (const field of CAMPOS) {
    const value = body?.ya_lleno?.[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const max = ['trabajos', 'observaciones'].includes(field) ? 1000 : 200;
    const bounded = value.trim().slice(0, Math.min(max, remaining));
    if (bounded) filled[field] = bounded;
    remaining -= bounded.length;
  }
  return { transcripcion: text, ya_lleno: filled,
    faltantes: texts(body?.faltantes, 12).map(name => name === 'tipoVehiculo' ? 'tipo_vehiculo' : name)
      .filter(name => CAMPOS.includes(name)) };
}

// Verify the client's current choices against the selected workshop using RLS.
async function workshopCatalog(db, requested = {}, signal) {
  let typeBrands = [];
  async function list(table, column, key) {
    const wanted = texts(requested[key], LIMITS[key]);
    let query = db.from(table).select(table === 'tipos_vehiculo' ? 'nombre_tipo,marca_nombre' : column);
    if (wanted.length) query = query.in(column, wanted);
    if (table === 'servicios') query = query.is('deleted_at', null);
    if (signal) query = query.abortSignal(signal);
    const result = await query.order(column).limit(table === 'servicios' ? 100 : LIMITS[key]);
    if (result.error || !Array.isArray(result.data)) {
      reject(503, 'voice_catalog_unavailable', 'No fue posible consultar el catálogo del taller.');
    }
    if (table === 'tipos_vehiculo') typeBrands = result.data.map(row => ({
      type: row.nombre_tipo, brand: row.marca_nombre,
    }));
    return texts(result.data.map(row => row[column]), LIMITS[key]);
  }
  const [brands, types, services] = await Promise.all([
    list('marcas', 'nombre', 'marcas'), list('tipos_vehiculo', 'nombre_tipo', 'tipos_vehiculo'),
    list('servicios', 'servicio', 'servicios_frecuentes'),
  ]);
  return { marcas: brands, tipos_vehiculo: types, servicios_frecuentes: services, typeBrands };
}

function safeVoiceResult(output, catalog, currentBrand) {
  if (!output || typeof output !== 'object' || !output.campos || typeof output.campos !== 'object' ||
      Array.isArray(output.campos) || !Array.isArray(output.servicios) || !Array.isArray(output.confianza_baja)) {
    throw new Error('Invalid voice output');
  }
  const fields = {};
  for (const field of CAMPOS) {
    const value = output.campos[field];
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) continue;
    fields[field] = value.trim();
  }
  if (!catalog.marcas.includes(fields.marca)) delete fields.marca;
  if (!catalog.tipos_vehiculo.includes(fields.tipo_vehiculo)) delete fields.tipo_vehiculo;
  const brand = fields.marca || currentBrand;
  if (brand && fields.tipo_vehiculo && !catalog.typeBrands?.some(row =>
    row.type === fields.tipo_vehiculo && row.brand === brand)) delete fields.tipo_vehiculo;
  return { campos: fields,
    servicios: texts(output.servicios, 25).filter(name => catalog.servicios_frecuentes.includes(name)),
    confianza_baja: texts(output.confianza_baja, 12).filter(name => Object.hasOwn(fields, name)),
  };
}

async function extractVoice(input, catalog, providers, signal) {
  for (const provider of providers) {
    signal.throwIfAborted();
    try {
      const result = await provider.extraer({ ...input, catalogo: {
        marcas: catalog.marcas, tipos_vehiculo: catalog.tipos_vehiculo,
        servicios_frecuentes: catalog.servicios_frecuentes,
      } }, { signal });
      signal.throwIfAborted();
      return safeVoiceResult(result.salida, catalog, input.ya_lleno?.marca);
    } catch (_) {
      // Provider errors may include the prompt or credentials. Do not log them.
      signal.throwIfAborted();
    }
  }
  reject(502, 'voice_provider_unavailable', 'El dictado remoto no respondió. Puedes seguir con el reconocimiento local.');
}

function createWorkshopVoiceRouter({ store, resolveConnection, makeClient,
  providers = proveedoresDisponibles, timeoutMs = 9000 }) {
  const operational = createWorkshopOperationalAccess({ store, resolveConnection, makeClient });
  const router = express.Router();
  function requireOrders(row) {
    if (row.schema_version === 'legacy-existing-v1') {
      reject(409, 'legacy_voice_endpoint', 'El taller actual conserva su dictado existente.');
    }
    if (!publicWorkshop(row).modules.includes('orders')) {
      reject(403, 'module_disabled', 'El módulo de órdenes no está activo en este plan.');
    }
  }
  router.post('/workshops/:id/voz/extraer-formato', express.json({ limit: '32kb' }), asyncRoute(async (req, res) => {
    const { row, db } = await operational(req);
    requireOrders(row);
    const input = voiceInput(req.body);
    const available = providers();
    if (!available.length) reject(503, 'voice_not_configured', 'Dictado remoto no configurado. Puedes usar el reconocimiento local.');
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once('close', disconnected);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const catalog = await workshopCatalog(db, req.body?.catalogo, signal);
      const result = await extractVoice(input, catalog, available, signal);
      // A pending change or expired plan must not return data after revocation.
      requireOrders((await operational(req)).row);
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } finally {
      res.off('close', disconnected);
    }
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const expected = error instanceof PlatformError;
    res.status(expected ? error.status : 503).json({
      code: expected ? error.code : 'voice_unavailable',
      error: expected ? error.message : 'No fue posible interpretar el dictado. Puedes continuar con el reconocimiento local.',
    });
  });
  return router;
}

module.exports = { createWorkshopVoiceRouter, voiceInput, workshopCatalog, safeVoiceResult, extractVoice };
