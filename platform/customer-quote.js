'use strict';

const {createHash} = require('node:crypto');
const axios = require('axios');
const Handlebars = require('handlebars');
const {workshopFileName} = require('../drive-service');

const CONVERTER_URL = 'https://api-pdf-to-html-vercel.vercel.app/api/convert/html-to-pdf';
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const GOOGLE_FILE_HOSTS = new Set([
  'drive.google.com',
  'drive.usercontent.google.com',
  'drive.googleusercontent.com',
]);

const TEMPLATE = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cotización {{format.claveKey}}</title>
  <style>
    @page { size: A4; margin: 18mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #20242c; font: 14px Arial, sans-serif; }
    .sheet { width: 100%; }
    .header { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 22px; border-bottom: 3px solid #3157d5; }
    h1 { margin: 0 0 5px; font-size: 28px; }
    h2 { margin: 0 0 6px; font-size: 18px; }
    p { margin: 4px 0; }
    .muted { color: #626b78; }
    .issuer { max-width: 52%; text-align: right; overflow-wrap: anywhere; }
    .metadata { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 22px 0; }
    .label { margin-bottom: 5px; color: #626b78; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    .items { width: 100%; border-collapse: collapse; }
    .items th { padding: 10px 8px; background: #f0f3fb; text-align: left; }
    .items td { padding: 10px 8px; border-bottom: 1px solid #e1e5ec; vertical-align: top; }
    .number { text-align: right !important; white-space: nowrap; }
    .totals { width: min(320px, 100%); margin: 18px 0 0 auto; }
    .total-row { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; }
    .grand-total { margin-top: 5px; padding-top: 12px; border-top: 2px solid #20242c; font-size: 18px; font-weight: 700; }
    .notes { margin-top: 24px; white-space: pre-line; overflow-wrap: anywhere; }
    .footer { margin-top: 28px; padding-top: 14px; border-top: 1px solid #d5dae2; color: #626b78; text-align: center; white-space: pre-line; }
    .compact .header { padding-bottom: 12px; }
    .compact .metadata { padding: 14px 0; }
    .compact .items th, .compact .items td { padding: 7px 6px; }
    .compact .footer { margin-top: 18px; }
  </style>
</head>
<body>
  <main class="sheet {{templateClass}}">
    <header class="header">
      <div><h1>Cotización</h1><div class="muted">Folio {{format.claveKey}}</div></div>
      <div class="issuer">
        <h2>{{issuer.name}}</h2>
        {{#if issuer.taxId}}<p>NIT / identificación: {{issuer.taxId}}</p>{{/if}}
        {{#if issuer.address}}<p>{{issuer.address}}</p>{{/if}}
        {{#if issuer.city}}<p>{{issuer.city}}</p>{{/if}}
        {{#if issuer.phone}}<p>{{issuer.phone}}</p>{{/if}}
        {{#if issuer.email}}<p>{{issuer.email}}</p>{{/if}}
      </div>
    </header>
    <section class="metadata">
      <div><div class="label">Cliente</div><strong>{{customer.name}}</strong>
        {{#if customer.phone}}<p>{{customer.phone}}</p>{{/if}}
      </div>
      <div><div class="label">Vehículo</div><strong>{{vehicle.label}}</strong>
        {{#if vehicle.plate}}<p>Placa: {{vehicle.plate}}</p>{{/if}}
        {{#if vehicle.mileage}}<p>Kilometraje: {{vehicle.mileage}} km</p>{{/if}}
        <p class="muted">Emitido: {{format.entryDate}}</p>
      </div>
    </section>
    <table class="items">
      <thead><tr><th>Descripción</th><th class="number">Cant.</th><th class="number">Vlr. unitario</th><th class="number">Total</th></tr></thead>
      <tbody>{{#each items}}
        <tr><td>{{description}}</td><td class="number">{{quantity}}</td><td class="number">{{unitPriceFormatted}}</td><td class="number">{{lineTotalFormatted}}</td></tr>
      {{/each}}</tbody>
    </table>
    <section class="totals">
      <div class="total-row"><span>Repuestos</span><strong>{{totals.partsFormatted}}</strong></div>
      <div class="total-row"><span>Mano de obra</span><strong>{{totals.laborFormatted}}</strong></div>
      <div class="total-row grand-total"><span>Total</span><strong>{{totals.totalFormatted}}</strong></div>
    </section>
    {{#if format.observations}}<section class="notes"><div class="label">Observaciones</div><p>{{format.observations}}</p></section>{{/if}}
    {{#if issuer.paymentInstructions}}<section class="notes"><div class="label">Medios de pago</div><p>{{issuer.paymentInstructions}}</p></section>{{/if}}
    <footer class="footer">{{issuer.thankYouMessage}}</footer>
  </main>
</body>
</html>`;

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function amount(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function currency(value) {
  return `$ ${Math.round(value).toLocaleString('es-CO')}`;
}

function normalizeItems(repuestos, servicios) {
  const parts = (Array.isArray(repuestos) ? repuestos : [])
    .filter(row => text(row?.descripcion))
    .map(row => {
      const quantity = Math.max(0, Math.floor(amount(row.cantidad, 0)));
      const unitPrice = amount(row.costo_unitario);
      return {description: text(row.descripcion), quantity, unitPrice, lineTotal: quantity * unitPrice};
    })
    .filter(row => row.quantity > 0);
  const serviceItems = (Array.isArray(servicios) ? servicios : [])
    .filter(row => text(row?.servicio))
    .map(row => {
      const unitPrice = amount(row.precio_mano_obra);
      return {description: text(row.servicio), quantity: 1, unitPrice, lineTotal: unitPrice};
    });
  return [...parts, ...serviceItems];
}

function renderCustomerQuoteHtml({workshop, profile, format, repuestos, servicios}) {
  if (!workshop?.id || !text(format?.clave_key)) {
    throw new Error('Faltan datos del taller o del formato para generar la cotización.');
  }
  const items = normalizeItems(repuestos, servicios).map(item => ({
    ...item,
    unitPriceFormatted: currency(item.unitPrice),
    lineTotalFormatted: currency(item.lineTotal),
  }));
  const partsTotal = (Array.isArray(repuestos) ? repuestos : []).reduce((total, row) => {
    if (!text(row?.descripcion)) return total;
    const quantity = Math.max(0, Math.floor(amount(row.cantidad, 0)));
    return total + quantity * amount(row.costo_unitario);
  }, 0);
  const laborTotal = amount(format.costo_mano_obra);
  const total = amount(format.costo_total, partsTotal + laborTotal);
  const templateKey = profile?.templateKey === 'compact-v1' ? 'compact' : 'standard';
  const template = Handlebars.compile(TEMPLATE, {noEscape: false});

  return template({
    templateClass: templateKey === 'compact' ? 'compact' : '',
    issuer: {
      name: text(profile?.issuerName, text(workshop.name, 'Taller')),
      taxId: text(profile?.taxId),
      address: text(profile?.address),
      city: text(profile?.city),
      phone: text(profile?.phone),
      email: text(profile?.email),
      paymentInstructions: text(profile?.paymentInstructions),
      thankYouMessage: text(profile?.thankYouMessage, 'Gracias por confiar en nuestro taller.'),
    },
    customer: {
      name: text(format.nombre_cliente, 'Cliente'),
      phone: text(format.telefono_contacto),
    },
    vehicle: {
      label: [text(format.marca), text(format.tipo_vehiculo), text(format.modelo)].filter(Boolean).join(' ') || 'Vehículo',
      plate: text(format.placa),
      mileage: format.kilometraje == null ? '' : Number(format.kilometraje).toLocaleString('es-CO'),
    },
    format: {
      claveKey: text(format.clave_key),
      entryDate: text(format.fecha_entrada),
      observations: text(format.observaciones),
    },
    items,
    totals: {
      partsFormatted: currency(partsTotal),
      laborFormatted: currency(laborTotal),
      totalFormatted: currency(total),
    },
  });
}

function googleFileUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('El generador de PDF no devolvió un enlace válido.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !GOOGLE_FILE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('El generador de PDF devolvió un origen de archivo no permitido.');
  }
  return url;
}

function converterFileUrl(data) {
  const value = data?.data?.googleDrive?.directLink ||
    data?.data?.googleDrive?.downloadLink ||
    data?.data?.googleDrive?.viewLink ||
    data?.url || data?.driveUrl || data;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('El generador de PDF no devolvió el archivo.');
  }
  return googleFileUrl(value.trim());
}

async function downloadGeneratedPdf(url, httpClient = axios) {
  let current = googleFileUrl(url);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await httpClient.get(current.toString(), {
      responseType: 'arraybuffer',
      maxRedirects: 0,
      maxContentLength: MAX_PDF_BYTES,
      timeout: 60_000,
      validateStatus: status => status >= 200 && status < 400,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location;
      if (!location || redirect === MAX_REDIRECTS) {
        throw new Error('El archivo PDF tiene demasiadas redirecciones.');
      }
      current = googleFileUrl(new URL(location, current).toString());
      continue;
    }
    const buffer = Buffer.from(response.data || []);
    const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!buffer.length || buffer.length > MAX_PDF_BYTES ||
        !buffer.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
        (contentType && contentType !== 'application/pdf' && contentType !== 'application/octet-stream')) {
      throw new Error('El generador devolvió un archivo que no es un PDF válido.');
    }
    return buffer;
  }
  throw new Error('No fue posible descargar el PDF generado.');
}

function fileSlug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'formato';
}

async function createCustomerQuotePdf({
  workshop,
  profile,
  format,
  repuestos,
  servicios,
  drive,
  httpClient = axios,
}) {
  if (typeof drive?.uploadPrivateFile !== 'function') {
    throw new Error('El almacenamiento privado de documentos no está disponible.');
  }
  const html = renderCustomerQuoteHtml({workshop, profile, format, repuestos, servicios});
  const response = await httpClient.post(CONVERTER_URL, {
    html,
    filename: `cotizacion-${fileSlug(format.clave_key)}.pdf`,
    pdfOptions: {format: 'A4', margin: {top: '20px', right: '20px', bottom: '20px', left: '20px'}},
  }, {
    headers: {'Content-Type': 'application/json'},
    timeout: 60_000,
    maxBodyLength: 2 * 1024 * 1024,
  });
  const sourceUrl = converterFileUrl(response.data);
  const buffer = await downloadGeneratedPdf(sourceUrl.toString(), httpClient);
  const requestHash = createHash('sha256').update(`${workshop.id}\n${html}`).digest('hex').slice(0, 40);
  const file = await drive.uploadPrivateFile({
    buffer,
    fileName: workshopFileName({
      root: 'invoices',
      folderPath: `cotizaciones/${fileSlug(format.clave_key)}`,
      mimeType: 'application/pdf',
      uploadRequestId: `quote_${requestHash}`,
    }),
    mimeType: 'application/pdf',
    folderPath: `cotizaciones/${fileSlug(format.clave_key)}`,
    root: 'invoices',
    uploadRequestId: `quote_${requestHash}`,
    appProperties: {
      vehicleAppWorkshop: workshop.id,
      vehicleAppDocument: 'customer_quote',
      vehicleAppFormat: text(format.clave_key),
    },
    workshop: {id: workshop.id, name: workshop.name},
  });
  if (!file?.id) throw new Error('Drive no devolvió el identificador de la cotización.');
  return {
    fileId: file.id,
    filePath: `/api/platform/workshops/${workshop.id}/drive/files/${file.id}`,
  };
}

module.exports = {
  CONVERTER_URL,
  createCustomerQuotePdf,
  downloadGeneratedPdf,
  renderCustomerQuoteHtml,
};
