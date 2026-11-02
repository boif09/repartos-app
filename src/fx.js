import { HttpError, badRequest } from './errors.js';
import { isCurrencyCode } from '../shared/money.js';
import { parseRate } from '../shared/fx.js';

// Tipos de cambio de referencia del BCE vía Frankfurter (gratis y sin clave).
// Los días pasados se guardan en fx_cache: no cambian y así funcionan aunque la API falle.
const DEFAULT_API_URL = 'https://api.frankfurter.dev/v1';

function isCalendarDate(value) {
  const text = String(value ?? '');
  const parsed = new Date(`${text}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

export function createFxService(db, { fetchImpl = globalThis.fetch, apiUrl = process.env.FX_API_URL || DEFAULT_API_URL, today } = {}) {
  const todayIso = today || (() => new Date().toISOString().slice(0, 10));
  const readCache = db.prepare('SELECT rate, published_on FROM fx_cache WHERE base = ? AND quote = ? AND day = ?');
  const writeCache = db.prepare('INSERT OR REPLACE INTO fx_cache (base, quote, day, rate, published_on) VALUES (?, ?, ?, ?, ?)');

  async function getRate(from, to, date) {
    if (!isCurrencyCode(from) || !isCurrencyCode(to)) throw badRequest('Moneda no válida.');
    if (!isCalendarDate(date)) throw badRequest('Fecha no válida.');
    if (from === to) return { rate: '1', date, source: 'ecb' };

    // Para hoy o el futuro se pide el último publicado y no se guarda: el BCE publica por la tarde.
    const day = date > todayIso() ? todayIso() : date;
    const cacheable = day < todayIso();
    if (cacheable) {
      const cached = readCache.get(from, to, day);
      if (cached) return { rate: cached.rate, date: cached.published_on || day, source: 'ecb' };
    }

    const path = cacheable ? day : 'latest';
    let response;
    try {
      response = await fetchImpl(`${apiUrl}/${path}?base=${from}&symbols=${to}`, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new HttpError(502, 'No se ha podido consultar el tipo de cambio. Escríbelo a mano.');
    }
    if (response.status === 404 || response.status === 422) {
      throw new HttpError(404, `El BCE no publica el cambio de ${from} a ${to}. Escríbelo a mano.`);
    }
    if (!response.ok) throw new HttpError(502, 'No se ha podido consultar el tipo de cambio. Escríbelo a mano.');

    const data = await response.json().catch(() => null);
    const rate = parseRate(data?.rates?.[to]?.toString());
    if (!rate) throw new HttpError(404, `El BCE no publica el cambio de ${from} a ${to}. Escríbelo a mano.`);
    const publishedOn = isCalendarDate(data.date) ? data.date : day;
    if (cacheable) writeCache.run(from, to, day, rate, publishedOn);
    return { rate, date: publishedOn, source: 'ecb' };
  }

  return { getRate };
}
