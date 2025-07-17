# API de Conversión HTML a PDF

Esta API permite convertir contenido HTML o archivos HTML a documentos PDF utilizando Node.js, Express y Puppeteer.

## 🚀 Instalación

1. Instalar dependencias:
```bash
npm install
```

2. Iniciar el servidor:
```bash
npm start
```

Para desarrollo con auto-recarga:
```bash
npm run dev
```

## 📋 Endpoints Disponibles

### GET /
Información general de la API y endpoints disponibles.

### POST /convert-html-content
Convierte contenido HTML a PDF.

**Body (JSON):**
```json
{
  "htmlContent": "<html><body><h1>Hola Mundo</h1></body></html>",
  "filename": "mi-documento",
  "options": {
    "format": "A4",
    "printBackground": true,
    "margin": {
      "top": "20px",
      "right": "20px",
      "bottom": "20px",
      "left": "20px"
    }
  }
}
```

**Respuesta:**
```json
{
  "success": true,
  "message": "PDF generado exitosamente",
  "filename": "mi-documento-1234567890.pdf",
  "downloadUrl": "/download/mi-documento-1234567890.pdf",
  "size": 12345
}
```

### POST /convert-html-file
Convierte un archivo HTML a PDF.

**Form Data:**
- `htmlFile`: Archivo HTML (required)
- `filename`: Nombre del archivo de salida (optional)
- `options`: Opciones de PDF en formato JSON (optional)

### GET /download/:filename
Descarga un archivo PDF generado.

### GET /files
Lista todos los archivos PDF generados.

**Respuesta:**
```json
{
  "success": true,
  "files": [
    {
      "filename": "documento-1234567890.pdf",
      "size": 12345,
      "created": "2023-12-01T10:00:00.000Z",
      "downloadUrl": "/download/documento-1234567890.pdf"
    }
  ],
  "count": 1
}
```

### DELETE /delete/:filename
Elimina un archivo PDF específico.

## 🔧 Opciones de PDF

Las opciones disponibles para la generación de PDF incluyen:

```json
{
  "format": "A4",           // A4, A3, A2, A1, A0, Legal, Letter, Tabloid, Ledger
  "printBackground": true,   // Incluir colores y imágenes de fondo
  "landscape": false,        // Orientación horizontal
  "margin": {
    "top": "20px",
    "right": "20px",
    "bottom": "20px",
    "left": "20px"
  },
  "width": "8.5in",         // Ancho personalizado
  "height": "11in",         // Alto personalizado
  "scale": 1,               // Escala (0.1 - 2)
  "displayHeaderFooter": false,
  "headerTemplate": "",
  "footerTemplate": "",
  "preferCSSPageSize": false
}
```

## 📁 Estructura de Archivos

```
PDF TO HTML/
├── server.js          # Servidor principal
├── package.json       # Dependencias
├── README.md          # Documentación
├── uploads/           # Archivos HTML temporales
├── output/            # Archivos PDF generados
└── examples/          # Ejemplos de uso
```

## 🧪 Ejemplos de Uso

### Usando curl

**Convertir contenido HTML:**
```bash
curl -X POST http://localhost:3000/convert-html-content \
  -H "Content-Type: application/json" \
  -d '{
    "htmlContent": "<html><body><h1>Mi Documento</h1><p>Contenido del documento.</p></body></html>",
    "filename": "mi-documento"
  }'
```

**Convertir archivo HTML:**
```bash
curl -X POST http://localhost:3000/convert-html-file \
  -F "htmlFile=@documento.html" \
  -F "filename=mi-documento"
```

**Descargar PDF:**
```bash
curl -O http://localhost:3000/download/mi-documento-1234567890.pdf
```

### Usando JavaScript (fetch)

```javascript
// Convertir contenido HTML
const response = await fetch('http://localhost:3000/convert-html-content', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    htmlContent: '<html><body><h1>Mi Documento</h1></body></html>',
    filename: 'mi-documento',
    options: {
      format: 'A4',
      printBackground: true
    }
  })
});

const result = await response.json();
console.log(result);

// Descargar el PDF
if (result.success) {
  window.open(`http://localhost:3000${result.downloadUrl}`);
}
```

## 🛠️ Configuración

El servidor utiliza las siguientes variables de entorno:

- `PORT`: Puerto del servidor (default: 3000)

## 📝 Notas

- Los archivos PDF se almacenan en la carpeta `output/`
- Los archivos HTML temporales se almacenan en `uploads/`
- El servidor limpia automáticamente los archivos temporales después de la conversión
- Se recomienda implementar un sistema de limpieza periódica para los archivos PDF generados

## 🔒 Seguridad

- La API incluye validación de archivos
- Límite de tamaño de payload: 50MB
- Timeout de conversión: 30 segundos
- Puppeteer ejecuta en modo sandbox deshabilitado para compatibilidad

## 🐛 Solución de Problemas

**Error: "Failed to launch the browser process"**
- Instalar dependencias del sistema para Puppeteer
- En Ubuntu/Debian: `sudo apt-get install -y gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget`

**Error de memoria**
- Reducir el tamaño del contenido HTML
- Implementar procesamiento por lotes para múltiples archivos