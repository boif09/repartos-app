// SPA vanilla con rutas por hash. Las rutas de red son relativas al documento, así la app
// funciona bajo cualquier BASE_PATH. El login lo gestiona Authelia: si la sesión caduca,
// nginx responde con una redirección y la app recarga la página para que el navegador la siga.
import { centsToInput, formatMoney, parseAmount } from './shared/money.js';
import { computeShares, SplitError } from './shared/splits.js';

const appEl = document.getElementById('app');
const GROUP_EMOJIS = ['👥', '❤️', '🏠', '✈️', '🏖️', '⛰️', '🍻', '🎉'];

let session = null;
let renderToken = 0;

// ---------- Utilidades ----------

class SessionExpiredError extends Error {}

async function api(pathName, { method = 'GET', body } = {}) {
  const response = await fetch(`api/${pathName}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    redirect: 'manual',
  });
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

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function personName(people, id) {
  if (id === session.person.id) return 'Tú';
  return people.get(id)?.name ?? '¿?';
}

function balanceText(cents) {
  if (cents === null || cents === undefined) return { text: 'No participas', tone: 'muted' };
  if (cents > 0) return { text: `Te deben ${formatMoney(cents)}`, tone: 'positive' };
  if (cents < 0) return { text: `Debes ${formatMoney(-cents)}`, tone: 'negative' };
  return { text: 'Estás en paz', tone: 'muted' };
}

// ---------- Piezas de interfaz ----------

function topbar({ title, back, action }) {
  return el('header', { class: 'topbar' },
    back
      ? el('a', { class: 'icon-btn', href: back, 'aria-label': 'Volver', text: '‹' })
      : el('span', { class: 'brand-dot', 'aria-hidden': 'true', text: '÷' }),
    el('h1', { text: title }),
    action || el('span', { class: 'user-chip', text: session.person.name }));
}

function chip({ label, selected, onToggle, role = 'checkbox' }) {
  const node = el('button', {
    type: 'button',
    class: 'chip',
    role,
    'aria-checked': String(Boolean(selected)),
    text: label,
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
  });
  return node;
}

function emojiPicker(current, onPick) {
  return el('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Icono del grupo' },
    GROUP_EMOJIS.map((emoji) => chip({
      label: emoji,
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

  const card = (group) => {
    const balance = balanceText(group.myBalanceCents);
    return el('a', { class: 'card group-card', href: `#/g/${group.id}` },
      el('span', { class: 'group-emoji', 'aria-hidden': 'true', text: group.emoji || '👥' }),
      el('span', { class: 'group-main' },
        el('strong', { text: group.title }),
        el('span', { class: 'muted small', text: `${plural(group.memberCount, 'persona', 'personas')} · ${plural(group.expenseCount, 'gasto', 'gastos')}` })),
      el('span', { class: `amount ${balance.tone}`, text: balance.text }));
  };

  mount(
    topbar({ title: 'Repartos' }),
    el('section', { class: 'content' },
      active.length
        ? active.map(card)
        : el('div', { class: 'card empty' },
          el('h2', { text: 'Aún no hay grupos' }),
          el('p', { text: 'Crea uno para la pareja, un viaje o un finde con amigos.' })),
      archived.length > 0 && el('details', { class: 'archived' },
        el('summary', { text: `Archivados (${archived.length})` }),
        archived.map(card))),
    el('a', { class: 'fab', href: '#/nuevo-grupo', text: '+ Nuevo grupo' }));
}

async function newGroupView() {
  const { people } = await api('people');
  const selected = new Map(); // key -> { personId } | { name }
  let emoji = GROUP_EMOJIS[0];

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
        const bundle = await api('groups', { method: 'POST', body: { title: title.value, emoji, members: [...selected.values()] } });
        navigate(`#/g/${bundle.group.id}`, { replace: true });
      } catch (error) {
        handleError(error);
        submit.disabled = false;
      }
    },
  },
  field('Nombre', title),
  field('Icono', emojiPicker(emoji, (value) => { emoji = value; })),
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

  const meId = session.person.id;
  const list = el('div', { class: 'timeline' });
  let currentDay = null;
  for (const item of items) {
    if (item.date !== currentDay) {
      currentDay = item.date;
      list.append(el('h3', { class: 'day', text: formatDay(item.date) }));
    }
    if (item.type === 'expense') {
      const expense = item.data;
      const myShare = expense.shares.find((share) => share.personId === meId)?.owedCents ?? 0;
      let impact;
      if (expense.payerId === meId) impact = { text: `prestaste ${formatMoney(expense.amountCents - myShare)}`, tone: 'positive' };
      else if (myShare > 0) impact = { text: `debes ${formatMoney(myShare)}`, tone: 'negative' };
      else impact = { text: 'no participas', tone: 'muted' };
      list.append(el('a', {
        class: 'row',
        href: bundle.group.archived ? undefined : `#/g/${bundle.group.id}/gasto/${expense.id}`,
      },
      el('span', { class: 'row-main' },
        el('strong', { text: expense.description }),
        el('span', { class: 'muted small', text: `${expense.payerId === meId ? 'Pagaste' : `Pagó ${personName(people, expense.payerId)}`} · ${expense.shares.length === bundle.members.length ? 'entre todos' : `entre ${expense.shares.length}`}` })),
      el('span', { class: 'row-side' },
        el('strong', { text: formatMoney(expense.amountCents) }),
        el('span', { class: `small ${impact.tone}`, text: impact.text }))));
    } else {
      const settlement = item.data;
      list.append(el('button', {
        type: 'button',
        class: 'row settlement',
        disabled: bundle.group.archived,
        onClick: () => deleteSettlement(bundle, settlement, people),
      },
      el('span', { class: 'row-main' },
        el('strong', { text: `${personName(people, settlement.fromId)} → ${personName(people, settlement.toId)}` }),
        el('span', { class: 'muted small', text: 'Pago' })),
      el('span', { class: 'row-side' }, el('strong', { text: formatMoney(settlement.amountCents) }))));
    }
  }
  return list;
}

async function deleteSettlement(bundle, settlement, people) {
  const label = `${personName(people, settlement.fromId)} → ${personName(people, settlement.toId)} (${formatMoney(settlement.amountCents)})`;
  if (!window.confirm(`¿Borrar el pago ${label}?`)) return;
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
  const writable = !bundle.group.archived;
  const balances = [...bundle.balances].sort((a, b) => b.amountCents - a.amountCents);

  return el('div', { class: 'stack' },
    el('div', { class: 'card list' },
      balances.map(({ personId, amountCents }) => el('div', { class: 'row static' },
        el('span', { class: 'row-main' }, el('strong', { text: personName(people, personId) })),
        el('span', {
          class: `amount ${amountCents > 0 ? 'positive' : amountCents < 0 ? 'negative' : 'muted'}`,
          text: amountCents > 0 ? `+${formatMoney(amountCents)}` : amountCents < 0 ? formatMoney(amountCents) : 'En paz',
        })))),
    el('h2', { class: 'section-title', text: bundle.group.simplifyDebts ? 'Pagos sugeridos' : 'Deudas' }),
    bundle.transfers.length
      ? el('div', { class: 'card list' },
        bundle.transfers.map((transfer) => el('div', { class: 'row static' },
          el('span', { class: 'row-main' },
            el('strong', { text: `${personName(people, transfer.fromId)} → ${personName(people, transfer.toId)}` }),
            el('span', { class: 'muted small', text: formatMoney(transfer.amountCents) })),
          writable && el('a', {
            class: 'btn small secondary',
            href: `#/g/${groupId}/pago?from=${transfer.fromId}&to=${transfer.toId}&amount=${transfer.amountCents}`,
            text: 'Registrar',
          }))))
      : el('div', { class: 'card empty' }, el('p', { text: 'Todo saldado. 🎉' })),
    writable && el('a', { class: 'btn ghost block', href: `#/g/${groupId}/pago`, text: 'Registrar otro pago' }));
}

async function groupView(groupId, tab) {
  const bundle = await api(`groups/${groupId}`);
  const people = new Map(bundle.members.map((person) => [person.id, person]));
  const balance = balanceText(bundle.myBalanceCents);
  const base = `#/g/${groupId}`;

  mount(
    topbar({
      title: `${bundle.group.emoji || '👥'} ${bundle.group.title}`,
      back: '#/',
      action: el('a', { class: 'icon-btn', href: `${base}/ajustes`, 'aria-label': 'Ajustes del grupo', text: '⚙' }),
    }),
    el('section', { class: 'content' },
      bundle.group.archived && el('div', { class: 'banner', text: 'Grupo archivado: solo lectura.' }),
      el('div', { class: 'card summary' },
        el('span', { class: 'muted small', text: 'Tu saldo en este grupo' }),
        el('strong', { class: `big ${balance.tone}`, text: balance.text })),
      el('nav', { class: 'tabs', 'aria-label': 'Secciones del grupo' },
        el('a', { href: base, class: tab === 'saldos' ? 'tab' : 'tab active', 'aria-current': tab === 'saldos' ? undefined : 'page', text: 'Gastos' }),
        el('a', { href: `${base}/saldos`, class: tab === 'saldos' ? 'tab active' : 'tab', 'aria-current': tab === 'saldos' ? 'page' : undefined, text: 'Saldos' })),
      tab === 'saldos' ? balancesPanel(bundle, people) : timeline(bundle, people)),
    !bundle.group.archived && el('a', { class: 'fab round', href: `${base}/gasto`, 'aria-label': 'Añadir gasto', text: '+' }));
}

async function expenseFormView(groupId, expenseId) {
  const bundle = await api(`groups/${groupId}`);
  const editing = expenseId ? bundle.expenses.find((expense) => expense.id === expenseId) : null;
  if (expenseId && !editing) throw new Error('Este gasto ya no existe.');
  if (bundle.group.archived) throw new Error('El grupo está archivado.');

  const id = editing?.id ?? crypto.randomUUID();
  const members = bundle.members;
  const meId = session.person.id;
  let payerId = editing?.payerId ?? (members.some((m) => m.id === meId) ? meId : members[0]?.id);
  const participants = new Set(editing ? editing.shares.map((share) => share.personId) : members.map((m) => m.id));

  const description = el('input', { type: 'text', maxLength: 120, placeholder: 'Cena, gasolina, súper…', autocomplete: 'off', value: editing?.description ?? '' });
  const amount = el('input', { type: 'text', inputMode: 'decimal', placeholder: '0,00', autocomplete: 'off', class: 'amount-input', value: editing ? centsToInput(editing.amountCents) : '' });
  const date = el('input', { type: 'date', value: editing?.spentOn ?? todayIso(), max: '2100-12-31' });
  const preview = el('div', { class: 'card list preview' });
  const status = el('p', { class: 'form-status', role: 'status' });

  const updatePreview = () => {
    preview.replaceChildren();
    const cents = parseAmount(amount.value);
    status.textContent = '';
    if (!participants.size) {
      status.textContent = 'Elige al menos una persona.';
      return;
    }
    if (!cents) return;
    try {
      const shares = computeShares({ totalCents: cents, mode: 'equal', entries: [...participants].map((personId) => ({ personId })), seed: id });
      for (const share of shares) {
        preview.append(el('div', { class: 'row static' },
          el('span', { class: 'row-main', text: personName(new Map(members.map((m) => [m.id, m])), share.personId) }),
          el('span', { class: 'amount', text: formatMoney(share.owedCents) })));
      }
    } catch (error) {
      if (error instanceof SplitError) status.textContent = error.message;
      else throw error;
    }
  };
  amount.addEventListener('input', updatePreview);

  const participantChips = el('div', { class: 'chips' },
    members.map((member) => chip({
      label: member.id === meId ? `${member.name} (tú)` : member.name,
      selected: participants.has(member.id),
      onToggle: (on) => {
        if (on) participants.add(member.id);
        else participants.delete(member.id);
        updatePreview();
      },
    })));
  const toggleAll = el('button', {
    type: 'button',
    class: 'link-btn',
    text: 'Todos / ninguno',
    onClick: () => {
      const selectAll = participants.size !== members.length;
      participantChips.querySelectorAll('.chip').forEach((node) => {
        if ((node.getAttribute('aria-checked') === 'true') !== selectAll) node.click();
      });
    },
  });

  const submit = el('button', { class: 'btn primary', type: 'submit', text: editing ? 'Guardar cambios' : 'Añadir gasto' });
  const form = el('form', {
    class: 'content form',
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      const cents = parseAmount(amount.value);
      if (!description.value.trim()) return (description.focus(), toast('Falta la descripción.'));
      if (!cents) return (amount.focus(), toast('Importe no válido.'));
      if (!participants.size) return toast('Elige al menos una persona.');
      const body = {
        id,
        description: description.value,
        amountCents: cents,
        payerId,
        spentOn: date.value,
        splitMode: 'equal',
        shares: [...participants].map((personId) => ({ personId })),
      };
      submit.disabled = true;
      try {
        if (editing) await api(`expenses/${id}`, { method: 'PUT', body: { ...body, version: editing.version } });
        else await api(`groups/${groupId}/expenses`, { method: 'POST', body });
        navigate(`#/g/${groupId}`, { replace: true });
        toast(editing ? 'Gasto actualizado' : 'Gasto añadido');
      } catch (error) {
        submit.disabled = false;
        if (error.status === 409 && error.data?.expense) {
          toast('Otro dispositivo cambió este gasto. Se ha recargado.');
          render();
          return;
        }
        handleError(error);
      }
    },
  },
  field('Descripción', description),
  field('Importe (€)', amount),
  el('div', { class: 'field' },
    el('span', { class: 'field-label', text: 'Pagó' }),
    el('div', { class: 'chips', role: 'radiogroup' },
      members.map((member) => chip({
        label: member.id === meId ? `${member.name} (tú)` : member.name,
        selected: member.id === payerId,
        role: 'radio',
        onToggle: () => { payerId = member.id; },
      })))),
  field('Fecha', date),
  el('div', { class: 'field' },
    el('span', { class: 'field-row' }, el('span', { class: 'field-label', text: 'Para quién (a partes iguales)' }), toggleAll),
    participantChips),
  preview,
  status,
  submit,
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
  }));

  mount(topbar({ title: editing ? 'Editar gasto' : 'Nuevo gasto', back: `#/g/${groupId}` }), form);
  updatePreview();
  if (!editing) description.focus();
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

  const amount = el('input', { type: 'text', inputMode: 'decimal', placeholder: '0,00', class: 'amount-input', autocomplete: 'off', value: suggested ? centsToInput(suggested) : '' });
  const date = el('input', { type: 'date', value: todayIso(), max: '2100-12-31' });
  const personChips = (selectedId, onPick) => el('div', { class: 'chips', role: 'radiogroup' },
    members.map((member) => chip({ label: personName(people, member.id), selected: member.id === selectedId, role: 'radio', onToggle: () => onPick(member.id) })));

  const submit = el('button', { class: 'btn primary', type: 'submit', text: 'Registrar pago' });
  const form = el('form', {
    class: 'content form',
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      const cents = parseAmount(amount.value);
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
  field('Importe (€)', amount, suggested ? 'Puedes cambiarlo si es un pago parcial.' : undefined),
  field('Fecha', date),
  submit);

  mount(topbar({ title: 'Registrar pago', back: `#/g/${groupId}/saldos` }), form);
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
      writable && el('button', { type: 'button', class: 'btn secondary block', text: 'Guardar nombre e icono', onClick: () => patch({ title: title.value, emoji }, 'Grupo actualizado') }),

      el('label', { class: 'card switch-row' },
        el('span', {},
          el('strong', { text: 'Simplificar deudas' }),
          el('span', { class: 'muted small block', text: 'Propone el mínimo de pagos entre todos, aunque alguien acabe pagando a quien no le prestó directamente.' })),
        simplify),

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

// ---------- Router ----------

const ROUTES = [
  [/^\/?$/, () => groupsView()],
  [/^\/nuevo-grupo$/, () => newGroupView()],
  [/^\/g\/(\d+)$/, ([id]) => groupView(id, 'gastos')],
  [/^\/g\/(\d+)\/saldos$/, ([id]) => groupView(id, 'saldos')],
  [/^\/g\/(\d+)\/gasto$/, ([id]) => expenseFormView(id, null)],
  [/^\/g\/(\d+)\/gasto\/([\w-]+)$/, ([id, expenseId]) => expenseFormView(id, expenseId)],
  [/^\/g\/(\d+)\/pago$/, ([id], query) => settlementFormView(id, query)],
  [/^\/g\/(\d+)\/ajustes$/, ([id]) => settingsView(id)],
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

async function init() {
  try {
    session = await api('session');
    sessionStorage.removeItem('repartos-reloaded');
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
