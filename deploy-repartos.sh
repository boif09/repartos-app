#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# Despliegue de Repartos (actualizaciones; la primera instalación
# está en docs/DESPLIEGUE.md).
#
# Uso normal:
#   ./deploy-repartos.sh
#
# Variables opcionales:
#   APP_DIR=/var/www/repartos-app PM2_APP=repartos BRANCH=main ./deploy-repartos.sh
# ============================================================

APP_DIR="${APP_DIR:-/var/www/repartos-app}"
PM2_APP="${PM2_APP:-repartos}"
DB_PATH="${DB_PATH:-/var/lib/repartos/repartos.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/repartos}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3016/api/health}"

log() {
  printf '\n\033[1;34m[Repartos]\033[0m %s\n' "$1"
}

error() {
  printf '\n\033[1;31m[ERROR]\033[0m %s\n' "$1" >&2
}

# Node y pm2 están instalados con nvm: en una sesión sin terminal no están en el PATH.
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" >/dev/null
fi

on_error() {
  local exit_code=$?
  error "El despliegue ha fallado (código $exit_code)."
  error "Revisa los logs con: pm2 logs $PM2_APP --lines 100"
  exit "$exit_code"
}
trap on_error ERR

log "Comprobando requisitos..."
for cmd in git node npm pm2 curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    error "No se encuentra el comando '$cmd'."
    exit 1
  fi
done

cd "$APP_DIR"
[[ -d .git ]] || { error "$APP_DIR no es un repositorio Git."; exit 1; }

BRANCH="${BRANCH:-$(git branch --show-current)}"
BRANCH="${BRANCH:-main}"
log "Aplicación: $APP_DIR · rama $BRANCH · proceso PM2 $PM2_APP · Node $(node -v)"

# No continúa con cambios locales en archivos versionados (la base de datos está fuera del repo).
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  error "Hay cambios locales en archivos controlados por Git:"
  git status --short
  exit 1
fi

log "Descargando cambios..."
git fetch origin "$BRANCH"
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
REMOTE_COMMIT="$(git rev-parse "origin/$BRANCH")"

if [[ "$PREVIOUS_COMMIT" == "$REMOTE_COMMIT" ]]; then
  log "El código ya está al día ($PREVIOUS_COMMIT). No hay nada que desplegar."
  exit 0
fi

# Copia de la base de datos antes de cambiar el código (las migraciones se aplican al arrancar).
if [[ -f "$DB_PATH" ]]; then
  log "Copia de seguridad de la base de datos..."
  DB_PATH="$DB_PATH" BACKUP_DIR="$BACKUP_DIR" node --no-warnings scripts/backup-db.js
else
  log "Aún no existe $DB_PATH: se creará al arrancar."
fi

log "Aplicando $PREVIOUS_COMMIT..$REMOTE_COMMIT:"
git log --oneline "$PREVIOUS_COMMIT..$REMOTE_COMMIT"
git pull --ff-only origin "$BRANCH"

log "Comprobando el código y pasando los tests..."
npm run check
npm test

log "Reiniciando la aplicación..."
if pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  pm2 restart ecosystem.config.cjs --only "$PM2_APP" --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

log "Comprobando que responde..."
for attempt in $(seq 1 15); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "Despliegue completado: $(git rev-parse --short HEAD) responde en $HEALTH_URL"
    exit 0
  fi
  sleep 1
done

error "La aplicación no responde en $HEALTH_URL."
pm2 logs "$PM2_APP" --lines 40 --nostream || true
error "Para volver a la versión anterior:"
error "  cd $APP_DIR && git checkout $PREVIOUS_COMMIT && pm2 restart $PM2_APP"
error "y, si hiciera falta, restaurar la última copia de $BACKUP_DIR (ver docs/DESPLIEGUE.md)."
exit 1
