'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderInvoiceHtml } = require('./invoice-template.js');

const sampleInvoice = () => ({
  formato: {
    clave_key: 'COT-001',
    fecha_entrada: '2026-07-29',
    nombre_cliente: 'Juan Pérez',
    placa: 'ABC123',
    marca: 'Chevrolet',
    tipo_vehiculo: 'Automóvil',
    kilometraje: '120.000',
    telefono_cliente: '3001234567',
    observaciones: 'Revisión de frenos.',
  },
  repuestos: [
    { descripcion: 'Pastillas de freno', cantidad: 2, costo_unitario: 85000 },
    { descripcion: 'Aceite 5W30', cantidad: 4, costo_unitario: 32000 },
  ],
  servicios: [{ descripcion: 'Mano de obra frenos', costo_unitario: 120000 }],
  costos: { mano_obra: 120000, total: 418000 },
});

// Esta es la prueba que protege contra el bug original: si el HTML vuelve a
// pedir el CSS, la fuente o el logo por red, el navegador que genera el PDF
// termina antes de que lleguen y la primera cotización sale sin logo ni diseño.
test('el HTML no referencia ningún recurso externo', () => {
  const html = renderInvoiceHtml(sampleInvoice());

  const externalRefs = html.match(/(?:src|href)="(?:https?:)?\/\/[^"]*"/g) || [];
  assert.deepStrictEqual(externalRefs, [], 'hay recursos cargados por red');

  assert.ok(!html.includes('@import'), 'el CSS no debe usar @import');
  assert.ok(!/url\(\s*(?:https?:)?\/\//.test(html), 'el CSS no debe pedir URLs remotas');
});

test('el logo y la fuente van incrustados', () => {
  const html = renderInvoiceHtml(sampleInvoice());

  assert.match(html, /<img class="logo"[^>]*src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  assert.match(html, /@font-face\s*\{[^}]*url\(data:font\/woff2;base64,/);
  assert.match(html, /<style>/, 'el CSS debe ir en línea');
});

test('arma una fila por cada repuesto y servicio con descripción', () => {
  const invoice = sampleInvoice();
  invoice.repuestos.push({ descripcion: '   ', cantidad: 1, costo_unitario: 5000 });
  invoice.servicios.push({ descripcion: '', costo_unitario: 9000 });

  const html = renderInvoiceHtml(invoice);
  const rows = html.match(/<td class="col-desc">/g) || [];

  assert.strictEqual(rows.length, 3, 'las descripciones vacías deben omitirse');
  assert.ok(html.includes('Pastillas de freno'));
  assert.ok(html.includes('Mano de obra frenos'));
});

test('calcula y formatea los totales en pesos', () => {
  const html = renderInvoiceHtml(sampleInvoice());

  // Repuestos: 2 x 85.000 + 4 x 32.000 = 298.000
  assert.ok(html.includes('298.000'), 'total de repuestos');
  assert.ok(html.includes('120.000'), 'mano de obra');
  assert.ok(html.includes('418.000'), 'monto a pagar');
});

test('escapa el contenido que viene de la base de datos', () => {
  const invoice = sampleInvoice();
  invoice.formato.nombre_cliente = 'Taller <b>A&B</b>';
  invoice.repuestos = [
    { descripcion: 'Filtro <aceite>', cantidad: 1, costo_unitario: 1000 },
  ];

  const html = renderInvoiceHtml(invoice);

  assert.ok(html.includes('Taller &lt;b&gt;A&amp;B&lt;/b&gt;'));
  assert.ok(html.includes('Filtro &lt;aceite&gt;'));
  assert.ok(!html.includes('<b>A&B</b>'), 'no debe inyectarse HTML crudo');
});

test('funciona sin repuestos ni servicios', () => {
  const html = renderInvoiceHtml({
    formato: { clave_key: 'COT-002', nombre_cliente: 'Ana' },
    costos: { total: 0 },
  });

  assert.match(html, /<img class="logo"/);
  assert.ok(html.includes('COT-002'));
});
