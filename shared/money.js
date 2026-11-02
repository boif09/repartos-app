// Dinero siempre en enteros (céntimos). Este módulo lo usan servidor y navegador.

export const MAX_CENTS = 1_000_000_000; // 10 millones de euros

const formatters = new Map();

export function formatMoney(cents, currency = 'EUR') {
  if (!formatters.has(currency)) {
    formatters.set(currency, new Intl.NumberFormat('es-ES', { style: 'currency', currency }));
  }
  return formatters.get(currency).format(cents / 100);
}

// Convierte lo que escribe una persona ("12,5", "1.234,56", "12.50 €") a céntimos.
// Devuelve null si no es un importe válido. Nunca pasa por float.
export function parseAmount(text) {
  let value = String(text ?? '').replace(/[\s€]/g, '');
  if (!value) return null;

  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // El último separador es el decimal; el otro, de miles.
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    value = value.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    value = value.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(value)) {
    value = value.split('.').join(''); // "1.234" en notación española
  }

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null;
}

// Para rellenar un campo de texto con un importe existente: 1250 -> "12,50".
export function centsToInput(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (const char of String(seed)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Reparte total (entero) proporcionalmente a weights (enteros >= 0) con el método del mayor resto.
// La suma del resultado es exactamente total. Los empates se resuelven en un orden
// rotado según seed, para que el céntimo sobrante no recaiga siempre en la misma posición.
export function allocate(total, weights, seed = '') {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('El total debe ser un entero positivo.');
  if (!weights.length || weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)) {
    throw new Error('Los pesos deben ser enteros positivos.');
  }
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0) throw new Error('Tiene que haber al menos un peso mayor que cero.');
  if (!Number.isSafeInteger(sum)) throw new Error('Los pesos son demasiado grandes.');

  // total × peso puede pasar de 2^53: los productos se hacen con BigInt.
  const bigTotal = BigInt(total);
  const bigSum = BigInt(sum);
  const base = weights.map((weight) => Number((bigTotal * BigInt(weight)) / bigSum));
  let remaining = total - base.reduce((acc, value) => acc + value, 0);
  if (remaining === 0) return base;

  const start = hashSeed(seed) % weights.length;
  const order = weights
    .map((weight, index) => ({
      index,
      remainder: (bigTotal * BigInt(weight)) % bigSum,
      rank: (index - start + weights.length) % weights.length,
    }))
    .filter((item) => weights[item.index] > 0)
    .sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.rank - b.rank));

  for (const item of order) {
    if (remaining === 0) break;
    base[item.index] += 1;
    remaining -= 1;
  }
  return base;
}
