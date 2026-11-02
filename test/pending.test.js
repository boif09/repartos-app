import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePending, pendingDelta } from '../shared/pending.js';

const XAVI = 1;
const JUDIT = 2;

function bundle({ simplifyDebts = true } = {}) {
  return {
    group: { id: 7, simplifyDebts, baseCurrency: 'EUR' },
    members: [{ id: XAVI, name: 'Xavi' }, { id: JUDIT, name: 'Judit' }],
    expenses: [{
      id: 'srv-1', payerId: XAVI, amountCents: 1000,
      shares: [{ personId: XAVI, owedCents: 500 }, { personId: JUDIT, owedCents: 500 }],
    }],
    settlements: [],
    balances: [{ personId: XAVI, amountCents: 500 }, { personId: JUDIT, amountCents: -500 }],
    transfers: [{ fromId: JUDIT, toId: XAVI, amountCents: 500 }],
    myBalanceCents: 500,
  };
}

const pendingExpense = (id, payerId, amountCents, extra = {}) => ({
  id, kind: 'expense', groupId: 7, ...extra,
  expense: {
    id, payerId, amountCents, description: 'Taxi', spentOn: '2026-11-02',
    shares: [{ personId: XAVI, owedCents: amountCents / 2 }, { personId: JUDIT, owedCents: amountCents / 2 }],
  },
});

test('sin pendientes, el bundle no cambia', () => {
  const original = bundle();
  assert.equal(mergePending(original, [], XAVI), original);
  assert.equal(mergePending(original, [{ ...pendingExpense('p1', JUDIT, 400), groupId: 99 }], XAVI), original);
});

test('un gasto pendiente aparece marcado y cuenta en saldos y pagos sugeridos', () => {
  const merged = mergePending(bundle(), [pendingExpense('p1', JUDIT, 400)], XAVI);
  assert.equal(merged.expenses.length, 2);
  assert.equal(merged.expenses[0].pending, true);
  assert.equal(merged.myBalanceCents, 500 - 200);
  assert.deepEqual(merged.transfers, [{ fromId: JUDIT, toId: XAVI, amountCents: 300 }]);
  assert.equal(merged.balances.reduce((sum, b) => sum + b.amountCents, 0), 0);
});

test('un pago pendiente salda la deuda', () => {
  const merged = mergePending(bundle(), [{
    id: 's1', kind: 'settlement', groupId: 7,
    settlement: { id: 's1', fromId: JUDIT, toId: XAVI, amountCents: 500, paidOn: '2026-11-02' },
  }], XAVI);
  assert.equal(merged.settlements[0].pending, true);
  assert.equal(merged.myBalanceCents, 0);
  assert.deepEqual(merged.transfers, []);
});

test('los rechazados por el servidor se muestran pero no cuentan', () => {
  const merged = mergePending(bundle(), [pendingExpense('p1', JUDIT, 400, { error: 'El grupo está archivado.' })], XAVI);
  assert.equal(merged.expenses[0].error, 'El grupo está archivado.');
  assert.equal(merged.myBalanceCents, 500);
});

test('un pendiente apuntado con otra moneda del grupo se ve pero no cuenta', () => {
  const merged = mergePending(bundle(), [pendingExpense('p1', JUDIT, 400, { baseCurrency: 'USD' })], XAVI);
  assert.match(merged.expenses[0].error, /moneda del grupo/);
  assert.equal(merged.myBalanceCents, 500);
});

test('si el servidor ya tiene el gasto no se cuenta dos veces', () => {
  const merged = mergePending(bundle(), [pendingExpense('srv-1', XAVI, 1000)], XAVI);
  assert.equal(merged.expenses.length, 1);
  assert.equal(merged.myBalanceCents, 500);
});

test('sin simplificar, las deudas por pares incluyen los pendientes', () => {
  const merged = mergePending(bundle({ simplifyDebts: false }), [pendingExpense('p1', JUDIT, 400)], XAVI);
  assert.deepEqual(merged.transfers, [{ fromId: JUDIT, toId: XAVI, amountCents: 300 }]);
});

test('pendingDelta: cambio de mi saldo en la lista de grupos', () => {
  const items = [
    pendingExpense('p1', XAVI, 1000),
    pendingExpense('p2', JUDIT, 400),
    { id: 's1', kind: 'settlement', groupId: 7, settlement: { id: 's1', fromId: JUDIT, toId: XAVI, amountCents: 100 } },
    pendingExpense('p3', XAVI, 9999, { error: 'rechazado' }),
    { ...pendingExpense('p4', XAVI, 1000), groupId: 8 },
  ];
  // +1000 −500 (p1) −200 (p2) −100 (Judit me pagó)
  assert.equal(pendingDelta(items, 7, XAVI), 200);
  // Judit: −500 (su parte de p1) +400 −200 (pagó p2) +100 (me pagó)
  assert.equal(pendingDelta(items, 7, JUDIT), -200);
  assert.equal(pendingDelta([pendingExpense('p9', XAVI, 1000, { baseCurrency: 'USD' })], 7, XAVI, 'EUR'), 0, 'otra moneda del grupo: no cuenta');
});
