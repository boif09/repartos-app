// Gastos y pagos guardados en el móvil sin conexión, pendientes de enviar.
// Se muestran mezclados con los del servidor y ya cuentan en los saldos que ve la persona.
// Los que el servidor rechazó (item.error) se enseñan, pero no cuentan.
import { computeBalances, pairwiseDebts } from './balances.js';
import { settle } from './settle.js';

const counts = (item) => !item.error;
const CURRENCY_CHANGED = 'La moneda del grupo ha cambiado desde que se apuntó.';

// bundle: respuesta de GET /api/groups/:id. items: elementos de la cola de ese grupo.
export function mergePending(bundle, items, meId) {
  const mine = items.filter((item) => item.groupId === bundle.group.id)
    .map((item) => (item.baseCurrency && item.baseCurrency !== bundle.group.baseCurrency && !item.error
      ? { ...item, error: CURRENCY_CHANGED } : item));
  if (!mine.length) return bundle;

  const pendingExpenses = mine.filter((item) => item.kind === 'expense')
    .map((item) => ({ ...item.expense, pending: true, error: item.error ?? null }));
  const pendingSettlements = mine.filter((item) => item.kind === 'settlement')
    .map((item) => ({ ...item.settlement, pending: true, error: item.error ?? null }));
  // Si el servidor ya lo tiene (se envió pero aún no se borró de la cola), no se cuenta dos veces.
  const known = new Set([...bundle.expenses.map((e) => e.id), ...bundle.settlements.map((s) => s.id)]);
  const newExpenses = pendingExpenses.filter((expense) => !known.has(expense.id));
  const newSettlements = pendingSettlements.filter((settlement) => !known.has(settlement.id));

  const expenses = [...newExpenses, ...bundle.expenses];
  const settlements = [...newSettlements, ...bundle.settlements];
  const forBalance = expenses.filter(counts).map((expense) => ({ payerId: expense.payerId, baseCents: expense.amountCents, shares: expense.shares }));
  const settlementsForBalance = settlements.filter(counts);
  const balances = computeBalances(bundle.members.map((member) => member.id), forBalance, settlementsForBalance);
  const transfers = bundle.group.simplifyDebts ? settle(balances) : pairwiseDebts(forBalance, settlementsForBalance);

  return {
    ...bundle,
    expenses,
    settlements,
    balances: [...balances].map(([personId, amountCents]) => ({ personId, amountCents })),
    transfers,
    myBalanceCents: balances.has(meId) ? balances.get(meId) : null,
  };
}

// Cuánto cambia el saldo de meId en un grupo por sus pendientes (para la lista de grupos).
export function pendingDelta(items, groupId, meId, baseCurrency) {
  let delta = 0;
  for (const item of items) {
    if (item.groupId !== groupId || !counts(item)) continue;
    if (baseCurrency && item.baseCurrency && item.baseCurrency !== baseCurrency) continue;
    if (item.kind === 'expense') {
      const { expense } = item;
      if (expense.payerId === meId) delta += expense.amountCents;
      delta -= expense.shares.find((share) => share.personId === meId)?.owedCents ?? 0;
    } else {
      const { settlement } = item;
      if (settlement.fromId === meId) delta += settlement.amountCents;
      if (settlement.toId === meId) delta -= settlement.amountCents;
    }
  }
  return delta;
}
