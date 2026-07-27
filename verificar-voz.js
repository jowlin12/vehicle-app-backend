'use strict';

/**
 * Comprueba que la extracción por voz funciona de verdad contra el proveedor
 * configurado, con frases del taller y el catálogo real.
 *
 *   cd Backend
 *   node --env-file=.env verificar-voz.js
 *
 * Mide tres cosas: que la salida cumpla el esquema, que acierte en los campos
 * que se dijeron, y que NO invente los que no se dijeron — que es el fallo que
 * de verdad importa, porque un dato falso guardado es peor que un campo vacío.
 */

const {
  ESQUEMA,
  CAMPOS,
  construirContexto,
  proveedoresDisponibles,
} = require('./voz-extraer.js');

// Un catálogo del tamaño del real: 55 marcas, los tipos de una marca y los 15
// servicios frecuentes que manda la app.
const CATALOGO = {
  marcas: [
    'Mazda', 'Chevrolet', 'Renault', 'Toyota', 'Nissan', 'Kia', 'Hyundai',
    'Ford', 'Volkswagen', 'Suzuki', 'Honda', 'Mitsubishi', 'Peugeot',
  ],
  tipos_vehiculo: ['Automóvil', 'Camioneta', 'Campero', 'Motocicleta', 'Van'],
  servicios_frecuentes: [
    'Cambio de aceite', 'Revisión de frenos', 'Alineación y balanceo',
    'Cambio de filtro de aire', 'Sincronización', 'Cambio de pastillas',
    'Revisión de suspensión', 'Cambio de correa', 'Lavado de inyectores',
    'Revisión eléctrica', 'Cambio de batería', 'Cambio de llantas',
    'Revisión de embrague', 'Cambio de bujías', 'Diagnóstico general',
  ],
};

const CASOS = [
  {
    nombre: 'la frase real del taller',
    dicho: 'el carro tiene 120000 km y el cliente viene para cambio de aceite',
    espera: { kilometraje: '120000' },
    servicioEsperado: 'Cambio de aceite',
    vacios: ['cliente', 'costo_mano_obra', 'telefono'],
  },
  {
    nombre: 'números dictados en palabras',
    dicho: 'tiene ciento veinte mil kilómetros',
    espera: { kilometraje: '120000' },
    vacios: ['costo_mano_obra'],
  },
  {
    nombre: 'carro nuevo con todos los datos',
    dicho:
      'es un Mazda automóvil modelo 2018, a nombre de Ana Gómez, el teléfono es 300 123 4567',
    espera: {
      marca: 'Mazda',
      tipo_vehiculo: 'Automóvil',
      modelo: '2018',
      telefono: '3001234567',
    },
    contiene: { cliente: 'Ana' },
    vacios: ['kilometraje'],
  },
  {
    nombre: 'marca que no existe en el catálogo',
    dicho: 'es un Lamborghini rojo',
    vacios: ['marca'],
  },
  {
    nombre: 'dinero no es kilometraje',
    dicho: 'la mano de obra son ochenta mil pesos',
    espera: { costo_mano_obra: '80000' },
    vacios: ['kilometraje'],
  },
  {
    nombre: 'queja libre sin datos duros',
    dicho: 'el señor dice que le suena raro adelante cuando frena',
    vacios: ['kilometraje', 'modelo', 'costo_mano_obra', 'telefono', 'marca'],
  },
];

/** Valida la forma contra el esquema, sin dependencias externas. */
function problemasDeEsquema(salida) {
  const fallas = [];
  if (!salida || typeof salida !== 'object') return ['la salida no es un objeto'];

  for (const clave of ESQUEMA.required) {
    if (!(clave in salida)) fallas.push(`falta "${clave}"`);
  }
  if (salida.campos && typeof salida.campos === 'object') {
    for (const campo of CAMPOS) {
      if (!(campo in salida.campos)) {
        fallas.push(`falta el campo "${campo}"`);
        continue;
      }
      const valor = salida.campos[campo];
      if (valor !== null && typeof valor !== 'string') {
        fallas.push(`"${campo}" no es texto ni null (${typeof valor})`);
      }
    }
    for (const clave of Object.keys(salida.campos)) {
      if (!CAMPOS.includes(clave)) fallas.push(`campo de más: "${clave}"`);
    }
  } else {
    fallas.push('"campos" no es un objeto');
  }
  for (const lista of ['servicios', 'confianza_baja']) {
    if (!Array.isArray(salida[lista])) fallas.push(`"${lista}" no es una lista`);
  }
  return fallas;
}

function normalizar(texto) {
  return String(texto == null ? '' : texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // marcas de tilde sueltas
    .trim();
}

function revisarCaso(caso, salida) {
  const fallas = problemasDeEsquema(salida);
  if (fallas.length > 0) return fallas;

  const campos = salida.campos;

  for (const [campo, esperado] of Object.entries(caso.espera || {})) {
    if (normalizar(campos[campo]) !== normalizar(esperado)) {
      fallas.push(`${campo}: esperaba "${esperado}", dio "${campos[campo]}"`);
    }
  }
  for (const [campo, trozo] of Object.entries(caso.contiene || {})) {
    if (!normalizar(campos[campo]).includes(normalizar(trozo))) {
      fallas.push(`${campo}: esperaba que contuviera "${trozo}", dio "${campos[campo]}"`);
    }
  }
  for (const campo of caso.vacios || []) {
    const valor = campos[campo];
    if (valor !== null && String(valor).trim() !== '') {
      fallas.push(`${campo}: debía quedar vacío, INVENTÓ "${valor}"`);
    }
  }
  if (caso.servicioEsperado) {
    const encontrado = (salida.servicios || []).some(
      s => normalizar(s) === normalizar(caso.servicioEsperado)
    );
    if (!encontrado) {
      fallas.push(
        `servicios: esperaba "${caso.servicioEsperado}", dio [${(salida.servicios || []).join(', ')}]`
      );
    }
  }
  return fallas;
}

async function probarProveedor(proveedor) {
  console.log(`\n=== ${proveedor.nombre} (${proveedor.modelo}) ===`);

  let aciertos = 0;
  let tokensEntrada = 0;
  let tokensSalida = 0;
  let msTotal = 0;

  for (const caso of CASOS) {
    const contexto = construirContexto(
      { catalogo: CATALOGO, ya_lleno: {}, faltantes: [] },
      caso.dicho
    );

    const inicio = process.hrtime.bigint();
    let salida;
    let uso;
    try {
      ({ salida, uso } = await proveedor.extraer(contexto));
    } catch (error) {
      console.log(`  ✗ ${caso.nombre}\n      ${error?.message || error}`);
      continue;
    }
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    msTotal += ms;

    tokensEntrada += uso?.prompt_tokens ?? uso?.input_tokens ?? 0;
    tokensSalida += uso?.completion_tokens ?? uso?.output_tokens ?? 0;

    const fallas = revisarCaso(caso, salida);
    if (fallas.length === 0) {
      aciertos++;
      console.log(`  ✓ ${caso.nombre}  (${Math.round(ms)} ms)`);
    } else {
      console.log(`  ✗ ${caso.nombre}  (${Math.round(ms)} ms)`);
      for (const falla of fallas) console.log(`      ${falla}`);
    }
  }

  const turnos = CASOS.length;
  const entradaPorTurno = Math.round(tokensEntrada / turnos) || 0;
  const salidaPorTurno = Math.round(tokensSalida / turnos) || 0;
  const porTurno = entradaPorTurno + salidaPorTurno;

  console.log(`\n  ${aciertos}/${turnos} casos correctos`);
  console.log(`  latencia media: ${Math.round(msTotal / turnos)} ms`);
  console.log(`  tokens por turno: ${porTurno} (${entradaPorTurno} entrada + ${salidaPorTurno} salida)`);

  if (proveedor.nombre === 'groq' && porTurno > 0) {
    // Límites del plan gratis de Groq para gpt-oss-120b.
    const TPM = 8000;
    const TPD = 200000;
    console.log(
      `  cabida en el plan gratis: ~${Math.floor(TPM / porTurno)} turnos por minuto, ` +
        `~${Math.floor(TPD / porTurno)} por día`
    );
  }

  return aciertos === turnos;
}

async function main() {
  const proveedores = proveedoresDisponibles();

  if (proveedores.length === 0) {
    console.error(
      'No hay ningún proveedor configurado.\n' +
        'Pon GROQ_API_KEY en Backend/.env (la llave gratis se saca en ' +
        'https://console.groq.com/keys) y vuelve a correr esto.'
    );
    process.exit(1);
  }

  console.log(
    `Proveedores configurados: ${proveedores.map(p => p.nombre).join(', ')}`
  );

  let todoBien = true;
  for (const proveedor of proveedores) {
    const bien = await probarProveedor(proveedor);
    todoBien = todoBien && bien;
  }

  console.log(todoBien ? '\nTodo en orden.' : '\nHay casos que fallan (ver arriba).');
  process.exit(todoBien ? 0 : 1);
}

main();
