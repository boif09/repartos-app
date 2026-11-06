// Gastos recurrentes: fechas de cada repetición. Todo en fechas ISO (AAAA-MM-DD), sin horas.
// Mensual y anual respetan el día de la primera vez: un gasto del 31 cae el 30 en abril y el 28/29
// en febrero, y en mayo vuelve al 31 (no se va "comiendo" días).

export const FREQUENCIES = ['weekly', 'monthly', 'yearly'];

export const FREQUENCY_LABELS = {
  weekly: 'Cada semana',
  monthly: 'Cada mes',
  yearly: 'Cada año',
};

const daysInMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

function parts(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month: month - 1, day };
}

function format(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// La siguiente fecha después de `current`, para una serie que empezó el día `anchor`.
export function nextOccurrence(current, frequency, anchor = current) {
  const now = parts(current);
  const start = parts(anchor);
  if (frequency === 'weekly') {
    const date = new Date(Date.UTC(now.year, now.month, now.day + 7));
    return format(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }
  if (frequency === 'monthly') {
    const month = (now.month + 1) % 12;
    const year = now.year + (now.month === 11 ? 1 : 0);
    return format(year, month, Math.min(start.day, daysInMonth(year, month)));
  }
  if (frequency === 'yearly') {
    const year = now.year + 1;
    return format(year, start.month, Math.min(start.day, daysInMonth(year, start.month)));
  }
  throw new Error(`Frecuencia desconocida: ${frequency}`);
}

// Fecha de hoy en una zona horaria (por defecto la de España): el gasto del día 1 aparece el día 1
// aunque el servidor esté en UTC.
export function todayIn(timeZone = 'Europe/Madrid', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
