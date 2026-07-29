'use strict';

/**
 * Construcción del HTML de la cotización que se manda a convertir en PDF.
 *
 * IMPORTANTE: el HTML que sale de aquí tiene que ser autocontenido. El PDF lo
 * renderiza un navegador headless remoto, y si el HTML pide el CSS, la fuente o
 * el logo por red el navegador termina el PDF antes de que esas descargas
 * lleguen: la cotización sale sin logo y sin diseño. Al reintentar salía bien
 * solo porque las descargas ya estaban en caché. Por eso el CSS va en línea y
 * el logo y la fuente van en base64 (ver invoice-assets.js).
 */

const handlebars = require('handlebars');
const { LOGO_DATA_URI, FONT_FACE_CSS, INVOICE_CSS } = require('./invoice-assets.js');

const CURRENCY_FORMAT = {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
};

const formatCOP = (value) => (value || 0).toLocaleString('es-CO', CURRENCY_FORMAT);

const templateHtml = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <title>COTIZACIÓN - {{formato.clave_key}}</title>
    <style>{{{invoiceStyles}}}</style>
</head>
<body>
    <!-- Encabezado -->
    <header class="header-section">
        <div class="invoice-title-block">
            <h1>Cotización</h1>
            <div class="invoice-id">#{{formato.clave_key}}</div>
        </div>
        <img class="logo" alt="Logo Empresa" src="{{{logoDataUri}}}">
    </header>

    <!-- Rejilla de Información -->
    <section class="info-grid">
        <div class="info-col">
            <div class="col-title">Emitido</div>
            <div class="col-content">{{formato.fecha_entrada}}</div>
        </div>
        <div class="info-col">
            <div class="col-title">Facturado a</div>
            <div class="col-content">
                <strong>{{formato.nombre_cliente}}</strong>
                {{#if hasVehicleInfo}}
                <div class="client-vehicle-info">
                    {{#if formato.placa}}<div class="info-row"><span class="info-label">Placa:</span><span class="info-value">{{formato.placa}}</span></div>{{/if}}
                    {{#if formato.marca}}<div class="info-row"><span class="info-label">Marca:</span><span class="info-value">{{formato.marca}}</span></div>{{/if}}
                    {{#if formato.tipo_vehiculo}}<div class="info-row"><span class="info-label">Tipo:</span><span class="info-value">{{formato.tipo_vehiculo}}</span></div>{{/if}}
                    {{#if formato.kilometraje}}<div class="info-row"><span class="info-label">KM:</span><span class="info-value">{{formato.kilometraje}}</span></div>{{/if}}
                </div>
                {{/if}}
                {{#if formato.direccion_cliente}}<div class="client-detail">{{formato.direccion_cliente}}</div>{{/if}}
                {{#if formato.telefono_cliente}}<div class="client-detail">{{formato.telefono_cliente}}</div>{{/if}}
            </div>
        </div>
        <div class="info-col">
            <div class="col-title">De</div>
            <div class="col-content"><strong>Mi Taller Mazos Car</strong><br>Calle 1 #7e-72 Quinta Oriental<br>Cucuta, Norte de Santander</div>
        </div>
    </section>

    <!-- Tabla de Servicios -->
    <main class="invoice-items">
        <table class="items-table">
            <thead>
                <tr>
                    <th class="col-desc">Servicio</th>
                    <th class="col-qty">Cant.</th>
                    <th class="col-price">Vlr Unit</th>
                    <th class="col-total">Total</th>
                </tr>
            </thead>
            <tbody>
                {{#each items}}
                <tr>
                    <td class="col-desc">{{this.descripcion}}</td>
                    <td class="col-qty">{{this.cantidad}}</td>
                    <td class="col-price">{{this.valor_unitario}}</td>
                    <td class="col-total">{{this.total}}</td>
                </tr>
                {{/each}}
            </tbody>
        </table>
    </main>

    <!-- Sección Inferior: Observaciones (Izq) y Totales (Der) -->
    <section class="bottom-section">
        <div class="bottom-left">
            {{#if formato.observaciones}}
            <div class="terms-block observations-block">
                <h3>Observaciones:</h3>
                <p>{{formato.observaciones}}</p>
            </div>
            {{/if}}
        </div>
        <div class="bottom-right">
            <div class="totals-box">
                <div class="summary-row">
                    <span class="label">Repuestos</span>
                    <span class="val">{{costos.repuestos_total_formateado}}</span>
                </div>
                <div class="summary-row">
                    <span class="label">Mano de Obra</span>
                    <span class="val">{{costos.mano_obra_formateado}}</span>
                </div>
                <div class="total-due-block">
                    <span class="label">Monto a pagar</span>
                    <span class="val">{{costos.total_formateado}}</span>
                </div>
            </div>
        </div>
    </section>

    <!-- Métodos de Pago (Abajo) -->
    <section class="payments-section">
        <div class="terms-block payments-block">
            <h3>Metodos de pago:</h3>
            <p>Bancolombia: Cuenta de Ahorros Nº 832 044 587 77</p>
            <p>LLave Bre-B: 60327747</p>
        </div>
    </section>

    <!-- Mensaje -->
    <section class="thanks-message">
        <h4>¡Gracias por su confianza!</h4>
        <p>Esperamos que vuelva pronto!</p>
    </section>

    <!-- Footer -->
    <footer class="footer-line">
        <span>Mi Taller Mazos Car, CUC/NTS</span>
        <div>
            <span>3184077646</span>
            <span class="separator">|</span>
            <span>mazos.car1@gmail.com</span>
        </div>
    </footer>
</body>
</html>
`;

// Se compila una sola vez: la plantilla no cambia entre cotizaciones.
const template = handlebars.compile(templateHtml);

const hasDescription = (item) =>
  item && typeof item.descripcion === 'string' && item.descripcion.trim() !== '';

/** Convierte un repuesto/servicio en la fila ya formateada de la tabla. */
function toTableItem(item, defaultQuantity) {
  const cantidad = item.cantidad || defaultQuantity;
  const valorUnitario = item.costo_unitario || 0;

  return {
    descripcion: item.descripcion,
    cantidad,
    valor_unitario: formatCOP(valorUnitario),
    total: formatCOP(cantidad * valorUnitario),
  };
}

/**
 * Devuelve el HTML completo y autocontenido de la cotización.
 *
 * @param {object} params
 * @param {object} params.formato Datos del formato/cliente/vehículo.
 * @param {Array}  [params.repuestos]
 * @param {Array}  [params.servicios]
 * @param {object} params.costos Totales calculados (mano_obra, total).
 * @returns {string} HTML sin ninguna referencia a recursos externos.
 */
function renderInvoiceHtml({ formato, repuestos, servicios, costos }) {
  const validRepuestos = (repuestos || []).filter(hasDescription);
  const validServicios = (servicios || []).filter(hasDescription);

  const repuestosTotal = validRepuestos.reduce(
    (acc, r) => acc + ((r.cantidad || 0) * (r.costo_unitario || 0)),
    0
  );

  return template({
    formato,
    // Los repuestos van sin cantidad por defecto; los servicios cuentan como 1.
    items: [
      ...validRepuestos.map((r) => toTableItem(r, 0)),
      ...validServicios.map((s) => toTableItem(s, 1)),
    ],
    hasVehicleInfo: !!(
      formato.placa || formato.marca || formato.tipo_vehiculo || formato.kilometraje
    ),
    costos: {
      ...costos,
      repuestos_total_formateado: formatCOP(repuestosTotal),
      mano_obra_formateado: formatCOP(costos.mano_obra),
      total_formateado: formatCOP(costos.total),
    },
    invoiceStyles: `${FONT_FACE_CSS}\n${INVOICE_CSS}`,
    logoDataUri: LOGO_DATA_URI,
  });
}

module.exports = { renderInvoiceHtml };
