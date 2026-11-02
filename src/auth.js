// La autenticación la hace Authelia delante de nginx (auth_request). Si el usuario tiene sesión,
// nginx reenvía la petición con la cabecera Remote-User. Esta app nunca ve contraseñas.

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const USERNAME = /^[a-z0-9._-]{1,64}$/;

export function isLoopback(req) {
  return LOOPBACK.has(req.socket.remoteAddress || '');
}

export function parseUserList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

// Devuelve el usuario autenticado o null.
// - Remote-User solo se acepta si la conexión viene de local (nginx en el mismo servidor).
// - devUser simula Authelia en desarrollo; server.js impide usarlo en producción.
// - Si allowedUsers no está vacío, cualquier otro usuario de Authelia queda fuera.
export function resolveUser(req, { devUser = null, allowedUsers = [] } = {}) {
  let username = null;
  const header = req.headers['remote-user'];
  if (header && isLoopback(req)) {
    username = String(header).trim().toLowerCase();
  } else if (devUser) {
    username = devUser;
  }
  if (!username || !USERNAME.test(username)) return null;
  if (allowedUsers.length && !allowedUsers.includes(username)) return null;
  return username;
}
