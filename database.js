const { createClient } = require('@supabase/supabase-js');

// --- Configuración de Supabase ---
// Usamos variables de entorno para seguridad en producción.
// Estas variables deben ser configuradas en el dashboard de Vercel.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Validar que las variables de entorno estén presentes
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Error: Las variables de entorno SUPABASE_URL y SUPABASE_SERVICE_KEY son requeridas.');
  // En un entorno de producción real, podrías querer que el proceso termine.
  // process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

console.log('Supabase client initialized for admin operations.');

// Exportamos solo la conexión de Supabase
module.exports = { supabase };
