import { allocate } from './money.js';

export const SPLIT_MODES = ['equal', 'shares', 'exact'];

export class SplitError extends Error {}

// Calcula cuánto debe cada participante de un gasto.
//   equal:  entries = [{ personId }]                 -> a partes iguales
//   shares: entries = [{ personId, value: peso }]    -> proporcional (60/40, 2/1/1…)
//   exact:  entries = [{ personId, value: céntimos }] -> importes exactos; deben sumar totalCents
// Las personas con peso o importe 0 no participan.
// Devuelve [{ personId, inputValue, owedCents }] con Σ owedCents === totalCents.
export function computeShares({ totalCents, mode, entries, seed = '' }) {
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
    if (assigned !== totalCents) {
      throw new SplitError('Los importes de cada persona no suman el total del gasto.');
    }
  }

  if (mode === 'shares' && participants.reduce((sum, item) => sum + item.value, 0) > 1_000_000) {
    throw new SplitError('Las partes son demasiado grandes.');
  }

  // En modo exact los importes ya cuadran: se usan tal cual.
  const owed = mode === 'exact'
    ? participants.map((item) => item.value)
    : allocate(totalCents, participants.map((item) => item.value), seed);
  return participants.map((item, index) => ({
    personId: item.personId,
    inputValue: item.value,
    owedCents: owed[index],
  }));
}
