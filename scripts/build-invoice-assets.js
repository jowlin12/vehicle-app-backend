#!/usr/bin/env node
/**
 * Genera invoice-assets.js a partir de los archivos de assets/.
 *
 * El PDF de la cotización se renderiza en un navegador headless remoto
 * (api-pdf-to-html-vercel). Si el HTML pide el CSS, la fuente o el logo por
 * red, el navegador toma la "foto" del PDF antes de que esas descargas
 * terminen y la primera factura sale sin logo y sin diseño. Por eso todo se
 * incrusta en el HTML y no queda ninguna petición de red al renderizar.
 *
 * Los assets se emiten como un módulo .js (y no se leen con fs en tiempo de
 * ejecución) para que el bundler de Vercel siempre los incluya en el deploy.
 *
 * Uso: npm run build:invoice-assets
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const OUTPUT_FILE = path.join(__dirname, '..', 'invoice-assets.js');

function readAsset(fileName) {
  return fs.readFileSync(path.join(ASSETS_DIR, fileName));
}

function toDataUri(fileName, mimeType) {
  return `data:${mimeType};base64,${readAsset(fileName).toString('base64')}`;
}

const css = readAsset('invoice.css').toString('utf8');

if (css.includes('@import')) {
  console.error(
    'assets/invoice.css contiene un @import. Las hojas de estilo externas ' +
    'vuelven a introducir el problema del diseño que no carga.'
  );
  process.exit(1);
}

const logoDataUri = toDataUri('logo-red.png', 'image/png');
const fontDataUri = toDataUri('inter-latin.woff2', 'font/woff2');

// Inter se sirve como fuente variable: un solo archivo cubre 400-700.
const fontFaceCss = `@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400 700;
  font-display: block;
  src: url(${fontDataUri}) format('woff2');
}`;

const output = `// ARCHIVO GENERADO - NO EDITAR A MANO.
// Se genera con: npm run build:invoice-assets
// Para cambiar el logo, la fuente o el diseño, edita los archivos de assets/
// y vuelve a ejecutar ese comando.
//
// Estos assets van incrustados (base64 / CSS en línea) para que el HTML de la
// cotización no dependa de ninguna descarga por red al generar el PDF.

'use strict';

const LOGO_DATA_URI = ${JSON.stringify(logoDataUri)};

const FONT_FACE_CSS = ${JSON.stringify(fontFaceCss)};

const INVOICE_CSS = ${JSON.stringify(css)};

module.exports = { LOGO_DATA_URI, FONT_FACE_CSS, INVOICE_CSS };
`;

fs.writeFileSync(OUTPUT_FILE, output);

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
console.log(`invoice-assets.js generado (${kb(Buffer.byteLength(output))})`);
console.log(`  logo:  ${kb(logoDataUri.length)} en base64`);
console.log(`  fuente: ${kb(fontDataUri.length)} en base64`);
console.log(`  css:   ${kb(css.length)}`);
