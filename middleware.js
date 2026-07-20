const { supabase } = require('./database');

/**
 * Middleware para proteger rutas. Verifica el token JWT del header,
 * obtiene los datos del usuario de Supabase y lo adjunta al objeto `req`.
 */
async function protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No se proporcionó un token, acceso denegado.' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: 'El token no es válido o expiró.' });
    }

    const {data: profile, error: profileError} = await supabase
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .single();
    const role = profile?.role?.toLowerCase();

    if (profileError || !['admin', 'empleado'].includes(role)) {
      return res.status(403).json({
        error: 'El usuario no tiene acceso autorizado a esta aplicación.',
      });
    }

    req.user = data.user;
    req.userRole = role;
    return next();
  } catch (error) {
    console.error('[Auth] Error verificando el token:', error.message);
    return res.status(503).json({ error: 'No fue posible validar la sesión.' });
  }
}

async function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({
      error: 'Esta acción requiere permisos de administrador.',
    });
  }
  return next();
}

module.exports = { protect, requireAdmin };
