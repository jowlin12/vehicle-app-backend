const express = require('express');
const cors = require('cors');
const { supabase } = require('./database.js'); 
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const handlebars = require('handlebars');

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
    const driveUrl = response.data.data?.googleDrive?.viewLink || 
                     response.data.data?.googleDrive?.directLink || 
                     response.data.data?.googleDrive?.downloadLink ||
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
          viewLink: driveUrl,
          directLink: driveUrl,
          downloadLink: driveUrl
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
