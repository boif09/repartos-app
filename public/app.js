// SPA vanilla con rutas por hash. Las rutas de red son relativas al documento, así la app
// funciona bajo cualquier BASE_PATH. El login lo gestiona Authelia: si la sesión caduca,
// nginx responde con una redirección y la app recarga la página para que el navegador la siga.
import { allocate, centsToInput, currencyExponent, formatMoney, parseAmount } from './shared/money.js';
import { convertMinor, parseRate } from './shared/fx.js';
import { computeShares, SplitError } from './shared/splits.js';

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

// La vista de amigos vive en /s/#token: la API está un nivel por encima.
const SHARED_MODE = /\/s\/$/.test(location.pathname);
const API_ROOT = SHARED_MODE ? '../api/' : 'api/';
const OFFLINE_WRITE = 'Sin conexión: no se puede guardar ahora. Inténtalo cuando vuelva la cobertura.';

async function api(pathName, { method = 'GET', body, headers = {} } = {}) {
  if (method !== 'GET' && !navigator.onLine) throw new Error(OFFLINE_WRITE);
  let response;
  try {
    response = await fetch(`${API_ROOT}${pathName}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      redirect: 'manual',
    });
  } catch {
    throw new Error(method === 'GET' ? 'Sin conexión y sin datos guardados para esta pantalla.' : OFFLINE_WRITE);
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
  offlineBanner.textContent = offline ? 'Sin conexión · viendo los últimos datos guardados' : '';
  document.body.classList.toggle('is-offline', offline);
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

function groupIcon(emoji) {
  const name = GROUP_ICONS.find(([value]) => value === emoji)?.[1] ?? 'users';
  return el('span', { class: 'group-icon', 'aria-hidden': 'true' }, icon(name));
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

function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input, hint && el('span', { class: 'field-hint', text: hint }));
}

function mount(...nodes) {
  appEl.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

function loading() {
  mount(el('p', { class: 'loading', text: 'Cargando…' }));
}

// ---------- Vistas ----------

async function groupsView() {
  const { groups } = await api('groups');
  const active = groups.filter((group) => !group.archived);
  const archived = groups.filter((group) => group.archived);

  const row = (group) => {
    const balance = balanceText(group.myBalanceCents, group.baseCurrency);
    return el('a', { class: 'row group-row', href: `#/g/${group.id}` },
      groupIcon(group.emoji),
      el('span', { class: 'row-main' },
        el('strong', { text: group.title }),
        el('span', { class: 'meta', text: `${plural(group.memberCount, 'persona', 'personas')} · ${plural(group.expenseCount, 'gasto', 'gastos')}` })),
      balanceSide(balance));
  };

  mount(
    topbar({ title: 'Repartos' }),
    el('section', { class: 'content' },
      active.length
        ? el('div', { class: 'card list' }, active.map(row))
        : el('div', { class: 'card empty' },
          el('h2', { text: 'Aún no hay grupos' }),
          el('p', { text: 'Crea uno para la pareja, un viaje o un finde con amigos.' })),
      archived.length > 0 && el('details', { class: 'archived' },
        el('summary', { text: `Archivados (${archived.length})` }),
        el('div', { class: 'card list' }, archived.map(row))),
      el('div', { class: 'home-links' },
        el('a', { class: 'btn secondary', href: '#/nuevo-grupo' }, icon('plus', { small: true }), 'Nuevo grupo'),
        el('a', { class: 'btn secondary', href: '#/personas' }, icon('users', { small: true }), 'Personas'))),
    active.length
      ? el('a', { class: 'fab', href: '#/gasto' }, icon('plus'), 'Añadir gasto')
      : el('a', { class: 'fab', href: '#/nuevo-grupo' }, icon('plus'), 'Nuevo grupo'));
}

async function newGroupView() {
  const { people } = await api('people');
  const selected = new Map(); // key -> { personId } | { name }
  let emoji = GROUP_EMOJIS[0];
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
  };
  newName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addNew();
    }
  });

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
        const bundle = await api('groups', { method: 'POST', body: { title: title.value, emoji, baseCurrency, members: [...selected.values()] } });
        navigate(`#/g/${bundle.group.id}`, { replace: true });
      } catch (error) {
        handleError(error);
        submit.disabled = false;
      }
    },
  },
  field('Nombre', title),
  field('Icono', emojiPicker(emoji, (value) => { emoji = value; })),
  field('Moneda de las cuentas', currencySelect(baseCurrency, (value) => { baseCurrency = value; }),
    'Los saldos se calculan en esta moneda. En un viaje puedes dejar euros y apuntar cada gasto en la moneda local.'),
  el('div', { class: 'field' },
    el('span', { class: 'field-label', text: 'Personas' }),
    el('span', { class: 'field-hint', text: `${session.person.name} ya está incluido. Toca para añadir.` }),
    peopleChips,
    el('div', { class: 'inline-form' }, newName, el('button', { type: 'button', class: 'btn secondary', text: 'Añadir', onClick: addNew }))),
  submit);

  mount(topbar({ title: 'Nuevo grupo', back: '#/' }), form);
  title.focus();
}

function timeline(bundle, people) {
  const items = [
    ...bundle.expenses.map((expense) => ({ type: 'expense', date: expense.spentOn, createdAt: expense.createdAt, data: expense })),
    ...bundle.settlements.map((settlement) => ({ type: 'settlement', date: settlement.paidOn, createdAt: settlement.createdAt, data: settlement })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

  if (!items.length) {
    return el('div', { class: 'card empty' },
      el('h2', { text: 'Sin gastos todavía' }),
      el('p', { text: 'Pulsa + para añadir el primero.' }));
  }

  const meId = session?.person.id ?? null;
  const editable = !bundle.group.archived && !SHARED_MODE;
  const cur = bundle.group.baseCurrency;
  const list = el('div', { class: 'stack timeline' });
  let currentDay = null;
  let dayCard = null;
  for (const item of items) {
    if (item.date !== currentDay) {
      currentDay = item.date;
      dayCard = el('div', { class: 'card list' });
      list.append(el('h3', { class: 'day', text: formatDay(item.date) }), dayCard);
    }
    if (item.type === 'expense') {
      const expense = item.data;
      const myShare = expense.shares.find((share) => share.personId === meId)?.owedCents ?? 0;
      let impact = null;
      if (meId === null) impact = null;
      else if (expense.payerId === meId) impact = { text: `prestaste ${formatMoney(expense.amountCents - myShare, cur)}`, tone: 'positive' };
      else if (myShare > 0) impact = { text: `debes ${formatMoney(myShare, cur)}`, tone: 'negative' };
      else impact = { text: 'no participas', tone: 'muted' };
      dayCard.append(el('a', {
        class: 'row',
        href: editable ? `#/g/${bundle.group.id}/gasto/${expense.id}` : undefined,
      },
      avatar(expense.payerId, people.get(expense.payerId)?.name),
      el('span', { class: 'row-main' },
        el('strong', { text: expense.description }),
        el('span', { class: 'meta', text: `${expense.payerId === meId ? 'Pagaste' : `Pagó ${personName(people, expense.payerId)}`} · ${splitSummary(expense, bundle.members.length)}` })),
      el('span', { class: 'row-side' },
        el('strong', { text: formatMoney(expense.originalMinor, expense.currency) }),
        expense.currency !== cur && el('span', { class: 'muted small num', text: `≈ ${formatMoney(expense.amountCents, cur)}` }),
        impact && el('span', { class: `small ${impact.tone}`, text: impact.text }))));
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
  if (!window.confirm(`¿Borrar este pago? ${label}`)) return;
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

// "Judit te debe" en vez de "Te deben": en un grupo de dos se dice con quién, y saldar está a un toque.
function balanceHero(bundle, tab) {
  const meId = session.person.id;
  const cur = bundle.group.baseCurrency;
  const mine = bundle.myBalanceCents;
  const others = bundle.members.filter((member) => member.id !== meId);
  const partner = others.length === 1 && mine !== null ? others[0] : null;
  let label;
  if (mine === null) label = 'No participas en este grupo';
  else if (partner) label = mine > 0 ? `${partner.name} te debe` : mine < 0 ? `Le debes a ${partner.name}` : `Estás en paz con ${partner.name}`;
  else label = mine > 0 ? 'Te deben' : mine < 0 ? 'Debes' : 'Estás en paz';
  const tone = mine > 0 ? 'positive' : mine < 0 ? 'negative' : 'muted';
  const settleUp = !bundle.group.archived && bundle.transfers.find((transfer) => transfer.fromId === meId || transfer.toId === meId);
  const base = `#/g/${bundle.group.id}`;

  return el('div', { class: 'card hero' },
    el('div', { class: 'hero-top' },
      partner ? avatar(partner.id, partner.name, { large: true }) : groupIcon(bundle.group.emoji),
      el('div', { class: 'hero-text' },
        el('span', { class: 'label', text: label }),
        el('strong', { class: `big ${tone}`, text: mine ? formatMoney(Math.abs(mine), cur) : 'Sin deudas' }))),
    el('div', { class: 'hero-actions' },
      settleUp && el('a', {
        href: `${base}/pago?from=${settleUp.fromId}&to=${settleUp.toId}&amount=${settleUp.amountCents}`,
        text: 'Saldar cuentas',
      }),
      tab === 'saldos' ? el('a', { href: base, text: 'Ver gastos' }) : el('a', { href: `${base}/saldos`, text: 'Ver saldos' })));
}

async function groupView(groupId, tab) {
  const bundle = await api(`groups/${groupId}`);
  rememberGroup(bundle.group.id);
  const people = new Map(bundle.members.map((person) => [person.id, person]));
  const base = `#/g/${groupId}`;

  mount(
    topbar({
      title: bundle.group.title,
      back: '#/',
      action: el('a', { class: 'icon-btn', href: `${base}/ajustes`, 'aria-label': 'Ajustes del grupo' }, icon('settings')),
    }),
    el('section', { class: 'content' },
      bundle.group.archived && el('div', { class: 'banner', text: 'Grupo archivado: solo lectura.' }),
      balanceHero(bundle, tab),
      el('nav', { class: 'tabs', 'aria-label': 'Secciones del grupo' },
        el('a', { href: base, class: tab === 'saldos' ? 'tab' : 'tab active', 'aria-current': tab === 'saldos' ? undefined : 'page', text: 'Gastos' }),
        el('a', { href: `${base}/saldos`, class: tab === 'saldos' ? 'tab active' : 'tab', 'aria-current': tab === 'saldos' ? 'page' : undefined, text: 'Saldos' })),
      tab === 'saldos' ? balancesPanel(bundle, people) : timeline(bundle, people)),
    !bundle.group.archived && el('a', { class: 'fab', href: `${base}/gasto` }, icon('plus'), 'Gasto'));
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
  return el('span', { class: 'picker-chip' },
    leadingSlot,
    el('span', { class: 'picker-text' }, label && el('span', { class: 'picker-label', text: label }), textNode),
    icon('down', { small: true }),
    select);
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
  });

  // Fila de chips: grupo (al crear), quién pagó y fecha.
  const payerChip = pickerChip({
    leading: avatar(payerId, people.get(payerId)?.name),
    label: 'Pagó',
    text: memberLabel(people.get(payerId)),
    options: members.map((member) => [member.id, memberLabel(member)]),
    value: payerId,
    ariaLabel: 'Quién pagó',
    onChange: (value, { setText, setLeading }) => {
      payerId = Number(value);
      setText(memberLabel(people.get(payerId)));
      setLeading(avatar(payerId, people.get(payerId)?.name));
    },
  });
  const activeGroups = groupList?.groups.filter((group) => !group.archived) ?? [];
  const groupChip = activeGroups.length > 1 && pickerChip({
    leading: groupIcon(bundle.group.emoji),
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
      const body = { id, description: description.value, payerId, spentOn: date.value, splitMode: mode, shares: entries, currency };
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
        if (editing) await api(`expenses/${id}`, { method: 'PUT', body: { ...body, version: editing.version } });
        else await api(`groups/${groupId}/expenses`, { method: 'POST', body });
        navigate(`#/g/${groupId}`, { replace: true });
        toast(editing ? 'Gasto actualizado' : 'Gasto añadido');
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
  el('div', { class: 'amount-row' }, amount, currencyInput),
  description,
  el('div', { class: 'chips' }, groupChip, payerChip, dateChip(date, () => refreshRate())),
  fxBox,
  el('div', { class: 'field' },
    el('span', { class: 'field-label', text: 'Para quién' }),
    segmented(SPLIT_MODES_UI, mode, (value) => {
      mode = value;
      renderSplitBody();
    }, 'Cómo se reparte'),
    splitBody),
  status,
  editing && el('button', {
    type: 'button',
    class: 'btn danger-ghost block',
    text: 'Borrar gasto',
    onClick: async () => {
      if (!window.confirm(`¿Borrar "${editing.description}"?`)) return;
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

  mount(topbar({ title: editing ? 'Editar gasto' : 'Nuevo gasto', back: backHref }), form);
  renderFx();
  renderSplitBody();
  // Gasto nuevo en moneda extranjera: se pide ya el tipo del día.
  if (!editing) {
    refreshRate();
    amount.focus();
  }
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

  const amount = el('input', { type: 'text', inputMode: 'decimal', placeholder: curExp ? '0,00' : '0', class: 'amount-input', autocomplete: 'off', value: suggested ? centsToInput(suggested, curExp) : '' });
  const date = el('input', { type: 'date', value: todayIso(), max: '2100-12-31' });
  const personChips = (selectedId, onPick) => el('div', { class: 'chips', role: 'radiogroup' },
    members.map((member) => chip({ label: personName(people, member.id), selected: member.id === selectedId, role: 'radio', onToggle: () => onPick(member.id) })));

  const submit = el('button', { class: 'btn primary', type: 'submit', text: 'Registrar pago' });
  const form = el('form', {
    class: 'content form',
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      const cents = parseAmount(amount.value, curExp);
      if (!fromId || !toId) return toast('Elige quién paga y quién recibe.');
      if (fromId === toId) return toast('Quien paga y quien recibe no pueden ser la misma persona.');
      if (!cents) return (amount.focus(), toast('Importe no válido.'));
      submit.disabled = true;
      try {
        await api(`groups/${groupId}/settlements`, { method: 'POST', body: { id, fromId, toId, amountCents: cents, paidOn: date.value } });
        navigate(`#/g/${groupId}/saldos`, { replace: true });
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
  el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Paga' }), personChips(fromId, (value) => { fromId = value; })),
  el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Recibe' }), personChips(toId, (value) => { toId = value; })),
  field(`Importe (${currencySymbol(cur)})`, amount, suggested ? 'Puedes cambiarlo si es un pago parcial.' : undefined),
  field('Fecha', date),
  submit);

  mount(topbar({ title: 'Registrar pago', back: `#/g/${groupId}/saldos` }), form);
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
          stepper(weights.get(member.id), (value) => weights.set(member.id, value), member.name)))));
  };

  const save = () => {
    if (!custom) return patch({ defaultSplit: null }, 'Reparto por defecto: a partes iguales');
    const entries = [...weights].map(([personId, weight]) => ({ personId, weight }));
    if (!entries.some((entry) => entry.weight > 0)) return toast('Al menos una persona tiene que tener partes.');
    const summary = entries.map((entry) => entry.weight).join('/');
    return patch({ defaultSplit: entries }, `Reparto por defecto: ${summary}`);
  };

  renderBody();
  return el('div', { class: 'card stack' },
    el('span', {},
      el('strong', { text: 'Reparto por defecto' }),
      el('span', { class: 'muted small block', text: 'Se puede cambiar en cada gasto.' })),
    segmented([['equal', 'Iguales'], ['shares', 'Por partes']], custom ? 'shares' : 'equal', (value) => {
      custom = value === 'shares';
      renderBody();
    }, 'Reparto por defecto'),
    body,
    el('button', { type: 'button', class: 'btn secondary block', text: 'Guardar reparto', onClick: save }));
}

async function settingsView(groupId) {
  const [bundle, { people }] = await Promise.all([api(`groups/${groupId}`), api('people')]);
  const { group } = bundle;
  const writable = !group.archived;
  let emoji = group.emoji || GROUP_EMOJIS[0];

  const patch = async (body, message) => {
    try {
      await api(`groups/${groupId}`, { method: 'PATCH', body });
      if (message) toast(message);
      render();
    } catch (error) {
      handleError(error);
    }
  };

  const title = el('input', { type: 'text', maxLength: 60, value: group.title, disabled: !writable });
  const simplify = el('input', {
    type: 'checkbox',
    class: 'switch',
    checked: group.simplifyDebts,
    disabled: !writable,
    onChange: () => patch({ simplifyDebts: simplify.checked }, simplify.checked ? 'Deudas simplificadas' : 'Deudas sin simplificar'),
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

  mount(
    topbar({ title: 'Ajustes del grupo', back: `#/g/${groupId}` }),
    el('section', { class: 'content form' },
      field('Nombre', title),
      writable && field('Icono', emojiPicker(emoji, (value) => { emoji = value; })),
      field('Moneda de las cuentas', currencySelect(group.baseCurrency, (value) => patch({ baseCurrency: value }, `Moneda del grupo: ${value}`),
        { disabled: !writable || bundle.expenses.length > 0 || bundle.settlements.length > 0 }),
      bundle.expenses.length || bundle.settlements.length ? 'No se puede cambiar cuando ya hay gastos o pagos.' : undefined),
      writable && el('button', { type: 'button', class: 'btn secondary block', text: 'Guardar nombre e icono', onClick: () => patch({ title: title.value, emoji }, 'Grupo actualizado') }),

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
              if (!window.confirm(`¿Quitar a ${member.name} del grupo?`)) return;
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
        onClick: () => {
          if (!group.archived && !window.confirm('El grupo pasará a solo lectura. ¿Archivar?')) return;
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
  const change = async (method, message, question) => {
    if (question && !window.confirm(question)) return;
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
      el('button', { type: 'button', class: 'link-btn', text: 'Cambiar enlace', onClick: () => change('POST', 'Enlace cambiado', 'El enlace actual dejará de funcionar. ¿Crear uno nuevo?') }),
      el('button', { type: 'button', class: 'link-btn danger', text: 'Dejar de compartir', onClick: () => change('DELETE', 'Ya no se comparte', '¿Dejar de compartir? El enlace dejará de funcionar.') })));
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
    panel.replaceChildren(which === 'saldos' ? balancesPanel(bundle, people) : timeline(bundle, people));
  };
  for (const [value, label] of [['saldos', 'Saldos'], ['gastos', 'Gastos']]) {
    tabs.append(el('button', { type: 'button', role: 'radio', 'data-tab': value, text: label, onClick: () => show(value) }));
  }
  mount(
    el('header', { class: 'topbar' },
      groupIcon(bundle.group.emoji),
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
              groupIcon(group.emoji),
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
    if (!SHARED_MODE) render();
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
