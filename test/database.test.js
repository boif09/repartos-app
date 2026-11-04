import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrate, openDatabase } from '../src/database.js';

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
}

test('las migraciones crean el esquema y fijan user_version', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  assert.deepEqual(tableNames(db), [
    'activity', 'activity_seen', 'app_settings', 'expense_groups', 'expense_payers', 'expense_shares', 'expenses',
    'fx_cache', 'group_members', 'people', 'push_subscriptions', 'settlements',
  ]);
  assert.ok(db.prepare('PRAGMA table_info(fx_cache)').all().some((column) => column.name === 'published_on'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.at(-1).version);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.close();
});

test('migrar dos veces no hace nada', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  assert.doesNotThrow(() => migrate(db));
  db.close();
});

test('una migración que falla se revierte entera', () => {
  const db = new DatabaseSync(':memory:');
  const broken = [{ version: 1, name: 'rota', sql: 'CREATE TABLE a (id INTEGER); CREATE TABLE a (id INTEGER);' }];
  assert.throws(() => migrate(db, broken), /Falló la migración 1/);
  assert.deepEqual(tableNames(db), []);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  db.close();
});

test('restricciones del esquema: nombres únicos activos e integridad referencial', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  db.prepare("INSERT INTO people (name) VALUES ('Xavi')").run();
  assert.throws(() => db.prepare("INSERT INTO people (name) VALUES ('xavi')").run(), /UNIQUE/);
  db.prepare("UPDATE people SET archived_at = CURRENT_TIMESTAMP WHERE name = 'Xavi'").run();
  assert.doesNotThrow(() => db.prepare("INSERT INTO people (name) VALUES ('Xavi')").run());

  assert.throws(() => db.prepare('INSERT INTO group_members (group_id, person_id) VALUES (999, 1)').run(), /FOREIGN KEY/);
  db.close();
});
