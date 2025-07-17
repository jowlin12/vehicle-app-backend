const { supabase } = require('./database');

/**
 * Middleware para proteger rutas. Verifica el token JWT del header,
 * obtiene los datos del usuario de Supabase y lo adjunta al objeto `req`.
 */
async function protect(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No se proporcionó un token, acceso denegado.' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error) {
    return res.status(401).json({ error: 'El token no es válido.' });
  }

  // Adjuntar el usuario al objeto de la petición para usarlo en las siguientes funciones
  req.user = user;
  next(); // Pasar al siguiente middleware o al controlador de la ruta
}

module.exports = { protect };
