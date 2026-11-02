// Minimizar pagos: a partir de los saldos netos, propone el menor número de transferencias.
//
// Con k personas con saldo distinto de 0, el mínimo de pagos es k − G, donde G es el máximo
// número de subgrupos disjuntos cuyos saldos suman 0 (cada subgrupo se liquida con |g| − 1 pagos).
// Encontrar G es NP-hard, pero con k pequeño se resuelve exacto por subconjuntos.
// Por encima de EXACT_LIMIT se usa el greedy (como mucho k − 1 pagos).

export const EXACT_LIMIT = 14;

function sortedEntries(balances) {
  return [...balances]
    .filter(([, cents]) => cents !== 0)
    .map(([personId, cents]) => ({ personId, cents }))
    .sort((a, b) => a.personId - b.personId);
}

// El mayor deudor paga al mayor acreedor, y se repite. Desempate estable por personId.
function greedy(entries) {
  const people = entries.map((entry) => ({ ...entry }));
  const transfers = [];
  for (;;) {
    let creditor = null;
    let debtor = null;
    for (const person of people) {
      if (person.cents > 0 && (!creditor || person.cents > creditor.cents)) creditor = person;
      if (person.cents < 0 && (!debtor || person.cents < debtor.cents)) debtor = person;
    }
    if (!creditor || !debtor) return transfers;
    const amount = Math.min(creditor.cents, -debtor.cents);
    transfers.push({ fromId: debtor.personId, toId: creditor.personId, amountCents: amount });
    creditor.cents -= amount;
    debtor.cents += amount;
  }
}

// Partición en el máximo número de subgrupos de suma cero (DP sobre máscaras de bits).
function zeroSumGroups(entries) {
  const k = entries.length;
  const size = 1 << k;
  const sum = new Float64Array(size);
  for (let mask = 1; mask < size; mask += 1) {
    const low = mask & -mask;
    sum[mask] = sum[mask ^ low] + entries[31 - Math.clz32(low)].cents;
  }

  // best[mask] = máximo de subgrupos de suma cero que particionan mask (solo masks de suma 0).
  const best = new Int8Array(size).fill(-1);
  const choice = new Int32Array(size);
  best[0] = 0;
  const solve = (mask) => {
    if (best[mask] >= 0) return best[mask];
    const low = mask & -mask;
    let bestCount = 0;
    let bestSub = mask;
    // Submáscaras que contienen el bit más bajo y suman 0.
    const rest = mask ^ low;
    for (let sub = rest; ; sub = (sub - 1) & rest) {
      const group = sub | low;
      if (sum[group] === 0 && group !== 0) {
        const count = 1 + solve(mask ^ group);
        if (count > bestCount) {
          bestCount = count;
          bestSub = group;
        }
      }
      if (sub === 0) break;
    }
    best[mask] = bestCount;
    choice[mask] = bestSub;
    return bestCount;
  };
  solve(size - 1);

  const groups = [];
  for (let mask = size - 1; mask; mask ^= choice[mask]) {
    const group = [];
    for (let i = 0; i < k; i += 1) if (choice[mask] & (1 << i)) group.push(entries[i]);
    groups.push(group);
  }
  return groups;
}

// balances: Map personId -> céntimos (suma 0). Devuelve [{ fromId, toId, amountCents }].
export function settle(balances) {
  const entries = sortedEntries(balances);
  const total = entries.reduce((acc, entry) => acc + entry.cents, 0);
  if (total !== 0) throw new Error('Los saldos no suman cero.');
  if (entries.length > EXACT_LIMIT) return greedy(entries);
  return zeroSumGroups(entries).flatMap(greedy);
}

export { greedy as settleGreedy };
