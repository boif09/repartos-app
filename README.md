# Repartos

Gastos compartidos para uso personal: pareja, viajes y amigos. Un clon pequeño de Splitwise, pensado para usarse desde el móvil.

El diseño completo está en [docs/DISENO-MVP.md](docs/DISENO-MVP.md).

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| F0 | Esqueleto, login con Authelia, migraciones, tests, pm2/nginx de ejemplo | ✅ |
| F1 | Personas, grupos, gastos a partes iguales (entre todos o algunos), saldos, pagos sugeridos, liquidaciones | ✅ |
| F2 | Importes exactos (con "repartir lo que falta"), partes y reparto por defecto del grupo | ✅ |
| F3 | Moneda por grupo y por gasto, tipo del BCE (Frankfurter) con caché, tipo manual y "me cobraron" | ✅ |
| F4 | PWA, offline de lectura, enlace para amigos | Pendiente |
| F5 | Despliegue y backups | Pendiente |

## Requisitos

- Node.js **22.13 o posterior** (en local se usa la 24).
- No hay dependencias de npm: usa `node:http`, `node:sqlite` y `node:test`.

## Ejecutar en local

```bash
cp .env.example .env
npm start
```

Abrir `http://localhost:3014/`. En local no hay Authelia: `DEV_REMOTE_USER` en `.env` simula el usuario con el que has entrado.

Con reinicio automático al cambiar archivos:

```bash
npm run dev
```

## Pruebas

```bash
npm run check
npm test
```

## Configuración

| Variable | Por defecto | Uso |
|---|---|---|
| `APP_USERS` | — (obligatoria en producción) | Usuarios de Authelia que pueden entrar, separados por comas |
| `DEV_REMOTE_USER` | — | Solo en desarrollo: simula la cabecera `Remote-User`. En producción impide arrancar |
| `PORT` | `3014` | Puerto interno |
| `HOST` | `127.0.0.1` | Dirección de escucha. Debe ser local: la app confía en nginx |
| `BASE_PATH` | `/` | Ruta pública (la app vive en la raíz de `repartos.jusboif.es`) |
| `DB_PATH` | `data/repartos.db` | Base de datos SQLite |
| `FX_API_URL` | `https://api.frankfurter.dev/v1` | API de tipos de cambio del BCE |
| `NODE_ENV` | — | `production` exige `APP_USERS` y prohíbe `DEV_REMOTE_USER` |

## Login y seguridad

El login es el mismo que el del resto de webs de `jusboif.es`: **Authelia**.

1. nginx pregunta a Authelia en cada petición (`auth_request`). Sin sesión, redirige a `auth.jusboif.es`.
2. Con sesión, nginx reenvía la petición a la app con la cabecera `Remote-User` (`xavi`, `judit`).
3. La app solo acepta esa cabecera si la conexión viene de `127.0.0.1` y el usuario está en `APP_USERS`.

Además:

- Toda la API requiere usuario salvo `health`.
- Las escrituras exigen `Content-Type: application/json`.
- CSP estricta, sin JS ni CSS inline.
- Si la sesión de Authelia caduca, la app recarga la página para volver a pasar por el login.

## Despliegue en repartos.jusboif.es (resumen; el script llega en F5)

1. **DNS**: registro A `repartos.jusboif.es` → IP del servidor.
2. **Authelia**: añadir la regla de `repartos.jusboif.es` (está en [nginx-repartos.conf.example](nginx-repartos.conf.example)) y `docker restart authelia`.
3. **App**: copiar el proyecto, crear `/var/lib/repartos/`, `npm run check && npm test`, `pm2 start ecosystem.config.cjs && pm2 save`.
4. **nginx y certificado**: `certbot certonly --nginx -d repartos.jusboif.es`, añadir el sitio de [nginx-repartos.conf.example](nginx-repartos.conf.example) y `sudo nginx -t && sudo systemctl reload nginx`.

## Estructura

```text
server.js            Arranque y validación de configuración
src/app.js           Router HTTP, estáticos, cabeceras de seguridad, API
src/auth.js          Usuario de Authelia (cabecera Remote-User)
src/database.js      SQLite y migraciones (PRAGMA user_version)
src/fx.js            Tipos de cambio del BCE con caché en SQLite
src/repository.js    Consultas, validación y transacciones
shared/              Dominio común servidor/navegador: dinero, repartos, saldos, minimizar pagos
public/              Frontend vanilla, diseñado para móvil primero
test/                node:test
docs/                Diseño
```
