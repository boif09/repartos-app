// SPA vanilla con rutas por hash. Las rutas de red son relativas al documento, así la app
// funciona bajo cualquier BASE_PATH. El login lo gestiona Authelia: si la sesión caduca,
// nginx responde con una redirección y la app recarga la página para que el navegador la siga.
import { allocate, centsToInput, currencyExponent, formatMoney, parseAmount } from './shared/money.js';
import { convertMinor, parseRate } from './shared/fx.js';
import { mergePending, pendingDelta } from './shared/pending.js';
import { listItems, outboxAvailable, putItem, removeItem } from './outbox.js';
import { computePayers, computeShares, mainPayer, SplitError } from './shared/splits.js';
import { payersOf } from './shared/balances.js';
import { CATEGORIES, categoryOf, guessCategory } from './shared/categories.js';
import { GROUP_COLORS, groupColor } from './shared/palette.js';

const appEl = document.getElementById('app');
const GROUP_EMOJIS = ['👥', '❤️', '🏠', '✈️', '🏖️', '⛰️', '🍻', '🎉'];
// Monedas habituales. Las del BCE tienen tipo automático; el resto se escribe a mano.
const CURRENCIES = [
  'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CNY', 'THB', 'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'CAD', 'AUD', 'NZD',
  'SEK', 'NOK', 'DKK', 'ISK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'MAD', 'EGP', 'AED', 'INR', 'IDR', 'VND', 'KRW',
  'SGD', 'HKD', 'PHP', 'MYR', 'ZAR', 'ILS',
];
const currencyNames = new Intl.DisplayNames('es', { type: 'currency' });

let session = null;
let renderToken = 0;

// ---------- Utilidades ----------

class SessionExpiredError extends Error {}
// La petición no llegó (sin red, o tan lenta que se cortó). Crear gastos y pagos se puede reintentar sin duplicar.
class OfflineError extends Error {}

// La vista de amigos vive en /s/#token: la API está un nivel por encima.
const SHARED_MODE = /\/s\/$/.test(location.pathname);
const API_ROOT = SHARED_MODE ? '../api/' : 'api/';
const OFFLINE_WRITE = 'Sin conexión: no se puede guardar ahora. Inténtalo cuando vuelva la cobertura.';

async function api(pathName, { method = 'GET', body, headers = {} } = {}) {
  if (method !== 'GET' && !navigator.onLine) throw new OfflineError(OFFLINE_WRITE);
  let response;
  try {
    response = await fetch(`${API_ROOT}${pathName}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      redirect: 'manual',
      // Con cobertura mala una escritura puede quedarse colgada: a los 15 s se trata como sin conexión.
      signal: method === 'GET' ? undefined : AbortSignal.timeout(15000),
    });
  } catch {
    if (method === 'GET') throw new Error('Sin conexión y sin datos guardados para esta pantalla.');
    throw new OfflineError(OFFLINE_WRITE);
  }
  // El service worker marca las respuestas que salen de la caché por falta de red.
  if (method === 'GET') setOfflineData(response.headers.get('X-Repartos-Offline') === '1');
  if (response.type === 'opaqueredirect' || response.status === 401) {
    throw new SessionExpiredError('La sesión ha caducado.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || 'Error de conexión.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

let offlineData = false;
const offlineBanner = document.createElement('div');
offlineBanner.className = 'offline-banner';
offlineBanner.setAttribute('role', 'status');

function setOfflineData(value) {
  offlineData = value;
  updateOfflineBanner();
}

function updateOfflineBanner() {
  const offline = !navigator.onLine || offlineData;
  const waiting = pendingItems.filter((item) => !item.error).length;
  offlineBanner.textContent = !offline ? ''
    : waiting ? `Sin conexión · ${waiting === 1 ? '1 pendiente' : `${waiting} pendientes`} de enviar`
      : 'Sin conexión · viendo los últimos datos guardados';
  document.body.classList.toggle('is-offline', offline);
}

// ---------- Cola sin conexión ----------

let pendingItems = []; // gastos y pagos de este usuario guardados en el móvil
let syncing = false;
let retryTimer = null;
const inFlight = new Set(); // ids que un formulario está enviando ahora mismo

// Con red "lenta pero conectada" no llega ningún evento online: se reintenta cada 30 s.
function scheduleRetry() {
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(syncOutbox, 30000);
}

async function refreshPending() {
  if (!session || !outboxAvailable()) return pendingItems;
  try {
    pendingItems = await listItems(session.user);
  } catch {
    pendingItems = [];
  }
  updateOfflineBanner();
  return pendingItems;
}

async function queueForLater(item) {
  await putItem({ ...item, user: session.user, createdAt: new Date().toISOString() });
  await refreshPending();
}

// Crear un gasto o pago: PRIMERO se guarda en el móvil y luego se envía. Si la app se cierra a mitad,
// no hay red o la sesión caduca, queda en la cola y se enviará solo (reenviar no duplica: mismo id).
// Devuelve 'sent' o 'queued'; los rechazos del servidor se lanzan y no quedan en la cola.
async function createWithOutbox(item) {
  let queued = false;
  if (outboxAvailable()) {
    try {
      await queueForLater(item);
      queued = true;
    } catch {
      queued = false; // sin IndexedDB (p. ej. navegación privada): se intenta enviar directamente
    }
  }
  inFlight.add(item.id);
  try {
    await api(item.path, { method: 'POST', body: item.body });
    if (queued) await removeItem(item.id).catch(() => {});
    return 'sent';
  } catch (error) {
    if (queued && error instanceof OfflineError) {
      scheduleRetry();
      return 'queued';
    }
    if (queued && !(error instanceof SessionExpiredError)) await removeItem(item.id).catch(() => {});
    throw error;
  } finally {
    inFlight.delete(item.id);
    await refreshPending();
  }
}

// Envía la cola en el orden en que se creó. Se para ante un fallo de red, de sesión o del servidor
// (se reintentará); si el servidor rechaza un elemento (4xx), queda marcado para que la persona decida.
async function syncOutbox() {
  if (syncing || !session || !outboxAvailable() || !navigator.onLine) return;
  syncing = true;
  let sent = 0;
  let stopped = false;
  try {
    // La sesión pudo venir de la caché (arranque sin red): se confirma con el servidor que sigue
    // siendo la misma persona antes de enviar nada a su nombre.
    const fresh = await api('session').catch(() => null);
    if (!fresh || offlineData) return;
    if (fresh.user !== session.user) {
      window.location.reload();
      return;
    }
    for (const item of await refreshPending()) {
      if (item.error || inFlight.has(item.id)) continue;
      try {
        await api(item.path, { method: 'POST', body: item.body });
        await removeItem(item.id);
        sent += 1;
      } catch (error) {
        if (error instanceof OfflineError || error instanceof SessionExpiredError || !error.status || error.status >= 500) {
          stopped = true;
          break;
        }
        await putItem({ ...item, error: error.message });
      }
    }
  } finally {
    syncing = false;
    await refreshPending();
    if (stopped && navigator.onLine) scheduleRetry();
  }
  if (sent) {
    toast(sent === 1 ? '1 pendiente enviado' : `${sent} pendientes enviados`);
    if (!document.querySelector('form')) render();
  }
}

// Fila de un gasto o pago que aún no está en el servidor.
function pendingRow({ id, title, amountText, payerId, people, error }) {
  return el('button', { type: 'button', class: `row pending${error ? ' failed' : ''}`, onClick: () => pendingSheet(id, title, error) },
    payerId ? avatar(payerId, people.get(payerId)?.name) : el('span', { class: 'pay-icon' }, icon('swap', { small: true })),
    el('span', { class: 'row-main' },
      el('strong', { text: title }),
      el('span', { class: 'meta pending-meta' }, icon('cloudOff', { small: true }), error ? `No se pudo enviar: ${error}` : 'Pendiente de enviar')),
    el('span', { class: 'row-side' }, el('strong', { text: amountText })));
}

async function pendingSheet(id, title, error) {
  const discard = await confirmSheet({
    title: error ? 'No se pudo enviar' : 'Pendiente de enviar',
    message: error
      ? `«${title}»: ${error} Puedes descartarlo y volver a apuntarlo.`
      : `«${title}» está guardado en este móvil y se enviará solo cuando haya conexión.`,
    confirmLabel: 'Descartar',
    danger: true,
  });
  if (!discard) return;
  await removeItem(id);
  await refreshPending();
  toast('Descartado');
  render();
}

// Crea elementos sin innerHTML: los datos nunca se interpretan como HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const dayFormat = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const dayYearFormat = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso) {
  const today = todayIso();
  const yesterday = new Date(`${today}T12:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  if (iso === today) return 'Hoy';
  if (iso === yesterday.toISOString().slice(0, 10)) return 'Ayer';
  const date = new Date(`${iso}T12:00:00`);
  return (iso.slice(0, 4) === today.slice(0, 4) ? dayFormat : dayYearFormat).format(date);
}

function navigate(hash, { replace = false } = {}) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

let toastTimer = null;
function toast(message, action) {
  document.querySelector('.toast')?.remove();
  window.clearTimeout(toastTimer);
  const node = el('div', { class: 'toast', role: 'status' },
    el('span', { text: message }),
    action && el('button', {
      type: 'button',
      class: 'toast-action',
      text: action.label,
      onClick: async () => {
        node.remove();
        try {
          await action.onClick();
        } catch (error) {
          handleError(error);
        }
      },
    }));
  document.body.append(node);
  toastTimer = window.setTimeout(() => node.remove(), action ? 6000 : 3500);
}

function handleError(error) {
  if (error instanceof SessionExpiredError) {
    window.location.reload();
    return;
  }
  toast(error.message || 'Algo ha fallado.');
}

// Iconos de línea propios (24×24, trazo): iguales en todos los móviles, a diferencia de los emojis.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  back: ['M15 18l-6-6 6-6'],
  forward: ['M9 18l6-6-6-6'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  swap: ['M7 7h11l-3-3', 'M17 17H6l3 3'],
  check: ['M20 6L9 17l-5-5'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.9 1.9 0 0 0 3.4 0'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-4.3-4.3'],
  food: ['M4 3v8a3 3 0 0 0 3 3v7', 'M10 3v8a3 3 0 0 1-3 3', 'M7 3v6', 'M17 3c-1.7 0-3 2-3 5s1.3 4 3 4v9'],
  cart: ['M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M18 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M2 3h3l2.6 12.4a1.5 1.5 0 0 0 1.5 1.1h8.8a1.5 1.5 0 0 0 1.5-1.1L21 7H6'],
  car: ['M5 17h14', 'M5 17a2 2 0 1 0 4 0', 'M15 17a2 2 0 1 0 4 0', 'M3 17v-5l2-5h14l2 5v5', 'M3 12h18'],
  bed: ['M3 7v12', 'M21 19v-6a3 3 0 0 0-3-3H3', 'M3 15h18', 'M7 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  ticket: ['M3 9a3 3 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a3 3 0 0 0 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z', 'M14 5v2', 'M14 11v2', 'M14 17v2'],
  bag: ['M6 7h12l1 14H5L6 7z', 'M9 7a3 3 0 0 1 6 0'],
  tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01'],
  cloudOff: ['M2 2l20 20', 'M5.8 5.8A7 7 0 0 0 9 19h8.5', 'M20.5 16.5A4.5 4.5 0 0 0 17.5 9h-1.3A7 7 0 0 0 9.5 5.1'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  contrast: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 3v18', 'M12 7h4.5', 'M12 11h6.5', 'M12 15h6', 'M12 19h3'],
  down: ['M6 9l6 6 6-6'],
  calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  heart: ['M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z'],
  home: ['M3 10.5L12 3l9 7.5', 'M5 9.5V21h14V9.5', 'M10 21v-6h4v6'],
  plane: ['M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M6.3 17.7l-1.4 1.4', 'M19.1 4.9l-1.4 1.4'],
  mountain: ['M8 3l4 8 5-5 5 15H2L8 3z'],
  glass: ['M8 22h8', 'M12 15v7', 'M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5z'],
  party: ['M5.8 11.3L2 22l10.7-3.8', 'M4 3h.01', 'M22 8h.01', 'M15 2h.01', 'M22 20h.01', 'M22 2l-2.2.8a2.9 2.9 0 0 0-2 3.1c.1.9-.6 1.6-1.5 1.6h-.4c-.9 0-1.6.6-1.8 1.4L14 10', 'M11 13c1.9 1.9 2.8 4.2 2 5-.8.8-3.1-.1-5-2s-2.8-4.2-2-5c.8-.8 3.1.1 5 2z'],
};

function icon(name, { small = false } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', small ? 'icon sm' : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// El grupo guarda un emoji (compatibilidad con los datos existentes); se pinta como icono propio.
const GROUP_ICONS = [
  ['👥', 'users', 'Grupo'],
  ['❤️', 'heart', 'Pareja'],
  ['🏠', 'home', 'Casa'],
  ['✈️', 'plane', 'Viaje'],
  ['🏖️', 'sun', 'Vacaciones'],
  ['⛰️', 'mountain', 'Montaña'],
  ['🍻', 'glass', 'Salir'],
  ['🎉', 'party', 'Celebración'],
];

function groupIconName(group) {
  return GROUP_ICONS.find(([value]) => value === group?.emoji)?.[1] ?? 'users';
}

// El color del grupo viaja como variable CSS (--g): lo usan la cabecera, las tarjetas y los iconos.
function tintWith(node, group) {
  node.style.setProperty('--g', groupColor(group).hex);
  return node;
}

function groupIcon(group) {
  return tintWith(el('span', { class: 'group-icon tinted', 'aria-hidden': 'true' }, icon(groupIconName(group))), group);
}

// Icono de la categoría del gasto, teñido con el color del grupo que lo contiene.
// Sin categoría guardada (gastos antiguos), la que sugiere la descripción.
function categoryTile(expense, { small = false } = {}) {
  const key = expense.category || guessCategory(expense.description) || 'other';
  return el('span', { class: small ? 'cat-tile small' : 'cat-tile', 'aria-hidden': 'true' }, icon(categoryOf(key).icon, { small }));
}

// Color fijo por persona (texto blanco ≥ 5:1 en todos): se reconoce quién pagó sin leer.
const AVATAR_COLORS = ['#2b3fd6', '#8a4f36', '#0b6b45', '#9a2f6a', '#3d5f80', '#6b4aa3', '#8a6a12', '#b03a2e'];

function avatar(personId, name, { large = false } = {}) {
  const node = el('span', { class: large ? 'avatar lg' : 'avatar', 'aria-hidden': 'true', text: (name || '?').trim().charAt(0).toUpperCase() });
  node.style.background = AVATAR_COLORS[(Math.abs(Number(personId) || 1) - 1) % AVATAR_COLORS.length];
  return node;
}

function currencySymbol(currency) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
    .formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency;
}

// Cerrado muestra solo el código (JPY); al abrirlo, la lista nativa muestra también el nombre.
function currencySelect(current, onChange, { disabled = false } = {}) {
  const codes = CURRENCIES.includes(current) ? CURRENCIES : [current, ...CURRENCIES];
  const shown = el('span', { class: 'currency-code', text: current });
  const select = el('select', {
    'aria-label': 'Moneda',
    disabled,
    onChange: () => {
      shown.textContent = select.value;
      onChange(select.value);
    },
  }, codes.map((code) => el('option', { value: code, text: `${code} · ${currencyNames.of(code)}` })));
  select.value = current;
  return el('span', { class: `currency-select${disabled ? ' disabled' : ''}` }, shown, el('span', { class: 'chevron', 'aria-hidden': 'true', text: '▾' }), select);
}

// La moneda del último gasto del grupo: en un viaje, lo normal es seguir pagando en la misma.
function lastCurrency(bundle) {
  return bundle.expenses[0]?.currency ?? null;
}

// "Judit te pagó", "Pagaste a Ana", "Ana pagó a Bea" (o en presente para los pagos sugeridos).
function paymentText(people, fromId, toId, tense) {
  const meId = session?.person.id;
  const name = (id) => people.get(id)?.name ?? '¿?';
  if (tense === 'present') {
    if (fromId === meId) return `Pagas a ${name(toId)}`;
    if (toId === meId) return `${name(fromId)} te paga`;
    return `${name(fromId)} paga a ${name(toId)}`;
  }
  if (fromId === meId) return `Pagaste a ${name(toId)}`;
  if (toId === meId) return `${name(fromId)} te pagó`;
  return `${name(fromId)} pagó a ${name(toId)}`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function personName(people, id) {
  if (session && id === session.person.id) return 'Tú';
  return people.get(id)?.name ?? '¿?';
}

// Saldo en dos piezas: la frase (texto) y la cifra (monoespaciada).
function balanceText(cents, currency = 'EUR', { mine = true } = {}) {
  if (cents === null || cents === undefined) return { label: 'No participas', amount: '', tone: 'muted' };
  if (cents > 0) return { label: mine ? 'Te deben' : 'Le deben', amount: formatMoney(cents, currency), tone: 'positive' };
  if (cents < 0) return { label: mine ? 'Debes' : 'Debe', amount: formatMoney(-cents, currency), tone: 'negative' };
  return { label: 'En paz', amount: '', tone: 'muted' };
}

function balanceSide(balance) {
  return el('span', { class: 'row-side' },
    el('span', { class: 'small muted', text: balance.label }),
    balance.amount && el('strong', { class: `amount ${balance.tone}`, text: balance.amount }));
}

// ---------- Piezas de interfaz ----------

function topbar({ title, back, action }) {
  return el('header', { class: 'topbar' },
    back && el('a', { class: 'icon-btn', href: back, 'aria-label': 'Volver' }, icon('back')),
    el('h1', { class: back ? undefined : 'wordmark', text: title }),
    action || (session && el('a', { class: 'me-link', href: '#/personas', 'aria-label': 'Personas y saldos' }, avatar(session.person.id, session.person.name))));
}

function chip({ label, selected, onToggle, role = 'checkbox', ariaLabel, className = 'chip' }) {
  const node = el('button', {
    type: 'button',
    class: className,
    role,
    'aria-checked': String(Boolean(selected)),
    'aria-label': ariaLabel,
    text: typeof label === 'string' ? label : undefined,
    onClick: () => {
      const next = node.getAttribute('aria-checked') !== 'true';
      if (role === 'radio') {
        node.parentElement?.querySelectorAll('[role="radio"]').forEach((other) => other.setAttribute('aria-checked', 'false'));
        node.setAttribute('aria-checked', 'true');
        onToggle(true);
      } else {
        node.setAttribute('aria-checked', String(next));
        onToggle(next);
      }
    },
  }, typeof label === 'string' ? null : label);
  return node;
}

function emojiPicker(current, onPick) {
  return el('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Icono del grupo' },
    GROUP_ICONS.map(([emoji, name, label]) => chip({
      label: icon(name),
      ariaLabel: label,
      className: 'chip icon-chip',
      selected: emoji === current,
      role: 'radio',
      onToggle: () => onPick(emoji),
    })));
}

function colorPicker(current, onPick) {
  return el('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Color del grupo' },
    GROUP_COLORS.map((color) => {
      const swatch = el('span', { class: 'swatch' });
      swatch.style.background = color.hex;
      return chip({
        label: swatch,
        ariaLabel: color.label,
        className: 'chip color-chip',
        selected: color.key === current,
        role: 'radio',
        onToggle: () => onPick(color.key),
      });
    }));
}

// Confirmación propia (hoja inferior) en lugar del diálogo gris del navegador.
// <dialog> nativo: atrapa el foco, se cierra con Escape y empieza enfocado en "Cancelar".
function confirmSheet({ title, message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'sheet', 'aria-labelledby': 'sheet-title' });
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.append(el('div', { class: 'sheet-body' },
      el('h2', { id: 'sheet-title', text: title }),
      message && el('p', { class: 'muted', text: message }),
      el('div', { class: 'sheet-actions' },
        el('button', { type: 'button', class: 'btn secondary', text: 'Cancelar', onClick: () => close(false) }),
        el('button', { type: 'button', class: danger ? 'btn danger' : 'btn primary', text: confirmLabel, onClick: () => close(true) }))));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(false);
    });
    // Tocar fuera de la hoja (el fondo) también cancela.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close(false);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// Apariencia: automático (sigue al sistema), claro u oscuro. Se guarda en este dispositivo.
const THEME_OPTIONS = [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']];

function themeIcon() {
  const theme = window.repartosTheme?.get() ?? 'auto';
  return icon(theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'contrast');
}

function appearanceSheet(button) {
  const dialog = el('dialog', { class: 'sheet', 'aria-labelledby': 'appearance-title' });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(el('div', { class: 'sheet-body' },
    el('h2', { id: 'appearance-title', text: 'Apariencia' }),
    el('p', { class: 'muted', text: 'Automático sigue el modo claro u oscuro del móvil.' }),
    segmented(THEME_OPTIONS, window.repartosTheme?.get() ?? 'auto', (value) => {
      window.repartosTheme?.set(value);
      button.replaceChildren(themeIcon());
    }, 'Apariencia'),
    el('button', { type: 'button', class: 'btn secondary block', text: 'Listo', onClick: close })));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  document.body.append(dialog);
  dialog.showModal();
}

function themeButton() {
  const button = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Apariencia: claro u oscuro' }, themeIcon());
  button.addEventListener('click', () => appearanceSheet(button));
  return button;
}

function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input, hint && el('span', { class: 'field-hint', text: hint }));
}

function mount(...nodes) {
  appEl.classList.remove('grouped');
  appEl.style.removeProperty('--g');
  appEl.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

// Pantallas de un grupo (el grupo, sus gastos, pagos y ajustes): su color pasa a ser el acento
// de botones, casillas y enlaces, y la barra superior va en ese color.
function mountGroup(group, ...nodes) {
  mount(...nodes);
  appEl.classList.add('grouped');
  tintWith(appEl, group);
}

function groupTopbar(group, { title, back, action }) {
  const bar = topbar({ title, back, action });
  bar.classList.add('tinted');
  if (!title || title === group.title) bar.querySelector('h1').prepend(icon(groupIconName(group), { small: true }));
  return bar;
}

function loading() {
  mount(el('p', { class: 'loading', text: 'Cargando…' }));
}

// ---------- Vistas ----------

async function groupsView() {
  const [{ groups: serverGroups, unreadActivity = 0 }, items] = await Promise.all([api('groups'), refreshPending()]);
  // Los pendientes de cada grupo ya cuentan en "te deben / debes".
  const groups = serverGroups.map((group) => (group.myBalanceCents === null ? group
    : { ...group, myBalanceCents: group.myBalanceCents + pendingDelta(items, group.id, session.person.id, group.baseCurrency) }));
  const active = groups.filter((group) => !group.archived);
  const archived = groups.filter((group) => group.archived);

  // Total de lo que te deben o debes en los grupos activos, por moneda.
  const totals = new Map();
  for (const group of active) {
    if (group.myBalanceCents) totals.set(group.baseCurrency, (totals.get(group.baseCurrency) || 0) + group.myBalanceCents);
  }
  const nonZero = [...totals].filter(([, cents]) => cents !== 0);
  const summary = active.length > 0 && el('div', { class: 'card hero' },
    el('div', { class: 'hero-top' },
      avatar(session.person.id, session.person.name, { large: true }),
      el('div', { class: 'hero-text' },
        nonZero.length
          ? nonZero.map(([currency, cents]) => el('span', { class: 'hero-line' },
            el('span', { class: 'label', text: cents > 0 ? 'En total te deben' : 'En total debes' }),
            el('strong', { class: `big ${cents > 0 ? 'positive' : 'negative'}`, text: formatMoney(Math.abs(cents), currency) })))
          : [el('span', { class: 'label', text: 'En todos tus grupos' }), el('strong', { class: 'big muted', text: 'Estás en paz' })])));

  // Cada grupo es una tarjeta de su color. Si el número de tarjetas (con "Nuevo") es impar,
  // la primera ocupa todo el ancho para que la cuadrícula quede completa.
  const featured = active.length > 0 && (active.length + 1) % 2 === 1;
  const tile = (group, index) => {
    const balance = balanceText(group.myBalanceCents, group.baseCurrency);
    return tintWith(el('a', { class: featured && index === 0 ? 'group-tile featured' : 'group-tile', href: `#/g/${group.id}` },
      el('span', { class: 'tile-top' },
        icon(groupIconName(group)),
        el('span', { class: 'tile-count', text: plural(group.memberCount, 'persona', 'personas') })),
      el('span', { class: 'tile-bottom' },
        el('strong', { class: 'tile-title', text: group.title }),
        el('span', { class: 'tile-balance' },
          el('span', { text: balance.label }),
          balance.amount && el('span', { class: 'num', text: balance.amount })))), group);
  };

  const row = (group) => {
    const balance = balanceText(group.myBalanceCents, group.baseCurrency);
    return el('a', { class: 'row group-row', href: `#/g/${group.id}` },
      groupIcon(group),
      el('span', { class: 'row-main' },
        el('strong', { text: group.title }),
        el('span', { class: 'meta', text: `${plural(group.memberCount, 'persona', 'personas')} · ${plural(group.expenseCount, 'gasto', 'gastos')}` })),
      balanceSide(balance));
  };

  mount(
    topbar({
      title: 'Repartos',
      action: el('span', { class: 'topbar-actions' },
        themeButton(),
        el('a', { class: 'icon-btn bell', href: '#/actividad', 'aria-label': unreadActivity ? `Actividad: ${unreadActivity} novedades` : 'Actividad' },
          icon('bell'),
          unreadActivity > 0 && el('span', { class: 'dot', text: unreadActivity > 9 ? '9+' : String(unreadActivity) })),
        el('a', { class: 'me-link', href: '#/personas', 'aria-label': 'Personas y saldos' }, avatar(session.person.id, session.person.name))),
    }),
    el('section', { class: 'content' },
      summary,
      active.length
        ? el('div', { class: 'group-grid' },
          active.map(tile),
          el('a', { class: 'group-tile new', href: '#/nuevo-grupo' }, icon('plus'), el('span', { text: 'Nuevo grupo' })))
        : el('div', { class: 'card empty' },
          el('h2', { text: 'Aún no hay grupos' }),
          el('p', { text: 'Crea uno para la pareja, un viaje o un finde con amigos.' })),
      archived.length > 0 && el('details', { class: 'archived' },
        el('summary', { text: `Archivados (${archived.length})` }),
        el('div', { class: 'card list' }, archived.map(row))),
      el('div', { class: 'home-links' },
        !active.length && el('a', { class: 'btn secondary', href: '#/nuevo-grupo' }, icon('plus', { small: true }), 'Nuevo grupo'),
        el('a', { class: 'btn secondary', href: '#/personas' }, icon('users', { small: true }), 'Personas'))),
    active.length
      ? el('a', { class: 'fab', href: '#/gasto' }, icon('plus'), 'Añadir gasto')
      : el('a', { class: 'fab', href: '#/nuevo-grupo' }, icon('plus'), 'Nuevo grupo'));
}

async function newGroupView() {
  const [{ people }, { groups }] = await Promise.all([api('people'), api('groups')]);
  const selected = new Map(); // key -> { personId } | { name }
  let emoji = GROUP_EMOJIS[0];
  // Se propone un color que aún no use ningún grupo.
  const used = new Set(groups.map((group) => groupColor(group).key));
  let color = (GROUP_COLORS.find((option) => !used.has(option.key)) ?? GROUP_COLORS[groups.length % GROUP_COLORS.length]).key;
  let baseCurrency = 'EUR';

  const title = el('input', { type: 'text', maxLength: 60, required: true, placeholder: 'Pareja, Japón 2027, Finde Cerdanya…', autocomplete: 'off' });
  const peopleChips = el('div', { class: 'chips' });
  const addPeople = (person) => {
    const key = `id:${person.id}`;
    peopleChips.append(chip({
      label: person.name,
      selected: false,
      onToggle: (on) => (on ? selected.set(key, { personId: person.id }) : selected.delete(key)),
    }));
  };
  people.filter((person) => person.id !== session.person.id).forEach(addPeople);

  const newName = el('input', { type: 'text', maxLength: 40, placeholder: 'Nombre', autocomplete: 'off' });
  const addNew = () => {
    const name = newName.value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    const existing = people.find((person) => person.name.toLowerCase() === name.toLowerCase());
    const key = existing ? `id:${existing.id}` : `name:${name.toLowerCase()}`;
    if (existing) {
      const node = [...peopleChips.children].find((child) => child.textContent === existing.name);
      if (node && node.getAttribute('aria-checked') !== 'true') node.click();
    } else if (!selected.has(key)) {
      selected.set(key, { name });
      peopleChips.append(chip({ label: name, selected: true, onToggle: (on) => (on ? selected.set(key, { name }) : selected.delete(key)) }));
    }
    newName.value = '';
    newName.focus();
    updatePreview();
  };
  newName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addNew();
    }
  });

  const previewIcon = el('span', { class: 'tile-icon' }, icon(groupIconName({ emoji })));
  const previewTitle = el('strong', { class: 'tile-title', text: 'Nuevo grupo' });
  const previewCount = el('span', { class: 'tile-count' });
  const preview = el('div', { class: 'group-tile featured tile-preview', 'aria-hidden': 'true' },
    el('span', { class: 'tile-top' }, previewIcon, previewCount),
    el('span', { class: 'tile-bottom' }, previewTitle, el('span', { class: 'tile-balance' }, el('span', { text: 'En paz' }))));
  const updatePreview = () => {
    previewTitle.textContent = title.value.trim() || 'Nuevo grupo';
    previewCount.textContent = plural(selected.size + 1, 'persona', 'personas');
    previewIcon.replaceChildren(icon(groupIconName({ emoji })));
    tintWith(preview, { color });
    tintWith(appEl, { color });
  };
  title.addEventListener('input', updatePreview);
  peopleChips.addEventListener('click', () => setTimeout(updatePreview));

  const submit = el('button', { class: 'btn primary', type: 'submit', text: 'Crear grupo' });
  const form = el('form', {
    class: 'content form',
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      if (!title.value.trim()) {
        title.focus();
        toast('Ponle un nombre al grupo.');
        return;
      }
      submit.disabled = true;
      try {
        const bundle = await api('groups', { method: 'POST', body: { title: title.value, emoji, color, baseCurrency, members: [...selected.values()] } });
        navigate(`#/g/${bundle.group.id}`, { replace: true });
      } catch (error) {
        handleError(error);
        submit.disabled = false;
      }
    },
  },
  preview,
  field('Nombre', title),
  field('Icono', emojiPicker(emoji, (value) => { emoji = value; updatePreview(); })),
  field('Color', colorPicker(color, (value) => { color = value; updatePreview(); })),
  field('Moneda de las cuentas', currencySelect(baseCurrency, (value) => { baseCurrency = value; }),
    'Los saldos se calculan en esta moneda. En un viaje puedes dejar euros y apuntar cada gasto en la moneda local.'),
  el('div', { class: 'field' },
    el('span', { class: 'field-label', text: 'Personas' }),
    el('span', { class: 'field-hint', text: `${session.person.name} ya está incluido. Toca para añadir.` }),
    peopleChips,
    el('div', { class: 'inline-form' }, newName, el('button', { type: 'button', class: 'btn secondary', text: 'Añadir', onClick: addNew }))),
  submit);

  mount(topbar({ title: 'Nuevo grupo', back: '#/' }), form);
  appEl.classList.add('grouped');
  updatePreview();
  title.focus();
}

function timeline(bundle, people, { emptyText } = {}) {
  const items = [
    ...bundle.expenses.map((expense) => ({ type: 'expense', date: expense.spentOn, createdAt: expense.createdAt, data: expense })),
    ...bundle.settlements.map((settlement) => ({ type: 'settlement', date: settlement.paidOn, createdAt: settlement.createdAt, data: settlement })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

  if (!items.length) {
    return emptyText
      ? el('div', { class: 'card empty' }, el('p', { text: emptyText }))
      : el('div', { class: 'card empty' },
        el('h2', { text: 'Sin gastos todavía' }),
        el('p', { text: 'Pulsa + para añadir el primero.' }));
  }

  const meId = session?.person.id ?? null;
  const editable = !bundle.group.archived && !SHARED_MODE;
  const cur = bundle.group.baseCurrency;
  const list = tintWith(el('div', { class: 'stack timeline' }), bundle.group);
  let currentDay = null;
  let dayCard = null;
  for (const item of items) {
    if (item.date !== currentDay) {
      currentDay = item.date;
      dayCard = el('div', { class: 'card list' });
      list.append(el('h3', { class: 'day', text: formatDay(item.date) }), dayCard);
    }
    if (item.data.pending) {
      const pending = item.data;
      dayCard.append(item.type === 'expense'
        ? pendingRow({ id: pending.id, title: pending.description, amountText: formatMoney(pending.originalMinor, pending.currency), payerId: pending.payerId, people, error: pending.error })
        : pendingRow({ id: pending.id, title: paymentText(people, pending.fromId, pending.toId, 'past'), amountText: formatMoney(pending.amountCents, cur), people, error: pending.error }));
      continue;
    }
    if (item.type === 'expense') {
      const expense = item.data;
      const myShare = expense.shares.find((share) => share.personId === meId)?.owedCents ?? 0;
      const myPaid = payersOf({ ...expense, baseCents: expense.amountCents }).find((payer) => payer.personId === meId)?.paidCents ?? 0;
      const net = myPaid - myShare;
      let impact = null;
      if (meId === null) impact = null;
      else if (net > 0) impact = { text: `prestaste ${formatMoney(net, cur)}`, tone: 'positive' };
      else if (net < 0) impact = { text: `debes ${formatMoney(-net, cur)}`, tone: 'negative' };
      else impact = { text: myShare || myPaid ? 'en paz' : 'no participas', tone: 'muted' };
      dayCard.append(el('a', {
        class: 'row',
        href: editable ? `#/g/${bundle.group.id}/gasto/${expense.id}` : undefined,
      },
      categoryTile(expense),
      el('span', { class: 'row-main' },
        el('strong', { text: expense.description }),
        el('span', { class: 'meta', text: `${payersText(expense, people, meId)} · ${splitSummary(expense, bundle.members.length)}` })),
      el('span', { class: 'row-side' },
        el('strong', { text: formatMoney(expense.originalMinor, expense.currency) }),
        expense.currency !== cur && el('span', { class: 'muted small num', text: `≈ ${formatMoney(expense.amountCents, cur)}` }),
        impact && el('span', { class: `small impact ${impact.tone}`, text: impact.text }))));
    } else {
      const settlement = item.data;
      dayCard.append(el('button', {
        type: 'button',
        class: 'row settlement',
        disabled: !editable,
        onClick: () => deleteSettlement(bundle, settlement, people),
      },
      el('span', { class: 'pay-icon' }, icon('swap', { small: true })),
      el('span', { class: 'row-main' },
        el('strong', { text: paymentText(people, settlement.fromId, settlement.toId, 'past') }),
        el('span', { class: 'meta', text: 'Pago' })),
      el('span', { class: 'row-side' }, el('strong', { text: formatMoney(settlement.amountCents, cur) }))));
    }
  }
  return list;
}

async function deleteSettlement(bundle, settlement, people) {
  const label = `${paymentText(people, settlement.fromId, settlement.toId, 'past')} ${formatMoney(settlement.amountCents, bundle.group.baseCurrency)}`;
  if (!(await confirmSheet({ title: '¿Borrar este pago?', message: label, confirmLabel: 'Borrar pago', danger: true }))) return;
  try {
    await api(`settlements/${settlement.id}`, { method: 'DELETE' });
    render();
    toast('Pago borrado', {
      label: 'Deshacer',
      onClick: async () => {
        await api(`settlements/${settlement.id}/restore`, { method: 'POST', body: {} });
        render();
      },
    });
  } catch (error) {
    handleError(error);
  }
}

function balancesPanel(bundle, people) {
  const groupId = bundle.group.id;
  const writable = !bundle.group.archived && !SHARED_MODE;
  const balances = [...bundle.balances].sort((a, b) => b.amountCents - a.amountCents);
  const cur = bundle.group.baseCurrency;

  return el('div', { class: 'stack' },
    el('div', { class: 'card list' },
      balances.map(({ personId, amountCents }) => el(SHARED_MODE ? 'div' : 'a', { class: 'row static', href: SHARED_MODE ? undefined : `#/p/${personId}` },
        avatar(personId, people.get(personId)?.name),
        el('span', { class: 'row-main' }, el('strong', { text: personName(people, personId) })),
        el('span', {
          class: `amount ${amountCents > 0 ? 'positive' : amountCents < 0 ? 'negative' : 'muted'}`,
          text: amountCents > 0 ? `+${formatMoney(amountCents, cur)}` : amountCents < 0 ? formatMoney(amountCents, cur) : 'En paz',
        })))),
    el('h2', { class: 'section-title', text: bundle.group.simplifyDebts ? 'Pagos sugeridos' : 'Deudas' }),
    bundle.transfers.length
      ? el('div', { class: 'card list' },
        bundle.transfers.map((transfer) => el('div', { class: 'row static' },
          avatar(transfer.fromId, people.get(transfer.fromId)?.name),
          el('span', { class: 'row-main' },
            el('strong', { text: paymentText(people, transfer.fromId, transfer.toId, 'present') }),
            writable
              ? el('a', {
                class: 'link-btn',
                href: `#/g/${groupId}/pago?from=${transfer.fromId}&to=${transfer.toId}&amount=${transfer.amountCents}`,
                text: 'Marcar como pagado',
              })
              : el('span', { class: 'meta', text: 'Pago sugerido' })),
          el('strong', { class: 'amount', text: formatMoney(transfer.amountCents, cur) }))))
      : el('div', { class: 'card empty' }, el('p', { text: 'Todo saldado.' })),
    writable && el('a', { class: 'btn ghost block', href: `#/g/${groupId}/pago`, text: 'Registrar otro pago' }));
}

// Cabecera del color del grupo: "Le debes a Judit 7,91 €", la balanza de saldos de cada persona
// (a la derecha a quien le deben, a la izquierda quien debe) y saldar a un toque.
function groupHeader(bundle, tab) {
  const meId = session.person.id;
  const cur = bundle.group.baseCurrency;
  const mine = bundle.myBalanceCents;
  const others = bundle.members.filter((member) => member.id !== meId);
  const partner = others.length === 1 && mine !== null ? others[0] : null;
  let label;
  if (mine === null) label = 'No participas en este grupo';
  else if (partner) label = mine > 0 ? `${partner.name} te debe` : mine < 0 ? `Le debes a ${partner.name}` : `Estás en paz con ${partner.name}`;
  else label = mine > 0 ? 'Te deben' : mine < 0 ? 'Debes' : 'Estás en paz';
  const settleUp = !bundle.group.archived && bundle.transfers.find((transfer) => transfer.fromId === meId || transfer.toId === meId);
  const base = `#/g/${bundle.group.id}`;

  const MAX_ROWS = 5;
  const balances = [...bundle.balances].filter((item) => item.amountCents !== 0)
    .sort((a, b) => b.amountCents - a.amountCents);
  const shown = balances.length > MAX_ROWS
    ? [...balances].sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents)).slice(0, MAX_ROWS).sort((a, b) => b.amountCents - a.amountCents)
    : balances;
  const largest = Math.max(1, ...shown.map((item) => Math.abs(item.amountCents)));
  const people = new Map(bundle.members.map((member) => [member.id, member]));
  const fill = (cents) => {
    const node = el('span');
    node.style.width = `${Math.max(4, Math.round((Math.abs(cents) / largest) * 100))}%`;
    return node;
  };
  const scale = shown.length > 0 && el('div', { class: 'scale', role: 'list', 'aria-label': 'Saldos del grupo' },
    shown.map(({ personId, amountCents }) => {
      const name = personId === meId ? 'Tú' : (people.get(personId)?.name ?? '¿?');
      const amount = `${amountCents > 0 ? '+' : '−'}${formatMoney(Math.abs(amountCents), cur)}`;
      return el('div', { class: 'scale-row', role: 'listitem', 'aria-label': `${name}: ${amountCents > 0 ? 'le deben' : 'debe'} ${formatMoney(Math.abs(amountCents), cur)}` },
        el('span', { class: 'scale-name', 'aria-hidden': 'true', text: name }),
        el('span', { class: 'scale-track', 'aria-hidden': 'true' },
          el('span', { class: 'scale-neg' }, amountCents < 0 && fill(amountCents)),
          el('span', { class: 'scale-axis' }),
          el('span', { class: 'scale-pos' }, amountCents > 0 && fill(amountCents))),
        el('span', { class: 'scale-amount', 'aria-hidden': 'true', text: amount }));
    }),
    balances.length > shown.length && el('span', { class: 'scale-more', text: `y ${plural(balances.length - shown.length, 'persona más', 'personas más')} en Saldos` }));

  return tintWith(el('div', { class: 'group-header' },
    el('span', { class: 'gh-label', text: label }),
    el('strong', { class: 'gh-amount', text: mine ? formatMoney(Math.abs(mine), cur) : 'Sin deudas' }),
    scale,
    el('div', { class: 'gh-actions' },
      settleUp && el('a', {
        class: 'gh-btn primary',
        href: `${base}/pago?from=${settleUp.fromId}&to=${settleUp.toId}&amount=${settleUp.amountCents}`,
        text: `Saldar ${formatMoney(settleUp.amountCents, cur)}`,
      }),
      tab === 'saldos'
        ? el('a', { class: 'gh-btn', href: base, text: 'Ver gastos' })
        : el('a', { class: 'gh-btn', href: `${base}/saldos`, text: 'Ver saldos' }))), bundle.group);
}

// Buscador sobre la lista de gastos: por descripción, categoría o quién pagó.
function searchableTimeline(bundle, people) {
  const cur = bundle.group.baseCurrency;
  if (bundle.expenses.length < 4) return timeline(bundle, people);
  const input = el('input', { type: 'search', class: 'search-input', placeholder: 'Buscar gastos', 'aria-label': 'Buscar gastos', autocomplete: 'off' });
  const results = el('div', { class: 'stack' });
  const matches = (expense, query) => normalizeSearch([
    expense.description,
    expense.category ? categoryOf(expense.category).label : '',
    ...payersOf({ ...expense, baseCents: expense.amountCents }).map((payer) => people.get(payer.personId)?.name ?? ''),
  ].join(' ')).includes(query);
  const update = () => {
    const query = normalizeSearch(input.value);
    if (!query) {
      results.replaceChildren(timeline(bundle, people));
      return;
    }
    const found = bundle.expenses.filter((expense) => matches(expense, query));
    const total = found.filter((expense) => !expense.error).reduce((sum, expense) => sum + expense.amountCents, 0);
    results.replaceChildren(
      el('p', { class: 'muted small', text: `${plural(found.length, 'gasto', 'gastos')} · ${formatMoney(total, cur)}` }),
      timeline({ ...bundle, expenses: found, settlements: [] }, people, { emptyText: 'Ningún gasto coincide con la búsqueda.' }));
  };
  input.addEventListener('input', update);
  update();
  return el('div', { class: 'stack' }, el('label', { class: 'search-box' }, icon('search', { small: true }), input), results);
}

// Cuánto ha costado el grupo o el viaje, quién pagó, a quién le corresponde y en qué se fue.
function summaryPanel(bundle, people) {
  const cur = bundle.group.baseCurrency;
  const expenses = bundle.expenses.filter((expense) => !expense.error);
  if (!expenses.length) return el('div', { class: 'card empty' }, el('p', { text: 'Aún no hay gastos que resumir.' }));

  const total = expenses.reduce((sum, expense) => sum + expense.amountCents, 0);
  const dates = expenses.map((expense) => expense.spentOn).sort();
  const days = Math.round((new Date(`${dates.at(-1)}T12:00:00`) - new Date(`${dates[0]}T12:00:00`)) / 86400000) + 1;
  const range = days === 1 ? formatDay(dates[0]) : `del ${dayYearFormat.format(new Date(`${dates[0]}T12:00:00`))} al ${dayYearFormat.format(new Date(`${dates.at(-1)}T12:00:00`))}`;

  const paid = new Map();
  const owed = new Map();
  const byCategory = new Map();
  for (const expense of expenses) {
    for (const payer of payersOf({ ...expense, baseCents: expense.amountCents })) paid.set(payer.personId, (paid.get(payer.personId) || 0) + payer.paidCents);
    for (const share of expense.shares) owed.set(share.personId, (owed.get(share.personId) || 0) + share.owedCents);
    const key = expense.category || 'other';
    byCategory.set(key, (byCategory.get(key) || 0) + expense.amountCents);
  }
  const bar = (value) => {
    const fill = el('span');
    fill.style.width = `${Math.max(2, Math.round((value / total) * 100))}%`;
    return el('span', { class: 'bar', 'aria-hidden': 'true' }, fill);
  };
  const percent = (value) => `${Math.round((value / total) * 100)} %`;

  return tintWith(el('div', { class: 'stack' },
    el('div', { class: 'card summary' },
      el('span', { class: 'muted small', text: 'Gasto total' }),
      el('strong', { class: 'big', text: formatMoney(total, cur) }),
      el('span', { class: 'muted small', text: [
        plural(expenses.length, 'gasto', 'gastos'),
        range,
        days > 1 ? `${formatMoney(Math.round(total / days), cur)} al día` : null,
      ].filter(Boolean).join(' · ') })),
    el('h2', { class: 'section-title', text: 'Por persona' }),
    el('div', { class: 'card list' },
      bundle.members
        .filter((member) => paid.get(member.id) || owed.get(member.id))
        .sort((a, b) => (owed.get(b.id) || 0) - (owed.get(a.id) || 0))
        .map((member) => el('div', { class: 'row static' },
          avatar(member.id, member.name),
          el('span', { class: 'row-main' },
            el('strong', { text: personName(people, member.id) }),
            el('span', { class: 'meta', text: `Pagó ${formatMoney(paid.get(member.id) || 0, cur)}` })),
          el('span', { class: 'row-side' },
            el('strong', { class: 'amount', text: formatMoney(owed.get(member.id) || 0, cur) }),
            el('span', { class: 'small muted', text: 'su parte' }))))),
    el('h2', { class: 'section-title', text: 'Por categoría' }),
    el('div', { class: 'card list' },
      [...byCategory].sort((a, b) => b[1] - a[1]).map(([key, value]) => el('div', { class: 'row static category-row' },
        el('span', { class: 'cat-tile small', 'aria-hidden': 'true' }, categoryIcon(key, { small: true })),
        el('span', { class: 'row-main' }, el('strong', { text: categoryOf(key).label }), bar(value)),
        el('span', { class: 'row-side' },
          el('strong', { class: 'amount', text: formatMoney(value, cur) }),
          el('span', { class: 'small muted', text: percent(value) })))))), bundle.group);
}

async function groupView(groupId, tab) {
  const [serverBundle, items] = await Promise.all([api(`groups/${groupId}`), refreshPending()]);
  const bundle = mergePending(serverBundle, items, session.person.id);
  rememberGroup(bundle.group.id);
  const people = new Map(bundle.members.map((person) => [person.id, person]));
  const base = `#/g/${groupId}`;

  const bar = groupTopbar(bundle.group, {
    title: bundle.group.title,
    back: '#/',
    action: el('a', { class: 'icon-btn', href: `${base}/ajustes`, 'aria-label': 'Ajustes del grupo' }, icon('settings')),
  });
  mountGroup(bundle.group,
    bar,
    el('section', { class: 'content' },
      groupHeader(bundle, tab),
      bundle.group.archived && el('div', { class: 'banner', text: 'Grupo archivado: solo lectura.' }),
      el('nav', { class: 'tabs', 'aria-label': 'Secciones del grupo' },
        [['gastos', 'Gastos', base], ['saldos', 'Saldos', `${base}/saldos`], ['resumen', 'Resumen', `${base}/resumen`]].map(([key, label, href]) =>
          el('a', { href, class: tab === key ? 'tab active' : 'tab', 'aria-current': tab === key ? 'page' : undefined, text: label }))),
      tab === 'saldos' ? balancesPanel(bundle, people)
        : tab === 'resumen' ? summaryPanel(bundle, people)
          : searchableTimeline(bundle, people)),
    !bundle.group.archived && tintWith(el('a', { class: 'fab tinted', href: `${base}/gasto` }, icon('plus'), 'Gasto'), bundle.group));
}

const SPLIT_MODES_UI = [
  ['equal', 'Iguales'],
  ['exact', 'Importes'],
  ['shares', 'Partes'],
];

function segmented(options, current, onPick, label) {
  const node = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  for (const [value, text] of options) {
    const button = el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(value === current),
      text,
      onClick: () => {
        node.querySelectorAll('button').forEach((other) => other.setAttribute('aria-checked', String(other === button)));
        onPick(value);
      },
    });
    node.append(button);
  }
  return node;
}

// Número de partes: se puede escribir (60/40) o ajustar con − y + (2/1/1).
function stepper(value, onChange, label) {
  let current = value;
  const input = el('input', {
    type: 'text',
    inputMode: 'numeric',
    class: 'stepper-value',
    value: String(value),
    'aria-label': `Partes de ${label}`,
    onInput: () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 4);
      current = Math.min(1000, Number(digits || 0));
      if (input.value !== digits) input.value = digits;
      onChange(current);
    },
    onBlur: () => { input.value = String(current); },
  });
  const set = (next) => {
    current = Math.max(0, Math.min(1000, next));
    input.value = String(current);
    onChange(current);
  };
  return el('div', { class: 'stepper' },
    el('button', { type: 'button', 'aria-label': `Menos partes para ${label}`, text: '−', onClick: () => set(current - 1) }),
    input,
    el('button', { type: 'button', 'aria-label': `Más partes para ${label}`, text: '+', onClick: () => set(current + 1) }));
}

function splitSummary(expense, memberCount) {
  if (expense.splitMode === 'exact') return 'importes a medida';
  if (expense.splitMode === 'shares') {
    return expense.shares.length <= 4 ? `por partes ${expense.shares.map((share) => share.inputValue).join('/')}` : 'por partes';
  }
  return expense.shares.length === memberCount ? 'entre todos' : `entre ${expense.shares.length}`;
}

// Lo escrito al cambiar de grupo desde el propio formulario (importe, descripción, moneda).
let expenseDraft = null;

function rememberGroup(groupId) {
  try {
    localStorage.setItem('repartos-last-group', String(groupId));
  } catch { /* sin almacenamiento: no pasa nada */ }
}

function lastGroupId() {
  try {
    return Number(localStorage.getItem('repartos-last-group')) || null;
  } catch {
    return null;
  }
}

// Chip compacto que abre un selector nativo: en el móvil sale la rueda o la lista del sistema.
function pickerChip({ leading, label, text, options, value, onChange, ariaLabel }) {
  const textNode = el('strong', { text });
  const leadingSlot = el('span', { class: 'picker-leading' }, leading);
  const select = el('select', {
    'aria-label': ariaLabel,
    onChange: () => onChange(select.value, { setText: (next) => { textNode.textContent = next; }, setLeading: (node) => leadingSlot.replaceChildren(node) }),
  }, options.map(([optionValue, optionLabel]) => el('option', { value: String(optionValue), text: optionLabel })));
  select.value = String(value);
  const node = el('span', { class: 'picker-chip' },
    leadingSlot,
    el('span', { class: 'picker-text' }, label && el('span', { class: 'picker-label', text: label }), textNode),
    icon('down', { small: true }),
    select);
  // Para cambiarlo sin que lo toque la persona (p. ej. la categoría sugerida al escribir).
  node.update = ({ value: next, text: nextText, leading: nextLeading }) => {
    select.value = String(next);
    textNode.textContent = nextText;
    leadingSlot.replaceChildren(nextLeading);
  };
  return node;
}

function categoryIcon(key, options) {
  return icon(key ? categoryOf(key).icon : 'tag', options);
}

// "Pagaste", "Pagó Judit" o, si pagaron varios, "Pagado por ti y Judit".
function payersText(expense, people, meId) {
  const payers = payersOf({ ...expense, baseCents: expense.amountCents });
  if (payers.length === 1) {
    return payers[0].personId === meId ? 'Pagaste' : `Pagó ${personName(people, payers[0].personId)}`;
  }
  const names = payers.map((payer) => (payer.personId === meId ? 'ti' : people.get(payer.personId)?.name ?? '¿?'));
  return `Pagado por ${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

function normalizeSearch(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Chip de fecha: muestra "Hoy", "Ayer" o "2 nov" y abre el calendario nativo.
function dateChip(input, onChange) {
  const textNode = el('strong', { text: formatDay(input.value) });
  input.classList.add('chip-overlay');
  input.addEventListener('click', () => input.showPicker?.());
  input.addEventListener('change', () => {
    if (!input.value) input.value = todayIso();
    textNode.textContent = formatDay(input.value);
    onChange();
  });
  return el('span', { class: 'picker-chip' },
    el('span', { class: 'picker-leading' }, icon('calendar', { small: true })),
    el('span', { class: 'picker-text' }, textNode),
    input);
}

async function expenseFormView(groupId, expenseId, query) {
  const [bundle, groupList] = await Promise.all([
    api(`groups/${groupId}`),
    expenseId ? null : api('groups'),
  ]);
  const editing = expenseId ? bundle.expenses.find((expense) => expense.id === expenseId) : null;
  if (expenseId && !editing) throw new Error('Este gasto ya no existe.');
  if (bundle.group.archived) throw new Error('El grupo está archivado.');
  rememberGroup(bundle.group.id);

  const fromHome = query?.get('desde') === 'inicio';
  const backHref = fromHome ? '#/' : `#/g/${groupId}`;
  const draft = editing ? null : expenseDraft;
  expenseDraft = null;

  const id = editing?.id ?? crypto.randomUUID();
  const members = bundle.members;
  const people = new Map(members.map((member) => [member.id, member]));
  const meId = session.person.id;
  const memberLabel = (member) => (member.id === meId ? `${member.name} (tú)` : member.name);
  let payerId = editing?.payerId ?? (people.has(meId) ? meId : members[0]?.id);

  // Moneda: la del grupo (base) o la del gasto. Los saldos siempre van en la del grupo.
  const base = bundle.group.baseCurrency;
  const baseExp = currencyExponent(base);
  let currency = editing?.currency ?? draft?.currency ?? lastCurrency(bundle) ?? base;
  const exp = () => currencyExponent(currency);
  // Origen del tipo escrito en el campo: BCE o a mano. Lo de la tarjeta va aparte, en cardInput.
  let fxSource = editing?.fxSource === 'manual' ? 'manual' : 'ecb';
  let fxDate = null;
  let fxRequest = 0;

  // Cada modo guarda su propio estado: cambiar de modo y volver no pierde lo escrito.
  const defaultSplit = new Map((bundle.group.defaultSplit || []).map((entry) => [entry.personId, entry.weight]));
  const editedShare = (personId) => editing?.shares.find((share) => share.personId === personId);
  let mode = editing?.splitMode ?? (bundle.group.defaultSplit ? 'shares' : 'equal');
  const participants = new Set(editing ? editing.shares.map((share) => share.personId) : members.map((member) => member.id));
  const exactInputs = new Map(members.map((member) => [member.id,
    editing?.splitMode === 'exact' && editedShare(member.id) ? centsToInput(editedShare(member.id).inputValue, exp()) : '']));
  const weights = new Map(members.map((member) => {
    if (editing?.splitMode === 'shares') return [member.id, editedShare(member.id)?.inputValue ?? 0];
    if (bundle.group.defaultSplit) return [member.id, defaultSplit.get(member.id) ?? 0];
    return [member.id, participants.has(member.id) ? 1 : 0];
  }));

  // Varios pagadores: lo que puso cada uno, como texto en la moneda del gasto.
  let multiPayers = (editing?.payers?.length ?? 0) > 1;
  const payerInputs = new Map(members.map((member) => {
    const paid = multiPayers ? editing.payers.find((payer) => payer.personId === member.id) : null;
    return [member.id, paid ? centsToInput(paid.inputValue, exp()) : ''];
  }));
  let category = editing ? editing.category : guessCategory(draft?.description ?? '');
  let categoryTouched = Boolean(editing);

  const amount = el('input', {
    type: 'text', inputMode: 'decimal', placeholder: '0,00', autocomplete: 'off', class: 'amount-input', 'aria-label': 'Importe',
    value: editing ? centsToInput(editing.originalMinor, exp()) : draft?.amount ?? '',
  });
  const description = el('input', {
    type: 'text', maxLength: 120, placeholder: '¿En qué? Cena, gasolina, súper…', autocomplete: 'off', 'aria-label': 'Descripción',
    value: editing?.description ?? draft?.description ?? '',
  });
  // Al cambiar de moneda se conserva la cifra escrita (3.500 sigue siendo 3.500), adaptada a los
  // decimales de la nueva; lo que depende de la moneda anterior (tarjeta y tipo) se vuelve a pedir.
  const currencyInput = currencySelect(currency, (value) => {
    const previousExp = exp();
    currency = value;
    const reformat = (text) => {
      const parsed = parseAmount(text, previousExp);
      if (parsed === null) return text;
      const units = parsed / 10 ** previousExp;
      return Number.isInteger(units * 10 ** exp()) ? centsToInput(Math.round(units * 10 ** exp()), exp()) : text;
    };
    amount.value = reformat(amount.value);
    for (const [personId, text] of exactInputs) exactInputs.set(personId, text.trim() ? reformat(text) : text);
    for (const [personId, text] of payerInputs) payerInputs.set(personId, text.trim() ? reformat(text) : text);
    renderPayers();
    cardInput.value = '';
    rateInput.value = '';
    fxSource = 'ecb';
    fxDate = null;
    renderFx();
    renderSplitBody();
    refreshRate();
  });
  const date = el('input', { type: 'date', value: editing?.spentOn ?? todayIso(), max: '2100-12-31', 'aria-label': 'Fecha' });
  const rateInput = el('input', { type: 'text', inputMode: 'decimal', autocomplete: 'off', class: 'rate-input', value: editing?.fxRate ?? '' });
  const cardInput = el('input', {
    type: 'text', inputMode: 'decimal', autocomplete: 'off', placeholder: 'Opcional',
    value: editing?.fxSource === 'card' ? centsToInput(editing.amountCents, baseExp) : '',
  });
  const fxBox = el('div', { class: 'card stack fx-box' });
  const payersBox = el('div', { class: 'card stack payers-box' });
  const payersStatus = el('p', { class: 'exact-status', role: 'status' });

  function currentPayers() {
    const entries = [];
    for (const member of members) {
      const value = payerInputs.get(member.id).trim();
      if (!value) continue;
      const parsed = parseAmount(value, exp());
      if (parsed === null) return { error: `Importe no válido para ${member.name}.` };
      if (parsed > 0) entries.push({ personId: member.id, value: parsed });
    }
    return entries.length ? { entries } : { error: 'Escribe cuánto puso al menos una persona.' };
  }

  function updatePayersStatus() {
    payersStatus.textContent = '';
    payersStatus.className = 'exact-status';
    if (!multiPayers) return;
    const original = originalTotal();
    const paid = (currentPayers().entries || []).reduce((sum, entry) => sum + entry.value, 0);
    if (!original) return;
    const diff = original - paid;
    payersStatus.textContent = diff === 0
      ? `Pagado ${formatMoney(paid, currency)} de ${formatMoney(original, currency)} ✓`
      : `Pagado ${formatMoney(paid, currency)} de ${formatMoney(original, currency)} · ${diff > 0 ? 'faltan' : 'sobran'} ${formatMoney(Math.abs(diff), currency)}`;
    payersStatus.classList.add(diff === 0 ? 'ok' : 'pending');
  }

  function renderPayers() {
    payersBox.hidden = !multiPayers;
    payersBox.replaceChildren();
    if (!multiPayers) return;
    payersBox.append(
      el('span', { class: 'field-label', text: `Cuánto puso cada uno (${currencySymbol(currency)})` }),
      el('div', { class: 'list' },
        members.map((member) => {
          const input = el('input', {
            type: 'text', inputMode: 'decimal', autocomplete: 'off', class: 'share-input',
            placeholder: exp() === 0 ? '0' : '0,00', value: payerInputs.get(member.id), 'aria-label': `Lo que pagó ${member.name}`,
            onInput: () => {
              payerInputs.set(member.id, input.value);
              updatePayersStatus();
            },
          });
          return el('label', { class: 'row static' }, avatar(member.id, member.name), el('span', { class: 'row-main', text: memberLabel(member) }), input);
        })),
      payersStatus);
    updatePayersStatus();
  }
  const fxHint = el('span', { class: 'field-hint' });
  const fxUnit = el('span', { class: 'fx-unit' });
  const converted = el('strong', { class: 'converted' });
  const splitBody = el('div', { class: 'stack' });
  const shareLabels = new Map(); // personId -> nodo donde se pinta lo que le toca
  const status = el('p', { class: 'form-status', role: 'status' });
  const exactStatus = el('p', { class: 'exact-status', role: 'status' });

  const originalTotal = () => parseAmount(amount.value, exp());

  // Importe en la moneda del grupo: igual, por tipo de cambio o lo que cobró la tarjeta.
  function baseTotal() {
    const original = originalTotal();
    if (!original) return null;
    if (currency === base) return original;
    if (cardInput.value.trim()) return parseAmount(cardInput.value, baseExp);
    const rate = parseRate(rateInput.value);
    if (!rate) return null;
    const value = convertMinor(original, rate, exp(), baseExp);
    return value > 0 ? value : null;
  }

  function renderFx() {
    fxBox.hidden = currency === base;
    fxUnit.textContent = `1 ${currency} =`;
    amount.placeholder = exp() === 0 ? '0' : '0,00';
    updateConverted();
  }

  function updateConverted() {
    if (currency === base) return;
    const total = baseTotal();
    converted.textContent = total ? `≈ ${formatMoney(total, base)}` : '';
    if (cardInput.value.trim()) fxHint.textContent = 'Se usará lo que cobró la tarjeta.';
    else if (fxSource === 'ecb' && fxDate) fxHint.textContent = `Tipo del BCE del ${dayYearFormat.format(new Date(`${fxDate}T12:00:00`))}. Puedes cambiarlo.`;
    else if (fxSource === 'ecb' && editing?.fxSource === 'ecb' && rateInput.value) fxHint.textContent = 'Tipo del BCE guardado con el gasto.';
    else if (fxSource === 'manual') fxHint.textContent = 'Tipo escrito a mano.';
  }

  async function refreshRate() {
    if (currency === base || fxSource === 'manual') return;
    const request = ++fxRequest;
    const asked = { currency, date: date.value || todayIso() };
    const stale = () => request !== fxRequest || asked.currency !== currency || asked.date !== (date.value || todayIso());
    fxHint.textContent = 'Consultando el tipo de cambio…';
    try {
      const result = await api(`fx?from=${asked.currency}&to=${base}&date=${asked.date}`);
      if (stale()) return;
      rateInput.value = result.rate.replace('.', ',');
      fxSource = 'ecb';
      fxDate = result.date;
    } catch (error) {
      if (error instanceof SessionExpiredError) return handleError(error);
      if (stale()) return;
      fxSource = 'manual';
      fxDate = null;
      fxHint.textContent = error.message;
      rateInput.focus();
    }
    updateConverted();
    updatePreview();
  }

  rateInput.addEventListener('input', () => {
    fxRequest += 1; // descarta cualquier consulta al BCE en curso
    fxSource = 'manual';
    fxDate = null;
    updateConverted();
    updatePreview();
  });
  cardInput.addEventListener('input', () => {
    // Si se borra lo de la tarjeta y no hay tipo escrito, se pide el del BCE.
    if (!cardInput.value.trim() && !parseRate(rateInput.value)) refreshRate();
    updateConverted();
    updatePreview();
  });

  // "Me cobraron" va plegado: solo hace falta cuando el banco cobró otra cantidad.
  const cardField = el('label', { class: 'field', hidden: !cardInput.value },
    el('span', { class: 'field-label', text: `Me cobraron (${currencySymbol(base)})` }),
    cardInput,
    el('span', { class: 'field-hint', text: 'Se usará esto en lugar del tipo de cambio.' }));
  const cardToggle = el('button', {
    type: 'button',
    class: 'link-btn',
    hidden: Boolean(cardInput.value),
    text: '¿El banco te cobró otra cantidad?',
    onClick: () => {
      cardField.hidden = false;
      cardToggle.hidden = true;
      cardInput.focus();
    },
  });
  fxBox.append(
    el('div', { class: 'fx-row' },
      el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'Tipo de cambio' }),
        el('span', { class: 'fx-rate' }, fxUnit, rateInput, el('span', { class: 'fx-unit', text: base }))),
      converted),
    fxHint,
    cardField,
    cardToggle);

  // Devuelve { entries } listo para la API, o { error } con un mensaje para la persona.
  function currentEntries() {
    if (mode === 'equal') {
      if (!participants.size) return { error: 'Elige al menos una persona.' };
      return { entries: [...participants].map((personId) => ({ personId })) };
    }
    if (mode === 'shares') {
      const entries = members.map((member) => ({ personId: member.id, value: weights.get(member.id) })).filter((entry) => entry.value > 0);
      return entries.length ? { entries } : { error: 'Pon al menos una parte a alguien.' };
    }
    const entries = [];
    for (const member of members) {
      const text = exactInputs.get(member.id).trim();
      if (!text) continue;
      const value = parseAmount(text, exp());
      if (value === null) return { error: `Importe no válido para ${member.name}.` };
      if (value > 0) entries.push({ personId: member.id, value });
    }
    return entries.length ? { entries } : { error: 'Escribe el importe de al menos una persona.' };
  }

  // Pinta junto a cada persona lo que le toca (en la moneda del grupo) y el botón de guardar.
  function updatePreview() {
    status.textContent = '';
    exactStatus.textContent = '';
    exactStatus.className = 'exact-status';
    for (const label of shareLabels.values()) label.textContent = '';
    const original = originalTotal();
    const total = baseTotal();
    submit.textContent = `${editing ? 'Guardar cambios' : 'Añadir gasto'}${original ? ` · ${formatMoney(original, currency)}` : ''}`;
    const { entries, error } = currentEntries();
    if (!original && amount.value.trim()) {
      status.textContent = exp() === 0 ? `Importe no válido: ${currency} no usa decimales.` : 'Importe no válido.';
      return;
    }

    if (mode === 'exact') {
      const assigned = (entries || []).reduce((sum, entry) => sum + entry.value, 0);
      if (original) {
        const diff = original - assigned;
        exactStatus.textContent = diff === 0
          ? `Asignado ${formatMoney(assigned, currency)} de ${formatMoney(original, currency)} ✓`
          : `Asignado ${formatMoney(assigned, currency)} de ${formatMoney(original, currency)} · ${diff > 0 ? 'faltan' : 'sobran'} ${formatMoney(Math.abs(diff), currency)}`;
        exactStatus.classList.add(diff === 0 ? 'ok' : 'pending');
      }
      if (error && assigned > 0) status.textContent = error;
      // En la moneda del grupo el importe ya está en cada casilla; en otra se enseña el equivalente.
      if (error || !total || assigned !== original || currency === base) return;
    }
    if (error) {
      status.textContent = error;
      return;
    }
    if (!total) return;
    try {
      for (const share of computeShares({ totalCents: total, mode, entries, seed: id, originalTotal: original })) {
        const label = shareLabels.get(share.personId);
        if (label) label.textContent = `${mode === 'exact' ? '≈ ' : ''}${formatMoney(share.owedCents, base)}`;
      }
    } catch (splitError) {
      if (splitError instanceof SplitError) status.textContent = splitError.message;
      else throw splitError;
    }
  }

  // "Repartir lo que falta": la propina o lo compartido, a partes iguales entre quienes ya
  // tienen importe (o entre todos si nadie lo tiene todavía).
  function fillRemaining() {
    const total = originalTotal();
    if (!total) return toast('Escribe primero el importe total.');
    const { entries, error } = currentEntries();
    if (error && (entries || []).length) return toast(error);
    const assigned = (entries || []).reduce((sum, entry) => sum + entry.value, 0);
    const remaining = total - assigned;
    if (remaining <= 0) return toast(remaining === 0 ? 'Ya está todo repartido.' : 'Los importes ya superan el total.');
    const targets = entries?.length ? entries.map((entry) => entry.personId) : members.map((member) => member.id);
    const extra = allocate(remaining, targets.map(() => 1), id);
    targets.forEach((personId, index) => {
      const current = parseAmount(exactInputs.get(personId), exp()) || 0;
      exactInputs.set(personId, centsToInput(current + extra[index], exp()));
    });
    renderSplitBody();
  }

  // Una sola lista de personas: cada fila es quién participa y cuánto le toca.
  function personRow(member, control, { tag = 'div', meta } = {}) {
    const share = el('span', { class: 'share-amount' });
    shareLabels.set(member.id, share);
    return el(tag, { class: 'row static person-row' },
      avatar(member.id, member.name),
      el('span', { class: 'row-main' },
        el('strong', { text: memberLabel(member) }),
        meta),
      mode === 'equal' ? share : el('span', { class: 'row-side' }, control, mode === 'shares' || currency !== base ? share : null));
  }

  function renderSplitBody() {
    splitBody.replaceChildren();
    shareLabels.clear();
    if (mode === 'equal') {
      const rows = members.map((member) => {
        const check = el('input', {
          type: 'checkbox',
          class: 'check',
          checked: participants.has(member.id),
          'aria-label': `${member.name} participa`,
          onChange: () => {
            if (check.checked) participants.add(member.id);
            else participants.delete(member.id);
            row.classList.toggle('off', !check.checked);
            updatePreview();
          },
        });
        const row = personRow(member, null, { tag: 'label' });
        row.prepend(check);
        row.classList.toggle('off', !participants.has(member.id));
        return row;
      });
      splitBody.append(
        el('div', { class: 'card list' }, rows),
        el('div', { class: 'field-row' },
          el('span', { class: 'field-hint', text: 'Desmarca a quien no participa.' }),
          el('button', {
            type: 'button',
            class: 'link-btn',
            text: participants.size === members.length ? 'Ninguno' : 'Todos',
            onClick: () => {
              const selectAll = participants.size !== members.length;
              for (const member of members) {
                if (selectAll) participants.add(member.id);
                else participants.delete(member.id);
              }
              renderSplitBody();
            },
          })));
    } else if (mode === 'exact') {
      splitBody.append(
        el('div', { class: 'card list' },
          members.map((member) => {
            const input = el('input', {
              type: 'text',
              inputMode: 'decimal',
              placeholder: exp() === 0 ? '0' : '0,00',
              autocomplete: 'off',
              class: 'share-input',
              value: exactInputs.get(member.id),
              'aria-label': `Importe de ${member.name}`,
              onInput: () => {
                exactInputs.set(member.id, input.value);
                updatePreview();
              },
            });
            return personRow(member, input, { tag: 'label' });
          })),
        exactStatus,
        el('span', { class: 'field-hint', text: `Lo que le toca a cada uno, en ${currencySymbol(currency)}. Vacío = no participa.` }),
        el('button', { type: 'button', class: 'btn secondary block', text: 'Repartir lo que falta a partes iguales', onClick: fillRemaining }));
    } else {
      splitBody.append(
        el('div', { class: 'card list' },
          members.map((member) => personRow(member, stepper(weights.get(member.id), (value) => {
            weights.set(member.id, value);
            updatePreview();
          }, member.name)))),
        el('span', { class: 'field-hint', text: 'Por ejemplo 60 y 40, o 2 y 1 si alguien cuenta doble. 0 = no participa.' }));
    }
    updatePreview();
  }

  amount.addEventListener('input', () => {
    updateConverted();
    updatePreview();
    updatePayersStatus();
  });

  // Fila de chips: grupo (al crear), quién pagó y fecha.
  // Quién pagó: una persona o "Varias personas" (con lo que puso cada una, en la moneda del gasto).
  const payerChip = pickerChip({
    leading: multiPayers ? icon('users', { small: true }) : avatar(payerId, people.get(payerId)?.name),
    label: 'Pagó',
    text: multiPayers ? 'Varias personas' : memberLabel(people.get(payerId)),
    options: [...members.map((member) => [member.id, memberLabel(member)]), ['multi', 'Varias personas…']],
    value: multiPayers ? 'multi' : payerId,
    ariaLabel: 'Quién pagó',
    onChange: (value, { setText, setLeading }) => {
      multiPayers = value === 'multi';
      if (multiPayers) {
        setText('Varias personas');
        setLeading(icon('users', { small: true }));
      } else {
        payerId = Number(value);
        setText(memberLabel(people.get(payerId)));
        setLeading(avatar(payerId, people.get(payerId)?.name));
      }
      renderPayers();
    },
  });

  // Categoría: se sugiere sola por la descripción hasta que la persona elige una.
  const categoryChip = pickerChip({
    leading: categoryIcon(category, { small: true }),
    label: 'Categoría',
    text: category ? categoryOf(category).label : 'Sin categoría',
    options: [['', 'Sin categoría'], ...CATEGORIES.map((item) => [item.key, item.label])],
    value: category ?? '',
    ariaLabel: 'Categoría',
    onChange: (value, { setText, setLeading }) => {
      category = value || null;
      categoryTouched = true;
      setText(category ? categoryOf(category).label : 'Sin categoría');
      setLeading(categoryIcon(category, { small: true }));
    },
  });
  description.addEventListener('input', () => {
    if (categoryTouched) return;
    const guess = guessCategory(description.value);
    if (guess === category) return;
    category = guess;
    categoryChip.update({ value: category ?? '', text: category ? categoryOf(category).label : 'Sin categoría', leading: categoryIcon(category, { small: true }) });
  });
  const activeGroups = groupList?.groups.filter((group) => !group.archived) ?? [];
  const groupChip = activeGroups.length > 1 && pickerChip({
    leading: groupIcon(bundle.group),
    label: 'Grupo',
    text: bundle.group.title,
    options: activeGroups.map((group) => [group.id, group.title]),
    value: bundle.group.id,
    ariaLabel: 'Grupo',
    onChange: (value) => {
      expenseDraft = { amount: amount.value, description: description.value, currency };
      navigate(`#/g/${value}/gasto${fromHome ? '?desde=inicio' : ''}`, { replace: true });
    },
  });

  const submit = el('button', { class: 'btn primary', type: 'submit', text: editing ? 'Guardar cambios' : 'Añadir gasto' });
  const form = el('form', {
    class: 'content form expense-form',
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      const original = originalTotal();
      if (!original) return (amount.focus(), toast('Escribe el importe.'));
      if (!description.value.trim()) return (description.focus(), toast('Falta la descripción.'));
      const { entries, error } = currentEntries();
      if (error) return toast(error);
      if (mode === 'exact') {
        const assigned = entries.reduce((sum, entry) => sum + entry.value, 0);
        if (assigned !== original) return toast(`Los importes suman ${formatMoney(assigned, currency)} y el gasto es de ${formatMoney(original, currency)}.`);
      }
      let payerEntries = null;
      if (multiPayers) {
        const result = currentPayers();
        if (result.error) return toast(result.error);
        const paidTotal = result.entries.reduce((sum, entry) => sum + entry.value, 0);
        if (paidTotal !== original) return toast(`Lo que pagó cada uno suma ${formatMoney(paidTotal, currency)} y el gasto es de ${formatMoney(original, currency)}.`);
        payerEntries = result.entries;
      }
      const body = { id, description: description.value, payerId, spentOn: date.value, splitMode: mode, shares: entries, currency, category };
      if (payerEntries) {
        body.payers = payerEntries;
        body.payerId = payerEntries.reduce((best, entry) => (entry.value > best.value ? entry : best)).personId;
      }
      if (currency === base) {
        body.amountCents = original;
      } else {
        body.originalMinor = original;
        if (cardInput.value.trim()) {
          const card = parseAmount(cardInput.value, baseExp);
          if (!card) return (cardInput.focus(), toast('Importe cobrado no válido.'));
          Object.assign(body, { fxSource: 'card', amountCents: card });
        } else {
          const rate = parseRate(rateInput.value);
          if (!rate) return (rateInput.focus(), toast('Escribe el tipo de cambio.'));
          Object.assign(body, { fxSource, fxRate: rate });
        }
      }
      submit.disabled = true;
      try {
        if (editing) {
          await api(`expenses/${id}`, { method: 'PUT', body: { ...body, version: editing.version } });
          navigate(`#/g/${groupId}`, { replace: true });
          toast('Gasto actualizado');
          return;
        }
        // Un gasto nuevo se guarda primero en el móvil: sin red se enviará solo más tarde.
        const total = baseTotal();
        const payersDto = computePayers({ totalCents: total, originalTotal: original, entries: payerEntries ?? [{ personId: payerId, value: original }], seed: id });
        const result = await createWithOutbox({
          id,
          kind: 'expense',
          groupId: bundle.group.id,
          baseCurrency: base,
          path: `groups/${groupId}/expenses`,
          body,
          expense: {
            id,
            groupId: bundle.group.id,
            description: body.description.trim(),
            spentOn: body.spentOn,
            payerId: mainPayer(payersDto),
            payers: payersDto,
            category,
            amountCents: total,
            originalMinor: original,
            currency,
            splitMode: mode,
            shares: computeShares({ totalCents: total, mode, entries, seed: id, originalTotal: original }),
            createdAt: new Date().toISOString(),
          },
        });
        navigate(`#/g/${groupId}`, { replace: true });
        toast(result === 'queued' ? 'Sin conexión: guardado en el móvil. Se enviará solo.' : 'Gasto añadido');
      } catch (requestError) {
        submit.disabled = false;
        if (requestError.status === 409 && requestError.data?.expense) {
          toast('Otro dispositivo cambió este gasto. Se ha recargado.');
          render();
          return;
        }
        handleError(requestError);
      }
    },
  },
  el('div', { class: 'form-hero' },
    el('span', { class: 'gh-label', text: editing ? `${bundle.group.title} · editar gasto` : `${bundle.group.title} · ¿cuánto ha sido?` }),
    el('div', { class: 'amount-row' }, amount, currencyInput)),
  description,
  el('div', { class: 'chips' }, groupChip, payerChip, dateChip(date, () => refreshRate()), categoryChip),
  payersBox,
  fxBox,
  el('div', { class: 'field' },
    el('span', { class: 'field-label', text: 'Para quién' }),
    segmented(SPLIT_MODES_UI, mode, (value) => {
      mode = value;
      renderSplitBody();
    }, 'Cómo se reparte'),
    splitBody),
  status,
  editing && authorLine(editing, people),
  editing && el('button', {
    type: 'button',
    class: 'btn danger-ghost block',
    text: 'Borrar gasto',
    onClick: async () => {
      if (!(await confirmSheet({ title: `¿Borrar «${editing.description}»?`, message: 'Podrás deshacerlo justo después.', confirmLabel: 'Borrar gasto', danger: true }))) return;
      try {
        await api(`expenses/${id}`, { method: 'DELETE', body: { version: editing.version } });
        navigate(`#/g/${groupId}`, { replace: true });
        toast('Gasto borrado', {
          label: 'Deshacer',
          onClick: async () => {
            await api(`expenses/${id}/restore`, { method: 'POST', body: {} });
            render();
          },
        });
      } catch (error) {
        handleError(error);
      }
    },
  }),
  // Guardar siempre a la vista, con el importe: sin tener que bajar hasta el final.
  el('div', { class: 'action-bar' }, submit));

  mountGroup(bundle.group, groupTopbar(bundle.group, { title: editing ? 'Editar gasto' : 'Nuevo gasto', back: backHref }), form);
  renderFx();
  renderSplitBody();
  renderPayers();
  // Gasto nuevo en moneda extranjera: se pide ya el tipo del día.
  if (!editing) {
    refreshRate();
    amount.focus();
  }
}

// "Añadido por Judit · editado por Xavi" al pie del formulario de edición.
function authorLine(expense, people) {
  const name = (id) => (id === session.person.id ? 'ti' : people.get(id)?.name);
  const parts = [];
  if (expense.createdBy && name(expense.createdBy)) parts.push(`Añadido por ${name(expense.createdBy)}`);
  if (expense.updatedBy && name(expense.updatedBy)) parts.push(`editado por ${name(expense.updatedBy)}`);
  return parts.length ? el('p', { class: 'muted small author-line', text: parts.join(' · ') }) : null;
}

// ---------- Actividad ----------

const CHANGE_LABELS = { description: 'descripción', amount: 'importe', payers: 'quién pagó', date: 'fecha', split: 'reparto', category: 'categoría' };

// Frase de un elemento de actividad, desde el punto de vista de quien la lee.
function activityText(item) {
  const meId = session.person.id;
  const mine = item.actorId === meId;
  const actor = mine ? 'Tú' : item.actorName ?? 'Alguien';
  const verb = (third, second) => (mine ? second : third);
  const data = item.data ?? {};
  const name = (id, fallback) => (id === meId ? 'ti' : fallback ?? '¿?');
  const desc = `«${data.description ?? '…'}»`;
  switch (item.kind) {
    case 'expense_created': return `${actor} ${verb('añadió', 'añadiste')} ${desc}`;
    case 'expense_updated': {
      const changes = (data.changes ?? []).map((key) => CHANGE_LABELS[key]).filter(Boolean);
      return `${actor} ${verb('editó', 'editaste')} ${desc}${changes.length ? ` (${changes.join(', ')})` : ''}`;
    }
    case 'expense_deleted': return `${actor} ${verb('borró', 'borraste')} ${desc}`;
    case 'expense_restored': return `${actor} ${verb('recuperó', 'recuperaste')} ${desc}`;
    case 'settlement_created':
      if (data.toId === meId) return `${data.fromName} te pagó`;
      if (data.fromId === meId) return `Pagaste a ${data.toName}`;
      return `${data.fromName} pagó a ${data.toName}`;
    case 'settlement_deleted': return `${actor} ${verb('borró', 'borraste')} un pago de ${name(data.fromId, data.fromName)} a ${name(data.toId, data.toName)}`;
    case 'settlement_restored': return `${actor} ${verb('recuperó', 'recuperaste')} un pago de ${name(data.fromId, data.fromName)} a ${name(data.toId, data.toName)}`;
    case 'member_added': return `${actor} ${verb('añadió', 'añadiste')} a ${data.name} al grupo`;
    case 'member_removed': return `${actor} ${verb('quitó', 'quitaste')} a ${data.name} del grupo`;
    case 'group_created': return `${actor} ${verb('creó', 'creaste')} el grupo`;
    case 'group_renamed': return `${actor} ${verb('cambió', 'cambiaste')} el nombre a «${data.title}»`;
    case 'group_currency': return `${actor} ${verb('cambió', 'cambiaste')} la moneda a ${data.currency}`;
    case 'group_default_split': return `${actor} ${verb('cambió', 'cambiaste')} el reparto por defecto`;
    case 'group_archived': return `${actor} ${verb('archivó', 'archivaste')} el grupo`;
    case 'group_unarchived': return `${actor} ${verb('desarchivó', 'desarchivaste')} el grupo`;
    default: return `${actor} ${verb('hizo un cambio', 'hiciste un cambio')}`;
  }
}

function activityAmount(item) {
  const data = item.data ?? {};
  if (item.kind.startsWith('expense_')) {
    return data.originalCurrency && data.originalCurrency !== data.currency
      ? formatMoney(data.originalMinor, data.originalCurrency)
      : formatMoney(data.amountCents ?? 0, data.currency ?? item.groupCurrency);
  }
  if (item.kind.startsWith('settlement_')) return formatMoney(data.amountCents ?? 0, data.currency ?? item.groupCurrency);
  return null;
}

const timeFormat = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

function activityRow(item, lastSeenId) {
  const unread = item.id > lastSeenId && item.actorId !== session.person.id;
  const when = new Date(`${item.createdAt.replace(' ', 'T')}Z`);
  const amountText = activityAmount(item);
  const isExpense = item.kind.startsWith('expense_') && item.kind !== 'expense_deleted';
  const href = isExpense ? `#/g/${item.groupId}/gasto/${item.subjectId}` : `#/g/${item.groupId}`;
  return el('a', { class: `row activity-row${unread ? ' unread' : ''}`, href },
    item.actorId ? avatar(item.actorId, item.actorName) : groupIcon({ id: item.groupId, emoji: item.groupEmoji, color: item.groupColor }),
    el('span', { class: 'row-main' },
      el('strong', { class: 'wrap', text: activityText(item) }),
      el('span', { class: 'meta', text: `${item.groupTitle} · ${timeFormat.format(when)}` })),
    amountText && el('span', { class: 'row-side' }, el('strong', { text: amountText })),
    unread && el('span', { class: 'unread-dot', 'aria-label': 'Nuevo' }));
}

async function activityView() {
  const first = await api('activity');
  const lastSeenId = first.lastSeenId;
  const list = el('div', { class: 'stack' });
  let currentDay = null;
  let dayCard = null;
  const append = (items) => {
    for (const item of items) {
      const day = new Date(`${item.createdAt.replace(' ', 'T')}Z`);
      const iso = new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      if (iso !== currentDay) {
        currentDay = iso;
        dayCard = el('div', { class: 'card list' });
        list.append(el('h3', { class: 'day', text: formatDay(iso) }), dayCard);
      }
      dayCard.append(activityRow(item, lastSeenId));
    }
  };
  append(first.items);

  let nextBefore = first.nextBefore;
  const more = el('button', {
    type: 'button',
    class: 'btn secondary block',
    text: 'Ver más',
    hidden: !nextBefore,
    onClick: async () => {
      more.disabled = true;
      try {
        const page = await api(`activity?before=${nextBefore}`);
        append(page.items);
        nextBefore = page.nextBefore;
        more.hidden = !nextBefore;
      } catch (error) {
        handleError(error);
      } finally {
        more.disabled = false;
      }
    },
  });

  mount(
    topbar({ title: 'Actividad', back: '#/' }),
    el('section', { class: 'content' },
      pushCard(),
      first.items.length ? list : el('div', { class: 'card empty' }, el('p', { text: 'Todavía no hay actividad.' })),
      more));

  // Lo que se ha mostrado ya no es novedad.
  if (first.items.length && first.items[0].id > lastSeenId) {
    api('activity/seen', { method: 'POST', body: { lastId: first.items[0].id } }).catch(() => {});
  }
}

// ---------- Avisos push ----------

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

// El service worker puede no estar listo (o no existir en este navegador): no se espera para siempre.
function swRegistration() {
  return Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => { window.setTimeout(() => resolve(null), 3000); })]);
}

function pushCard() {
  const statusText = el('span', { class: 'muted small block', text: 'Comprobando…' });
  const toggle = el('input', { type: 'checkbox', class: 'switch', disabled: true, 'aria-label': 'Avisos en este móvil' });
  const card = el('label', { class: 'card switch-row' },
    el('span', {}, el('strong', { text: 'Avisos en este móvil' }), statusText),
    toggle);

  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  (async () => {
    if (!pushSupported()) {
      statusText.textContent = isIos && !standalone
        ? 'En iPhone, primero añade Repartos a la pantalla de inicio (Compartir → Añadir a pantalla de inicio).'
        : 'Este navegador no permite avisos.';
      return;
    }
    const registration = await swRegistration();
    if (!registration) {
      statusText.textContent = 'Los avisos no están disponibles en este navegador.';
      return;
    }
    let subscription = await registration.pushManager.getSubscription();
    const describe = () => {
      if (Notification.permission === 'denied') statusText.textContent = 'Bloqueados en los ajustes del navegador para esta web.';
      else statusText.textContent = subscription ? 'Te avisaremos cuando alguien añada o cambie gastos.' : 'Recibe un aviso cuando alguien apunte un gasto o un pago.';
    };
    toggle.checked = Boolean(subscription);
    toggle.disabled = Notification.permission === 'denied';
    describe();

    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        if (toggle.checked) {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') throw new Error('Sin permiso para mostrar avisos.');
          const { publicKey } = await api('push/key');
          subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
          await api('push/subscriptions', { method: 'POST', body: { subscription: subscription.toJSON() } });
          toast('Avisos activados en este móvil');
        } else if (subscription) {
          const { endpoint } = subscription;
          await subscription.unsubscribe();
          subscription = null;
          await api('push/subscriptions', { method: 'DELETE', body: { endpoint } }).catch(() => {});
          toast('Avisos desactivados');
        }
      } catch (error) {
        toggle.checked = Boolean(subscription);
        handleError(error);
      } finally {
        toggle.disabled = Notification.permission === 'denied';
        describe();
      }
    });
  })();
  return card;
}

// "Añadir gasto" desde el inicio: abre el formulario en el último grupo usado.
async function quickExpenseView() {
  const { groups } = await api('groups');
  const active = groups.filter((group) => !group.archived);
  if (!active.length) {
    navigate('#/nuevo-grupo', { replace: true });
    toast('Crea primero un grupo.');
    return;
  }
  const target = active.find((group) => group.id === lastGroupId()) ?? active[0];
  navigate(`#/g/${target.id}/gasto?desde=inicio`, { replace: true });
}

async function settlementFormView(groupId, query) {
  const bundle = await api(`groups/${groupId}`);
  if (bundle.group.archived) throw new Error('El grupo está archivado.');
  const members = bundle.members;
  const people = new Map(members.map((m) => [m.id, m]));
  const id = crypto.randomUUID();
  let fromId = Number(query.get('from')) || null;
  let toId = Number(query.get('to')) || null;
  const suggested = Number(query.get('amount')) || null;
  const cur = bundle.group.baseCurrency;
  const curExp = currencyExponent(cur);

  const amount = el('input', { type: 'text', inputMode: 'decimal', placeholder: curExp ? '0,00' : '0', class: 'amount-input', autocomplete: 'off', 'aria-label': 'Importe', value: suggested ? centsToInput(suggested, curExp) : '' });
  const date = el('input', { type: 'date', value: todayIso(), max: '2100-12-31', 'aria-label': 'Fecha' });
  // "Ana → Bea": se actualiza al elegir; así se lee de un vistazo qué se va a apuntar.
  const summary = el('span', { class: 'gh-label' });
  const updateSummary = () => {
    summary.textContent = fromId && toId && fromId !== toId
      ? paymentText(people, fromId, toId, 'present')
      : 'Elige quién paga y quién recibe';
  };
  const personChips = (selectedId, onPick) => el('div', { class: 'chips', role: 'radiogroup' },
    members.map((member) => chip({
      label: el('span', { class: 'person-chip' }, avatar(member.id, member.name), el('span', { text: personName(people, member.id) })),
      ariaLabel: personName(people, member.id),
      className: 'chip person',
      selected: member.id === selectedId,
      role: 'radio',
      onToggle: () => {
        onPick(member.id);
        updateSummary();
      },
    })));

  const submit = el('button', { class: 'btn primary', type: 'submit', text: 'Registrar pago' });
  const form = el('form', {
    class: 'content form expense-form',
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      const cents = parseAmount(amount.value, curExp);
      if (!fromId || !toId) return toast('Elige quién paga y quién recibe.');
      if (fromId === toId) return toast('Quien paga y quien recibe no pueden ser la misma persona.');
      if (!cents) return (amount.focus(), toast('Importe no válido.'));
      submit.disabled = true;
      const body = { id, fromId, toId, amountCents: cents, paidOn: date.value };
      try {
        const result = await createWithOutbox({
          id,
          kind: 'settlement',
          groupId: bundle.group.id,
          baseCurrency: cur,
          path: `groups/${groupId}/settlements`,
          body,
          settlement: { ...body, groupId: bundle.group.id, createdAt: new Date().toISOString() },
        });
        navigate(`#/g/${groupId}/saldos`, { replace: true });
        if (result === 'queued') {
          toast('Sin conexión: pago guardado en el móvil. Se enviará solo.');
          return;
        }
        toast('Pago registrado', {
          label: 'Deshacer',
          onClick: async () => {
            await api(`settlements/${id}`, { method: 'DELETE' });
            render();
          },
        });
      } catch (error) {
        submit.disabled = false;
        handleError(error);
      }
    },
  },
  el('div', { class: 'form-hero' },
    summary,
    el('div', { class: 'amount-row' }, amount, el('span', { class: 'hero-currency', text: cur }))),
  suggested && el('p', { class: 'field-hint', text: 'Es lo que queda pendiente. Puedes cambiarlo si es un pago parcial.' }),
  el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Paga' }), personChips(fromId, (value) => { fromId = value; })),
  el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Recibe' }), personChips(toId, (value) => { toId = value; })),
  el('div', { class: 'chips' }, dateChip(date, () => {})),
  el('div', { class: 'action-bar' }, submit));

  updateSummary();
  mountGroup(bundle.group, groupTopbar(bundle.group, { title: 'Registrar pago', back: `#/g/${groupId}/saldos` }), form);
}

// Reparto con el que empieza cada gasto nuevo del grupo (p. ej. 60/40 en Pareja).
function defaultSplitCard(bundle, patch) {
  const current = new Map((bundle.group.defaultSplit || []).map((entry) => [entry.personId, entry.weight]));
  let custom = Boolean(bundle.group.defaultSplit);
  const weights = new Map(bundle.members.map((member) => [member.id, custom ? current.get(member.id) ?? 0 : 1]));
  const body = el('div', { class: 'stack' });

  const renderBody = () => {
    body.replaceChildren();
    if (!custom) {
      body.append(el('p', { class: 'muted small', text: 'Cada gasto nuevo empieza repartido a partes iguales entre todos.' }));
      return;
    }
    body.append(
      el('div', { class: 'list' },
        bundle.members.map((member) => el('div', { class: 'row static' },
          el('span', { class: 'row-main', text: member.id === session.person.id ? `${member.name} (tú)` : member.name }),
          stepper(weights.get(member.id), (value) => {
            weights.set(member.id, value);
            saveSoon();
          }, member.name)))));
  };

  // Se guarda solo: al cambiar de modo al momento y al ajustar las partes, al dejar de tocar.
  let timer = null;
  const save = () => {
    window.clearTimeout(timer);
    if (!custom) return patch({ defaultSplit: null }, 'Reparto: a partes iguales', { rerender: false });
    const entries = [...weights].map(([personId, weight]) => ({ personId, weight }));
    if (!entries.some((entry) => entry.weight > 0)) return toast('Al menos una persona tiene que tener partes.');
    return patch({ defaultSplit: entries }, `Reparto: ${entries.map((entry) => entry.weight).join('/')}`, { rerender: false });
  };
  const saveSoon = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(save, 800);
  };

  renderBody();
  return el('div', { class: 'card stack' },
    el('span', {},
      el('strong', { text: 'Reparto por defecto' }),
      el('span', { class: 'muted small block', text: 'Se puede cambiar en cada gasto.' })),
    segmented([['equal', 'Iguales'], ['shares', 'Por partes']], custom ? 'shares' : 'equal', (value) => {
      custom = value === 'shares';
      renderBody();
      save();
    }, 'Reparto por defecto'),
    body);
}

async function settingsView(groupId) {
  const [bundle, { people }] = await Promise.all([api(`groups/${groupId}`), api('people')]);
  const { group } = bundle;
  const writable = !group.archived;
  let emoji = group.emoji || GROUP_EMOJIS[0];

  // Todo se guarda al momento. Sin volver a pintar la pantalla cuando no hace falta (no se pierde el foco).
  const patch = async (body, message, { rerender = true } = {}) => {
    try {
      await api(`groups/${groupId}`, { method: 'PATCH', body });
      toast(message ? `${message} · guardado` : 'Guardado');
      if (rerender) render();
    } catch (error) {
      handleError(error);
      render();
    }
  };

  let savedTitle = group.title;
  const title = el('input', {
    type: 'text',
    maxLength: 60,
    value: group.title,
    disabled: !writable,
    onChange: () => {
      const next = title.value.trim().replace(/\s+/g, ' ');
      if (!next) {
        title.value = savedTitle;
        toast('El grupo necesita un nombre.');
        return;
      }
      if (next === savedTitle) return;
      savedTitle = next;
      patch({ title: next }, 'Nombre', { rerender: false });
    },
  });
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') title.blur();
  });
  const simplify = el('input', {
    type: 'checkbox',
    class: 'switch',
    checked: group.simplifyDebts,
    disabled: !writable,
    onChange: () => patch({ simplifyDebts: simplify.checked }, simplify.checked ? 'Deudas simplificadas' : 'Deudas sin simplificar', { rerender: false }),
  });

  const memberIds = new Set(bundle.members.map((m) => m.id));
  const datalist = el('datalist', { id: 'peopleList' },
    people.filter((person) => !memberIds.has(person.id)).map((person) => el('option', { value: person.name })));
  const newMember = el('input', { type: 'text', maxLength: 40, placeholder: 'Nombre', list: 'peopleList', autocomplete: 'off' });
  const addMember = async () => {
    const name = newMember.value.trim();
    if (!name) return;
    try {
      await api(`groups/${groupId}/members`, { method: 'POST', body: { name } });
      toast(`${name} añadido al grupo`);
      render();
    } catch (error) {
      handleError(error);
    }
  };

  mountGroup(group,
    groupTopbar(group, { title: 'Ajustes del grupo', back: `#/g/${groupId}` }),
    el('section', { class: 'content form' },
      field('Nombre', title),
      el('p', { class: 'muted small', text: writable ? 'Los cambios se guardan solos.' : 'Grupo archivado: solo lectura.' }),
      writable && field('Icono', emojiPicker(emoji, (value) => {
        emoji = value;
        patch({ emoji: value }, 'Icono', { rerender: false });
      })),
      writable && field('Color', colorPicker(groupColor(group).key, (value) => {
        tintWith(appEl, { ...group, color: value });
        patch({ color: value }, 'Color', { rerender: false });
      })),
      field('Moneda de las cuentas', currencySelect(group.baseCurrency, (value) => patch({ baseCurrency: value }, `Moneda del grupo: ${value}`),
        { disabled: !writable || bundle.expenses.length > 0 || bundle.settlements.length > 0 }),
      bundle.expenses.length || bundle.settlements.length ? 'No se puede cambiar cuando ya hay gastos o pagos.' : undefined),

      el('label', { class: 'card switch-row' },
        el('span', {},
          el('strong', { text: 'Simplificar deudas' }),
          el('span', { class: 'muted small block', text: 'Propone el mínimo de pagos entre todos, aunque alguien acabe pagando a quien no le prestó directamente.' })),
        simplify),

      writable && bundle.members.length > 1 && defaultSplitCard(bundle, patch),
      shareCard(bundle),

      el('h2', { class: 'section-title', text: `Personas (${bundle.members.length})` }),
      el('div', { class: 'card list' },
        bundle.members.map((member) => el('div', { class: 'row static' },
          el('span', { class: 'row-main', text: member.id === session.person.id ? `${member.name} (tú)` : member.name }),
          writable && member.id !== session.person.id && el('button', {
            type: 'button',
            class: 'link-btn danger',
            text: 'Quitar',
            onClick: async () => {
              if (!(await confirmSheet({ title: `¿Quitar a ${member.name} del grupo?`, message: 'Solo se puede si no aparece en ningún gasto ni pago.', confirmLabel: 'Quitar', danger: true }))) return;
              try {
                await api(`groups/${groupId}/members/${member.id}`, { method: 'DELETE' });
                render();
              } catch (error) {
                handleError(error);
              }
            },
          })))),
      writable && el('div', { class: 'inline-form' }, newMember, datalist, el('button', { type: 'button', class: 'btn secondary', text: 'Añadir', onClick: addMember })),

      el('button', {
        type: 'button',
        class: group.archived ? 'btn secondary block' : 'btn danger-ghost block',
        text: group.archived ? 'Desarchivar grupo' : 'Archivar grupo',
        onClick: async () => {
          if (!group.archived && !(await confirmSheet({
            title: '¿Archivar el grupo?',
            message: 'Pasará a solo lectura. Podrás desarchivarlo cuando quieras.',
            confirmLabel: 'Archivar',
          }))) return;
          patch({ archived: !group.archived }, group.archived ? 'Grupo desarchivado' : 'Grupo archivado');
        },
      })));
  newMember.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addMember();
    }
  });
}

function shareUrl(token) {
  return new URL(`s/#${token}`, location.href.split('#')[0]).href;
}

// Enlace de solo lectura para amigos: ven gastos, saldos y pagos sugeridos, sin poder tocar nada.
function shareCard(bundle) {
  const groupId = bundle.group.id;
  const token = bundle.group.shareToken;
  const change = async (method, message, confirmation) => {
    if (confirmation && !(await confirmSheet(confirmation))) return;
    try {
      await api(`groups/${groupId}/share`, { method, body: {} });
      toast(message);
      render();
    } catch (error) {
      handleError(error);
    }
  };
  const intro = el('span', {},
    el('strong', { text: 'Compartir con amigos' }),
    el('span', { class: 'muted small block', text: 'Un enlace de solo lectura: quien lo tenga ve los gastos y los saldos, sin registrarse y sin poder cambiar nada.' }));
  if (!token) {
    return el('div', { class: 'card stack' }, intro,
      el('button', { type: 'button', class: 'btn secondary block', text: 'Crear enlace', onClick: () => change('POST', 'Enlace creado') }));
  }

  const url = shareUrl(token);
  const input = el('input', { type: 'text', readOnly: true, value: url, class: 'share-url', 'aria-label': 'Enlace para compartir', onFocus: () => input.select() });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Enlace copiado');
    } catch {
      input.select();
      toast('Selecciona el enlace y cópialo.');
    }
  };
  return el('div', { class: 'card stack' }, intro, input,
    el('div', { class: 'inline-form' },
      navigator.share && el('button', {
        type: 'button',
        class: 'btn secondary',
        text: 'Compartir',
        onClick: () => navigator.share({ title: bundle.group.title, text: `Gastos de ${bundle.group.title}`, url }).catch(() => {}),
      }),
      el('button', { type: 'button', class: 'btn secondary', text: 'Copiar', onClick: copy })),
    el('div', { class: 'field-row' },
      el('button', { type: 'button', class: 'link-btn', text: 'Cambiar enlace', onClick: () => change('POST', 'Enlace cambiado', { title: '¿Cambiar el enlace?', message: 'El enlace actual dejará de funcionar.', confirmLabel: 'Cambiar enlace' }) }),
      el('button', { type: 'button', class: 'link-btn danger', text: 'Dejar de compartir', onClick: () => change('DELETE', 'Ya no se comparte', { title: '¿Dejar de compartir?', message: 'El enlace dejará de funcionar.', confirmLabel: 'Dejar de compartir', danger: true }) })));
}

// Vista de amigos (/s/#token): sin sesión, solo lectura.
async function sharedView(token) {
  loading();
  let bundle;
  try {
    bundle = await api('shared', { headers: { 'X-Share-Token': token } });
  } catch (error) {
    mount(el('section', { class: 'content' }, el('div', { class: 'card empty' },
      el('h2', { text: 'Enlace no disponible' }),
      el('p', { text: error.message }))));
    return;
  }
  const people = new Map(bundle.members.map((person) => [person.id, person]));
  document.title = `${bundle.group.title} · Repartos`;
  const panel = el('div', { class: 'stack' });
  const tabs = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Secciones' });
  const show = (which) => {
    tabs.querySelectorAll('button').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.tab === which)));
    panel.replaceChildren(which === 'saldos' ? balancesPanel(bundle, people) : which === 'resumen' ? summaryPanel(bundle, people) : timeline(bundle, people));
  };
  for (const [value, label] of [['saldos', 'Saldos'], ['gastos', 'Gastos'], ['resumen', 'Resumen']]) {
    tabs.append(el('button', { type: 'button', role: 'radio', 'data-tab': value, text: label, onClick: () => show(value) }));
  }
  mount(
    el('header', { class: 'topbar' },
      groupIcon(bundle.group),
      el('h1', { text: bundle.group.title })),
    el('section', { class: 'content' },
      el('div', { class: 'banner', text: `Solo lectura · ${plural(bundle.members.length, 'persona', 'personas')} · importes en ${bundle.group.baseCurrency}` }),
      tabs,
      panel));
  show('saldos');
}

async function peopleView() {
  const { people } = await api('people');
  mount(
    topbar({ title: 'Personas', back: '#/' }),
    el('section', { class: 'content' },
      el('p', { class: 'muted small', text: 'Toca una persona para ver sus saldos en todos los grupos.' }),
      el('div', { class: 'card list' },
        people.map((person) => el('a', { class: 'row', href: `#/p/${person.id}` },
          avatar(person.id, person.name),
          el('span', { class: 'row-main' }, el('strong', { text: person.id === session.person.id ? `${person.name} (tú)` : person.name })),
          el('span', { class: 'chevron-end' }, icon('forward', { small: true })))))));
}

// Saldo de una persona en cada grupo y el total por moneda (solo grupos activos).
async function personView(personId) {
  const summary = await api(`people/${personId}/summary`);
  const { person } = summary;
  const isMe = person.id === session.person.id;
  const describe = (cents, currency) => balanceText(cents, currency, { mine: isMe });

  const name = el('input', { type: 'text', maxLength: 40, value: person.name, 'aria-label': 'Nombre' });
  const rename = async () => {
    try {
      await api(`people/${person.id}`, { method: 'PATCH', body: { name: name.value } });
      if (isMe) session.person.name = name.value.trim();
      toast('Nombre actualizado');
      render();
    } catch (error) {
      handleError(error);
    }
  };

  mount(
    topbar({ title: isMe ? `${person.name} (tú)` : person.name, back: '#/personas' }),
    el('section', { class: 'content' },
      el('div', { class: 'card hero' },
        el('div', { class: 'hero-top' },
          avatar(person.id, person.name, { large: true }),
          el('div', { class: 'hero-text' },
            el('span', { class: 'label', text: 'Total en grupos activos' }),
            summary.totals.length
              ? summary.totals.map(({ currency, amountCents }) => {
                const total = describe(amountCents, currency);
                return el('span', { class: 'hero-line' },
                  el('span', { class: 'label', text: total.label }),
                  el('strong', { class: `big ${total.tone}`, text: total.amount || formatMoney(0, currency) }));
              })
              : el('strong', { class: 'big muted', text: 'Sin grupos activos' })))),
      el('h2', { class: 'section-title', text: `Grupos (${summary.groups.length})` }),
      summary.groups.length
        ? el('div', { class: 'card list' },
          summary.groups.map((group) => {
            const balance = describe(group.balanceCents, group.baseCurrency);
            return el('a', { class: 'row', href: `#/g/${group.id}/saldos` },
              groupIcon(group),
              el('span', { class: 'row-main' },
                el('strong', { text: group.title }),
                group.archived && el('span', { class: 'meta', text: 'Archivado' })),
              balanceSide(balance));
          }))
        : el('div', { class: 'card empty' }, el('p', { text: 'No está en ningún grupo.' })),
      el('h2', { class: 'section-title', text: 'Nombre' }),
      el('div', { class: 'inline-form' }, name, el('button', { type: 'button', class: 'btn secondary', text: 'Guardar', onClick: rename }))));
}

// ---------- Router ----------

const ROUTES = [
  [/^\/?$/, () => groupsView()],
  [/^\/nuevo-grupo$/, () => newGroupView()],
  [/^\/g\/(\d+)$/, ([id]) => groupView(id, 'gastos')],
  [/^\/g\/(\d+)\/saldos$/, ([id]) => groupView(id, 'saldos')],
  [/^\/g\/(\d+)\/resumen$/, ([id]) => groupView(id, 'resumen')],
  [/^\/actividad$/, () => activityView()],
  [/^\/gasto$/, () => quickExpenseView()],
  [/^\/g\/(\d+)\/gasto$/, ([id], query) => expenseFormView(id, null, query)],
  [/^\/g\/(\d+)\/gasto\/([\w-]+)$/, ([id, expenseId], query) => expenseFormView(id, expenseId, query)],
  [/^\/g\/(\d+)\/pago$/, ([id], query) => settlementFormView(id, query)],
  [/^\/g\/(\d+)\/ajustes$/, ([id]) => settingsView(id)],
  [/^\/personas$/, () => peopleView()],
  [/^\/p\/(\d+)$/, ([id]) => personView(id)],
];

async function render() {
  const token = ++renderToken;
  const [path, queryString = ''] = location.hash.replace(/^#/, '').split('?');
  const query = new URLSearchParams(queryString);
  const route = ROUTES.find(([pattern]) => pattern.test(path));
  if (!route) {
    navigate('#/', { replace: true });
    return;
  }
  if (!appEl.firstElementChild || appEl.querySelector('.loading')) loading();
  try {
    await route[1](route[0].exec(path).slice(1), query);
  } catch (error) {
    if (token !== renderToken) return;
    if (error instanceof SessionExpiredError) return handleError(error);
    mount(
      topbar({ title: 'Repartos', back: '#/' }),
      el('section', { class: 'content' }, el('div', { class: 'card empty' }, el('h2', { text: 'No se ha podido cargar' }), el('p', { text: error.message }))));
  }
}

// Los datos guardados para consultar sin conexión son de quien inició sesión. Si en este navegador
// entra otra persona (con conexión), se borran antes de que pueda verlos sin red.
function forgetOtherUsersData(user) {
  if (offlineData) return;
  let previous = null;
  try {
    previous = localStorage.getItem('repartos-user');
    localStorage.setItem('repartos-user', user);
  } catch {
    return;
  }
  if (previous && previous !== user) {
    navigator.serviceWorker?.controller?.postMessage({ type: 'forget-api-data' });
  }
}

async function init() {
  document.body.prepend(offlineBanner);
  window.addEventListener('online', () => {
    updateOfflineBanner();
    if (SHARED_MODE) return;
    render();
    syncOutbox();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !SHARED_MODE) syncOutbox();
  });
  window.addEventListener('offline', updateOfflineBanner);
  updateOfflineBanner();

  if (SHARED_MODE) {
    sharedView(location.hash.replace(/^#/, ''));
    return;
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    session = await api('session');
    sessionStorage.removeItem('repartos-reloaded');
    forgetOtherUsersData(session.user);
    refreshPending().then(syncOutbox);
  } catch (error) {
    if (error instanceof SessionExpiredError && !sessionStorage.getItem('repartos-reloaded')) {
      // Evita un bucle de recargas si el servidor responde 401 sin pasar por Authelia (p. ej. en local).
      sessionStorage.setItem('repartos-reloaded', '1');
      window.location.reload();
      return;
    }
    mount(el('p', { class: 'loading', text: error instanceof SessionExpiredError ? 'Necesitas iniciar sesión.' : 'No se puede conectar con el servidor.' }));
    return;
  }
  window.addEventListener('hashchange', render);
  render();
}

init();
