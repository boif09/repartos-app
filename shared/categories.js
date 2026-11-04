// Categorías de gasto. La app sugiere una a partir de la descripción; siempre se puede cambiar.
export const CATEGORIES = [
  { key: 'food', label: 'Comida y bares', icon: 'food' },
  { key: 'groceries', label: 'Súper', icon: 'cart' },
  { key: 'transport', label: 'Transporte', icon: 'car' },
  { key: 'lodging', label: 'Alojamiento', icon: 'bed' },
  { key: 'leisure', label: 'Ocio', icon: 'ticket' },
  { key: 'home', label: 'Casa', icon: 'home' },
  { key: 'shopping', label: 'Compras', icon: 'bag' },
  { key: 'other', label: 'Otros', icon: 'tag' },
];

export const CATEGORY_KEYS = CATEGORIES.map((category) => category.key);

export function categoryOf(key) {
  return CATEGORIES.find((category) => category.key === key) ?? CATEGORIES.at(-1);
}

// Palabras clave (sin tildes, en minúsculas). La primera categoría que coincide gana.
const KEYWORDS = [
  ['groceries', ['super', 'mercadona', 'carrefour', 'lidl', 'aldi', 'eroski', 'consum', 'bonpreu', 'caprabo', 'alcampo', 'condis', 'hipercor', 'supermercado', 'compra semanal', 'fruteria', 'carniceria', 'panaderia']],
  ['food', ['restaurante', 'cena', 'comida', 'almuerzo', 'desayuno', 'bar', 'bares', 'cafe', 'menu', 'pizza', 'sushi', 'ramen', 'tapas', 'copas', 'cerveza', 'vino', 'burger', 'hamburguesa', 'bocadillo', 'helado', 'brunch', 'vermut', 'kebab', 'glovo', 'just eat', 'uber eats']],
  ['transport', ['taxi', 'uber', 'cabify', 'bolt', 'gasolina', 'diesel', 'peaje', 'parking', 'aparcamiento', 'tren', 'renfe', 'ave', 'avion', 'vuelo', 'ryanair', 'vueling', 'iberia', 'bus', 'autobus', 'metro', 'billete', 'alquiler de coche', 'rent a car', 'ferry', 'shinkansen']],
  ['lodging', ['hotel', 'airbnb', 'apartamento', 'hostal', 'hostel', 'booking', 'alojamiento', 'casa rural', 'camping', 'ryokan']],
  ['leisure', ['entradas', 'entrada', 'cine', 'museo', 'concierto', 'teatro', 'excursion', 'forfait', 'ski', 'esqui', 'tour', 'parque', 'spa', 'karaoke', 'bolera', 'festival', 'partido']],
  ['home', ['luz', 'electricidad', 'agua', 'gas', 'internet', 'fibra', 'alquiler', 'comunidad', 'ikea', 'limpieza', 'muebles', 'ferreteria', 'leroy']],
  ['shopping', ['ropa', 'regalo', 'amazon', 'tienda', 'zapatos', 'zara', 'decathlon', 'farmacia', 'peluqueria']],
];

function normalize(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Devuelve la clave de categoría sugerida o null si no hay pistas. Compara palabras completas
// ("ave" no coincide con "llave"); las claves de varias palabras, como frase completa.
export function guessCategory(description) {
  const text = ` ${normalize(description)} `;
  for (const [key, words] of KEYWORDS) {
    if (words.some((word) => text.includes(` ${word} `))) return key;
  }
  return null;
}
