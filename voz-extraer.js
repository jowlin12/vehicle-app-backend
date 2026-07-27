'use strict';

/**
 * Convierte lo que dijo el mecánico en campos del formato.
 *
 * Hay dos proveedores posibles y se usa el primero que esté configurado:
 *
 *   1. Groq (gratis) — modelo abierto gpt-oss-120b. Es el camino por defecto.
 *   2. Anthropic (pago) — respaldo opcional, por si el plan gratis se agota.
 *
 * Las llaves viven en las variables de entorno de Vercel: la app nunca las ve.
 * Si ningún proveedor responde, el cliente sigue con su parser local, así que un
 * error aquí degrada la precisión pero no bloquea el trabajo del taller.
 */

const MODELO_GROQ = 'openai/gpt-oss-120b';
const MODELO_ANTHROPIC = 'claude-opus-5';

const URL_GROQ = 'https://api.groq.com/openai/v1/chat/completions';

// Por debajo de los 12 s que espera el cliente: si nos pasamos, la app ya se
// rindió y usó su parser local, y la respuesta llegaría a la nada.
const TIEMPO_LIMITE_MS = 10000;

// Un campo que no se dijo va como null, no se omite: el modo estricto de salida
// estructurada exige que todas las propiedades estén declaradas y requeridas.
// Groq y Anthropic piden exactamente lo mismo, así que el esquema es uno solo.
const CAMPOS = [
  'placa',
  'marca',
  'tipo_vehiculo',
  'modelo',
  'kilometraje',
  'cliente',
  'conductor',
  'telefono',
  'clave_control',
  'costo_mano_obra',
  'observaciones',
  'trabajos',
];

const ESQUEMA = {
  type: 'object',
  properties: {
    campos: {
      type: 'object',
      properties: Object.fromEntries(
        CAMPOS.map(campo => [campo, { type: ['string', 'null'] }])
      ),
      required: CAMPOS,
      additionalProperties: false,
    },
    servicios: {
      type: 'array',
      items: { type: 'string' },
    },
    confianza_baja: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['campos', 'servicios', 'confianza_baja'],
  additionalProperties: false,
};

const INSTRUCCIONES = `Eres el oído de una app de taller mecánico en Colombia.
Recibes lo que un mecánico acaba de decir en voz alta y devuelves únicamente los
datos que realmente dijo.

Reglas que no se rompen:
- No inventes. Si un dato no se dijo, va en null. Es mejor que la app vuelva a
  preguntar a que guarde algo falso.
- No repitas lo que ya está lleno. Solo devuelve lo nuevo o lo que corrija
  explícitamente un valor anterior.
- "marca", "tipo_vehiculo" y los servicios DEBEN salir textualmente de las
  listas del catálogo que recibes. Si lo dicho no corresponde a ninguna opción
  de la lista, deja el campo en null.
- Números siempre en dígitos y sin separadores: "ciento veinte mil" -> "120000",
  "120 mil kilómetros" -> "120000".
- "modelo" es el año del vehículo, cuatro dígitos.
- "kilometraje" solo si se habló de kilómetros; un número suelto no es
  kilometraje.
- "costo_mano_obra" solo si se habló de dinero o de mano de obra.
- La placa colombiana es AAA123 (carro) o AAA12A (moto), en mayúsculas.
- "trabajos" y "observaciones" son texto libre, en las palabras del mecánico.
- Pon en "confianza_baja" el nombre de cada campo que dedujiste sin estar
  seguro, para que la app lo resalte y la persona lo confirme.`;

/** Falla de un proveedor concreto: hay que intentar con el siguiente. */
class ErrorProveedor extends Error {
  constructor(proveedor, mensaje) {
    super(`${proveedor}: ${mensaje}`);
    this.proveedor = proveedor;
  }
}

// --- Groq (gratis) ---------------------------------------------------------

async function extraerConGroq(contexto) {
  let respuesta;
  try {
    respuesta = await fetch(URL_GROQ, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODELO_GROQ,
        // Sin creatividad: extraer no es redactar, y así la misma frase da
        // siempre el mismo resultado.
        temperature: 0,
        max_completion_tokens: 1500,
        // El razonamiento consume del mismo presupuesto que la respuesta y
        // cuenta contra el límite gratis de tokens por minuto. La tarea es
        // corta: no hace falta más.
        reasoning_effort: 'low',
        include_reasoning: false,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'campos_formato',
            strict: true,
            schema: ESQUEMA,
          },
        },
        messages: [
          { role: 'system', content: INSTRUCCIONES },
          { role: 'user', content: JSON.stringify(contexto) },
        ],
      }),
      signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
    });
  } catch (error) {
    throw new ErrorProveedor('groq', error?.name === 'TimeoutError'
      ? 'no respondió a tiempo'
      : `no se pudo conectar (${error?.message || error})`);
  }

  if (!respuesta.ok) {
    const detalle = (await respuesta.text().catch(() => '')).slice(0, 300);
    // 429 es el plan gratis agotado: si hay respaldo configurado, entra aquí.
    throw new ErrorProveedor('groq', `HTTP ${respuesta.status} ${detalle}`);
  }

  const datos = await respuesta.json();
  const eleccion = datos?.choices?.[0];

  if (eleccion?.finish_reason === 'content_filter') {
    throw new ErrorProveedor('groq', 'la respuesta fue filtrada');
  }

  const contenido = eleccion?.message?.content;
  if (!contenido) {
    throw new ErrorProveedor('groq', 'respuesta vacía');
  }

  return { salida: JSON.parse(contenido), uso: datos.usage || null };
}

// --- Anthropic (respaldo opcional de pago) ---------------------------------

let clienteAnthropic = null;

async function extraerConAnthropic(contexto) {
  if (!clienteAnthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    clienteAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  const respuesta = await clienteAnthropic.messages.create({
    model: MODELO_ANTHROPIC,
    max_tokens: 2000,
    system: [
      {
        type: 'text',
        text: INSTRUCCIONES,
        // Estas instrucciones se repiten en cada turno de la conversación.
        cache_control: { type: 'ephemeral' },
      },
    ],
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: ESQUEMA },
    },
    messages: [{ role: 'user', content: JSON.stringify(contexto) }],
  });

  if (respuesta.stop_reason === 'refusal') {
    throw new ErrorProveedor('anthropic', 'el modelo se negó a responder');
  }

  const bloque = (respuesta.content || []).find(b => b.type === 'text');
  if (!bloque) {
    throw new ErrorProveedor('anthropic', 'respuesta vacía');
  }

  return { salida: JSON.parse(bloque.text), uso: respuesta.usage || null };
}

// --- Selección de proveedor -----------------------------------------------

const PROVEEDORES = {
  groq: {
    llave: 'GROQ_API_KEY',
    modelo: MODELO_GROQ,
    extraer: extraerConGroq,
  },
  anthropic: {
    llave: 'ANTHROPIC_API_KEY',
    modelo: MODELO_ANTHROPIC,
    extraer: extraerConAnthropic,
  },
};

/**
 * Groq primero porque es gratis; Anthropic queda como red de seguridad si su
 * llave está puesta. `VOZ_PROVEEDOR` fuerza uno solo, útil para comparar cuál
 * acierta más con los dictados reales del taller.
 */
function proveedoresDisponibles() {
  const forzado = String(process.env.VOZ_PROVEEDOR || '').trim().toLowerCase();
  const orden = forzado ? [forzado] : ['groq', 'anthropic'];

  return orden
    .filter(nombre => PROVEEDORES[nombre])
    .filter(nombre => Boolean(process.env[PROVEEDORES[nombre].llave]))
    .map(nombre => ({ nombre, ...PROVEEDORES[nombre] }));
}

function listaDeTextos(valor, maximo) {
  if (!Array.isArray(valor)) return [];
  return valor
    .map(item => (item === null || item === undefined ? '' : String(item).trim()))
    .filter(Boolean)
    .slice(0, maximo);
}

/**
 * Arma el contexto que ve el modelo. Los topes no son decoración: el catálogo
 * viaja en cada turno y el plan gratis de Groq cuenta 8.000 tokens por minuto.
 * Con estos límites un turno pesa ~1.200 tokens.
 */
function construirContexto(cuerpo, transcripcion) {
  const catalogo = cuerpo?.catalogo || {};
  return {
    transcripcion,
    ya_lleno:
      cuerpo?.ya_lleno && typeof cuerpo.ya_lleno === 'object'
        ? cuerpo.ya_lleno
        : {},
    faltantes: listaDeTextos(cuerpo?.faltantes, 10),
    catalogo: {
      marcas: listaDeTextos(catalogo.marcas, 60),
      tipos_vehiculo: listaDeTextos(catalogo.tipos_vehiculo, 40),
      servicios_frecuentes: listaDeTextos(catalogo.servicios_frecuentes, 25),
    },
  };
}

async function extraerFormatoPorVoz(req, res) {
  const transcripcion = String(req.body?.transcripcion || '').trim();
  if (!transcripcion) {
    return res.status(400).json({ error: 'Falta la transcripción.' });
  }
  if (transcripcion.length > 2000) {
    return res.status(400).json({ error: 'La transcripción es demasiado larga.' });
  }

  const proveedores = proveedoresDisponibles();
  if (proveedores.length === 0) {
    // Sin llave configurada no hay nada que hacer aquí; el cliente tiene su
    // propio parser y seguirá funcionando.
    return res.status(503).json({ error: 'Extracción por voz no configurada.' });
  }

  const contexto = construirContexto(req.body, transcripcion);

  for (const proveedor of proveedores) {
    try {
      const { salida, uso } = await proveedor.extraer(contexto);
      // El consumo se registra para poder ver si el plan gratis alcanza.
      console.log(
        `voz/extraer ok con ${proveedor.nombre}`,
        JSON.stringify(uso || {})
      );
      // Con salida estructurada estricta el JSON ya tiene la forma del esquema,
      // así que no hay que sanear nada más.
      return res.json(salida);
    } catch (error) {
      console.error(
        `voz/extraer falló con ${proveedor.nombre}:`,
        error?.message || error
      );
    }
  }

  return res.status(502).json({ error: 'El extractor no respondió.' });
}

module.exports = {
  extraerFormatoPorVoz,
  // Exportados para el script de verificación.
  ESQUEMA,
  INSTRUCCIONES,
  CAMPOS,
  MODELO_GROQ,
  MODELO_ANTHROPIC,
  construirContexto,
  proveedoresDisponibles,
};
