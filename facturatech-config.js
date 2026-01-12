/**
 * Configuración de Facturatech para Facturación Electrónica
 * 
 * Este archivo contiene la configuración del emisor y endpoints
 * para la integración con el webservice SOAP de Facturatech.
 */

// Configuración del emisor (desde variables de entorno)
const EMISOR = {
  tipoPersona: process.env.EMISOR_TIPO_PERSONA || '2', // 1=Jurídica, 2=Natural
  nit: process.env.EMISOR_NIT || '',
  dv: process.env.EMISOR_DV || '',
  razonSocial: process.env.EMISOR_RAZON_SOCIAL || 'MI TALLER MAZOS CAR',
  nombreComercial: process.env.EMISOR_NOMBRE_COMERCIAL || 'MI TALLER MAZOS CAR',
  direccion: process.env.EMISOR_DIRECCION || 'Calle 1 #7E-72 Quinta Oriental',
  codigoCiudad: process.env.EMISOR_CODIGO_CIUDAD || '54001',
  ciudad: process.env.EMISOR_CIUDAD || 'Cúcuta',
  departamento: process.env.EMISOR_DEPARTAMENTO || 'Norte de Santander',
  codigoDepto: process.env.EMISOR_CODIGO_DEPTO || '54',
  pais: 'CO',
  telefono: process.env.EMISOR_TELEFONO || '3184077646',
  email: process.env.EMISOR_EMAIL || '',
  responsabilidad: process.env.EMISOR_RESPONSABILIDAD || 'R-99-PN',
  regimen: process.env.EMISOR_REGIMEN || '49' // 49=No responsable IVA
};

// Endpoints según ambiente
const ENDPOINTS = {
  demo: 'https://ws.facturatech.co/v2/demo/index.php',
  production: 'https://ws.facturatech.co/v2/pro/index.php'
};

// Configuración de numeración de facturación
const NUMERACION = {
  prefijo: process.env.FACTURA_PREFIJO || 'SETT',
  resolucion: process.env.FACTURA_RESOLUCION || '',
  rangoDesde: parseInt(process.env.FACTURA_RANGO_DESDE || '1'),
  rangoHasta: parseInt(process.env.FACTURA_RANGO_HASTA || '5000')
};

// Tipos de documento DIAN
const TIPOS_DOCUMENTO_DIAN = {
  'CC': '13',   // Cédula de ciudadanía
  'NIT': '31',  // NIT
  'CE': '22',   // Cédula de extranjería
  'PP': '41',   // Pasaporte
  'TI': '12',   // Tarjeta de identidad
  'DIE': '42'   // Documento de identificación extranjero
};

// Responsabilidades fiscales
const RESPONSABILIDADES_FISCALES = {
  'O-13': 'Gran contribuyente',
  'O-15': 'Autorretenedor',
  'O-23': 'Agente de retención IVA',
  'O-47': 'Régimen Simple de Tributación',
  'R-99-PN': 'No aplica - Persona Natural'
};

// Regímenes fiscales
const REGIMENES_FISCALES = {
  '01': 'IVA',
  '04': 'Simple',
  '48': 'Responsable de IVA',
  '49': 'No responsable de IVA'
};

// Códigos de ciudades principales de Colombia (DANE)
const CIUDADES_DANE = {
  'Bogotá': '11001',
  'Medellín': '05001',
  'Cali': '76001',
  'Barranquilla': '08001',
  'Cartagena': '13001',
  'Cúcuta': '54001',
  'Bucaramanga': '68001',
  'Pereira': '66001',
  'Santa Marta': '47001',
  'Ibagué': '73001'
};

// Códigos de departamentos (DANE)
const DEPARTAMENTOS_DANE = {
  'Amazonas': '91',
  'Antioquia': '05',
  'Arauca': '81',
  'Atlántico': '08',
  'Bolívar': '13',
  'Boyacá': '15',
  'Caldas': '17',
  'Caquetá': '18',
  'Casanare': '85',
  'Cauca': '19',
  'Cesar': '20',
  'Chocó': '27',
  'Córdoba': '23',
  'Cundinamarca': '25',
  'Guainía': '94',
  'Guaviare': '95',
  'Huila': '41',
  'La Guajira': '44',
  'Magdalena': '47',
  'Meta': '50',
  'Nariño': '52',
  'Norte de Santander': '54',
  'Putumayo': '86',
  'Quindío': '63',
  'Risaralda': '66',
  'San Andrés': '88',
  'Santander': '68',
  'Sucre': '70',
  'Tolima': '73',
  'Valle del Cauca': '76',
  'Vaupés': '97',
  'Vichada': '99',
  'Bogotá D.C.': '11'
};

module.exports = {
  EMISOR,
  ENDPOINTS,
  NUMERACION,
  TIPOS_DOCUMENTO_DIAN,
  RESPONSABILIDADES_FISCALES,
  REGIMENES_FISCALES,
  CIUDADES_DANE,
  DEPARTAMENTOS_DANE
};
