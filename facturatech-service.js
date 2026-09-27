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

function normalizedProviderKey(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findProviderValue(value, acceptedKeys, depth = 0) {
    if (depth > 10 || value == null || typeof value !== 'object') return null;
    const entries = Object.entries(value);
    for (const acceptedKey of acceptedKeys.map(normalizedProviderKey)) {
        const match = entries.find(([key, nested]) =>
            normalizedProviderKey(key) === acceptedKey &&
            (typeof nested === 'string' || typeof nested === 'number'));
        if (match) {
            const candidate = String(match[1]).trim();
            if (candidate && candidate.length <= 2_000_000 && !/[\u0000-\u001f\u007f]/.test(candidate)) {
                return candidate;
            }
        }
    }
    for (const nested of Object.values(value)) {
        const found = findProviderValue(nested, acceptedKeys, depth + 1);
        if (found != null) return found;
    }
    return null;
}

// --- FIN CONFIGURACIÓN INLINED ---

class FacturatechService {
    // Capture issuer, credentials, environment and invoice numbering per instance.
    // The no-argument form preserves the legacy environment-based configuration.
    constructor(configuration = {}) {
        if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
            throw new TypeError('La configuración de Facturatech no es válida.');
        }

        const tenantScoped = Object.keys(configuration).length > 0;
        const environment = tenantScoped
            ? (configuration.environment ?? 'demo')
            : (process.env.FACTURATECH_ENV ?? 'demo');
        if (!['demo', 'pro', 'production'].includes(environment)) {
            throw new Error('El entorno de Facturatech debe ser demo o pro.');
        }
        const environmentPath = environment === 'production' ? 'pro' : environment;

        let issuer;
        let numbering;
        let username;
        let passwordHash;
        if (tenantScoped) {
            const credentials = configuration.credentials;
            issuer = configuration.issuer;
            numbering = configuration.numbering;
            if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
                !issuer || typeof issuer !== 'object' || Array.isArray(issuer) ||
                !numbering || typeof numbering !== 'object' || Array.isArray(numbering)) {
                throw new Error('La configuración por taller requiere emisor, numeración y credenciales completos.');
            }
            const issuerFields = [
                'tipoPersona', 'nit', 'dv', 'razonSocial', 'nombreComercial', 'direccion',
                'codigoCiudad', 'ciudad', 'departamento', 'codigoDepto', 'pais',
                'telefono', 'responsabilidad', 'regimen',
            ];
            if (issuerFields.some(field => typeof issuer[field] !== 'string' || !issuer[field].trim())) {
                throw new Error('El perfil fiscal del taller está incompleto.');
            }
            if (typeof numbering.prefijo !== 'string' || !numbering.prefijo.trim() ||
                typeof numbering.resolucion !== 'string' || !numbering.resolucion.trim() ||
                !Number.isInteger(numbering.rangoDesde) || !Number.isInteger(numbering.rangoHasta) ||
                numbering.rangoDesde < 1 || numbering.rangoHasta < numbering.rangoDesde) {
                throw new Error('La numeración fiscal del taller está incompleta.');
            }
            username = credentials.username;
            passwordHash = credentials.passwordHash;
            if (typeof username !== 'string' || !username.trim() ||
                typeof passwordHash !== 'string' || !/^[a-f0-9]{64}$/i.test(passwordHash)) {
                throw new Error('Las credenciales fiscales del taller no están configuradas.');
            }
        } else {
            issuer = EMISOR;
            numbering = NUMERACION;
            username = process.env.FACTURATECH_USER || '';
            passwordHash = process.env.FACTURATECH_PASSWORD || '';
        }

        this.user = username;
        // Facturatech recibe la contraseña ya hasheada (SHA-256).
        this.password = passwordHash;
        this.env = environmentPath;
        this.endpoint = `https://ws.facturatech.co/v2/${environmentPath}/index.php?wsdl`;
        this.tenantScoped = tenantScoped;
        this.issuer = Object.freeze({ ...issuer });
        this.numbering = Object.freeze({ ...numbering });

        // Es una opción de transporte del servidor, nunca del perfil del taller.
        this.proxyUrl = process.env.FACTURATECH_PROXY_URL || '';
        this.proxyAgent = this.proxyUrl ? new HttpsProxyAgent(this.proxyUrl) : null;
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
            `ENC_2:${this.issuer.nit};`,                        // NIT del emisor
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
            `EMI_1:${this.issuer.tipoPersona};`,                 // Tipo de persona (1=jurídica, 2=natural)
            `EMI_2:${this.issuer.nit};`,                         // NIT
            `EMI_3:31;`,                                        // Tipo de documento (31 = NIT)
            `EMI_4:${this.issuer.dv};`,                         // Dígito de verificación
            `EMI_6:${clean(this.issuer.razonSocial)};`,         // Razón social
            `EMI_7:${clean(this.issuer.nombreComercial)};`,     // Nombre comercial
            `EMI_10:${clean(this.issuer.direccion)};`,          // Dirección
            `EMI_11:${this.issuer.codigoDepto};`,               // Código departamento
            `EMI_12:${clean(this.issuer.ciudad)};`,             // Ciudad (nombre)
            `EMI_13:${clean(this.issuer.departamento)};`,       // Departamento (nombre)
            `EMI_14:${this.issuer.codigoCiudad};`,              // Código municipio
            `EMI_15:${this.issuer.pais};`,                      // País
            `EMI_18:${clean(this.issuer.direccion)};`,          // Dirección fiscal
            `EMI_19:${clean(this.issuer.departamento)};`,       // Departamento fiscal
            `EMI_21:Colombia;`,                                 // País nombre
            `EMI_22:${this.issuer.telefono};`,                  // Teléfono
            `EMI_23:${this.issuer.responsabilidad};`,           // Responsabilidades fiscales
            `EMI_24:${clean(this.issuer.nombreComercial)};`,    // Nombre del contacto
            `EMI_25:${this.issuer.regimen};`,                   // Régimen fiscal
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
            `ADQ_15:${this.issuer.pais};`,                      // País
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
            `TAC_1:${this.issuer.responsabilidad};`,            // Códigos de responsabilidad
            '(/TAC)',
            itemsLayout,
            '(/FACTURA)'  // Cierre del elemento raíz
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
        // A workshop-scoped upload can create a provider document even when its
        // response is lost. Never replay that mutation automatically; callers
        // must reconcile the reserved number before deciding what to do next.
        const retryable = !(this.tenantScoped && method === 'FtechAction.uploadInvoiceFileLayout');
        const maxAttempts = retryable ? 5 : 1;

        // Determinar si params es ya un envelope (string) o parámetros para construirlo
        let envelope;
        if (typeof params === 'string') {
            envelope = params;
        } else {
            envelope = this._crearSoapEnvelope(method, params);
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

            console.log(`[Facturatech] Response length: ${responseData?.length || 0} chars`);

            // Validar que la respuesta sea XML antes de parsear
            const trimmedData = (typeof responseData === 'string' ? responseData : '').trim();
            if (!trimmedData.startsWith('<?xml') && !trimmedData.startsWith('<')) {
                console.error('[Facturatech] Respuesta no es XML válido. Posible error de Cloudflare/WAF.');
                console.error('[Facturatech] El proveedor devolvió una respuesta no XML.');

                // Si falla, reintentar con backoff exponencial
                if (attempt < maxAttempts) {
                    const delay = Math.pow(2, attempt) * 5000; // Backoff más lento: 10s, 20s, 40s, 80s
                    console.log(`[Facturatech] Reintentando en ${delay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this._ejecutarSoap(method, params, customSoapAction, attempt + 1);
                }

                throw new Error('Respuesta de Facturatech no válida.');
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
            console.error(`[Facturatech] Error en ${method} (intento ${attempt}).`);

            // Si es un error 502/503/504 y aún hay intentos, reintentar con backoff
            if (error.response && [502, 503, 504].includes(error.response.status) && attempt < maxAttempts) {
                const delay = Math.pow(2, attempt) * 1000; // Backoff exponencial: 2s, 4s, 8s
                console.log(`[Facturatech] Reintentando en ${delay / 1000}s con headers alternativos...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._ejecutarSoap(method, params, customSoapAction, attempt + 1);
            }

            // Si es error de parsing XML y aún hay intentos, reintentar
            if (error.message && error.message.includes('Non-whitespace') && attempt < maxAttempts) {
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`[Facturatech] Error de parsing XML, reintentando en ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._ejecutarSoap(method, params, customSoapAction, attempt + 1);
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
                console.warn(`[Facturatech] Respuesta SOAP sin estructura esperada para ${method}.`);
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
            console.error('[Facturatech] No fue posible interpretar la respuesta del proveedor.');
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

        // No registrar el layout: contiene identificación fiscal y datos personales.
        console.log(`[Facturatech] Layout preparado (${sanitizedLayout.length} caracteres).`);

        // ================================================================
        // IMPORTANTE: Según la Figura 16 del manual de Facturatech,
        // el layout se envía en TEXTO PLANO SIN SALTOS DE LÍNEA.
        // Todo debe ir en una sola línea.
        // ================================================================

        // Eliminar saltos de línea - enviar todo en una sola línea
        const layoutOneLine = sanitizedLayout.replace(/\r?\n/g, '');

        console.log('[Facturatech] Enviando layout al proveedor.');

        // NOTA: this.password YA está hasheada en el constructor, no hashear de nuevo
        const params = {
            username: this.user,
            password: this.password,  // Ya es hash SHA256
            layout: layoutOneLine     // Texto plano SIN saltos de línea
        };

        // Namespace según manual
        const namespace = 'urn:FacturaTech';
        const method = 'FtechAction.uploadInvoiceFileLayout';

        const envelope = this._crearSoapEnvelope(method, params, namespace);

        // SOAPAction
        const soapAction = `"urn:FacturaTech#${method}"`;

        const result = await this._ejecutarSoap(method, envelope, soapAction);
        if (!result?.success) return result;

        const findTransactionId = (value, depth = 0) => {
            if (depth > 8 || value == null || typeof value !== 'object') return null;
            for (const [key, nested] of Object.entries(value)) {
                const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
                if (normalizedKey === 'transaccionid' || normalizedKey === 'transactionid') {
                    const candidate = String(nested ?? '').trim();
                    if (candidate && candidate.length <= 100 && !/[\u0000-\u001f\u007f]/.test(candidate)) {
                        return candidate;
                    }
                }
            }
            for (const nested of Object.values(value)) {
                const found = findTransactionId(nested, depth + 1);
                if (found) return found;
            }
            return null;
        };

        const transactionId = findTransactionId(result.data);
        if (!transactionId) {
            // A successful transport without the provider's transaction ID is
            // still ambiguous: the invoice may already exist remotely.
            return {
                ...result,
                success: false,
                ambiguous: true,
                error: 'Facturatech respondió sin el identificador de transacción.',
            };
        }
        return {...result, transactionId};
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
                status: findProviderValue(result.data, ['status', 'estado', 'code', 'codigo']),
                message: findProviderValue(result.data, ['message', 'mensaje', 'description', 'descripcion']),
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
            const pdfBase64 = findProviderValue(result.data, ['pdfBase64', 'resourceData', 'return']);
            return {
                success: !!pdfBase64,
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
            const cufe = findProviderValue(result.data, ['cufe', 'resourceData', 'return']);
            return {
                success: !!cufe,
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
     * Lee un candidato al siguiente número. No reserva el consecutivo de forma
     * atómica; la emisión multitaller debe sustituirlo por una reserva idempotente.
     */
    async obtenerSiguienteNumeroFactura(supabase) {
        try {
            // Consultar el último número usado
            const { data, error } = await supabase
                .from('facturas_electronicas')
                .select('numero_factura')
                .eq('prefijo', this.numbering.prefijo)
                .order('numero_factura', { ascending: false })
                .limit(1);

            if (error) throw new Error('Consulta del consecutivo fallida.');

            if (data && data.length > 0) {
                const previous = Number(data[0].numero_factura);
                if (!this.tenantScoped) return parseInt(data[0].numero_factura) + 1;
                if (!Number.isSafeInteger(previous) || previous < 0) {
                    throw new Error('El último consecutivo guardado no es válido.');
                }
                const nextNumber = Math.max(this.numbering.rangoDesde, previous + 1);
                if (!Number.isSafeInteger(nextNumber) || nextNumber > this.numbering.rangoHasta) {
                    throw new Error('El rango autorizado de numeración está agotado.');
                }
                return nextNumber;
            }

            if (!this.tenantScoped) return this.numbering.rangoDesde;
            const nextNumber = this.numbering.rangoDesde;
            if (!Number.isSafeInteger(nextNumber) || nextNumber > this.numbering.rangoHasta) {
                throw new Error('El rango autorizado de numeración está agotado.');
            }
            return nextNumber;
        } catch (_) {
            console.error('[Facturatech] No fue posible consultar el consecutivo fiscal.');
            // La ruta legacy conserva su comportamiento histórico. Una instalación
            // por taller siempre falla cerrada: nunca inventa un consecutivo fiscal.
            if (this.tenantScoped) {
                throw new Error('No se pudo verificar el consecutivo fiscal del taller.');
            }
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
