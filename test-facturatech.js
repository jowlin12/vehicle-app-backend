/**
 * Script de prueba local para Facturatech
 * Ejecutar con: node test-facturatech.js
 */

const crypto = require('crypto');
const axios = require('axios');

// Configuración - AJUSTAR CON TUS CREDENCIALES
const CONFIG = {
    user: '88200963',
    password: 'Mazo170673*', // Reemplazar con tu contraseña real
    endpoint: 'https://ws.facturatech.co/v2/demo/index.php'
};

// Hash SHA-256 de la contraseña
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Generar un layout de prueba simple
function generarLayoutPrueba() {
    const fechaActual = new Date().toISOString().split('T')[0];
    const horaActual = new Date().toTimeString().split(' ')[0];

    return `[FACTURA]
(ENC)
ENC_1;01;
ENC_2;FCM;
ENC_3;999;
ENC_4;${fechaActual};
ENC_5;${horaActual};
ENC_6;${fechaActual};
ENC_7;01;
ENC_9;COP;
ENC_10;10;
ENC_16;PRUEBA LOCAL;
(/ENC)
(EMI)
EMI_1;2;
EMI_2;88200963;
EMI_3;6;
EMI_6;CARLOS ARTURO MAZO MARIN;
EMI_7;MI TALLER MAZOS CAR;
EMI_10;Calle 1 #7E-72 QUINTA ORIENTAL;
EMI_11;540001;
EMI_12;Cucuta;
EMI_13;Norte de Santander;
EMI_14;54;
EMI_15;CO;
EMI_19;3184077646;
EMI_23;R-99-PN;
EMI_24;49;
(/EMI)
(ADQ)
ADQ_1;2;
ADQ_2;12345678;
ADQ_3;;
ADQ_5;13;
ADQ_6;Cliente Prueba;
ADQ_7;Cliente Prueba;
ADQ_10;Direccion Prueba;
ADQ_11;54001;
ADQ_12;Cucuta;
ADQ_13;Norte de Santander;
ADQ_14;54;
ADQ_15;CO;
ADQ_19;3001234567;
ADQ_22;prueba@test.com;
ADQ_23;R-99-PN;
ADQ_24;49;
(/ADQ)
(TOT)
TOT_1;100000.00;
TOT_2;01;
TOT_3;0.00;
TOT_4;100000.00;
(/TOT)
(ITE)
ITE_1;1;
ITE_3;ITEM001;
ITE_4;1;
ITE_5;EA;
ITE_6;100000.00;
ITE_7;100000.00;
ITE_10;Servicio de prueba;
ITE_11;01;
ITE_14;0.00;
ITE_15;0.00;
ITE_18;100000.00;
(/ITE)`;
}

// Crear envelope SOAP
function crearSoapEnvelope(method, params) {
    const escapeXml = (text) => {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    };

    const paramsXml = Object.entries(params)
        .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
        .join('');

    return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:FacturaTech"><soapenv:Body><urn:${method}>${paramsXml}</urn:${method}></soapenv:Body></soapenv:Envelope>`;
}

async function probarFacturatech() {
    console.log('='.repeat(60));
    console.log('PRUEBA LOCAL DE FACTURATECH');
    console.log('='.repeat(60));

    const layout = generarLayoutPrueba();
    const layoutBase64 = Buffer.from(layout, 'utf-8').toString('base64');
    const passwordHash = hashPassword(CONFIG.password);

    console.log('\n📝 Layout generado:');
    console.log('-'.repeat(40));
    console.log(layout.substring(0, 500));
    console.log('...');
    console.log('-'.repeat(40));

    const envelope = crearSoapEnvelope('FtechAction.uploadInvoiceFileLayout', {
        username: CONFIG.user,
        password: passwordHash,
        layout: layoutBase64
    });

    console.log('\n🔐 Credenciales:');
    console.log(`   Usuario: ${CONFIG.user}`);
    console.log(`   Password hash: ${passwordHash.substring(0, 20)}...`);

    console.log('\n📡 Enviando petición a:', CONFIG.endpoint);

    try {
        const response = await axios.post(CONFIG.endpoint, envelope, {
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': '"urn:FacturaTech#FtechAction.uploadInvoiceFileLayout"',
                'User-Agent': 'PHP-SOAP/8.1',
                'Accept': 'text/xml'
            },
            timeout: 120000
        });

        console.log('\n✅ RESPUESTA EXITOSA:');
        console.log('-'.repeat(40));
        console.log(response.data);
        console.log('-'.repeat(40));

    } catch (error) {
        console.log('\n❌ ERROR:');
        console.log(`   Status: ${error.response?.status}`);
        console.log(`   Status Text: ${error.response?.statusText}`);
        console.log(`   Message: ${error.message}`);

        if (error.response?.data) {
            console.log('\n📄 Respuesta del servidor:');
            console.log('-'.repeat(40));
            console.log(error.response.data);
            console.log('-'.repeat(40));
        }
    }
}

// Ejecutar
probarFacturatech().catch(console.error);
