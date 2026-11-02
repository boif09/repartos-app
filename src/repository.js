import { badRequest, conflict, notFound } from './errors.js';
import { MAX_CENTS } from '../shared/money.js';
import { computeShares, SplitError, SPLIT_MODES } from '../shared/splits.js';
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

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ---------- Mapeo de filas ----------

const toPerson = (row) => ({ id: row.id, name: row.name, authUser: row.auth_user ?? null });

const toGroup = (row) => ({
  id: row.id,
  title: row.title,
  emoji: row.emoji ?? null,
  baseCurrency: row.base_currency,
  simplifyDebts: row.simplify_debts === 1,
  defaultSplit: parseDefaultSplit(row.default_split),
  archived: row.archived_at !== null,
});

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
  createdAt: row.created_at,
});

export function createRepository(db) {
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      db.exec('COMMIT;');
      return result;
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
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
    return expenses.map((row) => toExpense(row, byExpense.get(row.id) || []));
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
    const balanceExpenses = expenses.map((expense) => ({ payerId: expense.payerId, baseCents: expense.amountCents, shares: expense.shares }));
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
    const members = Array.isArray(body?.members) ? body.members : [];
    if (members.length > 50) throw badRequest('Demasiadas personas en el grupo.');
    return transaction(() => {
      const result = db.prepare('INSERT INTO expense_groups (title, emoji) VALUES (?, ?)').run(title, groupEmoji);
      const groupId = Number(result.lastInsertRowid);
      addMemberRow(groupId, meId);
      for (const member of members) addMemberRow(groupId, resolveMemberInput(member));
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
      if (body?.title !== undefined) {
        db.prepare('UPDATE expense_groups SET title = ? WHERE id = ?').run(text(body.title, 'el título', { max: 60 }), row.id);
      }
      if (body?.emoji !== undefined) {
        db.prepare('UPDATE expense_groups SET emoji = ? WHERE id = ?').run(emoji(body.emoji), row.id);
      }
      if (body?.simplifyDebts !== undefined) {
        db.prepare('UPDATE expense_groups SET simplify_debts = ? WHERE id = ?').run(body.simplifyDebts ? 1 : 0, row.id);
      }
      if (body?.defaultSplit !== undefined) {
        db.prepare('UPDATE expense_groups SET default_split = ? WHERE id = ?').run(validateDefaultSplit(body.defaultSplit, row.id), row.id);
      }
      if (body?.archived !== undefined) {
        if (body.archived) {
          const { balances } = computeGroupMoney(row.id, false);
          if ([...balances.values()].some((value) => value !== 0)) {
            throw conflict('Solo se puede archivar un grupo con todas las cuentas saldadas.');
          }
          db.prepare('UPDATE expense_groups SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP) WHERE id = ?').run(row.id);
        } else {
          db.prepare('UPDATE expense_groups SET archived_at = NULL WHERE id = ?').run(row.id);
        }
      }
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
      addMemberRow(row.id, resolveMemberInput(body));
      return getGroupBundle(row.id, meId);
    });
  }

  function removeMember(groupId, personId, meId) {
    const row = getWritableGroupRow(groupId);
    const id = positiveId(personId, 'Persona');
    // Solo cuentan gastos y pagos activos; restaurar uno borrado vuelve a comprobar los miembros.
    const used = db.prepare(`
      SELECT 1 FROM expenses e WHERE e.group_id = ? AND e.deleted_at IS NULL AND (e.payer_id = ? OR EXISTS (
        SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.person_id = ?))
      UNION ALL
      SELECT 1 FROM settlements WHERE group_id = ? AND deleted_at IS NULL AND (from_id = ? OR to_id = ?)
      LIMIT 1
    `).get(row.id, id, id, row.id, id, id);
    if (used) throw conflict('No se puede quitar a alguien que aparece en gastos o pagos del grupo.');
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND person_id = ?').run(row.id, id);
    return getGroupBundle(row.id, meId);
  }

  // ---------- Gastos ----------

  function toExpense(row, shares) {
    return {
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      spentOn: row.spent_on,
      payerId: row.payer_id,
      amountCents: row.base_cents,
      currency: row.currency,
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
    return toExpense(row, shares);
  }

  function parseExpenseInput(body, groupId, id) {
    const members = new Set(memberIds(groupId));
    const payerId = positiveId(body?.payerId, 'Quién pagó');
    if (!members.has(payerId)) throw badRequest('Quien pagó tiene que ser del grupo.');
    const splitMode = String(body?.splitMode || 'equal');
    if (!SPLIT_MODES.includes(splitMode)) throw badRequest('Modo de reparto no válido.');
    const entries = Array.isArray(body?.shares) ? body.shares : [];
    for (const entry of entries) {
      if (!members.has(Number(entry?.personId))) throw badRequest('Todas las personas del reparto tienen que ser del grupo.');
    }
    const amountCents = cents(body?.amountCents);
    let shares;
    try {
      shares = computeShares({ totalCents: amountCents, mode: splitMode, entries, seed: id });
    } catch (error) {
      if (error instanceof SplitError) throw badRequest(error.message);
      throw error;
    }
    return {
      description: text(body?.description, 'la descripción', { max: 120 }),
      spentOn: isoDate(body?.spentOn),
      payerId,
      amountCents,
      splitMode,
      notes: text(body?.notes, 'la nota', { max: 500, required: false }),
      shares,
    };
  }

  function insertShares(expenseId, shares) {
    const insert = db.prepare('INSERT INTO expense_shares (expense_id, person_id, input_value, owed_cents) VALUES (?, ?, ?, ?)');
    for (const share of shares) insert.run(expenseId, share.personId, share.inputValue, share.owedCents);
  }

  // Idempotente: el móvil genera el UUID; si reintenta por mala conexión, no se duplica.
  function createExpense(groupId, body) {
    const id = uuid(body?.id);
    const row = getWritableGroupRow(groupId);
    const existing = db.prepare('SELECT group_id FROM expenses WHERE id = ?').get(id);
    if (existing) {
      if (existing.group_id !== row.id) throw conflict('Ese identificador ya está en uso.');
      return { created: false, expense: getExpense(id) };
    }
    const input = parseExpenseInput(body, row.id, id);
    transaction(() => {
      db.prepare(`
        INSERT INTO expenses (id, group_id, description, spent_on, payer_id, original_minor, currency, base_cents, split_mode, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, row.id, input.description, input.spentOn, input.payerId, input.amountCents, row.base_currency,
        input.amountCents, input.splitMode, input.notes);
      insertShares(id, input.shares);
    });
    return { created: true, expense: getExpense(id) };
  }

  function getEditableExpenseRow(rawId) {
    const id = uuid(rawId);
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!row) throw notFound('Gasto no encontrado.');
    getWritableGroupRow(row.group_id);
    return row;
  }

  // Control optimista: si otro dispositivo lo cambió antes, 409 con la versión actual.
  function updateExpense(rawId, body) {
    const row = getEditableExpenseRow(rawId);
    if (row.deleted_at !== null) throw conflict('Este gasto se ha borrado.');
    if (Number(body?.version) !== row.version) {
      throw conflict('Este gasto ha cambiado en otro dispositivo.', { expense: getExpense(row.id) });
    }
    const input = parseExpenseInput(body, row.group_id, row.id);
    transaction(() => {
      const result = db.prepare(`
        UPDATE expenses SET description = ?, spent_on = ?, payer_id = ?, original_minor = ?, base_cents = ?,
          split_mode = ?, notes = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND version = ?
      `).run(input.description, input.spentOn, input.payerId, input.amountCents, input.amountCents,
        input.splitMode, input.notes, row.id, row.version);
      if (Number(result.changes) !== 1) throw conflict('Este gasto ha cambiado en otro dispositivo.');
      db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(row.id);
      insertShares(row.id, input.shares);
    });
    return getExpense(row.id);
  }

  // También con control de versión: no se borra un gasto que otro dispositivo acaba de cambiar.
  function deleteExpense(rawId, body) {
    const row = getEditableExpenseRow(rawId);
    if (row.deleted_at !== null) return getExpense(row.id);
    if (Number(body?.version) !== row.version) {
      throw conflict('Este gasto ha cambiado en otro dispositivo.', { expense: getExpense(row.id) });
    }
    db.prepare('UPDATE expenses SET deleted_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ? AND version = ?').run(row.id, row.version);
    return getExpense(row.id);
  }

  function restoreExpense(rawId) {
    const row = getEditableExpenseRow(rawId);
    if (row.deleted_at === null) return getExpense(row.id);
    const members = new Set(memberIds(row.group_id));
    const people = [row.payer_id, ...db.prepare('SELECT person_id FROM expense_shares WHERE expense_id = ?').all(row.id).map((s) => s.person_id)];
    if (people.some((personId) => !members.has(personId))) {
      throw conflict('No se puede restaurar: alguna persona del gasto ya no está en el grupo.');
    }
    db.prepare('UPDATE expenses SET deleted_at = NULL, version = version + 1 WHERE id = ?').run(row.id);
    return getExpense(row.id);
  }

  // ---------- Liquidaciones ----------

  function getSettlement(id) {
    const row = db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
    if (!row) throw notFound('Pago no encontrado.');
    return { ...toSettlement(row), deleted: row.deleted_at !== null };
  }

  function createSettlement(groupId, body) {
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
    db.prepare('INSERT INTO settlements (id, group_id, from_id, to_id, amount_cents, paid_on) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, row.id, fromId, toId, amountCents, paidOn);
    return { created: true, settlement: getSettlement(id) };
  }

  function getEditableSettlementRow(rawId) {
    const id = uuid(rawId);
    const row = db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
    if (!row) throw notFound('Pago no encontrado.');
    getWritableGroupRow(row.group_id);
    return row;
  }

  function deleteSettlement(rawId) {
    const row = getEditableSettlementRow(rawId);
    db.prepare('UPDATE settlements SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP) WHERE id = ?').run(row.id);
    return getSettlement(row.id);
  }

  function restoreSettlement(rawId) {
    const row = getEditableSettlementRow(rawId);
    const members = new Set(memberIds(row.group_id));
    if (!members.has(row.from_id) || !members.has(row.to_id)) {
      throw conflict('No se puede restaurar: alguna persona del pago ya no está en el grupo.');
    }
    db.prepare('UPDATE settlements SET deleted_at = NULL WHERE id = ?').run(row.id);
    return getSettlement(row.id);
  }

  return {
    ensureAuthPerson,
    listPeople,
    findOrCreatePerson,
    renamePerson,
    listGroups,
    getGroupBundle,
    createGroup,
    updateGroup,
    addMember,
    removeMember,
    getExpense,
    createExpense,
    updateExpense,
    deleteExpense,
    restoreExpense,
    createSettlement,
    deleteSettlement,
    restoreSettlement,
  };
}
