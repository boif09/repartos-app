// Color de cada grupo: tiñe su tarjeta en inicio, la cabecera y los iconos de sus gastos.
// Tonos oscuros para que el texto blanco encima tenga contraste AA (≥ 4,5:1) en claro y en oscuro.
export const GROUP_COLORS = [
  { key: 'teal', label: 'Verde azulado', hex: '#0f6e56' },
  { key: 'indigo', label: 'Añil', hex: '#4c46b0' },
  { key: 'berry', label: 'Frambuesa', hex: '#993556' },
  { key: 'blue', label: 'Azul', hex: '#185fa5' },
  { key: 'coral', label: 'Teja', hex: '#a3401f' },
  { key: 'amber', label: 'Ámbar', hex: '#85500b' },
  { key: 'green', label: 'Verde', hex: '#3b6d11' },
  { key: 'slate', label: 'Pizarra', hex: '#4f5866' },
];

export const GROUP_COLOR_KEYS = GROUP_COLORS.map((color) => color.key);

// Sin color elegido (grupos antiguos), uno fijo según el id: cada grupo se distingue desde el principio.
export function groupColor(group) {
  const chosen = GROUP_COLORS.find((color) => color.key === group?.color);
  if (chosen) return chosen;
  const index = (Math.abs(Number(group?.id) || 1) - 1) % GROUP_COLORS.length;
  return GROUP_COLORS[index];
}
