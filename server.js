import { createApp } from './src/app.js';
import { parseUserList } from './src/auth.js';

const port = Number(process.env.PORT || 3014);
// Solo local: la app confía en la cabecera Remote-User que pone nginx tras validar con Authelia.
const host = process.env.HOST || '127.0.0.1';
const production = process.env.NODE_ENV === 'production';
const devUser = process.env.DEV_REMOTE_USER?.trim().toLowerCase() || null;
const allowedUsers = parseUserList(process.env.APP_USERS);

if (production && devUser) {
  console.error('DEV_REMOTE_USER solo se puede usar en desarrollo: en producción el usuario lo da Authelia.');
  process.exit(1);
}
if (production && allowedUsers.length === 0) {
  console.error('Define APP_USERS (por ejemplo "xavi,judit") con los usuarios de Authelia que pueden entrar.');
  process.exit(1);
}

const { server, basePath } = createApp({ auth: { devUser, allowedUsers } });

server.listen(port, host, () => {
  console.log(`Repartos iniciado en http://${host}:${port}${basePath === '/' ? '' : basePath}/`);
  if (devUser) console.log(`Modo desarrollo: sesión simulada como "${devUser}".`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
