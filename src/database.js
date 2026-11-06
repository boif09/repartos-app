import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Cada migración se aplica una sola vez, en orden. PRAGMA user_version guarda la última aplicada.
// Nunca editar una migración ya desplegada: añadir una nueva al final.
export const MIGRATIONS = [
  {
    version: 1,
    name: 'esquema inicial',
    sql: `
      CREATE TABLE people (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        -- Usuario de Authelia asociado (xavi, judit). NULL para amigos sin cuenta.
        auth_user   TEXT UNIQUE,
        archived_at TEXT,
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX ux_people_name ON people(name COLLATE NOCASE) WHERE archived_at IS NULL;

      -- "groups" es palabra clave en SQLite >= 3.28
      CREATE TABLE expense_groups (
        id             INTEGER PRIMARY KEY,
        title          TEXT NOT NULL,
        emoji          TEXT,
        base_currency  TEXT NOT NULL DEFAULT 'EUR',
        simplify_debts INTEGER NOT NULL DEFAULT 1 CHECK (simplify_debts IN (0, 1)),
        default_split  TEXT,
        share_token    TEXT UNIQUE,
        archived_at    TEXT,
        created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE group_members (
        group_id  INTEGER NOT NULL REFERENCES expense_groups(id),
        person_id INTEGER NOT NULL REFERENCES people(id),
        PRIMARY KEY (group_id, person_id)
      );

      CREATE TABLE expenses (
        id             TEXT PRIMARY KEY,
        group_id       INTEGER NOT NULL REFERENCES expense_groups(id),
        description    TEXT NOT NULL,
        spent_on       TEXT NOT NULL,
        payer_id       INTEGER NOT NULL REFERENCES people(id),
        original_minor INTEGER NOT NULL CHECK (original_minor > 0),
        currency       TEXT NOT NULL,
        fx_rate        TEXT,
        fx_source      TEXT CHECK (fx_source IN ('ecb', 'manual', 'card')),
        base_cents     INTEGER NOT NULL CHECK (base_cents > 0),
        split_mode     TEXT NOT NULL CHECK (split_mode IN ('equal', 'exact', 'shares')),
        notes          TEXT,
        version        INTEGER NOT NULL DEFAULT 1,
        deleted_at     TEXT,
        created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX ix_expenses_group ON expenses(group_id, deleted_at, spent_on);

      CREATE TABLE expense_shares (
        expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        person_id   INTEGER NOT NULL REFERENCES people(id),
        input_value INTEGER NOT NULL,
        owed_cents  INTEGER NOT NULL,
        PRIMARY KEY (expense_id, person_id)
      );

      CREATE TABLE settlements (
        id           TEXT PRIMARY KEY,
        group_id     INTEGER NOT NULL REFERENCES expense_groups(id),
        from_id      INTEGER NOT NULL REFERENCES people(id),
        to_id        INTEGER NOT NULL REFERENCES people(id),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        paid_on      TEXT NOT NULL,
        deleted_at   TEXT,
        created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (from_id <> to_id)
      );
      CREATE INDEX ix_settlements_group ON settlements(group_id, deleted_at);

      CREATE TABLE fx_cache (
        base  TEXT NOT NULL,
        quote TEXT NOT NULL,
        day   TEXT NOT NULL,
        rate  TEXT NOT NULL,
        PRIMARY KEY (base, quote, day)
      );
    `,
  },
  {
    version: 2,
    name: 'fecha de publicación en la caché de tipos de cambio',
    sql: `
      -- El BCE no publica en fines de semana ni festivos: el tipo de un domingo es el del viernes.
      ALTER TABLE fx_cache ADD COLUMN published_on TEXT;
    `,
  },
  {
    version: 3,
    name: 'varios pagadores, categorías, autoría, actividad y avisos push',
    sql: `
      -- Quién puso cuánto. input_value en la moneda ORIGINAL del gasto; paid_cents en la del grupo
      -- (Σ paid_cents = base_cents). expenses.payer_id queda como pagador principal.
      CREATE TABLE expense_payers (
        expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        person_id   INTEGER NOT NULL REFERENCES people(id),
        input_value INTEGER NOT NULL,
        paid_cents  INTEGER NOT NULL,
        PRIMARY KEY (expense_id, person_id)
      );
      INSERT INTO expense_payers (expense_id, person_id, input_value, paid_cents)
        SELECT id, payer_id, original_minor, base_cents FROM expenses;

      ALTER TABLE expenses ADD COLUMN category TEXT;
      ALTER TABLE expenses ADD COLUMN created_by INTEGER REFERENCES people(id);
      ALTER TABLE expenses ADD COLUMN updated_by INTEGER REFERENCES people(id);
      ALTER TABLE settlements ADD COLUMN created_by INTEGER REFERENCES people(id);

      -- Todo lo que pasa en los grupos, para "Actividad" y las novedades.
      CREATE TABLE activity (
        id         INTEGER PRIMARY KEY,
        group_id   INTEGER NOT NULL REFERENCES expense_groups(id),
        actor_id   INTEGER REFERENCES people(id),
        kind       TEXT NOT NULL,
        subject_id TEXT,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX ix_activity_group ON activity(group_id, id);

      -- Hasta dónde ha visto cada persona la actividad.
      CREATE TABLE activity_seen (
        person_id    INTEGER PRIMARY KEY REFERENCES people(id),
        last_seen_id INTEGER NOT NULL DEFAULT 0
      );

      -- Suscripciones a avisos push (una por móvil o navegador).
      CREATE TABLE push_subscriptions (
        endpoint   TEXT PRIMARY KEY,
        person_id  INTEGER NOT NULL REFERENCES people(id),
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- Ajustes internos (p. ej. las claves VAPID de los avisos).
      CREATE TABLE app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: 'color de cada grupo',
    sql: `
      -- Clave de shared/palette.js; NULL = color por defecto según el id del grupo.
      ALTER TABLE expense_groups ADD COLUMN color TEXT;
    `,
  },
  {
    version: 5,
    name: 'gastos recurrentes y grupos de viaje',
    sql: `
      -- Viaje: el resumen muestra el gasto de cada día.
      ALTER TABLE expense_groups ADD COLUMN is_trip INTEGER NOT NULL DEFAULT 0;

      -- Un gasto que se repite. id = el del gasto con el que se creó la serie.
      -- template: el cuerpo del gasto (importe, quién pagó, reparto…) sin id ni fecha, siempre en
      -- la moneda del grupo. next_on: la próxima fecha que falta por crear.
      -- paused_reason: si una repetición no se pudo crear (p. ej. alguien salió del grupo).
      CREATE TABLE recurring_expenses (
        id             TEXT PRIMARY KEY,
        group_id       INTEGER NOT NULL REFERENCES expense_groups(id) ON DELETE CASCADE,
        frequency      TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
        anchor_on      TEXT NOT NULL,
        next_on        TEXT NOT NULL,
        template       TEXT NOT NULL,
        created_by     INTEGER REFERENCES people(id),
        paused_reason  TEXT,
        created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX ix_recurring_next ON recurring_expenses(next_on);

      -- De qué serie salió cada gasto (NULL = gasto normal).
      ALTER TABLE expenses ADD COLUMN recurring_id TEXT;
    `,
  },
];

export function openDatabase(options = {}) {
  const dbPath = options.dbPath || process.env.DB_PATH || path.join(projectRoot, 'data', 'repartos.db');

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db, migrations = MIGRATIONS) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version);
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${Number(migration.version)};`);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw new Error(`Falló la migración ${migration.version} (${migration.name}): ${error.message}`);
    }
  }
}
