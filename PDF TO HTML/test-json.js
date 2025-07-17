// Script de prueba para verificar el manejo de errores JSON
const axios = require('axios');

async function testValidJSON() {
  try {
    console.log('🧪 Probando JSON válido...');
    const response = await axios.post('http://localhost:3000/convert-html-content', {
      html: '<h1>Hola Mundo</h1><p>Este es un test válido</p>',
      filename: 'test-valido'
    });
    console.log('✅ JSON válido funcionó:', response.data.message);
  } catch (error) {
    console.log('❌ Error con JSON válido:', error.response?.data || error.message);
  }
}

async function testInvalidJSON() {
  try {
    console.log('\n🧪 Probando JSON inválido...');
    // Simular un JSON malformado enviando texto plano
    const response = await axios.post('http://localhost:3000/convert-html-content', 
      "'{html: <h1>Test</h1>}", // JSON malformado
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('⚠️ JSON inválido no fue detectado:', response.data);
  } catch (error) {
    console.log('✅ JSON inválido fue detectado correctamente:', error.response?.data || error.message);
  }
}

async function runTests() {
  console.log('🚀 Iniciando pruebas de manejo de errores JSON\n');
  
  await testValidJSON();
  await testInvalidJSON();
  
  console.log('\n✨ Pruebas completadas');
}

// Verificar si axios está disponible
try {
  runTests();
} catch (error) {
  console.log('❌ Error: axios no está instalado. Instala con: npm install axios');
  console.log('💡 Puedes probar manualmente con curl o la interfaz web');
}