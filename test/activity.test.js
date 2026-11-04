import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { MIGRATIONS, migrate, openDatabase } from '../src/database.js';
import { computePayers, mainPayer } from '../shared/splits.js';
import { computeBalances, pairwiseDebts } from '../shared/balances.js';
import { allocate } from '../shared/money.js';
import { guessCategory } from '../shared/categories.js';
import { describeForRecipient, encryptPayload } from '../src/push.js';

const today = '2026-11-04';

async function startApp(t, pushOptions) {
  const { server } = createApp({
    basePath: '/',
    db: openDatabase({ dbPath: ':memory:' }),
    auth: { allowedUsers: ['xavi', 'judit'] },
    push: pushOptions,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return async (method, pathName, body, user = 'xavi') => {
    const response = await fetch(`${baseUrl}/api${pathName}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Remote-User': user },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  };
}

async function pareja(call) {
  const { person: xavi } = await call('GET', '/session');
  const { person: judit } = await call('GET', '/session', undefined, 'judit');
  const { group } = await call('POST', '/groups', { title: 'Pareja', members: [{ personId: judit.id }] });
  return { xavi, judit, group };
}

// ---------- Varios pagadores ----------

test('computePayers: suma exacta, moneda extranjera y pagador principal', () => {
  const same = computePayers({ totalCents: 10000, entries: [{ personId: 1, value: 6000 }, { personId: 2, value: 4000 }] });
  assert.deepEqual(same.map((p) => p.paidCents), [6000, 4000]);
  assert.equal(mainPayer(same), 1);

  // 10.000 ¥ = 61,00 €; Xavi puso 7.000 ¥ y Judit 3.000 ¥
  const foreign = computePayers({ totalCents: 6100, originalTotal: 10000, entries: [{ personId: 1, value: 7000 }, { personId: 2, value: 3000 }], seed: 'x' });
  assert.equal(foreign.reduce((sum, p) => sum + p.paidCents, 0), 6100);
  assert.deepEqual(foreign.map((p) => p.inputValue), [7000, 3000]);

  assert.throws(() => computePayers({ totalCents: 100, entries: [{ personId: 1, value: 60 }] }), /no suma/);
  assert.throws(() => computePayers({ totalCents: 100, entries: [] }), /Falta quién pagó/);
  assert.throws(() => computePayers({ totalCents: 100, entries: [{ personId: 1, value: 50 }, { personId: 1, value: 50 }] }), /repetido/);
});

test('saldos y deudas por pares con varios pagadores', () => {
  // Cena de 100 €: Xavi pone 70 y Judit 30; a partes iguales entre Xavi, Judit y Ana.
  const expense = {
    payerId: 1, baseCents: 10000,
    payers: [{ personId: 1, paidCents: 7000 }, { personId: 2, paidCents: 3000 }],
    shares: [{ personId: 1, owedCents: 3334 }, { personId: 2, owedCents: 3333 }, { personId: 3, owedCents: 3333 }],
  };
  const balances = computeBalances([1, 2, 3], [expense], []);
  assert.deepEqual(Object.fromEntries(balances), { 1: 3666, 2: -333, 3: -3333 });
  const debts = pairwiseDebts([expense], []);
  const owedTo = (from, to) => debts.find((d) => d.fromId === from && d.toId === to)?.amountCents ?? 0;
  assert.equal(owedTo(3, 1) + owedTo(3, 2), 3333, 'Ana debe su parte, repartida entre quienes pagaron');
  assert.equal(owedTo(3, 1), 2333);
  // Neto de todos: coincide con los saldos
  const net = new Map([[1, 0], [2, 0], [3, 0]]);
  for (const d of debts) { net.set(d.toId, net.get(d.toId) + d.amountCents); net.set(d.fromId, net.get(d.fromId) - d.amountCents); }
  assert.deepEqual(Object.fromEntries(net), Object.fromEntries(balances));
});

test('deudas por pares con varios pagadores: cuadran al céntimo con los saldos (propiedad)', () => {
  // Caso de la revisión: los redondeos por parte no deben acumularse.
  const check = (expense, ids) => {
    const balances = computeBalances(ids, [expense], []);
    const net = new Map(ids.map((id) => [id, 0]));
    for (const d of pairwiseDebts([expense], [])) {
      assert.ok(d.amountCents > 0);
      net.set(d.toId, net.get(d.toId) + d.amountCents);
      net.set(d.fromId, net.get(d.fromId) - d.amountCents);
    }
    assert.deepEqual(Object.fromEntries(net), Object.fromEntries(balances));
  };
  check({
    payerId: 1, baseCents: 50,
    payers: [1, 2, 3, 4].map((personId, i) => ({ personId, paidCents: [27, 5, 9, 9][i] })),
    shares: [1, 2, 3, 4].map((personId, i) => ({ personId, owedCents: [5, 21, 23, 1][i] })),
  }, [1, 2, 3, 4]);
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 500; round += 1) {
    const ids = [1, 2, 3, 4, 5].slice(0, 2 + rand(4));
    const total = 1 + rand(20000);
    const cut = (n) => { const w = ids.map(() => rand(10)); if (!w.some(Boolean)) w[0] = 1; return allocate(n, w); };
    const paid = cut(total);
    const owed = cut(total);
    check({
      payerId: ids[0], baseCents: total,
      payers: ids.map((personId, i) => ({ personId, paidCents: paid[i] })).filter((p) => p.paidCents > 0),
      shares: ids.map((personId, i) => ({ personId, owedCents: owed[i] })).filter((s) => s.owedCents > 0),
    }, ids);
  }
});

test('API: gasto con varios pagadores, validación y edición a un solo pagador', async (t) => {
  const call = await startApp(t);
  const { xavi, judit, group } = await pareja(call);
  const id = crypto.randomUUID();
  const base = { id, description: 'Cena', spentOn: today, amountCents: 10000, splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: judit.id }] };

  let result = await call('POST', `/groups/${group.id}/expenses`, { ...base, payers: [{ personId: xavi.id, value: 7000 }, { personId: judit.id, value: 3000 }] });
  assert.equal(result.status, 201);
  assert.deepEqual(result.expense.payers.map((p) => [p.personId, p.paidCents]), [[xavi.id, 7000], [judit.id, 3000]]);
  assert.equal(result.expense.payerId, xavi.id, 'el principal es quien más puso');
  let bundle = await call('GET', `/groups/${group.id}`);
  assert.equal(bundle.myBalanceCents, 2000);

  result = await call('POST', `/groups/${group.id}/expenses`, { ...base, id: crypto.randomUUID(), payers: [{ personId: xavi.id, value: 5000 }] });
  assert.equal(result.status, 400);
  assert.match(result.error, /no suma/);
  result = await call('POST', `/groups/${group.id}/expenses`, { ...base, id: crypto.randomUUID(), payers: [{ personId: 999, value: 10000 }] });
  assert.equal(result.status, 400);

  const { expense } = await call('GET', `/groups/${group.id}`).then((b) => ({ expense: b.expenses[0] }));
  result = await call('PUT', `/expenses/${id}`, { ...base, version: expense.version, payerId: judit.id });
  assert.deepEqual(result.expense.payers.map((p) => [p.personId, p.paidCents]), [[judit.id, 10000]]);
  bundle = await call('GET', `/groups/${group.id}`);
  assert.equal(bundle.myBalanceCents, -5000);

  // Quitar a alguien que solo aparece como pagador tampoco se permite
  const { members } = await call('POST', `/groups/${group.id}/members`, { name: 'Ana' });
  const ana = members.find((m) => m.name === 'Ana');
  await call('POST', `/groups/${group.id}/expenses`, {
    id: crypto.randomUUID(), description: 'Taxi', spentOn: today, amountCents: 2000, splitMode: 'equal',
    shares: [{ personId: xavi.id }], payers: [{ personId: xavi.id, value: 1000 }, { personId: ana.id, value: 1000 }],
  });
  result = await call('DELETE', `/groups/${group.id}/members/${ana.id}`, {});
  assert.equal(result.status, 409);
});

test('migración 3: los gastos existentes pasan a tener su pagador en expense_payers', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS.slice(0, 2));
  db.prepare("INSERT INTO people (name) VALUES ('Xavi')").run();
  db.prepare("INSERT INTO expense_groups (title) VALUES ('G')").run();
  db.prepare(`INSERT INTO expenses (id, group_id, description, spent_on, payer_id, original_minor, currency, base_cents, split_mode)
    VALUES ('e1', 1, 'X', '2026-01-01', 1, 3500, 'JPY', 2143, 'equal')`).run();
  migrate(db);
  assert.deepEqual({ ...db.prepare('SELECT person_id, input_value, paid_cents FROM expense_payers').get() }, { person_id: 1, input_value: 3500, paid_cents: 2143 });
  db.close();
});

// ---------- Categorías ----------

test('categorías: sugerencia por palabras completas y validación en la API', async (t) => {
  assert.equal(guessCategory('Mercadona'), 'groceries');
  assert.equal(guessCategory('Cena japonés'), 'food');
  assert.equal(guessCategory('Llave de casa'), null, '"ave" no coincide dentro de "llave"');
  assert.equal(guessCategory('Factura de la LUZ'), 'home');

  const call = await startApp(t);
  const { xavi, group } = await pareja(call);
  const base = { description: 'Súper', spentOn: today, payerId: xavi.id, amountCents: 100, splitMode: 'equal', shares: [{ personId: xavi.id }] };
  let result = await call('POST', `/groups/${group.id}/expenses`, { ...base, id: crypto.randomUUID(), category: 'groceries' });
  assert.equal(result.expense.category, 'groceries');
  result = await call('POST', `/groups/${group.id}/expenses`, { ...base, id: crypto.randomUUID(), category: 'inventada' });
  assert.equal(result.status, 400);
  result = await call('POST', `/groups/${group.id}/expenses`, { ...base, id: crypto.randomUUID() });
  assert.equal(result.expense.category, null);
});

// ---------- Autoría y actividad ----------

test('autoría, actividad y novedades', async (t) => {
  const call = await startApp(t);
  const { xavi, judit, group } = await pareja(call);
  const id = crypto.randomUUID();
  const body = { id, description: 'Mercadona', spentOn: today, payerId: judit.id, amountCents: 8000, splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: judit.id }] };

  let result = await call('POST', `/groups/${group.id}/expenses`, body, 'judit');
  assert.equal(result.expense.createdBy, judit.id);
  await call('POST', `/groups/${group.id}/expenses`, body, 'judit'); // reintento: no duplica actividad

  result = await call('PUT', `/expenses/${id}`, { ...body, amountCents: 9000, version: result.expense.version }, 'judit');
  assert.equal(result.expense.updatedBy, judit.id);
  await call('POST', `/groups/${group.id}/settlements`, { id: crypto.randomUUID(), fromId: xavi.id, toId: judit.id, amountCents: 4500, paidOn: today });

  let activity = await call('GET', '/activity');
  assert.deepEqual(activity.items.map((a) => a.kind), ['settlement_created', 'expense_updated', 'expense_created', 'group_created']);
  const updated = activity.items[1];
  assert.equal(updated.actorName, 'Judit');
  assert.equal(updated.groupTitle, 'Pareja');
  assert.deepEqual(updated.data.changes, ['amount', 'split']);
  assert.equal(updated.data.before.amountCents, 8000);
  assert.equal(updated.data.amountCents, 9000);
  assert.equal(activity.unread, 2, 'para Xavi son novedad lo de Judit, no lo suyo');

  const groups = await call('GET', '/groups');
  assert.equal(groups.unreadActivity, 2);

  result = await call('POST', '/activity/seen', { lastId: activity.items[0].id });
  assert.equal(result.unread, 0);
  result = await call('POST', '/activity/seen', { lastId: 1 });
  assert.equal(result.lastSeenId, activity.items[0].id, 'nunca retrocede');

  const forJudit = await call('GET', '/activity', undefined, 'judit');
  assert.equal(forJudit.unread, 2, 'para Judit: crear el grupo y el pago de Xavi');

  // Paginación
  const page = await call('GET', '/activity?limit=2');
  assert.equal(page.items.length, 2);
  const next = await call('GET', `/activity?limit=2&before=${page.nextBefore}`);
  assert.deepEqual(next.items.map((a) => a.kind), ['expense_created', 'group_created']);
  assert.equal(next.nextBefore, null);

  // Borrar y restaurar también dejan rastro; la actividad de otros grupos no se ve
  const fresh = (await call('GET', `/groups/${group.id}`)).expenses[0];
  await call('DELETE', `/expenses/${id}`, { version: fresh.version });
  await call('POST', `/expenses/${id}/restore`, {});
  await call('POST', '/groups', { title: 'Privado de Judit' }, 'judit');
  activity = await call('GET', '/activity');
  assert.deepEqual(activity.items.slice(0, 2).map((a) => a.kind), ['expense_restored', 'expense_deleted']);
  assert.ok(!activity.items.some((a) => a.groupTitle === 'Privado de Judit'));
});

// ---------- Avisos push ----------

test('cifrado de avisos: vector del RFC 8291 (apéndice A)', () => {
  const body = encryptPayload('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, {
    salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    senderPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
  });
  assert.equal(body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('texto del aviso según quién lo recibe', () => {
  const event = {
    kind: 'expense_created', groupId: 3,
    data: { actorName: 'Judit', description: 'Mercadona', amountCents: 8740, currency: 'EUR', shares: [{ personId: 1, owedCents: 5244 }] },
  };
  const message = describeForRecipient(event, 1, 'Pareja');
  assert.deepEqual({ ...message, body: message.body.replace(/\s/g, ' ') }, {
    title: 'Pareja', body: 'Judit añadió «Mercadona»: 87,40 € · te toca 52,44 €', url: './#/g/3', tag: 'grupo-3',
  });
  const payment = { kind: 'settlement_created', groupId: 3, data: { actorName: 'Judit', fromId: 2, fromName: 'Judit', toId: 1, toName: 'Xavi', amountCents: 4500, currency: 'EUR' } };
  assert.equal(describeForRecipient(payment, 1, 'Pareja').body.replace(/\s/g, ' '), 'Judit te pagó 45,00 €');
  assert.equal(describeForRecipient({ kind: 'member_added', groupId: 3, data: {} }, 1, 'Pareja'), null);
});

function subscriptionKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}

test('avisos push: se envían al resto del grupo, firmados con VAPID, y se olvidan las suscripciones caducadas', async (t) => {
  const sent = [];
  let status = 201;
  const fetchImpl = async (url, options) => {
    sent.push({ url, headers: options.headers, body: options.body });
    return new Response(null, { status });
  };
  const call = await startApp(t, { fetchImpl, logger: { warn() {} } });
  const { xavi, judit, group } = await pareja(call);

  const key = await call('GET', '/push/key');
  assert.match(key.publicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.equal((await call('GET', '/push/key')).publicKey, key.publicKey, 'las claves VAPID son estables');

  const endpoint = 'https://fcm.googleapis.com/fcm/send/judit-movil';
  let result = await call('POST', '/push/subscriptions', { subscription: { endpoint, keys: subscriptionKeys() } }, 'judit');
  assert.equal(result.subscribed, true);
  result = await call('POST', '/push/subscriptions', { subscription: { endpoint: 'http://inseguro.test', keys: subscriptionKeys() } }, 'judit');
  assert.equal(result.status, 400);
  result = await call('POST', '/push/subscriptions', { subscription: { endpoint: 'https://127.0.0.1/interno', keys: subscriptionKeys() } }, 'judit');
  assert.equal(result.status, 400, 'solo servicios push conocidos');
  result = await call('POST', '/push/subscriptions', { subscription: { endpoint: 'https://fcm.googleapis.com.evil.test/x', keys: subscriptionKeys() } }, 'judit');
  assert.equal(result.status, 400);

  // Lo que hace Judit no le llega a ella misma
  await call('POST', `/groups/${group.id}/expenses`, { id: crypto.randomUUID(), description: 'Pan', spentOn: today, payerId: judit.id, amountCents: 300, splitMode: 'equal', shares: [{ personId: judit.id }] }, 'judit');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 0);

  await call('POST', `/groups/${group.id}/expenses`, { id: crypto.randomUUID(), description: 'Cena', spentOn: today, payerId: xavi.id, amountCents: 6000, splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: judit.id }] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, endpoint);
  assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');
  const [, jwt, publicKey] = /^vapid t=([^,]+), k=(.+)$/.exec(sent[0].headers.Authorization);
  assert.equal(publicKey, key.publicKey);
  const [header, claims, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).aud, 'https://fcm.googleapis.com');
  const raw = Buffer.from(publicKey, 'base64url');
  const verifyKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));

  // El servicio de push dice que la suscripción ya no existe: se borra
  status = 410;
  await call('POST', `/groups/${group.id}/expenses`, { id: crypto.randomUUID(), description: 'Taxi', spentOn: today, payerId: xavi.id, amountCents: 1000, splitMode: 'equal', shares: [{ personId: judit.id }] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  status = 201;
  await call('POST', `/groups/${group.id}/expenses`, { id: crypto.randomUUID(), description: 'Bus', spentOn: today, payerId: xavi.id, amountCents: 200, splitMode: 'equal', shares: [{ personId: judit.id }] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 2, 'tras el 410 ya no se le envía nada');

  result = await call('DELETE', '/push/subscriptions', { endpoint }, 'judit');
  assert.equal(result.subscribed, false);
});
