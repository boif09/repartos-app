import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, centsToInput, formatMoney, parseAmount } from '../shared/money.js';
import { computeShares, SplitError } from '../shared/splits.js';
import { computeBalances, pairwiseDebts } from '../shared/balances.js';
import { EXACT_LIMIT, settle, settleGreedy } from '../shared/settle.js';

// Generador pseudoaleatorio con semilla, para que los tests sean reproducibles.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return state / 2 ** 32;
  };
}

const sum = (values) => values.reduce((acc, value) => acc + value, 0);

test('parseAmount entiende los formatos habituales y rechaza el resto', () => {
  const cases = {
    '12': 1200, '12,5': 1250, '12,50': 1250, '12.5': 1250, '0,01': 1,
    '1.234,56': 123456, '1,234.56': 123456, '1.234': 123400, '12,50 €': 1250, ' 7 ': 700,
  };
  for (const [text, cents] of Object.entries(cases)) assert.equal(parseAmount(text), cents, text);
  for (const text of ['', 'abc', '12,345', '-5', '1e3', '12,5,0', null, '10000000,01']) {
    assert.equal(parseAmount(text), null, String(text));
  }
});

test('formatMoney y centsToInput', () => {
  assert.match(formatMoney(123456), /^1\.?234,56\s€$/);
  assert.match(formatMoney(-500), /^−5,00\s€$/);
  assert.equal(centsToInput(1250), '12,50');
  assert.equal(centsToInput(5), '0,05');
  assert.equal(parseAmount(centsToInput(98765)), 98765);
});

test('allocate: suma exacta, proporcional y empates rotados por semilla', () => {
  assert.deepEqual(allocate(1000, [1, 1, 1], 'a').sort(), [333, 333, 334]);
  assert.deepEqual(allocate(1000, [60, 40]), [600, 400]);
  assert.deepEqual(allocate(10, [1, 0, 1], 'x').filter((_, i) => i === 1), [0], 'peso 0 no recibe nada');

  const winners = new Set();
  for (let i = 0; i < 30; i += 1) winners.add(allocate(1, [1, 1, 1], `gasto-${i}`).indexOf(1));
  assert.equal(winners.size, 3, 'el céntimo sobrante no cae siempre en la misma persona');
  assert.deepEqual(allocate(100, [1, 1, 1], 'mismo'), allocate(100, [1, 1, 1], 'mismo'), 'determinista');

  const random = rng(1);
  for (let i = 0; i < 2000; i += 1) {
    const total = Math.floor(random() * 1_000_000);
    const weights = Array.from({ length: 1 + Math.floor(random() * 8) }, () => Math.floor(random() * 100));
    if (sum(weights) === 0) weights[0] = 1;
    const result = allocate(total, weights, String(i));
    assert.equal(sum(result), total);
    result.forEach((value, index) => {
      const ideal = (total * weights[index]) / sum(weights);
      assert.ok(Math.abs(value - ideal) < 1, 'cada parte está a menos de 1 céntimo de la ideal');
    });
  }

  // total × peso por encima de 2^53: sigue siendo exacto.
  const bigShares = allocate(1_000_000_000, [999_999, 1, 1], 'grande');
  assert.equal(sum(bigShares), 1_000_000_000);
  assert.equal(bigShares[0], 999_998_000);

  assert.throws(() => allocate(100, [0, 0]), /al menos un peso/);
  assert.throws(() => allocate(100, []), /pesos/);
  assert.throws(() => allocate(-1, [1]), /total/);
});

test('computeShares: los tres modos', () => {
  const equal = computeShares({ totalCents: 1000, mode: 'equal', entries: [{ personId: 1 }, { personId: 2 }, { personId: 3 }], seed: 's' });
  assert.equal(sum(equal.map((s) => s.owedCents)), 1000);
  assert.deepEqual(equal.map((s) => s.inputValue), [1, 1, 1]);

  const shares = computeShares({ totalCents: 10000, mode: 'shares', entries: [{ personId: 1, value: 60 }, { personId: 2, value: 40 }] });
  assert.deepEqual(shares.map((s) => s.owedCents), [6000, 4000]);

  const exact = computeShares({
    totalCents: 4500, mode: 'exact',
    entries: [{ personId: 1, value: 2000 }, { personId: 2, value: 1500 }, { personId: 3, value: 1000 }, { personId: 4, value: 0 }],
  });
  assert.deepEqual(exact.map((s) => [s.personId, s.owedCents]), [[1, 2000], [2, 1500], [3, 1000]], 'importe 0 = no participa');

  assert.throws(() => computeShares({ totalCents: 4500, mode: 'exact', entries: [{ personId: 1, value: 4000 }] }), /no suman/);
  assert.throws(() => computeShares({ totalCents: 100, mode: 'equal', entries: [] }), SplitError);
  assert.throws(() => computeShares({ totalCents: 100, mode: 'equal', entries: [{ personId: 1 }, { personId: 1 }] }), /repetido/);
  assert.throws(() => computeShares({ totalCents: 0, mode: 'equal', entries: [{ personId: 1 }] }), /mayor que cero/);
  assert.throws(() => computeShares({ totalCents: 100, mode: 'otro', entries: [{ personId: 1 }] }), /Modo/);
  assert.throws(() => computeShares({ totalCents: 100, mode: 'shares', entries: [{ personId: 1, value: 1.5 }] }), /enteros/);
});

test('saldos: pagador que no participa, subconjuntos y liquidaciones', () => {
  // Xavi (1) paga 30 € de alcohol entre Judit (2) y Ana (3); Judit paga 60 € de cena entre los tres.
  const expenses = [
    { payerId: 1, baseCents: 3000, shares: [{ personId: 2, owedCents: 1500 }, { personId: 3, owedCents: 1500 }] },
    { payerId: 2, baseCents: 6000, shares: [1, 2, 3].map((personId) => ({ personId, owedCents: 2000 })) },
  ];
  let balances = computeBalances([1, 2, 3], expenses, []);
  assert.deepEqual(Object.fromEntries(balances), { 1: 1000, 2: 2500, 3: -3500 });

  balances = computeBalances([1, 2, 3], expenses, [{ fromId: 3, toId: 2, amountCents: 2500 }]);
  assert.deepEqual(Object.fromEntries(balances), { 1: 1000, 2: 0, 3: -1000 });

  const debts = pairwiseDebts(expenses, [{ fromId: 3, toId: 2, amountCents: 2500 }]);
  // Ana debe a Xavi el alcohol; Xavi y Judit se compensan (20 − 15); Ana pagó a Judit 5 € de más.
  assert.deepEqual(debts, [
    { fromId: 3, toId: 1, amountCents: 1500 },
    { fromId: 1, toId: 2, amountCents: 500 },
    { fromId: 2, toId: 3, amountCents: 500 },
  ]);
});

test('saldos: siempre suman cero (aleatorio)', () => {
  const random = rng(7);
  for (let round = 0; round < 300; round += 1) {
    const members = [1, 2, 3, 4, 5, 6];
    const expenses = Array.from({ length: 30 }, (_, i) => {
      const entries = members.filter(() => random() < 0.7).map((personId) => ({ personId }));
      if (!entries.length) entries.push({ personId: 1 });
      const baseCents = 1 + Math.floor(random() * 50000);
      return {
        payerId: members[Math.floor(random() * members.length)],
        baseCents,
        shares: computeShares({ totalCents: baseCents, mode: 'equal', entries, seed: `${round}-${i}` }),
      };
    });
    assert.equal(sum([...computeBalances(members, expenses, []).values()]), 0);
  }
});

function applyTransfers(balances, transfers) {
  const result = new Map(balances);
  for (const { fromId, toId, amountCents } of transfers) {
    assert.ok(amountCents > 0);
    result.set(fromId, result.get(fromId) + amountCents);
    result.set(toId, result.get(toId) - amountCents);
  }
  return result;
}

test('settle: el contraejemplo donde el greedy hace un pago de más', () => {
  // +80, +70, +40, −60, −60, −70 (en euros)
  const balances = new Map([[1, 8000], [2, 7000], [3, 4000], [4, -6000], [5, -6000], [6, -7000]]);
  assert.equal(settleGreedy([...balances].map(([personId, cents]) => ({ personId, cents }))).length, 5);
  const transfers = settle(balances);
  assert.equal(transfers.length, 4);
  assert.ok([...applyTransfers(balances, transfers).values()].every((cents) => cents === 0));
});

test('settle: casos pequeños', () => {
  assert.deepEqual(settle(new Map()), []);
  assert.deepEqual(settle(new Map([[1, 0], [2, 0]])), []);
  assert.deepEqual(settle(new Map([[1, -2500], [2, 2500]])), [{ fromId: 1, toId: 2, amountCents: 2500 }]);
  assert.throws(() => settle(new Map([[1, 100], [2, -99]])), /no suman cero/);
});

test('settle: óptimo nunca peor que greedy, liquida todo y es rápido (aleatorio)', () => {
  const random = rng(42);
  for (let round = 0; round < 400; round += 1) {
    const n = 2 + Math.floor(random() * 11);
    const values = Array.from({ length: n - 1 }, () => (Math.floor(random() * 19) - 9) * 1000);
    values.push(-sum(values));
    const balances = new Map(values.map((cents, index) => [index + 1, cents]));
    const transfers = settle(balances);
    const nonZero = values.filter((v) => v !== 0).length;
    const greedyCount = settleGreedy([...balances].filter(([, c]) => c !== 0).map(([personId, cents]) => ({ personId, cents }))).length;
    assert.ok(transfers.length <= greedyCount);
    assert.ok(transfers.length <= Math.max(0, nonZero - 1));
    assert.ok([...applyTransfers(balances, transfers).values()].every((cents) => cents === 0));
  }

  const big = new Map(Array.from({ length: EXACT_LIMIT }, (_, i) => [i + 1, (i % 2 ? -1 : 1) * (1000 + i * 137)]));
  const adjust = sum([...big.values()]);
  big.set(1, big.get(1) - adjust);
  const start = performance.now();
  const transfers = settle(big);
  assert.ok(performance.now() - start < 2000, 'el óptimo con el máximo de personas tarda menos de 2 s');
  assert.ok([...applyTransfers(big, transfers).values()].every((cents) => cents === 0));

  const huge = new Map(Array.from({ length: 30 }, (_, i) => [i + 1, i < 29 ? 100 : -2900]));
  assert.equal(settle(huge).length, 29, 'por encima del límite usa greedy');
});
