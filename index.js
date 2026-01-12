const express = require('express');
const cors = require('cors');
const { supabase } = require('./database.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const handlebars = require('handlebars');
const FacturatechService = require('./facturatech-service.js');
const { NUMERACION } = require('./facturatech-config.js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

app.post('/api/generate-invoice', async (req, res) => {
  try {
    // Extraer los datos del cuerpo de la solicitud con la estructura correcta
    // Log detallado para depuración
    console.log('Datos recibidos:', JSON.stringify(req.body, null, 2));

    const { formato, repuestos, servicios, costos } = req.body;

    // Validar que los datos necesarios existen
    if (!formato || !costos) {
      return res.status(400).json({ error: 'Faltan datos para generar la factura.' });
    }

    const templateHtml = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="utf-8">
        <title>COTIZACIÓN - {{formato.clave_key}}</title>
        <link rel="stylesheet" href="https://jowlin12.github.io/invoice/style-new.css">
    </head>
    <body>
        <header class="invoice-header">
            <div class="company-info">
                <img class="logo" alt="Logo Empresa" src="https://raw.githubusercontent.com/jowlin12/invoice/refs/heads/main/fsimage.png">
                <address class="company-address">
                    <strong>MI TALLER MAZOS CAR</strong><br>
                    Calle 1 #7E-72 Quinta Oriental<br>
                    Cucuta, Norte De Santander<br>
                    Tel: 3184077646
                </address>
            </div>
            <div class="invoice-title">
                <h1>Cotización</h1>
                <div class="invoice-number">Remisión #<span>{{formato.clave_key}}</span></div>
                <div class="invoice-date">Fecha: <span>{{formato.fecha_entrada}}</span></div>
            </div>
        </header>
        <main>
            <section class="customer-vehicle-info">
                <div class="customer-details">
                    <h2>Cliente</h2>
                    <p>{{formato.nombre_cliente}}</p>
                </div>
                <div class="vehicle-details">
                    <h2>Vehículo</h2>
                    <p><strong>Marca:</strong> {{formato.marca}}</p>
                    <p><strong>Tipo:</strong> {{formato.tipo_vehiculo}}</p>
                    <p><strong>Placa:</strong> {{formato.placa}}</p>
                    <p><strong>Kilometraje:</strong> {{formato.kilometraje}}</p>
                </div>
            </section>
            <section class="invoice-items">
                <h2>Detalle de Repuestos y Servicios</h2>
                <div class="table-wrapper">
                    <table class="items-table">
                    <thead>
                        <tr>
                            <th class="col-qty">CANTIDAD</th>
                            <th class="col-desc">PRODUCTO / SERVICIO</th>
                            <th>PRECIO UNITARIO</th>
                            <th class="col-price">SUBTOTAL</th>
                        </tr>
                    </thead>
                    <tbody>
                        {{{ repuestos_html }}}
                    </tbody>

                    </table>
                </div>
            </section>
            <section class="invoice-summary">
                <table class="totals-table">
                    <tbody>
                        <tr>
                            <th>Mano de Obra</th>
                            <td>{{costos.mano_obra_formateado}}</td>
                        </tr>
                        <tr class="total-row">
                            <th>Total a Pagar</th>
                            <td>{{costos.total_formateado}}</td>
                        </tr>
                    </tbody>
                </table>
            </section>
            <section class="observations">
                 <h2>Observaciones del Vehículo</h2>
                 <p>{{formato.observaciones}}</p>
            </section>
        </main>
        <footer class="notes-section">
            <h2>Notas Adicionales</h2>
            <p>Si prefiere realizar el pago mediante transferencia bancaria, ponemos a su disposición las siguientes cuentas:</p>
            <div class="bank-details">
                <p><strong>Bancolombia:</strong></p>
                <p>Número de Cuenta: 832 044 587 77</p>
                <p>Tipo de Cuenta: Cuenta de Ahorros</p>
            </div>
             <p class="thank-you">¡Gracias por su confianza!</p>
        </footer>
    </body>
    </html>
    `;

    // Generar filas de la tabla para repuestos y servicios
    let repuestos_html = '';
    if (repuestos && repuestos.length > 0) {
      repuestos_html = repuestos.map(r => `
            <tr>
                <td>${r.cantidad}</td>
                <td>${r.descripcion}</td>
                <td>${(r.costo_unitario || 0).toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 })}</td>
                <td>${(r.cantidad * (r.costo_unitario || 0)).toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 })}</td>
            </tr>
        `).join('');
    }


    const template = handlebars.compile(templateHtml);
    const finalHtml = template({
      formato,
      repuestos,
      servicios,
      repuestos_html,

      costos: {
        ...costos,
        mano_obra_formateado: costos.mano_obra.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }),
        total_formateado: costos.total.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 })
      },
      currentDate: new Date().toLocaleDateString('es-CO')
    });

    // Usar la nueva API propia para convertir HTML a PDF y guardarlo en Google Drive
    console.log('Generando PDF con la API propia...');

    const response = await axios.post('https://api-pdf-to-html-vercel.vercel.app/api/convert/html-to-pdf',
      {
        html: finalHtml,
        filename: `${formato.clave_key}.pdf`,
        pdfOptions: {
          format: "A4",
          margin: {
            top: "20px",
            right: "20px",
            bottom: "20px",
            left: "20px"
          }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    // La nueva API devuelve la URL en una estructura anidada
    // Priorizar la URL de descarga directa para evitar problemas de formato
    const driveUrl = response.data.data?.googleDrive?.directLink ||
      response.data.data?.googleDrive?.downloadLink ||
      response.data.data?.googleDrive?.viewLink ||
      response.data.url ||
      response.data.driveUrl ||
      response.data;

    // Lógica para crear o actualizar la factura en la base de datos
    const { data: existingInvoice } = await supabase
      .from('facturas')
      .select('id_formato')
      .eq('id_formato', formato.clave_key)
      .maybeSingle();

    if (existingInvoice) {
      // Si existe, actualiza la factura
      await supabase
        .from('facturas')
        .update({
          precio_factura: costos.total,
          factura_pdf: driveUrl
        })
        .eq('id_formato', formato.clave_key);
    } else {
      // Si no existe, crea una nueva factura
      await supabase
        .from('facturas')
        .insert({
          id_formato: formato.clave_key,
          precio_factura: costos.total,
          debe: costos.total,
          factura_pdf: driveUrl,
          estado: 'PENDIENTE',
          cliente: formato.nombre_cliente
        });
    }

    // Finalmente, actualiza la URL en la tabla de formatos también
    await supabase
      .from('formatos')
      .update({ url_documento: driveUrl })
      .eq('clave_key', formato.clave_key);

    res.status(200).json({
      success: true,
      message: 'Factura generada exitosamente',
      data: {
        pdf: {
          fileName: `factura-${formato.clave_key}.pdf`,
          url: driveUrl
        },
        googleDrive: {
          directLink: driveUrl,
          downloadLink: driveUrl,
          viewLink: response.data.data?.googleDrive?.viewLink || driveUrl
        }
      },
      // Campos adicionales para compatibilidad
      invoiceUrl: driveUrl,
      pdfUrl: driveUrl,
      url: driveUrl,
      driveUrl: driveUrl,
      factura_pdf: driveUrl,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error detallado al generar la factura:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Ocurrió un error en el servidor al generar el PDF con la API propia.' });
  }
});

// Endpoint para crear un nuevo trabajador
app.post('/api/workers', async (req, res) => {
  const { full_name } = req.body;

  if (!full_name) {
    return res.status(400).json({ error: 'El nombre completo es requerido.' });
  }

  try {
    // 1. Generar credenciales únicas y temporales para el nuevo usuario
    const email = `${full_name.split(' ')[0].toLowerCase()}${Date.now()}@taller.local`; // Email único no real
    const temporal_password = Math.random().toString(36).slice(-8);
    const username = full_name.split(' ')[0].toLowerCase() + Math.floor(Math.random() * 1000);

    // 2. Crear el usuario en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      password: temporal_password,
      email_confirm: true, // Marcar como confirmado para que pueda iniciar sesión
    });

    if (authError) {
      console.error('Error de Supabase Auth:', authError);
      return res.status(500).json({ error: `Error al crear usuario de autenticación: ${authError.message}` });
    }

    const userId = authData.user.id;

    // 3. Actualizar el perfil del usuario en la tabla 'profiles' con los detalles
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .update({
        full_name: full_name,
        username: username,
        must_change_password: true // Forzar cambio de contraseña en el primer login
      })
      .eq('id', userId)
      .select()
      .single();

    if (profileError) {
      console.error('Error de Supabase Profile:', profileError);
      return res.status(500).json({ error: `Error al actualizar el perfil: ${profileError.message}` });
    }

    // 4. Devolver las credenciales para que el administrador las comparta
    res.status(201).json({
      message: 'Trabajador creado con éxito',
      username: profileData.username, // Devolver el username guardado
      temporal_password,
    });

  } catch (error) {
    console.error('Error del servidor:', error);
    res.status(500).json({ error: 'Ocurrió un error inesperado en el servidor.' });
  }
});

// Endpoint para que un trabajador configure su email y contraseña por primera vez
app.put('/api/workers/me/setup', async (req, res) => {
  const { newEmail, newPassword } = req.body;
  const token = req.headers.authorization?.split(' ')[1];

  // 1. Validaciones básicas
  if (!token) {
    return res.status(401).json({ error: 'No autorizado: Token no proporcionado.' });
  }
  if (!newEmail || !newPassword) {
    return res.status(400).json({ error: 'El nuevo email y la nueva contraseña son requeridos.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }

  try {
    // 2. Verificar el token y obtener el usuario
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return res.status(401).json({ error: 'No autorizado: Token inválido.' });
    }

    const userId = user.id;

    // 3. Actualizar el usuario en Supabase Auth (email y contraseña)
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      userId,
      { email: newEmail, password: newPassword }
    );

    if (updateError) {
      console.error('Error al actualizar credenciales en Supabase Auth:', updateError);
      return res.status(500).json({ error: `Error al actualizar credenciales: ${updateError.message}` });
    }

    // 4. Actualizar el perfil para que no se le vuelva a pedir el cambio
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', userId);

    if (profileError) {
      console.error('Error al actualizar el perfil (must_change_password):', profileError);
      // No se considera un error fatal, pero se debe registrar
    }

    // 5. Devolver una respuesta exitosa
    res.status(200).json({ message: '¡Cuenta configurada exitosamente!' });

  } catch (error) {
    console.error('Error inesperado en /api/workers/me/setup:', error);
    res.status(500).json({ error: 'Ocurrió un error inesperado en el servidor.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FACTURACIÓN ELECTRÓNICA - Endpoints
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/e-invoice/generate-preview
 * 
 * Genera una vista previa de la factura electrónica.
 * - Genera el XML Layout
 * - Lo envía a Facturatech
 * - Descarga el PDF preview
 * - Retorna el transactionId y URL del PDF
 */
app.post('/api/e-invoice/generate-preview', async (req, res) => {
  try {
    const { idFormato, cliente, items, manoDeObra } = req.body;

    console.log('[E-Invoice] Generando preview para formato:', idFormato);

    // Validaciones
    if (!idFormato) {
      return res.status(400).json({ error: 'idFormato es requerido' });
    }
    if (!cliente || !cliente.numeroDocumento || !cliente.razonSocial) {
      return res.status(400).json({ error: 'Datos del cliente incompletos' });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Se requiere al menos un item' });
    }

    // Inicializar servicio
    const facturatechService = new FacturatechService();

    // Obtener siguiente número de factura
    const numeroFactura = await facturatechService.obtenerSiguienteNumeroFactura(supabase);
    console.log('[E-Invoice] Número de factura asignado:', numeroFactura);

    // Preparar items (agregar mano de obra si existe)
    const itemsCompletos = [...items];
    if (manoDeObra && manoDeObra > 0) {
      itemsCompletos.push({
        codigo: 'MO001',
        descripcion: 'Mano de obra',
        cantidad: 1,
        precioUnitario: manoDeObra,
        porcentajeIva: 19
      });
    }

    // Calcular totales
    const totales = facturatechService.calcularTotales(itemsCompletos);
    console.log('[E-Invoice] Totales calculados:', totales);

    // Generar XML Layout
    const xmlLayout = facturatechService.generarXmlLayout(
      cliente,
      itemsCompletos,
      totales,
      numeroFactura,
      `Orden: ${idFormato}`
    );

    console.log('[E-Invoice] XML Layout generado, enviando a Facturatech...');

    // Subir a Facturatech
    const uploadResult = await facturatechService.uploadInvoiceFileLayout(xmlLayout);

    if (!uploadResult.success) {
      console.error('[E-Invoice] Error al subir a Facturatech:', uploadResult.error);
      return res.status(500).json({
        error: 'Error al enviar a Facturatech',
        details: uploadResult.error
      });
    }

    const transactionId = uploadResult.transactionId;
    console.log('[E-Invoice] Factura subida, transactionId:', transactionId);

    // Esperar un momento para que Facturatech procese
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Consultar estado
    const statusResult = await facturatechService.documentStatusFile(transactionId);
    console.log('[E-Invoice] Estado del documento:', statusResult);

    // Intentar descargar PDF
    let pdfUrl = null;
    try {
      const pdfResult = await facturatechService.downloadPDFFile(NUMERACION.prefijo, numeroFactura);
      if (pdfResult.success && pdfResult.pdfBase64) {
        // Subir PDF a almacenamiento (usando la API de PDF existente)
        const pdfBuffer = Buffer.from(pdfResult.pdfBase64, 'base64');

        // Guardar temporalmente y subir a Google Drive
        const response = await axios.post('https://api-pdf-to-html-vercel.vercel.app/api/upload/base64', {
          base64: pdfResult.pdfBase64,
          filename: `FE-${NUMERACION.prefijo}${numeroFactura}.pdf`,
          mimeType: 'application/pdf'
        });

        pdfUrl = response.data.data?.googleDrive?.directLink || response.data.url;
        console.log('[E-Invoice] PDF subido a storage:', pdfUrl);
      }
    } catch (pdfError) {
      console.error('[E-Invoice] Error descargando PDF:', pdfError.message);
      // Continuar sin PDF por ahora
    }

    // Guardar registro preliminar en Supabase
    const { data: facturaData, error: insertError } = await supabase
      .from('facturas_electronicas')
      .insert({
        id_formato: idFormato,
        transaction_id: transactionId,
        prefijo: NUMERACION.prefijo,
        numero_factura: numeroFactura.toString(),
        estado: 'PREVIEW',
        pdf_url: pdfUrl,
        adq_tipo_doc: cliente.tipoDocumento,
        adq_numero_doc: cliente.numeroDocumento,
        adq_razon_social: cliente.razonSocial,
        base_gravable: totales.baseGravable,
        iva: totales.iva,
        total: totales.total
      })
      .select()
      .single();

    if (insertError) {
      console.error('[E-Invoice] Error guardando en DB:', insertError);
    }

    res.status(200).json({
      success: true,
      message: 'Vista previa generada exitosamente',
      data: {
        transactionId,
        numeroFactura: `${NUMERACION.prefijo}${numeroFactura}`,
        pdfUrl,
        status: statusResult.status || 'procesando',
        totales,
        facturaId: facturaData?.id
      }
    });

  } catch (error) {
    console.error('[E-Invoice] Error general:', error);
    res.status(500).json({
      error: 'Error al generar vista previa de factura electrónica',
      details: error.message
    });
  }
});

/**
 * POST /api/e-invoice/confirm
 * 
 * Confirma una factura electrónica y obtiene los recursos finales (CUFE, PDF firmado)
 */
app.post('/api/e-invoice/confirm', async (req, res) => {
  try {
    const { transactionId } = req.body;

    if (!transactionId) {
      return res.status(400).json({ error: 'transactionId es requerido' });
    }

    console.log('[E-Invoice] Confirmando factura:', transactionId);

    // Buscar la factura en la base de datos
    const { data: factura, error: fetchError } = await supabase
      .from('facturas_electronicas')
      .select('*')
      .eq('transaction_id', transactionId)
      .single();

    if (fetchError || !factura) {
      return res.status(404).json({ error: 'Factura no encontrada' });
    }

    const facturatechService = new FacturatechService();

    // Consultar estado actual
    const statusResult = await facturatechService.documentStatusFile(transactionId);
    console.log('[E-Invoice] Estado actual:', statusResult);

    // Obtener CUFE
    let cufe = null;
    try {
      const cufeResult = await facturatechService.getCUFEFile(
        factura.prefijo,
        factura.numero_factura
      );
      if (cufeResult.success) {
        cufe = cufeResult.cufe;
        console.log('[E-Invoice] CUFE obtenido:', cufe);
      }
    } catch (cufeError) {
      console.error('[E-Invoice] Error obteniendo CUFE:', cufeError.message);
    }

    // Obtener PDF firmado
    let pdfUrl = factura.pdf_url;
    try {
      const pdfResult = await facturatechService.downloadPDFFile(
        factura.prefijo,
        factura.numero_factura
      );
      if (pdfResult.success && pdfResult.pdfBase64) {
        // Subir a storage
        const response = await axios.post('https://api-pdf-to-html-vercel.vercel.app/api/upload/base64', {
          base64: pdfResult.pdfBase64,
          filename: `FE-${factura.prefijo}${factura.numero_factura}-FIRMADO.pdf`,
          mimeType: 'application/pdf'
        });
        pdfUrl = response.data.data?.googleDrive?.directLink || response.data.url || pdfUrl;
        console.log('[E-Invoice] PDF firmado subido:', pdfUrl);
      }
    } catch (pdfError) {
      console.error('[E-Invoice] Error descargando PDF firmado:', pdfError.message);
    }

    // Actualizar registro en Supabase
    const { data: updatedFactura, error: updateError } = await supabase
      .from('facturas_electronicas')
      .update({
        estado: cufe ? 'VALIDADA' : 'PROCESANDO',
        cufe: cufe,
        pdf_url: pdfUrl,
        response_code: statusResult.status,
        response_message: statusResult.message
      })
      .eq('id', factura.id)
      .select()
      .single();

    if (updateError) {
      console.error('[E-Invoice] Error actualizando DB:', updateError);
    }

    res.status(200).json({
      success: true,
      message: cufe ? 'Factura electrónica validada exitosamente' : 'Factura en proceso de validación',
      data: {
        id: updatedFactura?.id || factura.id,
        transactionId,
        numeroFactura: `${factura.prefijo}${factura.numero_factura}`,
        cufe,
        pdfUrl,
        estado: cufe ? 'VALIDADA' : 'PROCESANDO',
        totales: {
          baseGravable: factura.base_gravable,
          iva: factura.iva,
          total: factura.total
        }
      }
    });

  } catch (error) {
    console.error('[E-Invoice] Error en confirmación:', error);
    res.status(500).json({
      error: 'Error al confirmar factura electrónica',
      details: error.message
    });
  }
});

/**
 * GET /api/e-invoice/status/:transactionId
 * 
 * Consulta el estado de una factura electrónica
 */
app.get('/api/e-invoice/status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;

    // Buscar en base de datos
    const { data: factura, error } = await supabase
      .from('facturas_electronicas')
      .select('*')
      .eq('transaction_id', transactionId)
      .single();

    if (error || !factura) {
      return res.status(404).json({ error: 'Factura no encontrada' });
    }

    // Si no está validada, consultar a Facturatech
    if (factura.estado !== 'VALIDADA') {
      const facturatechService = new FacturatechService();
      const statusResult = await facturatechService.documentStatusFile(transactionId);

      // Actualizar estado si cambió
      if (statusResult.status && statusResult.status !== factura.response_code) {
        await supabase
          .from('facturas_electronicas')
          .update({
            response_code: statusResult.status,
            response_message: statusResult.message
          })
          .eq('id', factura.id);
      }
    }

    res.status(200).json({
      success: true,
      data: factura
    });

  } catch (error) {
    console.error('[E-Invoice] Error consultando estado:', error);
    res.status(500).json({ error: 'Error al consultar estado' });
  }
});

/**
 * GET /api/e-invoice/list
 * 
 * Lista las facturas electrónicas emitidas
 */
app.get('/api/e-invoice/list', async (req, res) => {
  try {
    const { estado, busqueda, limit = 50 } = req.query;

    let query = supabase
      .from('facturas_electronicas')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (estado) {
      query = query.eq('estado', estado);
    }

    if (busqueda) {
      query = query.or(`adq_razon_social.ilike.%${busqueda}%,numero_factura.ilike.%${busqueda}%,adq_numero_doc.ilike.%${busqueda}%`);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    res.status(200).json({
      success: true,
      data: data || [],
      count: data?.length || 0
    });

  } catch (error) {
    console.error('[E-Invoice] Error listando facturas:', error);
    res.status(500).json({ error: 'Error al listar facturas electrónicas' });
  }
});

/**
 * GET /api/e-invoice/download/:type/:prefix/:folio
 * 
 * Descarga recursos de una factura (PDF, XML, QR)
 */
app.get('/api/e-invoice/download/:type/:prefix/:folio', async (req, res) => {
  try {
    const { type, prefix, folio } = req.params;

    const facturatechService = new FacturatechService();
    let result;
    let filename;
    let contentType;

    switch (type.toLowerCase()) {
      case 'pdf':
        result = await facturatechService.downloadPDFFile(prefix, folio);
        filename = `FE-${prefix}${folio}.pdf`;
        contentType = 'application/pdf';
        break;
      case 'xml':
        result = await facturatechService.downloadXMLFile(prefix, folio);
        filename = `FE-${prefix}${folio}.xml`;
        contentType = 'application/xml';
        break;
      case 'qr':
        result = await facturatechService.getQRImageFile(prefix, folio);
        filename = `QR-${prefix}${folio}.png`;
        contentType = 'image/png';
        break;
      default:
        return res.status(400).json({ error: 'Tipo de descarga no válido. Use: pdf, xml o qr' });
    }

    if (!result.success) {
      return res.status(404).json({ error: result.error || 'Recurso no encontrado' });
    }

    const base64Data = result.pdfBase64 || result.xmlBase64 || result.qrImageBase64;
    if (!base64Data) {
      return res.status(404).json({ error: 'No se pudo obtener el recurso' });
    }

    const buffer = Buffer.from(base64Data, 'base64');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);

  } catch (error) {
    console.error('[E-Invoice] Error en descarga:', error);
    res.status(500).json({ error: 'Error al descargar recurso' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CLIENTES FISCALES - Endpoints
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/clientes-fiscales/buscar
 * 
 * Busca clientes fiscales por documento o nombre
 */
app.get('/api/clientes-fiscales/buscar', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.status(200).json({ success: true, data: [] });
    }

    const { data, error } = await supabase
      .from('clientes_fiscales')
      .select('*')
      .or(`numero_documento.ilike.%${q}%,razon_social.ilike.%${q}%`)
      .limit(20);

    if (error) throw error;

    res.status(200).json({ success: true, data: data || [] });

  } catch (error) {
    console.error('[Clientes] Error en búsqueda:', error);
    res.status(500).json({ error: 'Error al buscar clientes' });
  }
});

/**
 * POST /api/clientes-fiscales
 * 
 * Crea o actualiza un cliente fiscal
 */
app.post('/api/clientes-fiscales', async (req, res) => {
  try {
    const cliente = req.body;

    if (!cliente.numero_documento || !cliente.razon_social) {
      return res.status(400).json({ error: 'Datos del cliente incompletos' });
    }

    const { data, error } = await supabase
      .from('clientes_fiscales')
      .upsert(cliente, { onConflict: 'numero_documento' })
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({ success: true, data });

  } catch (error) {
    console.error('[Clientes] Error guardando cliente:', error);
    res.status(500).json({ error: 'Error al guardar cliente' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
