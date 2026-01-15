/**
 * Servicio de Facturatech para Facturación Electrónica
 * 
 * Este servicio maneja toda la comunicación SOAP con el webservice
 * de Facturatech para la emisión de facturas electrónicas.
 */

const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');
const { HttpsProxyAgent } = require('https-proxy-agent');

// --- INICIO CONFIGURACIÓN INLINED (Para evitar dep. circular) ---

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

// --- FIN CONFIGURACIÓN INLINED ---

class FacturatechService {
    constructor() {
        this.user = process.env.FACTURATECH_USER || '';
        // IMPORTANTE: La contraseña ya viene hasheada (SHA-256) desde el soporte de Facturatech.
        // NO volver a hashear, usar directamente.
        this.password = process.env.FACTURATECH_PASSWORD || '';
        // Configuración por defecto a 'pro' si no se especifica, dado que el usuario 
        // indica que sus credenciales son de producción.
        this.env = process.env.FACTURATECH_ENV || 'pro';
        this.endpoint = `https://ws.facturatech.co/v2/${this.env}/index.php?wsdl`;

        console.log(`[Facturatech] Iniciando servicio en entorno: ${this.env}`);
        console.log(`[Facturatech] WSDL Endpoint: ${this.endpoint}`);
        // Debug de variables de entorno (ofuscado)
        console.log('[Facturatech] Variables de entorno detectadas:', {
            USER: !!process.env.FACTURATECH_USER,
            PASS: !!process.env.FACTURATECH_PASSWORD,
            PASS_PREVIEW: this.password ? `${this.password.substring(0, 8)}...` : 'vacío',
            PASS_LENGTH: this.password?.length || 0,
            PROXY: !!process.env.FACTURATECH_PROXY_URL,
            PROXY_VAL: process.env.FACTURATECH_PROXY_URL ? (process.env.FACTURATECH_PROXY_URL.substring(0, 7) + '...') : 'undefined'
        });

        // Configuración de proxy HTTP para evitar bloqueos de Cloudflare (opcional)
        // Formato: http://user:pass@proxy.example.com:8080
        this.proxyUrl = process.env.FACTURATECH_PROXY_URL || '';
        this.proxyAgent = this.proxyUrl ? new HttpsProxyAgent(this.proxyUrl) : null;

        if (!this.user) {
            console.warn('[Facturatech] ADVERTENCIA: FACTURATECH_USER no está configurado');
        }
        if (!process.env.FACTURATECH_PASSWORD) {
            console.warn('[Facturatech] ADVERTENCIA: FACTURATECH_PASSWORD no está configurado');
        }
        if (this.proxyAgent) {
            console.log('[Facturatech] Proxy HTTP configurado:', this.proxyUrl.replace(/:[^:@]+@/, ':****@'));
        } else {
            console.log('[Facturatech] Modo directo (sin proxy). Los errores 502 son intermitentes de Cloudflare.');
        }
    }

    /**
     * Hash SHA-256 de la contraseña (requerido por Facturatech)
     */
    _hashPassword(password) {
        if (!password) return '';
        return crypto.createHash('sha256').update(password).digest('hex');
    }

    /**
     * Escapa caracteres especiales para XML
     */
    _escapeXml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Genera el XML Layout completo para una factura
     * 
     * @param {Object} adquiriente - Datos del cliente/adquiriente
     * @param {Array} items - Lista de items (repuestos/servicios)
     * @param {Object} totales - Totales de la factura
     * @param {string} numeroFactura - Número de la factura
     * @param {string} referencia - Referencia (ej: número de orden de trabajo)
     */
    /**
     * Genera el Layout en formato Flat File (Archivo Plano) requerido por Facturatech
     * 
     * IMPORTANTE: El método uploadInvoiceFileLayout usa formato propietario.
     * Formato: CAMPO:VALOR; (dos puntos entre campo y valor, punto y coma al final)
     * 
     * Basado en el manual oficial de Facturatech - Figura 16
     */
    generarXmlLayout(adquiriente, items, totales, numeroFactura, referencia = '') {
        const fechaActual = new Date().toISOString().split('T')[0];
        const horaActual = new Date().toTimeString().split(' ')[0];

        // Fecha de vencimiento (30 días después por defecto para crédito)
        const fechaVencimiento = new Date();
        fechaVencimiento.setDate(fechaVencimiento.getDate() + 30);
        const fechaVenc = fechaVencimiento.toISOString().split('T')[0];

        // Obtener código DIAN del tipo de documento
        const tipoDocDian = TIPOS_DOCUMENTO_DIAN[adquiriente.tipoDocumento] || '13';

        // Función helper para limpiar valores (sin punto y coma, ni saltos de línea, ni acentos)
        const clean = (val) => {
            return String(val || '')
                .replace(/;/g, ',')
                .replace(/:/g, '-')
                .replace(/\n/g, ' ')
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Eliminar acentos
                .trim();
        };

        // Generar items en formato Layout correcto
        // Formato: ITE_X:VALOR;
        const itemsLayout = items.map((item, index) => {
            const subtotal = item.cantidad * item.precioUnitario;
            const valorIva = subtotal * (item.porcentajeIva / 100);
            const totalLinea = subtotal + valorIva;
            const codigoItem = clean(item.codigo || `ITEM${index + 1}`).substring(0, 20);

            return [
                '(ITE)',
                `ITE_1:${index + 1};`,
                `ITE_3:${codigoItem};`,
                `ITE_4:${item.cantidad};`,
                `ITE_5:EA;`,
                `ITE_6:${item.precioUnitario.toFixed(2)};`,
                `ITE_7:${subtotal.toFixed(2)};`,
                `ITE_10:${clean(item.descripcion)};`,
                `ITE_11:01;`, // Tipo de precio (01 = precio unitario)
                `ITE_14:${item.porcentajeIva.toFixed(2)};`,
                `ITE_15:${valorIva.toFixed(2)};`,
                `ITE_18:${totalLinea.toFixed(2)};`,
                '(/ITE)'
            ].join('\n');
        }).join('\n');

        // ================================================================
        // Construir Layout completo según Figura 16 del manual Facturatech
        // Formato: CAMPO:VALOR;
        // ================================================================
        const layout = [
            '[FACTURA]',
            '(ENC)',
            'ENC_1:INVOIC;',                                    // Tipo documento (INVOIC = factura)
            `ENC_2:${EMISOR.nit};`,                             // NIT del emisor
            `ENC_3:${numeroFactura};`,                          // Número/Folio de factura
            'ENC_4:UBL 2.1;',                                   // Versión UBL
            'ENC_5:DIAN 2.1;',                                  // Versión DIAN
            'ENC_6:01;',                                        // Tipo de factura (01 = Factura de venta)
            `ENC_7:${fechaActual};`,                            // Fecha de emisión
            `ENC_8:${horaActual};`,                             // Hora de emisión
            'ENC_9:01;',                                        // Tipo de operación (01 = contado, 02 = crédito)
            `ENC_10:COP;`,                                      // Moneda
            `ENC_15:${items.length};`,                          // Cantidad de líneas/items
            `ENC_16:${fechaVenc};`,                             // Fecha de vencimiento
            `ENC_20:${adquiriente.formaPago || '1'};`,          // Forma de pago (1=contado, 2=crédito)
            `ENC_21:10;`,                                       // Medio de pago (10 = efectivo)
            `ENC_22:${clean(referencia)};`,                     // Referencia/Observaciones
            '(/ENC)',
            '(EMI)',
            `EMI_1:${EMISOR.tipoPersona};`,                     // Tipo de persona (1=jurídica, 2=natural)
            `EMI_2:${EMISOR.nit};`,                             // NIT
            `EMI_3:31;`,                                        // Tipo de documento (31 = NIT)
            `EMI_4:${EMISOR.dv};`,                              // Dígito de verificación
            `EMI_6:${clean(EMISOR.razonSocial)};`,              // Razón social
            `EMI_7:${clean(EMISOR.nombreComercial)};`,          // Nombre comercial
            `EMI_10:${clean(EMISOR.direccion)};`,               // Dirección
            `EMI_11:${EMISOR.codigoDepto};`,                    // Código departamento
            `EMI_12:${clean(EMISOR.ciudad)};`,                  // Ciudad (nombre)
            `EMI_13:${clean(EMISOR.departamento)};`,            // Departamento (nombre)
            `EMI_14:${EMISOR.codigoCiudad};`,                   // Código municipio
            `EMI_15:${EMISOR.pais};`,                           // País
            `EMI_18:${clean(EMISOR.direccion)};`,               // Dirección fiscal
            `EMI_19:${clean(EMISOR.departamento)};`,            // Departamento fiscal
            `EMI_21:Colombia;`,                                 // País nombre
            `EMI_22:${EMISOR.telefono};`,                       // Teléfono
            `EMI_23:${EMISOR.responsabilidad};`,                // Responsabilidades fiscales
            `EMI_24:${clean(EMISOR.nombreComercial)};`,         // Nombre del contacto
            `EMI_25:${EMISOR.regimen};`,                        // Régimen fiscal
            '(/EMI)',
            '(ADQ)',
            `ADQ_1:${adquiriente.tipoPersona || '2'};`,         // Tipo persona
            `ADQ_2:${adquiriente.numeroDocumento};`,            // Número documento
            `ADQ_3:${tipoDocDian};`,                            // Tipo documento DIAN
            `ADQ_4:${adquiriente.dv || ''};`,                   // DV (si aplica)
            `ADQ_6:${clean(adquiriente.razonSocial)};`,         // Razón social/Nombre
            `ADQ_7:${clean(adquiriente.nombreComercial || adquiriente.razonSocial)};`,
            `ADQ_10:${clean(adquiriente.direccion)};`,          // Dirección
            `ADQ_11:${adquiriente.codigoDepto || '54'};`,       // Código departamento
            `ADQ_12:${clean(adquiriente.ciudad || 'Cucuta')};`, // Ciudad
            `ADQ_13:${clean(adquiriente.departamento || 'Norte de Santander')};`,
            `ADQ_14:${adquiriente.codigoCiudad || '54001'};`,   // Código municipio
            `ADQ_15:${EMISOR.pais};`,                           // País
            `ADQ_18:${clean(adquiriente.direccion)};`,          // Dirección fiscal
            `ADQ_19:${clean(adquiriente.departamento || 'Norte de Santander')};`,
            `ADQ_21:Colombia;`,                                 // País nombre
            `ADQ_22:${adquiriente.telefono || ''};`,            // Teléfono
            `ADQ_23:${adquiriente.responsabilidad || 'R-99-PN'};`, // Responsabilidad fiscal
            `ADQ_24:${clean(adquiriente.razonSocial)};`,        // Nombre contacto
            `ADQ_25:${adquiriente.regimen || '49'};`,           // Régimen fiscal
            `ADQ_26:${adquiriente.email || ''};`,               // Email
            '(/ADQ)',
            '(TOT)',
            `TOT_1:${totales.baseGravable.toFixed(2)};`,        // Base gravable
            `TOT_2:COP;`,                                       // Moneda base
            `TOT_3:${totales.total.toFixed(2)};`,               // Total a pagar
            `TOT_4:COP;`,                                       // Moneda total
            `TOT_5:${totales.baseGravable.toFixed(2)};`,        // Valor bruto
            `TOT_6:COP;`,                                       // Moneda valor bruto
            `TOT_7:${totales.iva.toFixed(2)};`,                 // Total IVA
            `TOT_8:COP;`,                                       // Moneda IVA
            '(/TOT)',
            // Sección de impuestos (TAC) - Responsabilidades fiscales
            '(TAC)',
            `TAC_1:${EMISOR.responsabilidad};`,                 // Códigos de responsabilidad
            '(/TAC)',
            itemsLayout
        ].join('\n');

        return layout;
    }

    /**
     * Crea el envelope SOAP para una llamada al webservice
     */
    /**
     * Crea el envelope SOAP para una llamada al webservice
     */
    _crearSoapEnvelope(method, params, namespace = 'urn:FacturaTech') {
        const paramsXml = Object.entries(params)
            .map(([key, value]) => `<${key}>${this._escapeXml(value)}</${key}>`)
            .join('');

        return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="${namespace}"><soapenv:Body><urn:${method}>${paramsXml}</urn:${method}></soapenv:Body></soapenv:Envelope>`;
    }

    /**
     * Ejecuta una llamada SOAP al webservice con reintentos
     * @param {string} method Nombre del método SOAP
     * @param {object|string} params Objeto con parámetros o string XML del envelope ya construido
     * @param {string|null} customSoapAction Acción SOAP personalizada (opcional)
     * @param {number} attempt Contador de intentos
     */
    async _ejecutarSoap(method, params, customSoapAction = null, attempt = 1) {
        const maxAttempts = 5;

        // Determinar si params es ya un envelope (string) o parámetros para construirlo
        let envelope;
        if (typeof params === 'string') {
            envelope = params;
        } else {
            envelope = this._crearSoapEnvelope(method, params);
        }

        // Log del envelope SOAP para diagnóstico (primeros 1500 chars)
        if (attempt === 1) {
            console.log('[Facturatech] ========== SOAP ENVELOPE ==========');
            console.log(envelope.substring(0, 1500));
            console.log('[Facturatech] ========== FIN SOAP ENVELOPE ==========');
        }

        console.log(`[Facturatech] Ejecutando método: ${method} (intento ${attempt}/${maxAttempts})`);
        console.log(`[Facturatech] Endpoint: ${this.endpoint}`);

        // Validar credenciales antes de enviar (solo si params es objeto)
        if (typeof params === 'object') {
            if (!this.user || !this.password) {
                console.warn('[Facturatech] ¡PELIGRO! Credenciales vacías. La solicitud fallará.');
            }
        }

        // Headers SOAP 1.1
        const headers = {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': customSoapAction || `"urn:FacturaTech#${method}"`,
            'User-Agent': 'PHP-SOAP/8.1',
            'Accept': 'text/xml',
            'Connection': 'keep-alive'
        };

        try {
            // Configurar axios con soporte de proxy opcional
            const axiosConfig = {
                headers,
                timeout: 120000,
                decompress: attempt > 1 ? false : true,
                responseType: 'text'
            };

            // Usar proxy HTTP si está configurado
            if (this.proxyAgent) {
                axiosConfig.httpsAgent = this.proxyAgent;
                axiosConfig.proxy = false;
                console.log(`[Facturatech] Usando proxy para intento ${attempt}`);
            }

            const response = await axios.post(this.endpoint, envelope, axiosConfig);
            const responseData = response.data;

            // Log de respuesta completa para diagnóstico (si es menor a 2000 chars)
            console.log(`[Facturatech] Response length: ${responseData?.length || 0} chars`);
            if (responseData && responseData.length < 2000) {
                console.log('[Facturatech] RESPUESTA COMPLETA:');
                console.log(responseData);
            } else {
                console.log('[Facturatech] Response preview:', responseData?.substring(0, 500));
            }

            // Validar que la respuesta sea XML antes de parsear
            const trimmedData = (typeof responseData === 'string' ? responseData : '').trim();
            if (!trimmedData.startsWith('<?xml') && !trimmedData.startsWith('<')) {
                console.error('[Facturatech] Respuesta no es XML válido. Posible error de Cloudflare/WAF.');
                console.error('[Facturatech] Contenido COMPLETO recibido:', responseData);

                // Si falla, reintentar con backoff exponencial
                if (attempt < maxAttempts) {
                    const delay = Math.pow(2, attempt) * 5000; // Backoff más lento: 10s, 20s, 40s, 80s
                    console.log(`[Facturatech] Reintentando en ${delay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this._ejecutarSoap(method, params, attempt + 1);
                }

                throw new Error(`Respuesta de Facturatech no es XML válido. Contenido: ${responseData.substring(0, 200)}`);
            }

            // Limpiar BOM y caracteres invisibles al inicio
            const cleanedData = responseData.replace(/^\uFEFF/, '').trim();

            // Parsear respuesta XML
            const parser = new xml2js.Parser({
                explicitArray: false,
                ignoreAttrs: true
            });

            const result = await parser.parseStringPromise(cleanedData);
            console.log(`[Facturatech] Respuesta XML parseada correctamente para ${method}`);

            return this._extraerRespuesta(result, method);
        } catch (error) {
            console.error(`[Facturatech] Error en ${method} (intento ${attempt}):`, error.message);

            // Si es un error 502/503/504 y aún hay intentos, reintentar con backoff
            if (error.response && [502, 503, 504].includes(error.response.status) && attempt < maxAttempts) {
                const delay = Math.pow(2, attempt) * 1000; // Backoff exponencial: 2s, 4s, 8s
                console.log(`[Facturatech] Reintentando en ${delay / 1000}s con headers alternativos...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._ejecutarSoap(method, params, attempt + 1);
            }

            // Si es error de parsing XML y aún hay intentos, reintentar
            if (error.message && error.message.includes('Non-whitespace') && attempt < maxAttempts) {
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`[Facturatech] Error de parsing XML, reintentando en ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._ejecutarSoap(method, params, attempt + 1);
            }

            if (error.response) {
                console.error('[Facturatech] Response data:', error.response.data);
            }
            throw error;
        }
    }

    /**
     * Extrae la respuesta relevante del XML parseado
     */
    _extraerRespuesta(result, method) {
        try {
            // Navegar por la estructura del SOAP response
            const body = result['SOAP-ENV:Envelope']?.['SOAP-ENV:Body'] ||
                result['soap:Envelope']?.['soap:Body'] ||
                result['soapenv:Envelope']?.['soapenv:Body'];

            if (!body) {
                console.log('[Facturatech] Estructura de respuesta:', JSON.stringify(result, null, 2));
                return result;
            }

            // Buscar la respuesta del método
            const methodResponse = body[`${method}Response`] || body[`ns1:${method}Response`];

            if (methodResponse) {
                const actualResponse = methodResponse.return || methodResponse;

                // Si el método devolvió un objeto con error (negocio)
                if (actualResponse && (actualResponse.error || (actualResponse.code && parseInt(actualResponse.code) >= 400))) {
                    return {
                        success: false,
                        error: actualResponse.error || `Error ${actualResponse.code}`,
                        code: String(actualResponse.code),
                        data: actualResponse
                    };
                }

                return {
                    success: true,
                    data: methodResponse
                };
            }

            // Si hay un fault, extraerlo
            const fault = body['SOAP-ENV:Fault'] || body['soap:Fault'] || body['soapenv:Fault'] || body['Fault'];
            if (fault) {
                return {
                    success: false,
                    error: fault.faultstring || fault.reason || 'Error desconocido en SOAP'
                };
            }

            return { success: true, data: body };
        } catch (e) {
            console.error('[Facturatech] Error extrayendo respuesta:', e);
            return { success: false, error: e.message, raw: result };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // MÉTODOS PÚBLICOS DEL WEBSERVICE
    // ═══════════════════════════════════════════════════════════════

    /**
     * Sube una factura en formato Layout a Facturatech
     * @returns {Promise<{success: boolean, transactionId?: string, error?: string}>}
     */
    async uploadInvoiceFileLayout(xmlLayout) {
        // Asegurar formato limpio: trimming y sin BOM
        const sanitizedLayout = xmlLayout.trim().replace(/^\uFEFF/, '');

        // Debug: Mostrar primeros bytes en HEX para detectar caracteres invisibles
        const hexPreview = Buffer.from(sanitizedLayout.substring(0, 20), 'utf-8').toString('hex');
        console.log(`Layout Start Hex: ${hexPreview}`);

        // Log del layout completo para debug crítico
        console.log('========== LAYOUT COMPLETO ==========');
        console.log(sanitizedLayout);
        console.log('========== FIN LAYOUT ==========');
        console.log(`Layout length: ${sanitizedLayout.length} chars`);

        // WSDL especifica ISO-8859-1, probar latin1 encoding
        const layoutBase64 = Buffer.from(sanitizedLayout, 'latin1').toString('base64');

        // NOTA: this.password YA está hasheada en el constructor, no hashear de nuevo
        const params = {
            username: this.user,
            password: this.password,  // Ya es hash SHA256
            layout: layoutBase64
        };

        // PRUEBA: Usar namespace simple como el test local que SÍ funcionó
        // El test local usa 'urn:FacturaTech' independientemente del endpoint
        const namespace = 'urn:FacturaTech';
        const method = 'FtechAction.uploadInvoiceFileLayout';

        const envelope = this._crearSoapEnvelope(method, params, namespace);

        // Debug del Envelope
        console.log('========== SOAP ENVELOPE ==========');
        console.log(envelope);
        console.log('========== FIN SOAP ENVELOPE ==========');

        // SOAPAction simple como test local
        const soapAction = `"urn:FacturaTech#${method}"`;

        return this._ejecutarSoap(method, envelope, soapAction);
    }

    /**
     * Consulta el estado de un documento
     * @returns {Promise<{success: boolean, status?: string, message?: string}>}
     */
    async documentStatusFile(transactionId) {
        const result = await this._ejecutarSoap('FtechAction.documentStatusFile', {
            username: this.user,
            password: this.password,
            transaccionID: transactionId
        });

        if (result.success && result.data) {
            return {
                success: true,
                status: result.data.status || result.data.return?.status,
                message: result.data.message || result.data.return?.message,
                data: result.data
            };
        }

        return {
            success: false,
            error: result.error || 'Error al consultar estado'
        };
    }

    /**
     * Descarga el PDF de una factura
     * @returns {Promise<{success: boolean, pdfBase64?: string}>}
     */
    async downloadPDFFile(prefijo, folio) {
        const result = await this._ejecutarSoap('FtechAction.downloadPDFFile', {
            username: this.user,
            password: this.password,
            prefijo: prefijo,
            folio: folio
        });

        if (result.success && result.data) {
            const pdfBase64 = result.data.return || result.data.resourceData;
            return {
                success: true,
                pdfBase64: pdfBase64
            };
        }

        return {
            success: false,
            error: result.error || 'Error al descargar PDF'
        };
    }

    /**
     * Descarga el XML firmado de una factura
     * @returns {Promise<{success: boolean, xmlBase64?: string}>}
     */
    async downloadXMLFile(prefijo, folio) {
        const result = await this._ejecutarSoap('FtechAction.downloadXMLFile', {
            username: this.user,
            password: this.password,
            prefijo: prefijo,
            folio: folio
        });

        if (result.success && result.data) {
            const xmlBase64 = result.data.return || result.data.resourceData;
            return {
                success: true,
                xmlBase64: xmlBase64
            };
        }

        return {
            success: false,
            error: result.error || 'Error al descargar XML'
        };
    }

    /**
     * Obtiene el CUFE de una factura
     * @returns {Promise<{success: boolean, cufe?: string}>}
     */
    async getCUFEFile(prefijo, folio) {
        const result = await this._ejecutarSoap('FtechAction.getCUFEFile', {
            username: this.user,
            password: this.password,
            prefijo: prefijo,
            folio: folio
        });

        if (result.success && result.data) {
            const cufe = result.data.return || result.data.resourceData;
            return {
                success: true,
                cufe: cufe
            };
        }

        return {
            success: false,
            error: result.error || 'Error al obtener CUFE'
        };
    }

    /**
     * Obtiene los datos del código QR de una factura
     * @returns {Promise<{success: boolean, qrData?: string}>}
     */
    async getQRFile(prefijo, folio) {
        const result = await this._ejecutarSoap('FtechAction.getQRFile', {
            username: this.user,
            password: this.password,
            prefijo: prefijo,
            folio: folio
        });

        if (result.success && result.data) {
            const qrData = result.data.return || result.data.resourceData;
            return {
                success: true,
                qrData: qrData
            };
        }

        return {
            success: false,
            error: result.error || 'Error al obtener QR'
        };
    }

    /**
     * Obtiene la imagen del código QR de una factura
     * @returns {Promise<{success: boolean, qrImageBase64?: string}>}
     */
    async getQRImageFile(prefijo, folio) {
        const result = await this._ejecutarSoap('FtechAction.getQRImageFile', {
            username: this.user,
            password: this.password,
            prefijo: prefijo,
            folio: folio
        });

        if (result.success && result.data) {
            const qrImage = result.data.return || result.data.resourceData;
            return {
                success: true,
                qrImageBase64: qrImage
            };
        }

        return {
            success: false,
            error: result.error || 'Error al obtener imagen QR'
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // MÉTODOS DE UTILIDAD
    // ═══════════════════════════════════════════════════════════════

    /**
     * Obtiene el siguiente número de factura disponible
     * (En producción, esto debería consultarse de la base de datos)
     */
    async obtenerSiguienteNumeroFactura(supabase) {
        try {
            // Consultar el último número usado
            const { data, error } = await supabase
                .from('facturas_electronicas')
                .select('numero_factura')
                .eq('prefijo', NUMERACION.prefijo)
                .order('numero_factura', { ascending: false })
                .limit(1);

            if (error) throw error;

            if (data && data.length > 0) {
                const ultimoNumero = parseInt(data[0].numero_factura);
                return ultimoNumero + 1;
            }

            // Si no hay facturas, empezar desde el rango inicial
            return NUMERACION.rangoDesde;
        } catch (e) {
            console.error('[Facturatech] Error obteniendo siguiente número:', e);
            // Fallback: usar timestamp
            return Date.now() % 1000000;
        }
    }

    /**
     * Calcula los totales de una factura a partir de los items
     */
    calcularTotales(items, porcentajeIvaDefault = 19) {
        let baseGravable = 0;
        let iva = 0;

        items.forEach(item => {
            const subtotal = item.cantidad * item.precioUnitario;
            const porcentajeIva = item.porcentajeIva ?? porcentajeIvaDefault;
            const valorIva = subtotal * (porcentajeIva / 100);

            baseGravable += subtotal;
            iva += valorIva;
        });

        return {
            baseGravable,
            iva,
            total: baseGravable + iva
        };
    }
}

module.exports = FacturatechService;
