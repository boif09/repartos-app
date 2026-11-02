// Copia de seguridad de la base SQLite, consistente y sin parar la app (VACUUM INTO),
// verificada con integrity_check y con rotación de las copias antiguas.
//
// Uso: DB_PATH=/var/lib/repartos/repartos.db BACKUP_DIR=/var/backups/repartos KEEP_DAYS=30 node scripts/backup-db.js
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || path.join(projectRoot, 'data', 'repartos.db');
const backupDir = process.env.BACKUP_DIR || path.join(projectRoot, 'data', 'backups');
const keepDays = Number(process.env.KEEP_DAYS || 30);
const BACKUP_NAME = /^repartos-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function fail(message) {
  console.error(`[${new Date().toISOString()}] ERROR: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(dbPath)) fail(`No existe la base de datos: ${dbPath}`);
if (!Number.isFinite(keepDays) || keepDays < 1) fail('KEEP_DAYS debe ser un número mayor que 0.');
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace('T', '-').replace(/:/g, '');
const target = path.join(backupDir, `repartos-${stamp}.db`);
if (fs.existsSync(target)) fail(`Ya existe ${target}`);

// VACUUM INTO funciona con la app escribiendo (WAL) y sobre una conexión de solo lectura.
const source = new DatabaseSync(dbPath, { readOnly: true });
try {
  source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  source.close();
}

const copy = new DatabaseSync(target, { readOnly: true });
try {
  const integrity = copy.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') {
    fs.rmSync(target, { force: true });
    fail(`La copia no supera integrity_check: ${integrity}`);
  }
  const version = copy.prepare('PRAGMA user_version').get().user_version;
  const expenses = copy.prepare('SELECT COUNT(*) AS n FROM expenses').get().n;
  log(`Copia creada: ${target} (${fs.statSync(target).size} bytes, esquema v${version}, ${expenses} gastos)`);
} finally {
  copy.close();
}

// Rotación: borra copias de más de KEEP_DAYS días, pero nunca la más reciente.
const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
const backups = fs.readdirSync(backupDir)
  .filter((name) => BACKUP_NAME.test(name))
  .map((name) => ({ name, mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
for (const backup of backups.slice(1)) {
  if (backup.mtime < cutoff) {
    fs.rmSync(path.join(backupDir, backup.name));
    log(`Copia antigua borrada: ${backup.name}`);
  }
}
