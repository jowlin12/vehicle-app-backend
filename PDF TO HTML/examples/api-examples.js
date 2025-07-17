// Ejemplo de uso de la API HTML a PDF con JavaScript

// Configuración base
const API_BASE_URL = 'http://localhost:3000';

// Función para convertir contenido HTML a PDF
async function convertHtmlContent(htmlContent, filename = 'documento', options = {}) {
    try {
        const response = await fetch(`${API_BASE_URL}/convert-html-content`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                htmlContent,
                filename,
                options
            })
        });

        if (!response.ok) {
            throw new Error(`Error HTTP: ${response.status}`);
        }

        const result = await response.json();
        console.log('Conversión exitosa:', result);
        return result;
    } catch (error) {
        console.error('Error al convertir HTML:', error);
        throw error;
    }
}

// Función para convertir archivo HTML a PDF
async function convertHtmlFile(file, filename = 'documento', options = {}) {
    try {
        const formData = new FormData();
        formData.append('htmlFile', file);
        formData.append('filename', filename);
        formData.append('options', JSON.stringify(options));

        const response = await fetch(`${API_BASE_URL}/convert-html-file`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Error HTTP: ${response.status}`);
        }

        const result = await response.json();
        console.log('Conversión exitosa:', result);
        return result;
    } catch (error) {
        console.error('Error al convertir archivo HTML:', error);
        throw error;
    }
}

// Función para descargar PDF
function downloadPdf(filename) {
    const downloadUrl = `${API_BASE_URL}/download/${filename}`;
    window.open(downloadUrl, '_blank');
}

// Función para listar archivos PDF
async function listPdfFiles() {
    try {
        const response = await fetch(`${API_BASE_URL}/files`);
        
        if (!response.ok) {
            throw new Error(`Error HTTP: ${response.status}`);
        }

        const result = await response.json();
        console.log('Archivos disponibles:', result);
        return result;
    } catch (error) {
        console.error('Error al listar archivos:', error);
        throw error;
    }
}

// Función para eliminar archivo PDF
async function deletePdfFile(filename) {
    try {
        const response = await fetch(`${API_BASE_URL}/delete/${filename}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            throw new Error(`Error HTTP: ${response.status}`);
        }

        const result = await response.json();
        console.log('Archivo eliminado:', result);
        return result;
    } catch (error) {
        console.error('Error al eliminar archivo:', error);
        throw error;
    }
}

// Ejemplos de uso

// Ejemplo 1: Convertir HTML simple
async function ejemplo1() {
    const htmlContent = `
        <html>
            <head>
                <title>Mi Documento</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 40px; }
                    h1 { color: #007bff; }
                </style>
            </head>
            <body>
                <h1>Hola Mundo</h1>
                <p>Este es un documento generado desde HTML.</p>
                <ul>
                    <li>Elemento 1</li>
                    <li>Elemento 2</li>
                    <li>Elemento 3</li>
                </ul>
            </body>
        </html>
    `;

    try {
        const result = await convertHtmlContent(htmlContent, 'hola-mundo');
        if (result.success) {
            console.log(`PDF generado: ${result.filename}`);
            // Descargar automáticamente
            downloadPdf(result.filename);
        }
    } catch (error) {
        console.error('Error en ejemplo 1:', error);
    }
}

// Ejemplo 2: Convertir con opciones personalizadas
async function ejemplo2() {
    const htmlContent = `
        <html>
            <head>
                <style>
                    body { font-family: 'Times New Roman', serif; margin: 20px; }
                    .header { text-align: center; color: #333; }
                    .content { line-height: 1.6; }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>Documento Personalizado</h1>
                    <p>Con opciones específicas de PDF</p>
                </div>
                <div class="content">
                    <p>Este documento se genera con opciones personalizadas de formato.</p>
                </div>
            </body>
        </html>
    `;

    const options = {
        format: 'A4',
        landscape: true,
        margin: {
            top: '30px',
            right: '30px',
            bottom: '30px',
            left: '30px'
        },
        printBackground: true
    };

    try {
        const result = await convertHtmlContent(htmlContent, 'documento-personalizado', options);
        if (result.success) {
            console.log(`PDF generado: ${result.filename}`);
            downloadPdf(result.filename);
        }
    } catch (error) {
        console.error('Error en ejemplo 2:', error);
    }
}

// Ejemplo 3: Manejar archivo HTML desde input
function setupFileInput() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.html';
    fileInput.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (file) {
            try {
                const result = await convertHtmlFile(file, 'archivo-convertido');
                if (result.success) {
                    console.log(`PDF generado desde archivo: ${result.filename}`);
                    downloadPdf(result.filename);
                }
            } catch (error) {
                console.error('Error al convertir archivo:', error);
            }
        }
    });
    
    // Agregar al DOM si existe
    if (document.body) {
        document.body.appendChild(fileInput);
    }
}

// Ejemplo 4: Gestión completa de archivos
async function gestionArchivos() {
    try {
        // Listar archivos existentes
        const files = await listPdfFiles();
        console.log(`Archivos encontrados: ${files.count}`);
        
        files.files.forEach(file => {
            console.log(`- ${file.filename} (${file.size} bytes)`);
        });

        // Eliminar archivos antiguos (ejemplo)
        const archivosAntiguos = files.files.filter(file => {
            const fechaCreacion = new Date(file.created);
            const hace7Dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            return fechaCreacion < hace7Dias;
        });

        for (const archivo of archivosAntiguos) {
            await deletePdfFile(archivo.filename);
            console.log(`Archivo eliminado: ${archivo.filename}`);
        }

    } catch (error) {
        console.error('Error en gestión de archivos:', error);
    }
}

// Exportar funciones para uso en navegador
if (typeof window !== 'undefined') {
    window.HtmlToPdfAPI = {
        convertHtmlContent,
        convertHtmlFile,
        downloadPdf,
        listPdfFiles,
        deletePdfFile,
        ejemplo1,
        ejemplo2,
        setupFileInput,
        gestionArchivos
    };
}

// Exportar para Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        convertHtmlContent,
        convertHtmlFile,
        downloadPdf,
        listPdfFiles,
        deletePdfFile
    };
}