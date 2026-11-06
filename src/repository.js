import crypto from 'node:crypto';
import { badRequest, conflict, notFound } from './errors.js';
import { MAX_CENTS, currencyExponent, isCurrencyCode } from '../shared/money.js';
import { convertMinor, parseRate } from '../shared/fx.js';
import { isPushEndpoint } from './push.js';
import { computePayers, computeShares, mainPayer, SplitError, SPLIT_MODES } from '../shared/splits.js';
import { CATEGORY_KEYS } from '../shared/categories.js';
import { GROUP_COLOR_KEYS } from '../shared/palette.js';
import { FREQUENCIES, nextOccurrence, todayIn } from '../shared/recurring.js';
import { computeBalances, pairwiseDebts } from '../shared/balances.js';
import { settle } from '../shared/settle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Validación de entrada ----------

function text(value, field, { max, required = true } = {}) {
  const cleaned = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!cleaned) {
    if (required) throw badRequest(`Falta ${field}.`);
    return null;
  }
  if (cleaned.length > max) throw badRequest(`${field[0].toUpperCase()}${field.slice(1)} es demasiado largo (máximo ${max} caracteres).`);
  return cleaned;
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`${field} no válido.`);
  return id;
}

function cents(value, field = 'El importe') {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest(`${field} debe ser mayor que cero.`);
  if (amount > MAX_CENTS) throw badRequest(`${field} es demasiado grande.`);
  return amount;
}

function currencyCode(value, field = 'Moneda') {
  const code = String(value ?? '').trim().toUpperCase();
  if (!isCurrencyCode(code)) throw badRequest(`${field} no válida.`);
  return code;
}

function isoDate(value) {
  const date = String(value ?? '');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!ISO_DATE.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw badRequest('Fecha no válida.');
  }
  return date;
}

function uuid(value) {
  const id = String(value ?? '');
  if (!UUID.test(id)) throw badRequest('Identificador no válido.');
  return id.toLowerCase();
}

function emoji(value) {
  const cleaned = String(value ?? '').trim();
  if (!cleaned) return null;
  if ([...cleaned].length > 4) throw badRequest('Emoji no válido.');
  return cleaned;
}

function groupColorKey(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!GROUP_COLOR_KEYS.includes(value)) throw badRequest('Color de grupo no válido.');
  return value;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ---------- Mapeo de filas ----------

const toPerson = (row) => ({ id: row.id, name: row.name, authUser: row.auth_user ?? null });

const toGroup = (row) => ({
  id: row.id,
  title: row.title,
  emoji: row.emoji ?? null,
  color: row.color ?? null,
  isTrip: row.is_trip === 1,
  baseCurrency: row.base_currency,
  simplifyDebts: row.simplify_debts === 1,
  defaultSplit: parseDefaultSplit(row.default_split),
  shareToken: row.share_token ?? null,
  archived: row.archived_at !== null,
});

const SHARE_TOKEN = /^[A-Za-z0-9_-]{22}$/;

// Reparto por defecto del grupo (p. ej. 60/40 en Pareja): [{ personId, weight }] o null = a partes iguales.
function parseDefaultSplit(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const toSettlement = (row) => ({
  id: row.id,
  groupId: row.group_id,
  fromId: row.from_id,
  toId: row.to_id,
  amountCents: row.amount_cents,
  paidOn: row.paid_on,
  createdBy: row.created_by ?? null,
  createdAt: row.created_at,
});

const ACTIVITY_PAGE = 30;

// onActivity(evento) se llama DESPUÉS de confirmar cada cambio (p. ej. para enviar avisos push).
export function createRepository(db, { onActivity = () => {} } = {}) {
  let pendingEvents = [];

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      db.exec('COMMIT;');
      const events = pendingEvents;
      pendingEvents = [];
      for (const event of events) {
        try {
          onActivity(event);
        } catch (error) {
          console.error('Error al notificar actividad:', error);
        }
      }
      return result;
    } catch (error) {
      db.exec('ROLLBACK;');
      pendingEvents = [];
      throw error;
    }
  }

  // ---------- Actividad ----------

  function personName(id) {
    return id ? db.prepare('SELECT name FROM people WHERE id = ?').get(id)?.name ?? null : null;
  }

  // Siempre dentro de una transacción: si el cambio se deshace, la actividad también.
  function logActivity(groupId, actorId, kind, subjectId, data) {
    const result = db.prepare('INSERT INTO activity (group_id, actor_id, kind, subject_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(groupId, actorId ?? null, kind, subjectId ?? null, JSON.stringify(data ?? {}));
    pendingEvents.push({ id: Number(result.lastInsertRowid), groupId, actorId: actorId ?? null, kind, subjectId: subjectId ?? null, data: data ?? {} });
  }

  function toActivity(row) {
    let data = {};
    try {
      data = JSON.parse(row.data);
    } catch { /* datos dañados: se muestra sin detalle */ }
    return {
      id: row.id,
      groupId: row.group_id,
      groupTitle: row.group_title,
      groupEmoji: row.group_emoji ?? null,
      groupColor: row.group_color ?? null,
      groupCurrency: row.group_currency,
      actorId: row.actor_id ?? null,
      actorName: row.actor_name ?? null,
      kind: row.kind,
      subjectId: row.subject_id ?? null,
      data,
      createdAt: row.created_at,
    };
  }

  // Lo último que ha pasado en los grupos de meId, de más reciente a más antiguo.
  function listActivity(meId, { before, limit } = {}) {
    const max = Math.min(Math.max(Number(limit) || ACTIVITY_PAGE, 1), 100);
    const cursor = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(`
      SELECT a.*, g.title AS group_title, g.emoji AS group_emoji, g.color AS group_color, g.base_currency AS group_currency, p.name AS actor_name
      FROM activity a
      JOIN group_members gm ON gm.group_id = a.group_id AND gm.person_id = ?
      JOIN expense_groups g ON g.id = a.group_id
      LEFT JOIN people p ON p.id = a.actor_id
      WHERE a.id < ?
      ORDER BY a.id DESC
      LIMIT ?
    `).all(meId, cursor, max + 1);
    const items = rows.slice(0, max).map(toActivity);
    return {
      items,
      nextBefore: rows.length > max ? items.at(-1).id : null,
      lastSeenId: lastSeenId(meId),
      unread: unreadCount(meId),
    };
  }

  function lastSeenId(meId) {
    return db.prepare('SELECT last_seen_id FROM activity_seen WHERE person_id = ?').get(meId)?.last_seen_id ?? 0;
  }

  // Novedades: lo que han hecho otras personas en mis grupos desde la última vez que miré.
  function unreadCount(meId) {
    return Number(db.prepare(`
      SELECT COUNT(*) AS n FROM activity a
      JOIN group_members gm ON gm.group_id = a.group_id AND gm.person_id = ?
      WHERE a.id > ? AND (a.actor_id IS NULL OR a.actor_id <> ?)
    `).get(meId, lastSeenId(meId), meId).n);
  }

  function markActivitySeen(meId, lastId) {
    const id = Number(lastId);
    if (!Number.isSafeInteger(id) || id < 0) throw badRequest('Identificador no válido.');
    db.prepare(`
      INSERT INTO activity_seen (person_id, last_seen_id) VALUES (?, ?)
      ON CONFLICT(person_id) DO UPDATE SET last_seen_id = MAX(last_seen_id, excluded.last_seen_id)
    `).run(meId, id);
    return { lastSeenId: lastSeenId(meId), unread: unreadCount(meId) };
  }

  // ---------- Avisos push y ajustes ----------

  function getSetting(key) {
    return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
  }

  function setSetting(key, value) {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  function savePushSubscription(meId, subscription) {
    const endpoint = String(subscription?.endpoint ?? '');
    const p256dh = String(subscription?.keys?.p256dh ?? '');
    const auth = String(subscription?.keys?.auth ?? '');
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw badRequest('Suscripción no válida.');
    }
    if (url.protocol !== 'https:' || endpoint.length > 1000 || !isPushEndpoint(endpoint)) throw badRequest('Suscripción no válida.');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) throw badRequest('Suscripción no válida.');
    db.prepare(`
      INSERT INTO push_subscriptions (endpoint, person_id, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth
    `).run(endpoint, meId, p256dh, auth);
    return { subscribed: true };
  }

  function deletePushSubscription(meId, endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND person_id = ?').run(String(endpoint ?? ''), meId);
    return { subscribed: false };
  }

  function forgetPushEndpoint(endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  // Suscripciones de los miembros del grupo, salvo quien hizo el cambio.
  function pushTargets(groupId, actorId) {
    return db.prepare(`
      SELECT s.*, p.name AS person_name FROM push_subscriptions s
      JOIN group_members gm ON gm.person_id = s.person_id AND gm.group_id = ?
      JOIN people p ON p.id = s.person_id
      WHERE s.person_id <> ?
    `).all(groupId, actorId ?? 0);
  }

  function groupTitle(groupId) {
    return db.prepare('SELECT title, base_currency FROM expense_groups WHERE id = ?').get(groupId) ?? null;
  }

  // ---------- Personas ----------

  function findActivePersonByName(name) {
    return db.prepare('SELECT * FROM people WHERE name = ? COLLATE NOCASE AND archived_at IS NULL').get(name);
  }

  function getPersonRow(id) {
    const row = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
    if (!row) throw notFound('Persona no encontrada.');
    return row;
  }

  // Persona asociada al usuario de Authelia. Se crea (o se enlaza por nombre) la primera vez.
  function ensureAuthPerson(authUser) {
    const linked = db.prepare('SELECT * FROM people WHERE auth_user = ?').get(authUser);
    if (linked) return toPerson(linked);
    return transaction(() => {
      const name = capitalize(authUser);
      const sameName = findActivePersonByName(name);
      if (sameName && sameName.auth_user === null) {
        db.prepare('UPDATE people SET auth_user = ? WHERE id = ?').run(authUser, sameName.id);
        return toPerson({ ...sameName, auth_user: authUser });
      }
      const finalName = sameName ? `${name} (${authUser})` : name;
      const result = db.prepare('INSERT INTO people (name, auth_user) VALUES (?, ?)').run(finalName, authUser);
      return toPerson(getPersonRow(Number(result.lastInsertRowid)));
    });
  }

  function listPeople() {
    return db.prepare('SELECT * FROM people WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE').all().map(toPerson);
  }

  // Si ya existe una persona activa con ese nombre se reutiliza: así se comparten entre grupos.
  function findOrCreatePerson(rawName) {
    const name = text(rawName, 'el nombre', { max: 40 });
    const existing = findActivePersonByName(name);
    if (existing) return toPerson(existing);
    const result = db.prepare('INSERT INTO people (name) VALUES (?)').run(name);
    return toPerson(getPersonRow(Number(result.lastInsertRowid)));
  }

  function renamePerson(id, rawName) {
    const row = getPersonRow(positiveId(id, 'Persona'));
    const name = text(rawName, 'el nombre', { max: 40 });
    const other = findActivePersonByName(name);
    if (other && other.id !== row.id) throw conflict('Ya existe otra persona con ese nombre.');
    db.prepare('UPDATE people SET name = ? WHERE id = ?').run(name, row.id);
    return toPerson({ ...row, name });
  }

  // ---------- Grupos ----------

  function getGroupRow(id) {
    const row = db.prepare('SELECT * FROM expense_groups WHERE id = ?').get(positiveId(id, 'Grupo'));
    if (!row) throw notFound('Grupo no encontrado.');
    return row;
  }

  function getWritableGroupRow(id) {
    const row = getGroupRow(id);
    if (row.archived_at !== null) throw conflict('El grupo está archivado. Desarchívalo para hacer cambios.');
    return row;
  }

  function memberIds(groupId) {
    return db.prepare('SELECT person_id FROM group_members WHERE group_id = ? ORDER BY person_id').all(groupId).map((row) => row.person_id);
  }

  function listMembers(groupId) {
    return db.prepare(`
      SELECT p.* FROM group_members gm JOIN people p ON p.id = gm.person_id
      WHERE gm.group_id = ? ORDER BY p.name COLLATE NOCASE
    `).all(groupId).map(toPerson);
  }

  function addMemberRow(groupId, personId) {
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, person_id) VALUES (?, ?)').run(groupId, personId);
  }

  function activeExpenses(groupId) {
    const expenses = db.prepare(`
      SELECT * FROM expenses WHERE group_id = ? AND deleted_at IS NULL
      ORDER BY spent_on DESC, created_at DESC, id
    `).all(groupId);
    const shares = db.prepare(`
      SELECT s.* FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
      WHERE e.group_id = ? AND e.deleted_at IS NULL ORDER BY s.person_id
    `).all(groupId);
    const byExpense = new Map();
    for (const share of shares) {
      if (!byExpense.has(share.expense_id)) byExpense.set(share.expense_id, []);
      byExpense.get(share.expense_id).push({ personId: share.person_id, inputValue: share.input_value, owedCents: share.owed_cents });
    }
    const payers = db.prepare(`
      SELECT p.* FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
      WHERE e.group_id = ? AND e.deleted_at IS NULL ORDER BY p.paid_cents DESC, p.person_id
    `).all(groupId);
    const payersByExpense = new Map();
    for (const payer of payers) {
      if (!payersByExpense.has(payer.expense_id)) payersByExpense.set(payer.expense_id, []);
      payersByExpense.get(payer.expense_id).push({ personId: payer.person_id, inputValue: payer.input_value, paidCents: payer.paid_cents });
    }
    return expenses.map((row) => toExpense(row, byExpense.get(row.id) || [], payersByExpense.get(row.id) || []));
  }

  function activeSettlements(groupId) {
    return db.prepare(`
      SELECT * FROM settlements WHERE group_id = ? AND deleted_at IS NULL
      ORDER BY paid_on DESC, created_at DESC, id
    `).all(groupId).map(toSettlement);
  }

  function computeGroupMoney(groupId, simplifyDebts) {
    const expenses = activeExpenses(groupId);
    const settlements = activeSettlements(groupId);
    const balanceExpenses = expenses.map((expense) => ({ payerId: expense.payerId, baseCents: expense.amountCents, shares: expense.shares, payers: expense.payers }));
    const balances = computeBalances(memberIds(groupId), balanceExpenses, settlements);
    const transfers = simplifyDebts ? settle(balances) : pairwiseDebts(balanceExpenses, settlements);
    return { expenses, settlements, balances, transfers };
  }

  function listGroups(meId) {
    const rows = db.prepare('SELECT * FROM expense_groups ORDER BY archived_at IS NOT NULL, created_at DESC, id DESC').all();
    return rows.map((row) => {
      const members = memberIds(row.id);
      const { balances, expenses } = computeGroupMoney(row.id, false);
      return {
        ...toGroup(row),
        memberCount: members.length,
        expenseCount: expenses.length,
        myBalanceCents: members.includes(meId) ? balances.get(meId) ?? 0 : null,
      };
    });
  }

  function getGroupBundle(groupId, meId) {
    const row = getGroupRow(groupId);
    const group = toGroup(row);
    const { expenses, settlements, balances, transfers } = computeGroupMoney(row.id, group.simplifyDebts);
    const members = listMembers(row.id);
    // Si alguien salió del grupo, su entrada del reparto por defecto deja de contar.
    if (group.defaultSplit) {
      const current = new Set(members.map((member) => member.id));
      const entries = group.defaultSplit.filter((entry) => current.has(entry.personId));
      group.defaultSplit = entries.some((entry) => entry.weight > 0) ? entries : null;
    }
    return {
      group,
      members,
      expenses,
      settlements,
      balances: [...balances].map(([personId, amountCents]) => ({ personId, amountCents })),
      transfers,
      myBalanceCents: balances.has(meId) ? balances.get(meId) : null,
      recurring: listRecurring(row.id),
    };
  }

  // ---------- Enlace de solo lectura para amigos ----------

  // Token aleatorio de 128 bits. Regenerarlo invalida el enlace anterior; null deja de compartir.
  function setShareLink(groupId, enabled, meId) {
    const row = getGroupRow(groupId);
    const token = enabled ? crypto.randomBytes(16).toString('base64url') : null;
    db.prepare('UPDATE expense_groups SET share_token = ? WHERE id = ?').run(token, row.id);
    return getGroupBundle(row.id, meId);
  }

  // Lo que ve un amigo con el enlace: sin token, sin usuarios de Authelia y sin "yo".
  function getSharedBundle(token) {
    const row = SHARE_TOKEN.test(String(token)) ? db.prepare('SELECT * FROM expense_groups WHERE share_token = ?').get(token) : null;
    if (!row) throw notFound('Este enlace no existe o ya no está compartido.');
    const bundle = getGroupBundle(row.id, null);
    const { shareToken, defaultSplit, ...group } = bundle.group;
    return {
      group,
      members: bundle.members.map(({ id, name }) => ({ id, name })),
      expenses: bundle.expenses.map(({ notes, version, deleted, ...expense }) => expense),
      settlements: bundle.settlements,
      balances: bundle.balances,
      transfers: bundle.transfers,
    };
  }

  // ---------- Resumen de una persona en todos sus grupos ----------

  function personSummary(personId) {
    const person = getPersonRow(positiveId(personId, 'Persona'));
    const rows = db.prepare(`
      SELECT g.* FROM group_members gm JOIN expense_groups g ON g.id = gm.group_id
      WHERE gm.person_id = ? ORDER BY g.archived_at IS NOT NULL, g.created_at DESC, g.id DESC
    `).all(person.id);
    const totals = new Map();
    const groups = rows.map((row) => {
      const { balances } = computeGroupMoney(row.id, false);
      const balanceCents = balances.get(person.id) ?? 0;
      if (row.archived_at === null) totals.set(row.base_currency, (totals.get(row.base_currency) || 0) + balanceCents);
      const { shareToken, ...group } = toGroup(row);
      return { ...group, balanceCents };
    });
    return {
      person: toPerson(person),
      groups,
      totals: [...totals].map(([currency, amountCents]) => ({ currency, amountCents })),
    };
  }

  function resolveMemberInput(input) {
    if (input?.personId !== undefined && input?.personId !== null) {
      const row = getPersonRow(positiveId(input.personId, 'Persona'));
      if (row.archived_at !== null) throw conflict('Esa persona está archivada.');
      return row.id;
    }
    return findOrCreatePerson(input?.name).id;
  }

  function createGroup(body, meId) {
    const title = text(body?.title, 'el título', { max: 60 });
    const groupEmoji = emoji(body?.emoji);
    const color = groupColorKey(body?.color);
    const baseCurrency = body?.baseCurrency === undefined ? 'EUR' : currencyCode(body.baseCurrency, 'La moneda del grupo');
    const members = Array.isArray(body?.members) ? body.members : [];
    if (members.length > 50) throw badRequest('Demasiadas personas en el grupo.');
    return transaction(() => {
      const result = db.prepare('INSERT INTO expense_groups (title, emoji, color, base_currency, is_trip) VALUES (?, ?, ?, ?, ?)')
        .run(title, groupEmoji, color, baseCurrency, body?.isTrip ? 1 : 0);
      const groupId = Number(result.lastInsertRowid);
      addMemberRow(groupId, meId);
      for (const member of members) addMemberRow(groupId, resolveMemberInput(member));
      logActivity(groupId, meId, 'group_created', null, { title });
      return getGroupBundle(groupId, meId);
    });
  }

  function updateGroup(groupId, body, meId) {
    const row = getGroupRow(groupId);
    // Un grupo archivado solo admite desarchivarse.
    const onlyUnarchive = Object.keys(body || {}).every((key) => key === 'archived') && body?.archived === false;
    if (row.archived_at !== null && !onlyUnarchive) {
      throw conflict('El grupo está archivado. Desarchívalo para hacer cambios.');
    }
    return transaction(() => {
      const changes = [];
      if (body?.title !== undefined) {
        const title = text(body.title, 'el título', { max: 60 });
        if (title !== row.title) changes.push('title');
        db.prepare('UPDATE expense_groups SET title = ? WHERE id = ?').run(title, row.id);
      }
      if (body?.emoji !== undefined) {
        db.prepare('UPDATE expense_groups SET emoji = ? WHERE id = ?').run(emoji(body.emoji), row.id);
      }
      if (body?.isTrip !== undefined) {
        db.prepare('UPDATE expense_groups SET is_trip = ? WHERE id = ?').run(body.isTrip ? 1 : 0, row.id);
      }
      if (body?.color !== undefined) {
        db.prepare('UPDATE expense_groups SET color = ? WHERE id = ?').run(groupColorKey(body.color), row.id);
      }
      if (body?.simplifyDebts !== undefined) {
        db.prepare('UPDATE expense_groups SET simplify_debts = ? WHERE id = ?').run(body.simplifyDebts ? 1 : 0, row.id);
      }
      if (body?.baseCurrency !== undefined) {
        const baseCurrency = currencyCode(body.baseCurrency, 'La moneda del grupo');
        if (baseCurrency !== row.base_currency) {
          const used = db.prepare(`
            SELECT 1 FROM expenses WHERE group_id = ? AND deleted_at IS NULL
            UNION ALL SELECT 1 FROM settlements WHERE group_id = ? AND deleted_at IS NULL LIMIT 1
          `).get(row.id, row.id);
          if (used) throw conflict('La moneda del grupo solo se puede cambiar mientras no tenga gastos ni pagos.');
          db.prepare('UPDATE expense_groups SET base_currency = ? WHERE id = ?').run(baseCurrency, row.id);
          changes.push('currency');
        }
      }
      if (body?.defaultSplit !== undefined) {
        db.prepare('UPDATE expense_groups SET default_split = ? WHERE id = ?').run(validateDefaultSplit(body.defaultSplit, row.id), row.id);
        changes.push('defaultSplit');
      }
      if (body?.archived !== undefined) {
        if (body.archived) {
          const { balances } = computeGroupMoney(row.id, false);
          if ([...balances.values()].some((value) => value !== 0)) {
            throw conflict('Solo se puede archivar un grupo con todas las cuentas saldadas.');
          }
          db.prepare('UPDATE expense_groups SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP) WHERE id = ?').run(row.id);
          if (row.archived_at === null) logActivity(row.id, meId, 'group_archived', null, {});
        } else {
          db.prepare('UPDATE expense_groups SET archived_at = NULL WHERE id = ?').run(row.id);
          if (row.archived_at !== null) logActivity(row.id, meId, 'group_unarchived', null, {});
        }
      }
      if (changes.includes('title')) logActivity(row.id, meId, 'group_renamed', null, { from: row.title, title: text(body.title, 'el título', { max: 60 }) });
      if (changes.includes('currency')) logActivity(row.id, meId, 'group_currency', null, { currency: currencyCode(body.baseCurrency) });
      if (changes.includes('defaultSplit')) logActivity(row.id, meId, 'group_default_split', null, {});
      return getGroupBundle(row.id, meId);
    });
  }

  // null o [] = a partes iguales. Pesos enteros 0..1000; 0 = no participa por defecto.
  function validateDefaultSplit(value, groupId) {
    if (value === null || (Array.isArray(value) && value.length === 0)) return null;
    if (!Array.isArray(value)) throw badRequest('Reparto por defecto no válido.');
    const members = new Set(memberIds(groupId));
    const seen = new Set();
    const entries = value.map((entry) => {
      const personId = positiveId(entry?.personId, 'Persona');
      const weight = Number(entry?.weight);
      if (!members.has(personId)) throw badRequest('El reparto por defecto solo puede incluir personas del grupo.');
      if (seen.has(personId)) throw badRequest('Hay una persona repetida en el reparto por defecto.');
      if (!Number.isSafeInteger(weight) || weight < 0 || weight > 1000) throw badRequest('Las partes deben ser números enteros entre 0 y 1000.');
      seen.add(personId);
      return { personId, weight };
    });
    if (!entries.some((entry) => entry.weight > 0)) throw badRequest('Al menos una persona tiene que tener partes.');
    return JSON.stringify(entries);
  }

  function addMember(groupId, body, meId) {
    const row = getWritableGroupRow(groupId);
    return transaction(() => {
      const personId = resolveMemberInput(body);
      const already = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND person_id = ?').get(row.id, personId);
      addMemberRow(row.id, personId);
      if (!already) logActivity(row.id, meId, 'member_added', String(personId), { personId, name: personName(personId) });
      return getGroupBundle(row.id, meId);
    });
  }

  function removeMember(groupId, personId, meId) {
    const row = getWritableGroupRow(groupId);
    const id = positiveId(personId, 'Persona');
    // Solo cuentan gastos y pagos activos; restaurar uno borrado vuelve a comprobar los miembros.
    const used = db.prepare(`
      SELECT 1 FROM expenses e WHERE e.group_id = ? AND e.deleted_at IS NULL AND (e.payer_id = ? OR EXISTS (
        SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.person_id = ?) OR EXISTS (
        SELECT 1 FROM expense_payers p WHERE p.expense_id = e.id AND p.person_id = ?))
      UNION ALL
      SELECT 1 FROM settlements WHERE group_id = ? AND deleted_at IS NULL AND (from_id = ? OR to_id = ?)
      LIMIT 1
    `).get(row.id, id, id, id, row.id, id, id);
    if (used) throw conflict('No se puede quitar a alguien que aparece en gastos o pagos del grupo.');
    return transaction(() => {
      const removed = db.prepare('DELETE FROM group_members WHERE group_id = ? AND person_id = ?').run(row.id, id);
      if (Number(removed.changes)) logActivity(row.id, meId, 'member_removed', String(id), { personId: id, name: personName(id) });
      return getGroupBundle(row.id, meId);
    });
  }

  // ---------- Gastos ----------

  function toExpense(row, shares, payers) {
    return {
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      spentOn: row.spent_on,
      payerId: row.payer_id,
      payers: payers.length ? payers : [{ personId: row.payer_id, inputValue: row.original_minor, paidCents: row.base_cents }],
      category: row.category ?? null,
      recurringId: row.recurring_id ?? null,
      createdBy: row.created_by ?? null,
      updatedBy: row.updated_by ?? null,
      amountCents: row.base_cents,
      originalMinor: row.original_minor,
      currency: row.currency,
      fxRate: row.fx_rate ?? null,
      fxSource: row.fx_source ?? null,
      splitMode: row.split_mode,
      notes: row.notes ?? null,
      version: row.version,
      deleted: row.deleted_at !== null,
      shares,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function getExpense(id) {
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!row) throw notFound('Gasto no encontrado.');
    const shares = db.prepare('SELECT * FROM expense_shares WHERE expense_id = ? ORDER BY person_id').all(id)
      .map((share) => ({ personId: share.person_id, inputValue: share.input_value, owedCents: share.owed_cents }));
    const payers = db.prepare('SELECT * FROM expense_payers WHERE expense_id = ? ORDER BY paid_cents DESC, person_id').all(id)
      .map((payer) => ({ personId: payer.person_id, inputValue: payer.input_value, paidCents: payer.paid_cents }));
    return toExpense(row, shares, payers);
  }

  // Importe del gasto. En la moneda del grupo basta amountCents. En otra moneda llega originalMinor
  // y el importe base sale del tipo de cambio (ecb/manual) o de lo que cobró la tarjeta (card).
  function parseMoneyInput(body, baseCurrency) {
    const currency = body?.currency === undefined ? baseCurrency : currencyCode(body.currency);
    if (currency === baseCurrency) {
      const amountCents = cents(body?.amountCents);
      return { currency, originalMinor: amountCents, amountCents, fxRate: null, fxSource: null };
    }
    const originalMinor = cents(body?.originalMinor);
    const fxSource = String(body?.fxSource || '');
    if (fxSource === 'card') {
      return { currency, originalMinor, amountCents: cents(body?.amountCents, 'Lo que cobró la tarjeta'), fxRate: null, fxSource };
    }
    if (fxSource !== 'ecb' && fxSource !== 'manual') throw badRequest('Falta el tipo de cambio.');
    const fxRate = parseRate(body?.fxRate);
    if (!fxRate) throw badRequest('Tipo de cambio no válido.');
    const amountCents = convertMinor(originalMinor, fxRate, currencyExponent(currency), currencyExponent(baseCurrency));
    if (amountCents <= 0) throw badRequest('El importe convertido es demasiado pequeño.');
    if (amountCents > MAX_CENTS) throw badRequest('El importe convertido es demasiado grande.');
    return { currency, originalMinor, amountCents, fxRate, fxSource };
  }

  function parseExpenseInput(body, groupRow, id) {
    const groupId = groupRow.id;
    const members = new Set(memberIds(groupId));
    // Varios pagadores: payers = [{ personId, value }] en la moneda original. Uno solo: payerId.
    const payerEntries = Array.isArray(body?.payers) && body.payers.length
      ? body.payers
      : [{ personId: positiveId(body?.payerId, 'Quién pagó'), value: null }];
    for (const entry of payerEntries) {
      if (!members.has(Number(entry?.personId))) throw badRequest('Quien pagó tiene que ser del grupo.');
    }
    const category = body?.category === undefined || body?.category === null || body?.category === '' ? null : String(body.category);
    if (category !== null && !CATEGORY_KEYS.includes(category)) throw badRequest('Categoría no válida.');
    const splitMode = String(body?.splitMode || 'equal');
    if (!SPLIT_MODES.includes(splitMode)) throw badRequest('Modo de reparto no válido.');
    const entries = Array.isArray(body?.shares) ? body.shares : [];
    for (const entry of entries) {
      if (!members.has(Number(entry?.personId))) throw badRequest('Todas las personas del reparto tienen que ser del grupo.');
    }
    const money = parseMoneyInput(body, groupRow.base_currency);
    let shares;
    let payers;
    try {
      shares = computeShares({ totalCents: money.amountCents, mode: splitMode, entries, seed: id, originalTotal: money.originalMinor });
      payers = computePayers({
        totalCents: money.amountCents,
        originalTotal: money.originalMinor,
        entries: payerEntries.map((entry) => ({ personId: entry.personId, value: entry.value ?? money.originalMinor })),
        seed: id,
      });
    } catch (error) {
      if (error instanceof SplitError) throw badRequest(error.message);
      throw error;
    }
    return {
      description: text(body?.description, 'la descripción', { max: 120 }),
      spentOn: isoDate(body?.spentOn),
      payerId: mainPayer(payers),
      payers,
      category,
      ...money,
      splitMode,
      notes: text(body?.notes, 'la nota', { max: 500, required: false }),
      shares,
    };
  }

  function insertShares(expenseId, shares) {
    const insert = db.prepare('INSERT INTO expense_shares (expense_id, person_id, input_value, owed_cents) VALUES (?, ?, ?, ?)');
    for (const share of shares) insert.run(expenseId, share.personId, share.inputValue, share.owedCents);
  }

  function insertPayers(expenseId, payers) {
    const insert = db.prepare('INSERT INTO expense_payers (expense_id, person_id, input_value, paid_cents) VALUES (?, ?, ?, ?)');
    for (const payer of payers) insert.run(expenseId, payer.personId, payer.inputValue, payer.paidCents);
  }

  // Lo justo para la actividad y los avisos: qué gasto, cuánto, quién pagó y cuánto le toca a cada uno.
  function expenseSummary(expense, groupRow) {
    return {
      description: expense.description,
      amountCents: expense.amountCents,
      currency: groupRow.base_currency,
      originalMinor: expense.originalMinor,
      originalCurrency: expense.currency,
      payers: expense.payers.map((payer) => ({ personId: payer.personId, name: personName(payer.personId), paidCents: payer.paidCents })),
      shares: expense.shares.map((share) => ({ personId: share.personId, owedCents: share.owedCents })),
    };
  }

  function expenseChanges(before, after) {
    const changes = [];
    if (before.description !== after.description) changes.push('description');
    if (before.amountCents !== after.amountCents || before.originalMinor !== after.originalMinor || before.currency !== after.currency) changes.push('amount');
    // Quién pagó: cambian las personas o, si eran varias, cuánto puso cada una (no basta con que cambie el total).
    const payerIds = (expense) => JSON.stringify(expense.payers.map((p) => p.personId).sort((a, b) => a - b));
    const payerSplit = (expense) => JSON.stringify(expense.payers.map((p) => [p.personId, p.inputValue]).sort((a, b) => a[0] - b[0]));
    if (payerIds(before) !== payerIds(after) || (after.payers.length > 1 && payerSplit(before) !== payerSplit(after))) changes.push('payers');
    if (before.spentOn !== after.spentOn) changes.push('date');
    if (JSON.stringify(before.shares.map((s) => [s.personId, s.owedCents])) !== JSON.stringify(after.shares.map((s) => [s.personId, s.owedCents]))) changes.push('split');
    if (before.category !== after.category) changes.push('category');
    return changes;
  }

  // Idempotente: el móvil genera el UUID; si reintenta por mala conexión, no se duplica.
  // body.repeat ('weekly' | 'monthly' | 'yearly') crea además una serie que empieza con este gasto.
  // recurringId solo lo pasa el generador de repeticiones.
  function createExpense(groupId, body, meId = null, { recurringId = null } = {}) {
    const id = uuid(body?.id);
    const row = getWritableGroupRow(groupId);
    const existing = db.prepare('SELECT group_id, recurring_id FROM expenses WHERE id = ?').get(id);
    if (existing) {
      if (existing.group_id !== row.id) throw conflict('Ese identificador ya está en uso.');
      // El id de una repetición se puede calcular: si ya lo usa otro gasto, no se da por creada.
      if (recurringId && existing.recurring_id !== recurringId) throw conflict('El identificador de esta repetición ya está en uso.');
      return { created: false, expense: getExpense(id) };
    }
    const input = parseExpenseInput(body, row, id);
    const repeat = recurringId ? null : parseRepeat(body?.repeat, input, row);
    const expense = transaction(() => {
      if (recurringId && !db.prepare('SELECT 1 FROM recurring_expenses WHERE id = ?').get(recurringId)) {
        throw notFound('Este gasto ya no se repite.');
      }
      db.prepare(`
        INSERT INTO expenses (id, group_id, description, spent_on, payer_id, original_minor, currency, fx_rate, fx_source,
          base_cents, split_mode, notes, category, created_by, recurring_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, row.id, input.description, input.spentOn, input.payerId, input.originalMinor, input.currency, input.fxRate,
        input.fxSource, input.amountCents, input.splitMode, input.notes, input.category, meId, recurringId ?? (repeat ? id : null));
      insertShares(id, input.shares);
      insertPayers(id, input.payers);
      if (repeat) {
        db.prepare(`
          INSERT INTO recurring_expenses (id, group_id, frequency, anchor_on, next_on, template, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, row.id, repeat, input.spentOn, nextOccurrence(input.spentOn, repeat), JSON.stringify(recurringTemplate(body)), meId);
      }
      const created = getExpense(id);
      // Las repeticiones las crea la app (sin autor en la actividad): así el aviso llega a todos.
      logActivity(row.id, recurringId ? null : meId, 'expense_created', id, {
        ...expenseSummary(created, row),
        ...(recurringId ? { recurring: true } : {}),
        ...(repeat ? { repeat } : {}),
      });
      return created;
    });
    // Si la primera fecha era antigua, las repeticiones que ya tocaban se crean ahora.
    if (repeat) generateRecurring();
    return { created: true, expense };
  }

  // ---------- Gastos recurrentes ----------

  function parseRepeat(value, input, groupRow) {
    if (value === undefined || value === null || value === '' || value === 'none') return null;
    if (!FREQUENCIES.includes(value)) throw badRequest('Frecuencia de repetición no válida.');
    // Con otra moneda haría falta el tipo de cambio de cada día: las series van en la del grupo.
    if (input.currency !== groupRow.base_currency) throw badRequest(`Los gastos recurrentes van en ${groupRow.base_currency}, la moneda del grupo.`);
    return value;
  }

  // Lo que se repite: todo menos el id, la fecha y la propia repetición.
  function recurringTemplate(body) {
    const template = {};
    for (const key of ['description', 'amountCents', 'payerId', 'payers', 'splitMode', 'shares', 'category', 'notes']) {
      if (body?.[key] !== undefined) template[key] = body[key];
    }
    return template;
  }

  function parseTemplate(row) {
    try {
      return JSON.parse(row.template);
    } catch {
      return {};
    }
  }

  function toRecurring(row) {
    const template = parseTemplate(row);
    return {
      id: row.id,
      groupId: row.group_id,
      frequency: row.frequency,
      nextOn: row.next_on,
      description: template.description ?? '',
      amountCents: Number(template.amountCents) || 0,
      category: template.category ?? null,
      payerId: template.payers?.[0]?.personId ?? template.payerId ?? null,
      pausedReason: row.paused_reason ?? null,
      createdBy: row.created_by ?? null,
    };
  }

  function listRecurring(groupId) {
    return db.prepare('SELECT * FROM recurring_expenses WHERE group_id = ? ORDER BY next_on, created_at').all(groupId).map(toRecurring);
  }

  function getRecurringRow(rawId) {
    const row = db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(uuid(rawId));
    if (!row) throw notFound('Este gasto ya no se repite.');
    return row;
  }

  // Dejar de repetir: los gastos ya creados se quedan; solo deja de haber nuevos.
  function stopRecurring(rawId, meId = null) {
    const row = getRecurringRow(rawId);
    getWritableGroupRow(row.group_id);
    if (meId !== null && !memberIds(row.group_id).includes(meId)) throw notFound('Este gasto ya no se repite.');
    return transaction(() => {
      db.prepare('DELETE FROM recurring_expenses WHERE id = ?').run(row.id);
      const recurring = toRecurring(row);
      logActivity(row.group_id, meId, 'recurring_stopped', row.id, { description: recurring.description, frequency: row.frequency });
      return recurring;
    });
  }

  // Al editar un gasto de una serie se puede aplicar el cambio a las próximas repeticiones.
  function updateRecurringTemplate(recurringId, body, groupRow) {
    const row = db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(recurringId);
    if (!row) return;
    const currency = body?.currency === undefined ? groupRow.base_currency : body.currency;
    if (currency !== groupRow.base_currency) throw badRequest(`Los gastos recurrentes van en ${groupRow.base_currency}, la moneda del grupo.`);
    db.prepare('UPDATE recurring_expenses SET template = ?, paused_reason = NULL WHERE id = ?').run(JSON.stringify(recurringTemplate(body)), row.id);
  }

  // Id estable de cada repetición: si el generador se corta a medias, al volver no duplica nada.
  function occurrenceId(recurringId, date) {
    const hex = crypto.createHash('sha256').update(`repartos:recurrente:${recurringId}:${date}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  // Crea las repeticiones que ya tocan (hasta hoy). Lo llama el servidor al arrancar y cada hora.
  // Máximo 600 por serie y pasada (más de 11 años semanales): una fecha absurda no bloquea el servidor.
  function generateRecurring({ today = todayIn(process.env.APP_TIMEZONE || 'Europe/Madrid') } = {}) {
    const due = db.prepare('SELECT * FROM recurring_expenses WHERE paused_reason IS NULL AND next_on <= ? ORDER BY next_on').all(today);
    let created = 0;
    for (const rule of due) {
      let nextOn = rule.next_on;
      const template = parseTemplate(rule);
      for (let count = 0; count < 600 && nextOn <= today; count += 1) {
        try {
          const result = createExpense(rule.group_id, { ...template, id: occurrenceId(rule.id, nextOn), spentOn: nextOn }, rule.created_by, { recurringId: rule.id });
          if (result.created) created += 1;
        } catch (error) {
          if (!db.prepare('SELECT 1 FROM recurring_expenses WHERE id = ?').get(rule.id)) break;
          // Grupo archivado, alguien que ya no está… La serie se pausa y se explica en Ajustes.
          const reason = error.status ? error.message : 'No se pudo crear la repetición.';
          db.prepare('UPDATE recurring_expenses SET paused_reason = ? WHERE id = ?').run(reason, rule.id);
          if (!error.status) console.error('Error en un gasto recurrente:', error);
          break;
        }
        nextOn = nextOccurrence(nextOn, rule.frequency, rule.anchor_on);
        db.prepare('UPDATE recurring_expenses SET next_on = ? WHERE id = ?').run(nextOn, rule.id);
      }
    }
    return created;
  }

  function getEditableExpenseRow(rawId) {
    const id = uuid(rawId);
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!row) throw notFound('Gasto no encontrado.');
    getWritableGroupRow(row.group_id);
    return row;
  }

  // Control optimista: si otro dispositivo lo cambió antes, 409 con la versión actual.
  function updateExpense(rawId, body, meId = null) {
    const row = getEditableExpenseRow(rawId);
    if (row.deleted_at !== null) throw conflict('Este gasto se ha borrado.');
    if (Number(body?.version) !== row.version) {
      throw conflict('Este gasto ha cambiado en otro dispositivo.', { expense: getExpense(row.id) });
    }
    const groupRow = getGroupRow(row.group_id);
    const input = parseExpenseInput(body, groupRow, row.id);
    return transaction(() => {
      const before = getExpense(row.id);
      const result = db.prepare(`
        UPDATE expenses SET description = ?, spent_on = ?, payer_id = ?, original_minor = ?, currency = ?, fx_rate = ?,
          fx_source = ?, base_cents = ?, split_mode = ?, notes = ?, category = ?, updated_by = ?,
          version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND version = ?
      `).run(input.description, input.spentOn, input.payerId, input.originalMinor, input.currency, input.fxRate,
        input.fxSource, input.amountCents, input.splitMode, input.notes, input.category, meId, row.id, row.version);
      if (Number(result.changes) !== 1) throw conflict('Este gasto ha cambiado en otro dispositivo.');
      db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(row.id);
      insertShares(row.id, input.shares);
      db.prepare('DELETE FROM expense_payers WHERE expense_id = ?').run(row.id);
      insertPayers(row.id, input.payers);
      if (body?.applyToRecurring && row.recurring_id) updateRecurringTemplate(row.recurring_id, body, groupRow);
      const after = getExpense(row.id);
      const changes = expenseChanges(before, after);
      if (changes.length) {
        logActivity(row.group_id, meId, 'expense_updated', row.id, {
          ...expenseSummary(after, groupRow),
          changes,
          before: { description: before.description, amountCents: before.amountCents },
        });
      }
      return after;
    });
  }

  // También con control de versión: no se borra un gasto que otro dispositivo acaba de cambiar.
  function deleteExpense(rawId, body, meId = null) {
    const row = getEditableExpenseRow(rawId);
    if (row.deleted_at !== null) return getExpense(row.id);
    if (Number(body?.version) !== row.version) {
      throw conflict('Este gasto ha cambiado en otro dispositivo.', { expense: getExpense(row.id) });
    }
    return transaction(() => {
      db.prepare('UPDATE expenses SET deleted_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ? AND version = ?').run(row.id, row.version);
      const expense = getExpense(row.id);
      logActivity(row.group_id, meId, 'expense_deleted', row.id, expenseSummary(expense, getGroupRow(row.group_id)));
      return expense;
    });
  }

  function restoreExpense(rawId, meId = null) {
    const row = getEditableExpenseRow(rawId);
    if (row.deleted_at === null) return getExpense(row.id);
    const members = new Set(memberIds(row.group_id));
    const people = [
      row.payer_id,
      ...db.prepare('SELECT person_id FROM expense_shares WHERE expense_id = ?').all(row.id).map((s) => s.person_id),
      ...db.prepare('SELECT person_id FROM expense_payers WHERE expense_id = ?').all(row.id).map((p) => p.person_id),
    ];
    if (people.some((personId) => !members.has(personId))) {
      throw conflict('No se puede restaurar: alguna persona del gasto ya no está en el grupo.');
    }
    return transaction(() => {
      db.prepare('UPDATE expenses SET deleted_at = NULL, version = version + 1 WHERE id = ?').run(row.id);
      const expense = getExpense(row.id);
      logActivity(row.group_id, meId, 'expense_restored', row.id, expenseSummary(expense, getGroupRow(row.group_id)));
      return expense;
    });
  }

  // ---------- Liquidaciones ----------

  function getSettlement(id) {
    const row = db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
    if (!row) throw notFound('Pago no encontrado.');
    return { ...toSettlement(row), deleted: row.deleted_at !== null };
  }

  function settlementSummary(settlement, currency) {
    return {
      fromId: settlement.fromId,
      fromName: personName(settlement.fromId),
      toId: settlement.toId,
      toName: personName(settlement.toId),
      amountCents: settlement.amountCents,
      currency,
    };
  }

  function createSettlement(groupId, body, meId = null) {
    const id = uuid(body?.id);
    const row = getWritableGroupRow(groupId);
    const existing = db.prepare('SELECT group_id FROM settlements WHERE id = ?').get(id);
    if (existing) {
      if (existing.group_id !== row.id) throw conflict('Ese identificador ya está en uso.');
      return { created: false, settlement: getSettlement(id) };
    }
    const members = new Set(memberIds(row.id));
    const fromId = positiveId(body?.fromId, 'Quién paga');
    const toId = positiveId(body?.toId, 'Quién recibe');
    if (!members.has(fromId) || !members.has(toId)) throw badRequest('Las dos personas tienen que ser del grupo.');
    if (fromId === toId) throw badRequest('Quien paga y quien recibe no pueden ser la misma persona.');
    const amountCents = cents(body?.amountCents);
    const paidOn = isoDate(body?.paidOn);
    const settlement = transaction(() => {
      db.prepare('INSERT INTO settlements (id, group_id, from_id, to_id, amount_cents, paid_on, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, row.id, fromId, toId, amountCents, paidOn, meId);
      const created = getSettlement(id);
      logActivity(row.id, meId, 'settlement_created', id, settlementSummary(created, row.base_currency));
      return created;
    });
    return { created: true, settlement };
  }

  function getEditableSettlementRow(rawId) {
    const id = uuid(rawId);
    const row = db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
    if (!row) throw notFound('Pago no encontrado.');
    getWritableGroupRow(row.group_id);
    return row;
  }

  function deleteSettlement(rawId, meId = null) {
    const row = getEditableSettlementRow(rawId);
    if (row.deleted_at !== null) return getSettlement(row.id);
    return transaction(() => {
      db.prepare('UPDATE settlements SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      const settlement = getSettlement(row.id);
      logActivity(row.group_id, meId, 'settlement_deleted', row.id, settlementSummary(settlement, getGroupRow(row.group_id).base_currency));
      return settlement;
    });
  }

  function restoreSettlement(rawId, meId = null) {
    const row = getEditableSettlementRow(rawId);
    if (row.deleted_at === null) return getSettlement(row.id);
    const members = new Set(memberIds(row.group_id));
    if (!members.has(row.from_id) || !members.has(row.to_id)) {
      throw conflict('No se puede restaurar: alguna persona del pago ya no está en el grupo.');
    }
    return transaction(() => {
      db.prepare('UPDATE settlements SET deleted_at = NULL WHERE id = ?').run(row.id);
      const settlement = getSettlement(row.id);
      logActivity(row.group_id, meId, 'settlement_restored', row.id, settlementSummary(settlement, getGroupRow(row.group_id).base_currency));
      return settlement;
    });
  }

  return {
    listActivity,
    unreadCount,
    markActivitySeen,
    getSetting,
    setSetting,
    savePushSubscription,
    deletePushSubscription,
    forgetPushEndpoint,
    pushTargets,
    groupTitle,
    personName,
    ensureAuthPerson,
    listPeople,
    findOrCreatePerson,
    renamePerson,
    listGroups,
    getGroupBundle,
    setShareLink,
    getSharedBundle,
    personSummary,
    createGroup,
    updateGroup,
    addMember,
    removeMember,
    getExpense,
    createExpense,
    updateExpense,
    deleteExpense,
    restoreExpense,
    generateRecurring,
    stopRecurring,
    createSettlement,
    deleteSettlement,
    restoreSettlement,
  };
}
