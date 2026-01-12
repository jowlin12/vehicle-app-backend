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
const { EMISOR, ENDPOINTS, NUMERACION, TIPOS_DOCUMENTO_DIAN } = require('./facturatech-config');

class FacturatechService {
    constructor() {
        this.user = process.env.FACTURATECH_USER || '';
        this.password = this._hashPassword(process.env.FACTURATECH_PASSWORD || '');
        this.env = process.env.FACTURATECH_ENV || 'demo';
        this.endpoint = ENDPOINTS[this.env];

        // Debug de variables de entorno (ofuscado)
        console.log('[Facturatech] Variables de entorno detectadas:', {
            USER: !!process.env.FACTURATECH_USER,
            PASS: !!process.env.FACTURATECH_PASSWORD,
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
     * IMPORTANTE: El método uploadInvoiceFileLayout NO acepta XML.
     * Usa formato propietario: [FACTURA], (SECCION), CAMPO;VALOR;
     */
    generarXmlLayout(adquiriente, items, totales, numeroFactura, referencia = '') {
        const fechaActual = new Date().toISOString().split('T')[0];
        const horaActual = new Date().toTimeString().split(' ')[0];

        // Obtener código DIAN del tipo de documento
        const tipoDocDian = TIPOS_DOCUMENTO_DIAN[adquiriente.tipoDocumento] || '13';

        // Función helper para limpiar valores (sin punto y coma ni saltos de línea)
        const clean = (val) => String(val || '').replace(/;/g, ',').replace(/\n/g, ' ').trim();

        // Generar items en formato Layout
        const itemsLayout = items.map((item, index) => {
            const subtotal = item.cantidad * item.precioUnitario;
            const valorIva = subtotal * (item.porcentajeIva / 100);
            const totalLinea = subtotal + valorIva;

            return [
                '(ITE)',
                `ITE_1;${index + 1};`,
                `ITE_3;${clean(item.codigo || `ITEM${index + 1}`)};`,
                `ITE_4;${item.cantidad};`,
                `ITE_5;EA;`,
                `ITE_6;${item.precioUnitario.toFixed(2)};`,
                `ITE_7;${subtotal.toFixed(2)};`,
                `ITE_10;${clean(item.descripcion)};`,
                `ITE_11;01;`,
                `ITE_14;${item.porcentajeIva.toFixed(2)};`,
                `ITE_15;${valorIva.toFixed(2)};`,
                `ITE_18;${totalLinea.toFixed(2)};`,
                '(/ITE)'
            ].join('\r\n');
        }).join('\r\n');

        // Construir Layout completo en formato Flat File
        const layout = [
            '[FACTURA]',
            '(ENC)',
            'ENC_1;01;',
            `ENC_2;${NUMERACION.prefijo};`,
            `ENC_3;${numeroFactura};`,
            `ENC_4;${fechaActual};`,
            `ENC_5;${horaActual};`,
            `ENC_6;${fechaActual};`,
            'ENC_7;01;',
            'ENC_9;COP;',
            'ENC_10;10;',
            `ENC_16;${clean(referencia)};`,
            '(/ENC)',
            '(EMI)',
            `EMI_1;${EMISOR.tipoPersona};`,
            `EMI_2;${EMISOR.nit};`,
            `EMI_3;${EMISOR.dv};`,
            `EMI_6;${clean(EMISOR.razonSocial)};`,
            `EMI_7;${clean(EMISOR.nombreComercial)};`,
            `EMI_10;${clean(EMISOR.direccion)};`,
            `EMI_11;${EMISOR.codigoCiudad};`,
            `EMI_12;${clean(EMISOR.ciudad)};`,
            `EMI_13;${clean(EMISOR.departamento)};`,
            `EMI_14;${EMISOR.codigoDepto};`,
            `EMI_15;${EMISOR.pais};`,
            `EMI_19;${EMISOR.telefono};`,
            `EMI_23;${EMISOR.responsabilidad};`,
            `EMI_24;${EMISOR.regimen};`,
            '(/EMI)',
            '(ADQ)',
            `ADQ_1;${adquiriente.tipoPersona || '2'};`,
            `ADQ_2;${adquiriente.numeroDocumento};`,
            `ADQ_3;${adquiriente.dv || ''};`,
            `ADQ_5;${tipoDocDian};`,
            `ADQ_6;${clean(adquiriente.razonSocial)};`,
            `ADQ_7;${clean(adquiriente.nombreComercial || adquiriente.razonSocial)};`,
            `ADQ_10;${clean(adquiriente.direccion)};`,
            `ADQ_11;${adquiriente.codigoCiudad || '54001'};`,
            `ADQ_12;${clean(adquiriente.ciudad || 'Cúcuta')};`,
            `ADQ_13;${clean(adquiriente.departamento || 'Norte de Santander')};`,
            `ADQ_14;${adquiriente.codigoDepto || '54'};`,
            'ADQ_15;CO;',
            `ADQ_19;${adquiriente.telefono || ''};`,
            `ADQ_22;${adquiriente.email || ''};`,
            `ADQ_23;${adquiriente.responsabilidad || 'R-99-PN'};`,
            `ADQ_24;${adquiriente.regimen || '49'};`,
            '(/ADQ)',
            '(TOT)',
            `TOT_1;${totales.baseGravable.toFixed(2)};`,
            'TOT_2;01;',
            `TOT_3;${totales.iva.toFixed(2)};`,
            `TOT_4;${totales.total.toFixed(2)};`,
            `TOT_4;${totales.total.toFixed(2)};`,
            '(/TOT)',
            itemsLayout
        ].join('\r\n');

        return layout;
    }

    /**
     * Crea el envelope SOAP para una llamada al webservice
     */
    _crearSoapEnvelope(method, params) {
        const paramsXml = Object.entries(params)
            .map(([key, value]) => `<${key}>${this._escapeXml(value)}</${key}>`)
            .join('');

        return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:FacturaTech"><soapenv:Body><urn:${method}>${paramsXml}</urn:${method}></soapenv:Body></soapenv:Envelope>`;
    }

    /**
     * Ejecuta una llamada SOAP al webservice con reintentos
     */
    async _ejecutarSoap(method, params, attempt = 1) {
        const maxAttempts = 5; // Aumentado para manejar bloqueos intermitentes de Cloudflare
        const envelope = this._crearSoapEnvelope(method, params);

        console.log(`[Facturatech] Ejecutando método: ${method} (intento ${attempt}/${maxAttempts})`);
        console.log(`[Facturatech] Endpoint: ${this.endpoint}`);

        // Validar credenciales antes de enviar
        if (!this.user || !this.password) {
            console.warn('[Facturatech] ¡PELIGRO! Credenciales vacías. La solicitud fallará.');
        } else if (this.user.length < 8) {
            console.warn(`[Facturatech] ¡ADVERTENCIA! El usuario '${this.user}' tiene ${this.user.length} dígitos. ¿Es correcto? (NIT suele tener 9 o 10 con DV, o 8-9 sin DV).`);
        }

        // Log parcial del payload para debug (sin revelar password completo)
        if (params.file && attempt === 1) {
            try {
                const sample = Buffer.from(params.file, 'base64').toString('utf-8').substring(0, 500);
                console.log('[Facturatech] CHECK XML LAYOUT (Decoded Part):', sample);
            } catch (err) {
                console.error('Error decodificando sample de base64:', err);
            }
        }

        // Headers SOAP 1.1 - SOAPAction DEBE estar entre comillas dobles según especificación
        // Content-Type DEBE ser text/xml para SOAP 1.1 (application/soap+xml es para SOAP 1.2)
        const headersVariants = [
            {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': `"urn:FacturaTech#${method}"`,
                'User-Agent': 'PHP-SOAP/8.1',
                'Accept': 'text/xml',
                'Connection': 'keep-alive'
            },
            {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': `"urn:FacturaTech#${method}"`,
                'User-Agent': 'NuSOAP/0.9.5 (1.123)',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            },
            {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': `"urn:FacturaTech#${method}"`,
                'User-Agent': 'Mozilla/5.0 (compatible; FacturaTech-Client/1.0)',
                'Accept': 'text/xml, application/xml, */*',
                'Connection': 'keep-alive'
            }
        ];

        const headers = headersVariants[(attempt - 1) % headersVariants.length];

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

            // Log de respuesta - si es corta, mostrar completa para diagnóstico
            const previewLength = responseData.length < 1000 ? responseData.length : 500;
            console.log(`[Facturatech] Response preview (${method}) [${responseData.length} chars]:`,
                typeof responseData === 'string' ? responseData.substring(0, previewLength) : JSON.stringify(responseData).substring(0, previewLength));

            // Validar que la respuesta sea XML antes de parsear
            const trimmedData = (typeof responseData === 'string' ? responseData : '').trim();
            if (!trimmedData.startsWith('<?xml') && !trimmedData.startsWith('<')) {
                console.error('[Facturatech] Respuesta no es XML válido. Posible error de Cloudflare/WAF.');
                console.error('[Facturatech] Contenido COMPLETO recibido:', responseData);

                // Si no es XML y hay intentos, reintentar con más delay
                if (attempt < maxAttempts) {
                    const delay = Math.pow(2, attempt) * 2000; // Backoff más agresivo: 4s, 8s, 16s, 32s
                    console.log(`[Facturatech] Reintentando en ${delay / 1000}s debido a respuesta inválida...`);
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
        console.log(`[Facturatech] Layout Start Hex: ${hexPreview}`);

        const xmlBase64 = Buffer.from(sanitizedLayout, 'utf-8').toString('base64');

        // Log del XML antes de codificar para verificar formato
        console.log('[Facturatech] XML Layout primeros 300 chars:', sanitizedLayout.substring(0, 300));

        const result = await this._ejecutarSoap('FtechAction.uploadInvoiceFileLayout', {
            username: this.user,
            password: this.password,
            layout: xmlBase64  // Cambiado de 'file' a 'layout' según el manual
        });

        // LOG DETALLADO de la respuesta completa
        console.log('[Facturatech] Resultado completo:', JSON.stringify(result, null, 2));

        if (result.success && result.data) {
            const data = result.data.return || result.data;

            // Log detallado de los campos recibidos
            console.log('[Facturatech] Data extraída:', JSON.stringify(data, null, 2));

            // Si hay un ID de transacción válido
            if (data.transaccionID && data.transaccionID !== '0') {
                return {
                    success: true,
                    transactionId: String(data.transaccionID)
                };
            }

            return {
                success: false,
                error: data.error || data.mensaje || data.message || 'No se obtuvo ID de transacción',
                code: data.code || data.codigo
            };
        }

        return {
            success: false,
            error: result.error || 'Error al subir factura'
        };
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
