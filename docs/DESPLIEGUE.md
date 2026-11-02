# Despliegue en repartos.jusboif.es

Servidor: el mismo de TripFlow y prevision-gastos-web (Hetzner, nginx, pm2, Authelia en Docker).

| Dato | Valor |
|---|---|
| URL pública | `https://repartos.jusboif.es` |
| Código | `/var/www/repartos-app` (clon de `github.com/boif09/repartos-app`) |
| Base de datos | `/var/lib/repartos/repartos.db` (fuera del código) |
| Copias | `/var/backups/repartos` (diarias, 30 días) |
| Proceso pm2 | `repartos`, en `127.0.0.1:3016` |
| Login | Authelia (`auth.jusboif.es`), usuarios `xavi` y `judit` |

> El puerto 3014 ya lo usa la API de Tens Pla y el 3015 está reservado para su revisión interna. Por eso Repartos usa el 3016.

Node 24 y pm2 están instalados con nvm en `/root/.nvm`. En una sesión SSH interactiva están en el PATH; en scripts y cron hay que cargarlo, como ya hacen `deploy-repartos.sh` y el crontab.

---

## Primera instalación

Cada paso se puede comprobar antes de pasar al siguiente. Hasta el paso 6 nada es visible desde internet.

### 1. DNS (en el panel del proveedor del dominio)

Registro **A** `repartos` → `178.105.156.23`. Comprobar desde el ordenador:

```bash
nslookup repartos.jusboif.es
```

### 2. Código y carpetas

```bash
git clone https://github.com/boif09/repartos-app.git /var/www/repartos-app
mkdir -p /var/lib/repartos /var/backups/repartos
cd /var/www/repartos-app
chmod +x deploy-repartos.sh
npm run check && npm test
```

Si el repositorio es privado, el servidor necesitará las mismas credenciales de GitHub que usa para TripFlow.

### 3. Arrancar con pm2

```bash
cd /var/www/repartos-app
pm2 start ecosystem.config.cjs
pm2 save
curl -s http://127.0.0.1:3016/api/health     # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3016/api/session   # 401: sin Authelia no entra nadie
```

### 4. Regla en Authelia

Hacer una copia y editar `/opt/authelia/config/configuration.yml`. Dentro de `access_control.rules`, añadir:

```yaml
    - domain: "repartos.jusboif.es"
      policy: "one_factor"
      subject:
        - "user:xavi"
        - "user:judit"
```

```bash
cp /opt/authelia/config/configuration.yml /opt/authelia/config/configuration.yml.backup-repartos
nano /opt/authelia/config/configuration.yml
docker restart authelia
docker logs --tail 30 authelia      # sin errores de configuración
```

La cookie de sesión de Authelia ya es para todo `jusboif.es`, así que si has entrado en otra app no hace falta volver a hacer login.

### 5. Certificado

Necesita que el DNS del paso 1 ya resuelva:

```bash
certbot certonly --nginx -d repartos.jusboif.es
```

### 6. nginx

```bash
cp /var/www/repartos-app/nginx-repartos.conf.example /etc/nginx/sites-available/repartos
ln -s /etc/nginx/sites-available/repartos /etc/nginx/sites-enabled/repartos
nginx -t && systemctl reload nginx
```

El sitio incluye la ruta pública de los enlaces para amigos (`/s/` y `/api/shared`): sin Authelia, solo GET y con `Remote-User` vaciado.

### 7. Comprobar

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://repartos.jusboif.es/
# 302 hacia auth.jusboif.es: sin sesión manda al login
curl -s -o /dev/null -w '%{http_code}\n' https://repartos.jusboif.es/s/
# 200: la vista de amigos es pública (sin token no muestra datos)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://repartos.jusboif.es/api/shared
# 403: la ruta pública solo admite GET
```

En el móvil, abrir `https://repartos.jusboif.es`, entrar con Authelia (marcando "Recordarme") y:

- **iPhone**: Safari → Compartir → "Añadir a pantalla de inicio".
- **Android**: Chrome → menú → "Instalar aplicación".

Comprobar con el modo avión que la app abre y muestra los últimos datos.

### 8. Copia diaria

Añadir con `crontab -e` (el crontab ya define el PATH de nvm):

```cron
20 3 * * * cd /var/www/repartos-app && DB_PATH=/var/lib/repartos/repartos.db BACKUP_DIR=/var/backups/repartos node --no-warnings scripts/backup-db.js >> /var/log/repartos-backup.log 2>&1
```

Probarlo una vez a mano:

```bash
cd /var/www/repartos-app && DB_PATH=/var/lib/repartos/repartos.db BACKUP_DIR=/var/backups/repartos node --no-warnings scripts/backup-db.js
```

---

## Actualizaciones

Después de hacer push a `main`:

```bash
/var/www/repartos-app/deploy-repartos.sh
```

El script se niega a seguir si hay cambios locales. Si todo está en orden:

1. Hace una copia de la base de datos.
2. Hace `git pull --ff-only`.
3. Pasa `npm run check` y `npm test`.
4. Reinicia con pm2.
5. Comprueba que la app responde. Si no responde, muestra los logs y cómo volver a la versión anterior.

Las migraciones de la base de datos se aplican solas al arrancar.

## Restaurar una copia

```bash
pm2 stop repartos
cp /var/lib/repartos/repartos.db /var/lib/repartos/repartos.db.antes-de-restaurar
rm -f /var/lib/repartos/repartos.db-wal /var/lib/repartos/repartos.db-shm
cp /var/backups/repartos/repartos-AAAA-MM-DD-HHMMSS.db /var/lib/repartos/repartos.db
pm2 start repartos
```

## Desde fuera

- Los tipos de cambio se piden a `api.frankfurter.dev`. Si el servidor no llega, la app sigue funcionando y el tipo se escribe a mano.
- Para cambiar quién puede entrar: la regla de Authelia (paso 4) y `APP_USERS` en `ecosystem.config.cjs`, que tienen que coincidir.
