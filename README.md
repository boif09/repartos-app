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
| F4 | PWA instalable, consulta sin conexión, enlace de solo lectura para amigos, ficha de persona | ✅ |
| F5 | Despliegue en `repartos.jusboif.es`, script de despliegue y copias diarias | ✅ ([guía](docs/DESPLIEGUE.md)) |

## Requisitos

- Node.js **22.13 o posterior** (en local se usa la 24).
- No hay dependencias de npm: usa `node:http`, `node:sqlite` y `node:test`.

## Ejecutar en local

```bash
cp .env.example .env
npm start
```

Abrir `http://localhost:3016/`. En local no hay Authelia: `DEV_REMOTE_USER` en `.env` simula el usuario con el que has entrado.

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
| `PORT` | `3016` | Puerto interno |
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
- **Enlace para amigos** (`/s/#token`): token aleatorio de 128 bits por grupo. Va en el `#` de la URL y la app lo manda a la API en la cabecera `X-Share-Token`, así nunca aparece en los logs de acceso. Solo lectura: gastos, saldos y pagos sugeridos, sin notas ni usuarios de Authelia. Se puede cambiar o revocar desde los ajustes del grupo. En nginx esas rutas van sin Authelia, solo con GET y con `Remote-User` vaciado.
- **Sin conexión**: el service worker guarda la app y las últimas lecturas de la API para consultarlas sin red (a propósito, aunque la API responda `no-store`). Las escrituras necesitan conexión y nunca se guardan redirecciones al login. Si en el mismo navegador entra otro usuario, se borran los datos guardados del anterior.

## Iconos

Los PNG de `public/icons/` se generan con `node scripts/make-icons.js` (sin dependencias).

## Despliegue

Paso a paso en [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md): DNS, pm2, Authelia, certificado, nginx y copia diaria. Las actualizaciones se hacen con `./deploy-repartos.sh`, que hace una copia de la base de datos, actualiza el código, pasa los tests, reinicia y comprueba que la app responde.

Copia manual de la base de datos (consistente, sin parar la app):

```bash
DB_PATH=/var/lib/repartos/repartos.db BACKUP_DIR=/var/backups/repartos npm run backup
```

## Estructura

```text
server.js            Arranque y validación de configuración
src/app.js           Router HTTP, estáticos, cabeceras de seguridad, API
src/auth.js          Usuario de Authelia (cabecera Remote-User)
src/database.js      SQLite y migraciones (PRAGMA user_version)
src/fx.js            Tipos de cambio del BCE con caché en SQLite
src/repository.js    Consultas, validación y transacciones
shared/              Dominio común servidor/navegador: dinero, repartos, saldos, minimizar pagos
public/              Frontend vanilla (móvil primero), manifest y service worker (sw.js)
scripts/             make-icons.js (iconos PNG) y backup-db.js (copia de la base de datos)
deploy-repartos.sh   Actualización en el servidor
test/                node:test
docs/                Diseño
```
