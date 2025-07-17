const express = require('express');
const pdf = require('html-pdf');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuración de multer para archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    fs.ensureDirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Crear directorios necesarios
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
fs.ensureDirSync(uploadsDir);
fs.ensureDirSync(outputDir);

// Ruta principal
app.get('/', (req, res) => {
  res.json({
    message: 'API de conversión HTML a PDF',
    endpoints: {
      'POST /convert-html-content': 'Convierte contenido HTML a PDF',
      'POST /convert-html-file': 'Convierte archivo HTML a PDF',
      'GET /download/:filename': 'Descarga archivo PDF generado'
    }
  });
});

// Endpoint para convertir contenido HTML a PDF
app.post('/convert-html-content', async (req, res) => {
  try {
    // Aceptar tanto 'html' como 'htmlContent' para compatibilidad
    const { html, htmlContent, filename = 'document', options = {} } = req.body;
    const content = html || htmlContent;

    if (!content) {
      return res.status(400).json({ 
        error: 'Se requiere contenido HTML',
        details: 'Envía el HTML en el campo "html" o "htmlContent"'
      });
    }

    // Configuración por defecto para PDF
    const pdfOptions = {
      format: 'A4',
      border: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px'
      },
      ...options
    };

    // Generar PDF
    const pdfFileName = `${filename}-${Date.now()}.pdf`;
    const pdfPath = path.join(outputDir, pdfFileName);
    
    pdf.create(content, pdfOptions).toFile(pdfPath, (err, result) => {
      if (err) {
        console.error('Error al generar PDF:', err);
        return res.status(500).json({ 
          error: 'Error al generar PDF',
          details: err.message 
        });
      }

      // Obtener tamaño del archivo
      fs.stat(pdfPath, (statErr, stats) => {
        if (statErr) {
          console.error('Error al obtener estadísticas del archivo:', statErr);
          return res.status(500).json({ 
            error: 'Error al procesar archivo',
            details: statErr.message 
          });
        }

        // Enviar respuesta con información del archivo
        res.json({
          success: true,
          message: 'PDF generado exitosamente',
          filename: pdfFileName,
          downloadUrl: `/download/${pdfFileName}`,
          size: stats.size
        });
      });
    });

  } catch (error) {
    console.error('Error al convertir HTML a PDF:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: error.message 
    });
  }
});

// Endpoint para convertir archivo HTML a PDF
app.post('/convert-html-file', upload.single('htmlFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Se requiere un archivo HTML' });
    }

    const { filename = 'document', options = {} } = req.body;
    let parsedOptions = {};
    
    try {
      parsedOptions = typeof options === 'string' ? JSON.parse(options) : options;
    } catch (e) {
      parsedOptions = {};
    }

    // Leer contenido del archivo HTML
    const htmlContent = await fs.readFile(req.file.path, 'utf8');

    // Configuración por defecto para PDF
    const pdfOptions = {
      format: 'A4',
      border: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px'
      },
      ...parsedOptions
    };

    // Generar PDF
    const pdfFileName = `${filename}-${Date.now()}.pdf`;
    const pdfPath = path.join(outputDir, pdfFileName);
    
    pdf.create(htmlContent, pdfOptions).toFile(pdfPath, async (err, result) => {
      // Limpiar archivo temporal
      try {
        await fs.remove(req.file.path);
      } catch (cleanupError) {
        console.error('Error al limpiar archivo temporal:', cleanupError);
      }

      if (err) {
        console.error('Error al generar PDF:', err);
        return res.status(500).json({ 
          error: 'Error al generar PDF',
          details: err.message 
        });
      }

      // Obtener tamaño del archivo
      fs.stat(pdfPath, (statErr, stats) => {
        if (statErr) {
          console.error('Error al obtener estadísticas del archivo:', statErr);
          return res.status(500).json({ 
            error: 'Error al procesar archivo',
            details: statErr.message 
          });
        }

        // Enviar respuesta con información del archivo
        res.json({
          success: true,
          message: 'PDF generado exitosamente desde archivo HTML',
          filename: pdfFileName,
          downloadUrl: `/download/${pdfFileName}`,
          size: stats.size
        });
      });
    });

  } catch (error) {
    console.error('Error al convertir archivo HTML a PDF:', error);
    
    // Limpiar archivo temporal en caso de error
    if (req.file) {
      try {
        await fs.remove(req.file.path);
      } catch (cleanupError) {
        console.error('Error al limpiar archivo temporal:', cleanupError);
      }
    }

    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: error.message 
    });
  }
});

// Endpoint para descargar archivos PDF generados
app.get('/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(outputDir, filename);

    // Verificar si el archivo existe
    if (!(await fs.pathExists(filePath))) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    // Configurar headers para descarga
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Enviar archivo
    res.sendFile(filePath);

  } catch (error) {
    console.error('Error al descargar archivo:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: error.message 
    });
  }
});

// Endpoint para listar archivos PDF generados
app.get('/files', async (req, res) => {
  try {
    const files = await fs.readdir(outputDir);
    const pdfFiles = files.filter(file => file.endsWith('.pdf'));
    
    const fileList = await Promise.all(
      pdfFiles.map(async (file) => {
        const filePath = path.join(outputDir, file);
        const stats = await fs.stat(filePath);
        return {
          filename: file,
          size: stats.size,
          created: stats.birthtime,
          downloadUrl: `/download/${file}`
        };
      })
    );

    res.json({
      success: true,
      files: fileList,
      count: fileList.length
    });

  } catch (error) {
    console.error('Error al listar archivos:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: error.message 
    });
  }
});

// Endpoint para eliminar archivo PDF
app.delete('/delete/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(outputDir, filename);

    // Verificar si el archivo existe
    if (!(await fs.pathExists(filePath))) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    // Eliminar archivo
    await fs.remove(filePath);

    res.json({
      success: true,
      message: `Archivo ${filename} eliminado exitosamente`
    });

  } catch (error) {
    console.error('Error al eliminar archivo:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: error.message 
    });
  }
});

// Manejo de errores global
app.use((error, req, res, next) => {
  // Manejo específico para errores de parsing JSON
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    console.error('Error de parsing JSON:', error.message);
    return res.status(400).json({ 
      error: 'JSON inválido',
      details: 'El contenido enviado no es un JSON válido. Verifica las comillas y la sintaxis.',
      received: error.body
    });
  }
  
  // Otros errores
  console.error('Error no manejado:', error);
  res.status(500).json({ 
    error: 'Error interno del servidor',
    details: error.message 
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
  console.log(`📄 API de conversión HTML a PDF disponible en http://localhost:${PORT}`);
  console.log(`📁 Archivos de salida en: ${outputDir}`);
});

module.exports = app;