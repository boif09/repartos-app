// Saldos a partir de gastos y liquidaciones (ya filtrados: sin borrados).
//   expenses:    [{ payerId, baseCents, shares: [{ personId, owedCents }], payers?: [{ personId, paidCents }] }]
//                (sin payers, pagó todo payerId)
//   settlements: [{ fromId, toId, amountCents }]
// Saldo > 0: le deben. Saldo < 0: debe. La suma de todos los saldos es 0.
import { allocate } from './money.js';

export function payersOf(expense) {
  return expense.payers?.length ? expense.payers : [{ personId: expense.payerId, paidCents: expense.baseCents }];
}

export function computeBalances(memberIds, expenses, settlements) {
  const balances = new Map(memberIds.map((id) => [id, 0]));
  const add = (id, cents) => balances.set(id, (balances.get(id) || 0) + cents);

  for (const expense of expenses) {
    for (const payer of payersOf(expense)) add(payer.personId, payer.paidCents);
    for (const share of expense.shares) add(share.personId, -share.owedCents);
  }
  for (const settlement of settlements) {
    add(settlement.fromId, settlement.amountCents);
    add(settlement.toId, -settlement.amountCents);
  }
  return balances;
}

// Deudas netas entre cada par de personas, sin simplificar: cada participante debe su parte a quien
// pagó (si pagaron varios, repartida en proporción a lo que puso cada uno), y las liquidaciones lo
// compensan. Devuelve [{ fromId, toId, amountCents }].
export function pairwiseDebts(expenses, settlements) {
  const net = new Map(); // "a|b" con a < b -> lo que a debe a b (negativo: b debe a a)
  const owe = (debtor, creditor, cents) => {
    if (debtor === creditor || cents === 0) return;
    const [a, b] = debtor < creditor ? [debtor, creditor] : [creditor, debtor];
    const key = `${a}|${b}`;
    net.set(key, (net.get(key) || 0) + (debtor === a ? cents : -cents));
  };

  for (const expense of expenses) {
    const payers = payersOf(expense);
    if (payers.length === 1) {
      for (const share of expense.shares) owe(share.personId, payers[0].personId, share.owedCents);
      continue;
    }
    // Cada parte se reparte en proporción a lo que le queda por cobrar a cada pagador. Así cada
    // persona debe exactamente su parte y cada pagador cobra exactamente lo que puso, sin que los
    // redondeos de varias partes se acumulen (los saldos por pareja cuadran con computeBalances).
    const left = payers.map((payer) => payer.paidCents);
    for (const share of expense.shares) {
      if (share.owedCents <= 0) continue;
      const parts = left.some((cents) => cents > 0)
        ? allocate(share.owedCents, left.map((cents) => Math.max(cents, 0)), `${share.personId}`)
        : payers.map((_, index) => (index === 0 ? share.owedCents : 0));
      parts.forEach((cents, index) => {
        left[index] -= cents;
        owe(share.personId, payers[index].personId, cents);
      });
    }
  }
  for (const settlement of settlements) owe(settlement.toId, settlement.fromId, settlement.amountCents);

  const debts = [];
  for (const [key, cents] of net) {
    if (cents === 0) continue;
    const [a, b] = key.split('|').map(Number);
    debts.push(cents > 0 ? { fromId: a, toId: b, amountCents: cents } : { fromId: b, toId: a, amountCents: -cents });
  }
  return debts.sort((x, y) => y.amountCents - x.amountCents || x.fromId - y.fromId || x.toId - y.toId);
}
