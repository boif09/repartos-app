import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { centsToInput, currencyExponent, formatMoney, isCurrencyCode, parseAmount } from '../shared/money.js';
import { convertMinor, effectiveRate, parseRate } from '../shared/fx.js';
import { computeShares } from '../shared/splits.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';

test('exponentes, parseo y formato por divisa', () => {
  assert.equal(currencyExponent('EUR'), 2);
  assert.equal(currencyExponent('JPY'), 0);
  assert.equal(currencyExponent('KWD'), 3);
  assert.equal(isCurrencyCode('JPY'), true);
  assert.equal(isCurrencyCode('jpy'), false);
  assert.equal(isCurrencyCode('EURO'), false);

  assert.equal(parseAmount('3500', 0), 3500);
  assert.equal(parseAmount('3.500', 0), 3500);
  assert.equal(parseAmount('3500,5', 0), null, 'el yen no tiene decimales');
  assert.equal(parseAmount('1,250', 3), 1250);
  assert.equal(parseAmount('12,5', 2), 1250);

  assert.equal(centsToInput(3500, 0), '3500');
  assert.equal(centsToInput(1250, 3), '1,250');
  assert.match(formatMoney(3500, 'JPY'), /3\.?500\s(¥|JPY)/);
});

test('tipos de cambio: parseo y conversión exacta con un único redondeo', () => {
  assert.equal(parseRate('0,006123'), '0.006123');
  assert.equal(parseRate('1.0800'), '1.08');
  assert.equal(parseRate('007'), '7');
  for (const bad of ['', '0', '0,000', '-1', 'abc', '1e3', '0.0000000000001']) assert.equal(parseRate(bad), null, bad);

  // 3500 JPY × 0.006123 = 21.4305 EUR -> 2143 céntimos
  assert.equal(convertMinor(3500, '0.006123', 0, 2), 2143);
  // 10,00 USD × 0.9215 = 9.215 -> 9,22 (mitad hacia arriba)
  assert.equal(convertMinor(1000, '0.9215', 2, 2), 922);
  // 50,00 EUR × 162.35 = 8117.5 JPY -> 8118
  assert.equal(convertMinor(5000, '162.35', 2, 0), 8118);
  // Números grandes sin perder precisión
  assert.equal(convertMinor(1_000_000_000, '0.123456789012', 2, 2), 123456789);

  assert.equal(effectiveRate(3500, 2150, 0, 2), '0.0061428571');
});

test('reparto exacto en moneda extranjera: se convierte y suma exacto en la moneda base', () => {
  // 3500 JPY = 21,43 €; Ana 2000 ¥, Bea 1500 ¥
  const shares = computeShares({
    totalCents: 2143, originalTotal: 3500, mode: 'exact',
    entries: [{ personId: 1, value: 2000 }, { personId: 2, value: 1500 }],
  });
  assert.deepEqual(shares.map((s) => s.inputValue), [2000, 1500]);
  assert.equal(shares.reduce((sum, s) => sum + s.owedCents, 0), 2143);
  assert.deepEqual(shares.map((s) => s.owedCents), [1225, 918]);
  assert.throws(() => computeShares({ totalCents: 2143, originalTotal: 3500, mode: 'exact', entries: [{ personId: 1, value: 2143 }] }), /no suman/);
});

function fakeFrankfurter(rates) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    const key = `${searchParams.get('base')}>${searchParams.get('symbols')}`;
    if (!(key in rates)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const day = pathname.split('/').pop();
    return Response.json({ amount: 1, base: searchParams.get('base'), date: day === 'latest' ? '2026-11-02' : day, rates: { [searchParams.get('symbols')]: rates[key] } });
  };
  return { fetchImpl, calls };
}

async function startApp(t, fxOptions) {
  const { server } = createApp({
    basePath: '/',
    db: openDatabase({ dbPath: ':memory:' }),
    auth: { allowedUsers: ['xavi', 'judit'] },
    fx: fxOptions,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return async (method, pathName, body) => {
    const response = await fetch(`${baseUrl}/api${pathName}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'xavi' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  };
}

test('API /fx: BCE simulado, caché de días pasados y errores', async (t) => {
  const fake = fakeFrankfurter({ 'JPY>EUR': 0.006123, 'USD>EUR': 0.92 });
  const call = await startApp(t, { fetchImpl: fake.fetchImpl, apiUrl: 'https://fx.test/v1', today: () => '2026-11-02' });

  let result = await call('GET', '/fx?from=JPY&to=EUR&date=2026-10-30');
  assert.deepEqual({ rate: result.rate, date: result.date, source: result.source }, { rate: '0.006123', date: '2026-10-30', source: 'ecb' });
  result = await call('GET', '/fx?from=JPY&to=EUR&date=2026-10-30');
  assert.equal(result.rate, '0.006123');
  assert.equal(fake.calls.length, 1, 'el segundo se sirve desde la caché');

  result = await call('GET', '/fx?from=USD&to=EUR&date=2026-11-02');
  assert.equal(result.rate, '0.92');
  await call('GET', '/fx?from=USD&to=EUR&date=2026-11-02');
  assert.equal(fake.calls.length, 3, 'el día de hoy no se guarda en caché');
  assert.match(fake.calls[1], /\/latest\?/);

  result = await call('GET', '/fx?from=VND&to=EUR&date=2026-10-30');
  assert.equal(result.status, 404);
  assert.match(result.error, /a mano/);

  result = await call('GET', '/fx?from=EUR&to=EUR&date=2026-10-30');
  assert.equal(result.rate, '1');

  result = await call('GET', '/fx?from=XX&to=EUR&date=2026-10-30');
  assert.equal(result.status, 400);
  result = await call('GET', '/fx?from=JPY&to=EUR&date=2026-02-30');
  assert.equal(result.status, 400, 'fecha imposible: no se consulta fuera');
});

test('API /fx: un domingo devuelve el tipo del viernes, también desde la caché', async (t) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return Response.json({ amount: 1, base: 'JPY', date: '2026-10-30', rates: { EUR: 0.0057 } });
  };
  const call = await startApp(t, { fetchImpl, today: () => '2026-11-02' });
  const first = await call('GET', '/fx?from=JPY&to=EUR&date=2026-11-01');
  const second = await call('GET', '/fx?from=JPY&to=EUR&date=2026-11-01');
  assert.equal(first.date, '2026-10-30');
  assert.equal(second.date, '2026-10-30');
  assert.equal(calls.length, 1);
});

test('API /fx: la API del BCE no responde', async (t) => {
  const call = await startApp(t, { fetchImpl: async () => { throw new Error('sin red'); }, today: () => '2026-11-02' });
  const result = await call('GET', '/fx?from=JPY&to=EUR&date=2026-10-30');
  assert.equal(result.status, 502);
  assert.match(result.error, /a mano/);
});

test('gastos en moneda extranjera: BCE, manual y lo que cobró la tarjeta', async (t) => {
  const call = await startApp(t, { fetchImpl: async () => { throw new Error('no se usa'); } });
  const { person: xavi } = await call('GET', '/session');
  const { group, members } = await call('POST', '/groups', { title: 'Japón 2027', members: [{ name: 'Judit' }] });
  const judit = members.find((m) => m.name === 'Judit');
  assert.equal(group.baseCurrency, 'EUR');
  const base = { description: 'Ramen', spentOn: '2026-10-30', payerId: xavi.id, splitMode: 'equal', shares: [{ personId: xavi.id }, { personId: judit.id }] };

  let result = await call('POST', `/groups/${group.id}/expenses`, {
    ...base, id: crypto.randomUUID(), currency: 'JPY', originalMinor: 3500, fxSource: 'ecb', fxRate: '0.006123',
  });
  assert.equal(result.status, 201);
  assert.equal(result.expense.amountCents, 2143);
  assert.equal(result.expense.originalMinor, 3500);
  assert.equal(result.expense.currency, 'JPY');
  assert.equal(result.expense.fxRate, '0.006123');
  assert.equal(result.expense.shares.reduce((sum, s) => sum + s.owedCents, 0), 2143);

  result = await call('POST', `/groups/${group.id}/expenses`, {
    ...base, id: crypto.randomUUID(), currency: 'JPY', originalMinor: 3500, fxSource: 'card', amountCents: 2150,
  });
  assert.equal(result.expense.amountCents, 2150);
  assert.equal(result.expense.fxSource, 'card');
  assert.equal(result.expense.fxRate, null);

  result = await call('POST', `/groups/${group.id}/expenses`, {
    ...base, id: crypto.randomUUID(), currency: 'JPY', originalMinor: 10000, splitMode: 'exact',
    shares: [{ personId: xavi.id, value: 6000 }, { personId: judit.id, value: 4000 }], fxSource: 'manual', fxRate: '0,0061',
  });
  assert.equal(result.expense.amountCents, 6100);
  assert.deepEqual(result.expense.shares.map((s) => s.owedCents).sort((a, b) => a - b), [2440, 3660]);

  const invalid = [
    [{ currency: 'JPY', originalMinor: 3500 }, /tipo de cambio/],
    [{ currency: 'JPY', originalMinor: 3500, fxSource: 'ecb', fxRate: 'abc' }, /no válido/],
    [{ currency: 'JPY', originalMinor: 1, fxSource: 'manual', fxRate: '0.001' }, /demasiado pequeño/],
    [{ currency: 'XYZW', amountCents: 100 }, /Moneda/],
    [{ currency: 'JPY', originalMinor: 3500, fxSource: 'card', amountCents: 0 }, /cobró la tarjeta/],
  ];
  for (const [money, message] of invalid) {
    result = await call('POST', `/groups/${group.id}/expenses`, { ...base, id: crypto.randomUUID(), ...money });
    assert.equal(result.status, 400, JSON.stringify(money));
    assert.match(result.error, message);
  }

  // Editar: pasar un gasto de yenes a euros.
  const first = (await call('GET', `/groups/${group.id}`)).expenses.find((e) => e.fxRate === '0.006123');
  result = await call('PUT', `/expenses/${first.id}`, { ...base, id: first.id, version: first.version, currency: 'EUR', amountCents: 2000 });
  assert.equal(result.expense.currency, 'EUR');
  assert.equal(result.expense.originalMinor, 2000);
  assert.equal(result.expense.fxRate, null);

  const bundle = await call('GET', `/groups/${group.id}`);
  assert.equal(bundle.balances.reduce((sum, b) => sum + b.amountCents, 0), 0);
});

test('moneda del grupo: se elige al crear y solo se cambia sin movimientos', async (t) => {
  const call = await startApp(t, {});
  const { person: xavi } = await call('GET', '/session');
  let bundle = await call('POST', '/groups', { title: 'Trip USA', baseCurrency: 'USD' });
  assert.equal(bundle.group.baseCurrency, 'USD');
  bundle = await call('PATCH', `/groups/${bundle.group.id}`, { baseCurrency: 'EUR' });
  assert.equal(bundle.group.baseCurrency, 'EUR');

  await call('POST', `/groups/${bundle.group.id}/expenses`, {
    id: crypto.randomUUID(), description: 'X', spentOn: '2026-10-30', payerId: xavi.id, amountCents: 100, splitMode: 'equal', shares: [{ personId: xavi.id }],
  });
  const result = await call('PATCH', `/groups/${bundle.group.id}`, { baseCurrency: 'USD' });
  assert.equal(result.status, 409);
  assert.equal((await call('PATCH', `/groups/${bundle.group.id}`, { baseCurrency: 'EUR' })).status, 200, 'la misma moneda no es un cambio');
  assert.equal((await call('POST', '/groups', { title: 'Mal', baseCurrency: 'EURO' })).status, 400);
});
