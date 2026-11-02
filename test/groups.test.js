import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';

async function startApp(t) {
  const { server } = createApp({
    basePath: '/',
    db: openDatabase({ dbPath: ':memory:' }),
    auth: { allowedUsers: ['xavi', 'judit'] },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const call = async function call(method, pathName, body, user = 'xavi') {
    const response = await fetch(`${baseUrl}/api${pathName}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Remote-User': user },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, ...json };
  };
  call.baseUrl = baseUrl;
  return call;
}

const today = '2026-11-02';
const balanceOf = (bundle, personId) => bundle.balances.find((b) => b.personId === personId)?.amountCents;

test('la sesión crea y enlaza la persona de cada usuario de Authelia', async (t) => {
  const call = await startApp(t);
  const xavi = await call('GET', '/session');
  assert.equal(xavi.person.name, 'Xavi');
  assert.equal(xavi.person.authUser, 'xavi');
  const again = await call('GET', '/session');
  assert.equal(again.person.id, xavi.person.id);

  // Si alguien creó "Judit" a mano antes de que ella entrara, se enlaza en vez de duplicarla.
  const manual = await call('POST', '/people', { name: 'judit' });
  const judit = await call('GET', '/session', undefined, 'judit');
  assert.equal(judit.person.id, manual.person.id);
  assert.equal(judit.person.authUser, 'judit');
});

test('flujo Pareja: grupo, gastos, saldos, liquidación y archivar', async (t) => {
  const call = await startApp(t);
  const { person: xavi } = await call('GET', '/session');
  const { person: judit } = await call('GET', '/session', undefined, 'judit');

  let bundle = await call('POST', '/groups', { title: 'Pareja', emoji: '❤️', members: [{ personId: judit.id }] });
  assert.equal(bundle.status, 201);
  const groupId = bundle.group.id;
  assert.deepEqual(bundle.members.map((m) => m.name), ['Judit', 'Xavi']);
  assert.equal(bundle.myBalanceCents, 0);

  const expenseId = crypto.randomUUID();
  const expense = {
    id: expenseId, description: 'Cena', spentOn: today, payerId: xavi.id, amountCents: 5001,
    splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: judit.id }],
  };
  let result = await call('POST', `/groups/${groupId}/expenses`, expense);
  assert.equal(result.status, 201);
  assert.equal(result.expense.shares.reduce((s, x) => s + x.owedCents, 0), 5001);

  result = await call('POST', `/groups/${groupId}/expenses`, expense);
  assert.equal(result.status, 200, 'reintento con el mismo UUID: no se duplica');

  await call('POST', `/groups/${groupId}/expenses`, {
    id: crypto.randomUUID(), description: 'Súper', spentOn: today, payerId: judit.id, amountCents: 2000,
    splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: judit.id }],
  });

  bundle = await call('GET', `/groups/${groupId}`);
  assert.equal(bundle.expenses.length, 2);
  const xaviOwed = result.expense.shares.find((s) => s.personId === xavi.id).owedCents;
  assert.equal(balanceOf(bundle, xavi.id), 5001 - xaviOwed - 1000);
  assert.equal(balanceOf(bundle, xavi.id) + balanceOf(bundle, judit.id), 0);
  assert.equal(bundle.transfers.length, 1);
  assert.deepEqual(bundle.transfers[0], { fromId: judit.id, toId: xavi.id, amountCents: balanceOf(bundle, xavi.id) });

  result = await call('PATCH', `/groups/${groupId}`, { archived: true });
  assert.equal(result.status, 409, 'no se archiva con deudas pendientes');

  const settlementId = crypto.randomUUID();
  result = await call('POST', `/groups/${groupId}/settlements`, {
    id: settlementId, fromId: judit.id, toId: xavi.id, amountCents: bundle.transfers[0].amountCents, paidOn: today,
  });
  assert.equal(result.status, 201);
  bundle = await call('GET', `/groups/${groupId}`);
  assert.equal(balanceOf(bundle, xavi.id), 0);
  assert.deepEqual(bundle.transfers, []);

  const list = await call('GET', '/groups', undefined, 'judit');
  assert.equal(list.groups[0].myBalanceCents, 0);
  assert.equal(list.groups[0].expenseCount, 2);

  result = await call('PATCH', `/groups/${groupId}`, { archived: true });
  assert.equal(result.group.archived, true);
  result = await call('POST', `/groups/${groupId}/expenses`, { ...expense, id: crypto.randomUUID() });
  assert.equal(result.status, 409, 'un grupo archivado no admite cambios');
  result = await call('PATCH', `/groups/${groupId}`, { title: 'Otro' });
  assert.equal(result.status, 409, 'ni siquiera renombrarlo');
  result = await call('PATCH', `/groups/${groupId}`, { archived: false });
  assert.equal(result.group.archived, false);
  result = await call('PATCH', `/groups/${groupId}`, { title: 'Pareja 2' });
  assert.equal(result.group.title, 'Pareja 2');
});

test('editar con control de versión, borrar y restaurar', async (t) => {
  const call = await startApp(t);
  const { person: xavi } = await call('GET', '/session');
  const { person: judit } = await call('GET', '/session', undefined, 'judit');
  const { group } = await call('POST', '/groups', { title: 'Casa', members: [{ personId: judit.id }] });

  const id = crypto.randomUUID();
  const base = { id, description: 'Luz', spentOn: today, payerId: xavi.id, amountCents: 6000, splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: judit.id }] };
  const { expense } = await call('POST', `/groups/${group.id}/expenses`, base);

  let result = await call('PUT', `/expenses/${id}`, { ...base, amountCents: 8000, version: expense.version });
  assert.equal(result.status, 200);
  assert.equal(result.expense.amountCents, 8000);
  assert.equal(result.expense.version, expense.version + 1);

  result = await call('PUT', `/expenses/${id}`, { ...base, amountCents: 9000, version: expense.version }, 'judit');
  assert.equal(result.status, 409, 'versión antigua: no pisa el cambio de otro móvil');
  assert.equal(result.expense.amountCents, 8000, 'devuelve la versión actual');

  result = await call('DELETE', `/expenses/${id}`, { version: expense.version }, 'judit');
  assert.equal(result.status, 409, 'no se borra una versión que otro dispositivo ya cambió');

  result = await call('DELETE', `/expenses/${id}`, { version: expense.version + 1 });
  assert.equal(result.expense.deleted, true);
  let bundle = await call('GET', `/groups/${group.id}`);
  assert.equal(bundle.expenses.length, 0);
  assert.equal(balanceOf(bundle, xavi.id), 0);

  result = await call('POST', `/expenses/${id}/restore`, {});
  assert.equal(result.expense.deleted, false);
  bundle = await call('GET', `/groups/${group.id}`);
  assert.equal(balanceOf(bundle, xavi.id), 4000);
});

test('amigos: personas compartidas, subconjuntos, miembros y simplificar deudas', async (t) => {
  const call = await startApp(t);
  const { person: xavi } = await call('GET', '/session');

  const { group, members } = await call('POST', '/groups', {
    title: 'Finde Cerdanya',
    members: [{ name: 'Ana' }, { name: 'Bea' }, { name: ' bea ' }],
  });
  assert.equal(members.length, 3, 'Bea no se duplica aunque se escriba distinto');
  const ana = members.find((m) => m.name === 'Ana');
  const bea = members.find((m) => m.name === 'Bea');

  // La misma Ana se reutiliza en otro grupo.
  const other = await call('POST', '/groups', { title: 'Cumple', members: [{ name: 'ana' }] });
  assert.ok(other.members.some((m) => m.id === ana.id));

  // Alcohol: paga Xavi, Bea no bebe.
  await call('POST', `/groups/${group.id}/expenses`, {
    id: crypto.randomUUID(), description: 'Alcohol', spentOn: today, payerId: xavi.id, amountCents: 3000,
    splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: ana.id }],
  });
  // Restaurante: cada uno lo suyo, paga Ana.
  await call('POST', `/groups/${group.id}/expenses`, {
    id: crypto.randomUUID(), description: 'Restaurante', spentOn: today, payerId: ana.id, amountCents: 6000,
    splitMode: 'exact', shares: [{ personId: xavi.id, value: 2500 }, { personId: ana.id, value: 2000 }, { personId: bea.id, value: 1500 }],
  });

  let bundle = await call('GET', `/groups/${group.id}`);
  assert.equal(balanceOf(bundle, xavi.id), 3000 - 1500 - 2500);
  assert.equal(balanceOf(bundle, ana.id), 6000 - 1500 - 2000);
  assert.equal(balanceOf(bundle, bea.id), -1500);
  assert.equal(bundle.transfers.length, 2);

  bundle = await call('PATCH', `/groups/${group.id}`, { simplifyDebts: false });
  assert.equal(bundle.group.simplifyDebts, false);
  assert.ok(bundle.transfers.length >= 2);

  let result = await call('DELETE', `/groups/${group.id}/members/${bea.id}`);
  assert.equal(result.status, 409, 'Bea aparece en un gasto');

  result = await call('POST', `/groups/${group.id}/members`, { name: 'Carla' });
  const carla = result.members.find((m) => m.name === 'Carla');
  result = await call('DELETE', `/groups/${group.id}/members/${carla.id}`);
  assert.equal(result.status, 200);
  assert.ok(!result.members.some((m) => m.id === carla.id));
});

test('validaciones de gastos', async (t) => {
  const call = await startApp(t);
  const { person: xavi } = await call('GET', '/session');
  const { group } = await call('POST', '/groups', { title: 'Solo', members: [{ name: 'Ana' }] });
  const outsider = (await call('POST', '/people', { name: 'Fuera' })).person;
  const valid = { description: 'X', spentOn: today, payerId: xavi.id, amountCents: 100, splitMode: 'equal', shares: [{ personId: xavi.id }] };

  const cases = [
    [{ ...valid, id: 'no-uuid' }, /Identificador/],
    [{ ...valid, description: '' }, /descripción/],
    [{ ...valid, amountCents: 0 }, /mayor que cero/],
    [{ ...valid, amountCents: 12.5 }, /mayor que cero/],
    [{ ...valid, spentOn: '2026-02-30' }, /Fecha/],
    [{ ...valid, payerId: outsider.id }, /pagó/],
    [{ ...valid, shares: [{ personId: outsider.id }] }, /del grupo/],
    [{ ...valid, shares: [] }, /al menos una persona/],
    [{ ...valid, splitMode: 'exact', shares: [{ personId: xavi.id, value: 99 }] }, /no suman/],
    [{ ...valid, splitMode: 'shares', shares: [{ personId: xavi.id, value: 2_000_000 }] }, /demasiado grandes/],
  ];
  for (const [body, message] of cases) {
    const result = await call('POST', `/groups/${group.id}/expenses`, { id: crypto.randomUUID(), ...body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.match(result.error, message);
  }

  // Importes máximos en todos los modos: nunca un 500.
  for (const extra of [
    { splitMode: 'exact', shares: [{ personId: xavi.id, value: 1_000_000_000 }] },
    { splitMode: 'shares', shares: [{ personId: xavi.id, value: 999_999 }] },
    { splitMode: 'equal', shares: [{ personId: xavi.id }] },
  ]) {
    const result = await call('POST', `/groups/${group.id}/expenses`, { ...valid, ...extra, id: crypto.randomUUID(), amountCents: 1_000_000_000 });
    assert.equal(result.status, 201, extra.splitMode);
    assert.equal(result.expense.shares[0].owedCents, 1_000_000_000);
  }

  let result = await call('GET', '/groups/9999');
  assert.equal(result.status, 404);
  result = await call('PUT', `/groups/${group.id}`, {});
  assert.equal(result.status, 405);
  result = await call('POST', '/groups', { title: 'x'.repeat(61) });
  assert.equal(result.status, 400);
});

test('reparto por defecto del grupo (60/40) y gasto por partes', async (t) => {
  const call = await startApp(t);
  const { person: xavi } = await call('GET', '/session');
  const { person: judit } = await call('GET', '/session', undefined, 'judit');
  const { group } = await call('POST', '/groups', { title: 'Pareja', members: [{ personId: judit.id }] });
  assert.equal(group.defaultSplit, null);

  let bundle = await call('PATCH', `/groups/${group.id}`, {
    defaultSplit: [{ personId: xavi.id, weight: 60 }, { personId: judit.id, weight: 40 }],
  });
  assert.deepEqual(bundle.group.defaultSplit, [{ personId: xavi.id, weight: 60 }, { personId: judit.id, weight: 40 }]);

  const { expense } = await call('POST', `/groups/${group.id}/expenses`, {
    id: crypto.randomUUID(), description: 'Compra', spentOn: today, payerId: judit.id, amountCents: 10001,
    splitMode: 'shares', shares: [{ personId: xavi.id, value: 60 }, { personId: judit.id, value: 40 }],
  });
  assert.equal(expense.splitMode, 'shares');
  assert.deepEqual(expense.shares.map((s) => [s.personId, s.inputValue]), [[xavi.id, 60], [judit.id, 40]]);
  assert.equal(expense.shares.reduce((sum, s) => sum + s.owedCents, 0), 10001);
  bundle = await call('GET', `/groups/${group.id}`);
  assert.equal(balanceOf(bundle, xavi.id), -expense.shares.find((s) => s.personId === xavi.id).owedCents);

  const invalid = [
    [{ defaultSplit: [{ personId: 9999, weight: 1 }] }, /personas del grupo/],
    [{ defaultSplit: [{ personId: xavi.id, weight: 0 }] }, /Al menos una persona/],
    [{ defaultSplit: [{ personId: xavi.id, weight: 1001 }] }, /entre 0 y 1000/],
    [{ defaultSplit: [{ personId: xavi.id, weight: 1 }, { personId: xavi.id, weight: 2 }] }, /repetida/],
    [{ defaultSplit: 'mitad' }, /no válido/],
  ];
  for (const [body, message] of invalid) {
    const result = await call('PATCH', `/groups/${group.id}`, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.match(result.error, message);
  }

  bundle = await call('PATCH', `/groups/${group.id}`, { defaultSplit: null });
  assert.equal(bundle.group.defaultSplit, null);
});

test('el reparto por defecto ignora a quien ya no está en el grupo', async (t) => {
  const call = await startApp(t);
  const { person: xavi } = await call('GET', '/session');
  const { group, members } = await call('POST', '/groups', { title: 'Piso', members: [{ name: 'Ana' }] });
  const ana = members.find((m) => m.name === 'Ana');
  await call('PATCH', `/groups/${group.id}`, { defaultSplit: [{ personId: xavi.id, weight: 2 }, { personId: ana.id, weight: 1 }] });
  let bundle = await call('DELETE', `/groups/${group.id}/members/${ana.id}`);
  assert.deepEqual(bundle.group.defaultSplit, [{ personId: xavi.id, weight: 2 }]);

  await call('PATCH', `/groups/${group.id}`, { defaultSplit: [{ personId: xavi.id, weight: 2 }] });
  bundle = await call('GET', `/groups/${group.id}`);
  assert.deepEqual(bundle.group.defaultSplit, [{ personId: xavi.id, weight: 2 }]);
});

test('enlace para amigos: crear, ver sin sesión, cambiar y revocar', async (t) => {
  const call = await startApp(t);
  const { person: xavi } = await call('GET', '/session');
  const { group, members } = await call('POST', '/groups', { title: 'Finde', members: [{ name: 'Ana' }] });
  const ana = members.find((m) => m.name === 'Ana');
  await call('POST', `/groups/${group.id}/expenses`, {
    id: crypto.randomUUID(), description: 'Cena', spentOn: today, payerId: xavi.id, amountCents: 4000,
    splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: ana.id }], notes: 'privado',
  });
  assert.equal(group.shareToken, null);

  let bundle = await call('POST', `/groups/${group.id}/share`, {});
  const token = bundle.group.shareToken;
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);

  // Sin cabecera Remote-User: como un amigo desde internet.
  const anon = (pathName, shareToken) => fetch(`${call.baseUrl}/api${pathName}`, { headers: shareToken === undefined ? {} : { 'X-Share-Token': shareToken } })
    .then(async (r) => ({ status: r.status, headers: r.headers, ...(await r.json()) }));
  let shared = await anon('/shared', token);
  assert.equal(shared.status, 200);
  assert.equal(shared.group.title, 'Finde');
  assert.equal(shared.group.shareToken, undefined, 'el token no se reenvía');
  assert.deepEqual(Object.keys(shared.members[0]).sort(), ['id', 'name'], 'sin usuarios de Authelia');
  assert.equal(shared.expenses[0].notes, undefined, 'sin notas privadas');
  assert.equal(shared.transfers.length, 1);
  assert.equal(shared.headers.get('x-robots-tag'), 'noindex');
  assert.equal((await anon(`/groups/${group.id}`)).status, 401, 'el resto de la API sigue cerrada');

  assert.equal((await anon(`/shared/${token}`)).status, 401, 'el token en la URL no sirve (va en cabecera): esa ruta es privada');
  const writeAttempt = await fetch(`${call.baseUrl}/api/shared`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-Token': token }, body: '{}' });
  assert.equal(writeAttempt.status, 405);

  bundle = await call('POST', `/groups/${group.id}/share`, {});
  assert.notEqual(bundle.group.shareToken, token);
  assert.equal((await anon('/shared', token)).status, 404, 'el enlace anterior deja de funcionar');

  bundle = await call('DELETE', `/groups/${group.id}/share`, {});
  assert.equal(bundle.group.shareToken, null);
  shared = await anon('/shared', bundle.group.shareToken ?? '');
  assert.equal(shared.status, 404);
  assert.equal((await anon('/shared', 'no-valido')).status, 404);
  assert.equal((await anon('/shared')).status, 404, 'sin token');
});

test('ficha de persona: saldo en cada grupo y total por moneda de los activos', async (t) => {
  const call = await startApp(t);
  const { person: xavi } = await call('GET', '/session');
  const a = await call('POST', '/groups', { title: 'Piso', members: [{ name: 'Ana' }] });
  const ana = a.members.find((m) => m.name === 'Ana');
  const b = await call('POST', '/groups', { title: 'Viaje USA', baseCurrency: 'USD', members: [{ personId: ana.id }] });
  const c = await call('POST', '/groups', { title: 'Cena', members: [{ personId: ana.id }] });
  const expense = (groupId, amountCents) => call('POST', `/groups/${groupId}/expenses`, {
    id: crypto.randomUUID(), description: 'X', spentOn: today, payerId: xavi.id, amountCents,
    splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: ana.id }],
  });
  await expense(a.group.id, 3000);
  await expense(b.group.id, 5000);
  await expense(c.group.id, 1000);

  const summary = await call('GET', `/people/${ana.id}/summary`);
  assert.equal(summary.person.name, 'Ana');
  assert.equal(summary.groups.length, 3);
  assert.deepEqual(summary.groups.map((g) => [g.title, g.balanceCents]).sort(), [['Cena', -500], ['Piso', -1500], ['Viaje USA', -2500]]);
  assert.deepEqual(summary.totals.sort((x, y) => x.currency.localeCompare(y.currency)), [
    { currency: 'EUR', amountCents: -2000 },
    { currency: 'USD', amountCents: -2500 },
  ]);
  assert.equal(summary.groups[0].shareToken, undefined);

  assert.equal((await call('GET', '/people/9999/summary')).status, 404);
});
