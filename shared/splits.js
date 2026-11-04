import { allocate } from './money.js';

export const SPLIT_MODES = ['equal', 'shares', 'exact'];

// Quién pagó y cuánto. entries = [{ personId, value }] con lo que puso cada uno en la moneda ORIGINAL
// (deben sumar originalTotal). Devuelve [{ personId, inputValue, paidCents }] con Σ paidCents === totalCents.
export function computePayers({ totalCents, originalTotal = totalCents, entries, seed = '' }) {
  if (!Array.isArray(entries) || !entries.length) throw new SplitError('Falta quién pagó.');
  const seen = new Set();
  const payers = [];
  for (const entry of entries) {
    const personId = Number(entry?.personId);
    if (!Number.isSafeInteger(personId) || personId <= 0) throw new SplitError('Pagador no válido.');
    if (seen.has(personId)) throw new SplitError('Hay un pagador repetido.');
    seen.add(personId);
    const value = Number(entry.value);
    if (!Number.isSafeInteger(value) || value < 0) throw new SplitError('Lo que pagó cada uno debe ser un importe positivo.');
    if (value > 0) payers.push({ personId, value });
  }
  if (!payers.length) throw new SplitError('Falta quién pagó.');
  const paid = payers.reduce((sum, payer) => sum + payer.value, 0);
  if (paid !== originalTotal) throw new SplitError('Lo que pagó cada uno no suma el total del gasto.');
  const cents = originalTotal === totalCents
    ? payers.map((payer) => payer.value)
    : allocate(totalCents, payers.map((payer) => payer.value), `${seed}:pagadores`);
  return payers.map((payer, index) => ({ personId: payer.personId, inputValue: payer.value, paidCents: cents[index] }));
}

// El pagador principal (el que más puso; si empatan, el primero): se guarda en expenses.payer_id.
export function mainPayer(payers) {
  return payers.reduce((best, payer) => (payer.paidCents > best.paidCents ? payer : best), payers[0]).personId;
}

export class SplitError extends Error {}

// Calcula cuánto debe cada participante de un gasto.
//   equal:  entries = [{ personId }]                 -> a partes iguales
//   shares: entries = [{ personId, value: peso }]    -> proporcional (60/40, 2/1/1…)
//   exact:  entries = [{ personId, value: importe }]  -> importes exactos en la moneda ORIGINAL;
//           deben sumar originalTotal (por defecto totalCents, si el gasto es en la moneda base)
// Las personas con peso o importe 0 no participan.
// Devuelve [{ personId, inputValue, owedCents }] con Σ owedCents === totalCents (moneda base).
export function computeShares({ totalCents, mode, entries, seed = '', originalTotal = totalCents }) {
  if (!SPLIT_MODES.includes(mode)) throw new SplitError('Modo de reparto no válido.');
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new SplitError('El importe debe ser mayor que cero.');
  if (!Array.isArray(entries)) throw new SplitError('Faltan los participantes.');

  const seen = new Set();
  const participants = [];
  for (const entry of entries) {
    const personId = Number(entry?.personId);
    if (!Number.isSafeInteger(personId) || personId <= 0) throw new SplitError('Participante no válido.');
    if (seen.has(personId)) throw new SplitError('Hay un participante repetido.');
    seen.add(personId);
    const value = mode === 'equal' ? 1 : Number(entry.value);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SplitError(mode === 'exact' ? 'Los importes deben ser positivos.' : 'Las partes deben ser números enteros positivos.');
    }
    if (value > 0) participants.push({ personId, value });
  }
  if (!participants.length) throw new SplitError('Elige al menos una persona para repartir el gasto.');

  if (mode === 'exact') {
    const assigned = participants.reduce((sum, item) => sum + item.value, 0);
    if (assigned !== originalTotal) {
      throw new SplitError('Los importes de cada persona no suman el total del gasto.');
    }
  }

  if (mode === 'shares' && participants.reduce((sum, item) => sum + item.value, 0) > 1_000_000) {
    throw new SplitError('Las partes son demasiado grandes.');
  }

  // En modo exact y la misma moneda los importes ya cuadran: se usan tal cual.
  // En otra moneda se convierten proporcionalmente para que sumen exactamente el total base.
  const owed = mode === 'exact' && originalTotal === totalCents
    ? participants.map((item) => item.value)
    : allocate(totalCents, participants.map((item) => item.value), seed);
  return participants.map((item, index) => ({
    personId: item.personId,
    inputValue: item.value,
    owedCents: owed[index],
  }));
}
