// Dinero siempre en enteros, en la unidad menor de cada divisa (céntimos de euro, yenes…).
// Este módulo lo usan servidor y navegador.

export const MAX_CENTS = 1_000_000_000; // 10 millones de euros (o 1.000 millones de yenes)

const formatters = new Map();
const exponents = new Map();

// Decimales de la divisa: EUR 2, JPY 0, KWD 3. Sale de Intl, igual en Node y en el navegador.
export function currencyExponent(currency = 'EUR') {
  if (!exponents.has(currency)) {
    exponents.set(currency, new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits);
  }
  return exponents.get(currency);
}

export function isCurrencyCode(value) {
  if (!/^[A-Z]{3}$/.test(String(value ?? ''))) return false;
  try {
    currencyExponent(value);
    return true;
  } catch {
    return false;
  }
}

// Símbolo corto (¥, £, $) salvo que sea ambiguo: el "$" solo para el dólar; MXN o ARS van con su código.
function moneyFormatter(currency) {
  const options = { style: 'currency', currency, useGrouping: 'always' };
  const narrow = new Intl.NumberFormat('es-ES', { ...options, currencyDisplay: 'narrowSymbol' });
  const symbol = narrow.formatToParts(0).find((part) => part.type === 'currency')?.value;
  return symbol === '$' && currency !== 'USD' ? new Intl.NumberFormat('es-ES', { ...options, currencyDisplay: 'code' }) : narrow;
}

export function formatMoney(minor, currency = 'EUR') {
  if (!formatters.has(currency)) formatters.set(currency, moneyFormatter(currency));
  // Signo menos tipográfico (−), no el guion.
  return formatters.get(currency).format(minor / 10 ** currencyExponent(currency)).replace('-', '−');
}

// Convierte lo que escribe una persona ("12,5", "1.234,56", "12.50 €") a unidades menores
// de una divisa con `exponent` decimales. Devuelve null si no es válido. Nunca pasa por float.
export function parseAmount(text, exponent = 2) {
  let value = String(text ?? '').replace(/[\s€$£¥]/g, '');
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
  } else if (/^\d{1,3}(\.\d{3})+$/.test(value) && exponent < 3) {
    value = value.split('.').join(''); // "1.234" en notación española
  }

  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2] && match[2].length > exponent)) return null;
  const minor = Number(match[1]) * 10 ** exponent + Number((match[2] || '').padEnd(exponent, '0') || 0);
  return Number.isSafeInteger(minor) && minor <= MAX_CENTS ? minor : null;
}

// Para rellenar un campo de texto con un importe existente: 1250 -> "12,50"; en JPY 3500 -> "3500".
export function centsToInput(minor, exponent = 2) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  if (exponent === 0) return `${sign}${abs}`;
  const factor = 10 ** exponent;
  return `${sign}${Math.floor(abs / factor)},${String(abs % factor).padStart(exponent, '0')}`;
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
