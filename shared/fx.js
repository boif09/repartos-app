// Tipos de cambio como texto decimal ("0.006123") y conversión exacta con BigInt.
// El tipo se fija al guardar el gasto y nunca se recalcula después.

const MAX_RATE_DIGITS = 15;
const MAX_RATE_DECIMALS = 12;

// Normaliza lo que escribe una persona ("0,006123", "1.08") a "0.006123". null si no es válido.
export function parseRate(text) {
  const value = String(text ?? '').trim().replace(',', '.');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const decimals = (match[2] || '').replace(/0+$/, '');
  const integer = match[1].replace(/^0+(?=\d)/, '');
  if (decimals.length > MAX_RATE_DECIMALS || (integer + decimals).replace(/^0+/, '').length > MAX_RATE_DIGITS) return null;
  if (/^0*$/.test(integer + decimals)) return null;
  return decimals ? `${integer}.${decimals}` : integer;
}

function rateFraction(rate) {
  const [integer, decimals = ''] = rate.split('.');
  return { numerator: BigInt(integer + decimals), denominator: 10n ** BigInt(decimals.length) };
}

// originalMinor (unidades menores de la divisa origen) × rate -> unidades menores de la divisa destino.
// Un único redondeo, al entero más cercano (mitades hacia arriba).
export function convertMinor(originalMinor, rate, fromExponent, toExponent) {
  const { numerator, denominator } = rateFraction(rate);
  let top = BigInt(originalMinor) * numerator;
  let bottom = denominator;
  const shift = toExponent - fromExponent;
  if (shift >= 0) top *= 10n ** BigInt(shift);
  else bottom *= 10n ** BigInt(-shift);
  return Number((top * 2n + bottom) / (bottom * 2n));
}

// Tipo efectivo (informativo) cuando el importe en la moneda base lo fija la tarjeta.
export function effectiveRate(originalMinor, baseMinor, fromExponent, toExponent) {
  const value = (baseMinor / 10 ** toExponent) / (originalMinor / 10 ** fromExponent);
  return parseRate(value.toPrecision(8)) ?? String(value);
}
