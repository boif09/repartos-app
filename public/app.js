// Las rutas son relativas al documento, así la app funciona bajo cualquier BASE_PATH.
// El login lo gestiona Authelia: si la sesión caduca, nginx responde con una redirección
// a auth.jusboif.es y la app recarga la página para que el navegador la siga.
const appEl = document.getElementById('app');

class SessionExpiredError extends Error {}

async function api(pathName, options = {}) {
  const response = await fetch(`api/${pathName}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
    redirect: 'manual',
  });
  if (response.type === 'opaqueredirect' || response.status === 401) {
    throw new SessionExpiredError('La sesión ha caducado.');
  }
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error || 'Error de conexión.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function mount(templateId) {
  const template = document.getElementById(templateId);
  appEl.replaceChildren(template.content.cloneNode(true));
}

function showMessage(text) {
  const message = document.createElement('p');
  message.className = 'loading';
  message.textContent = text;
  appEl.replaceChildren(message);
}

function renderHome(user) {
  mount('homeTemplate');
  document.getElementById('userName').textContent = user;
}

async function init() {
  try {
    const session = await api('session');
    renderHome(session.user);
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      // Evita un bucle de recargas si el servidor responde 401 sin pasar por Authelia (p. ej. en local).
      if (!sessionStorage.getItem('repartos-reloaded')) {
        sessionStorage.setItem('repartos-reloaded', '1');
        window.location.reload();
        return;
      }
      showMessage('Necesitas iniciar sesión.');
      return;
    }
    showMessage('No se puede conectar con el servidor.');
  } finally {
    if (appEl.querySelector('.topbar')) sessionStorage.removeItem('repartos-reloaded');
  }
}

init();
