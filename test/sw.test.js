// El service worker se ejecuta en un contexto simulado: caché en memoria y red controlada.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SCOPE = 'https://repartos.test/';
const source = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function basic(body, init = {}) {
  const response = new Response(body, init);
  Object.defineProperty(response, 'type', { value: init.type || 'basic' });
  Object.defineProperty(response, 'redirected', { value: Boolean(init.redirected) });
  return response;
}

function loadWorker(network) {
  const handlers = {};
  const store = new Map();
  const key = (request) => new URL(typeof request === 'string' ? request : request.url, SCOPE).href;
  const cache = {
    put: async (request, response) => { store.set(key(request), response); },
    match: async (request) => store.get(key(request))?.clone(),
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (request) => store.delete(key(request)),
  };
  const context = {
    self: {
      registration: { scope: SCOPE },
      addEventListener: (type, handler) => { handlers[type] = handler; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: (request) => cache.match(request) },
    fetch: async (request) => network.fetch(key(request), request),
    Response, Headers, URL, Promise, console,
  };
  vm.runInNewContext(source, context);

  async function dispatch(request) {
    let responded = null;
    const pending = [];
    handlers.fetch({ request, respondWith: (promise) => { responded = promise; }, waitUntil: (promise) => pending.push(promise) });
    const response = responded ? await responded : null;
    await Promise.all(pending);
    return response;
  }
  async function install() {
    const waits = [];
    handlers.install({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
  }
  async function message(data) {
    const waits = [];
    handlers.message({ data, waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
  }
  return { dispatch, install, message, store };
}

const get = (path, extra = {}) => ({ url: SCOPE + path, method: 'GET', mode: 'cors', ...extra });

test('instala la app, pero nunca guarda una redirección al login de Authelia', async () => {
  const network = {
    fetch: async (url) => (url.endsWith('/styles.css')
      ? basic(null, { status: 200, redirected: true }) // sesión caducada: acabaría en auth.jusboif.es
      : basic(`contenido de ${url}`, { status: 200 })),
  };
  const worker = loadWorker(network);
  await worker.install();
  assert.ok(worker.store.has(`${SCOPE}app.js`));
  assert.ok(worker.store.has(SCOPE));
  assert.ok(!worker.store.has(`${SCOPE}styles.css`));
});

test('API: con red pasa y se guarda; sin red, la última copia marcada como offline', async () => {
  let online = true;
  const network = {
    fetch: async (url) => {
      if (!online) throw new TypeError('Failed to fetch');
      return basic(JSON.stringify({ url }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  const worker = loadWorker(network);

  let response = await worker.dispatch(get('api/groups/1'));
  assert.equal(response.headers.get('X-Repartos-Offline'), null);

  online = false;
  response = await worker.dispatch(get('api/groups/1'));
  assert.equal(response.headers.get('X-Repartos-Offline'), '1');
  assert.deepEqual(await response.json(), { url: `${SCOPE}api/groups/1` });

  response = await worker.dispatch(get('api/groups/2'));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Sin conexión/);
});

test('API: los errores y redirecciones no sustituyen a la copia buena', async () => {
  let mode = 'ok';
  const network = {
    fetch: async () => {
      if (mode === 'ok') return basic('{"v":1}', { status: 200 });
      // Una redirección real tiene status 0, que Node no deja construir; basta con el tipo.
      if (mode === 'redirect') return basic(null, { status: 200, type: 'opaqueredirect' });
      throw new TypeError('offline');
    },
  };
  const worker = loadWorker(network);
  await worker.dispatch(get('api/session'));
  mode = 'redirect';
  const redirect = await worker.dispatch(get('api/session'));
  assert.equal(redirect.type, 'opaqueredirect', 'la app recibe la redirección y recarga hacia el login');
  mode = 'offline';
  assert.equal(await (await worker.dispatch(get('api/session'))).text(), '{"v":1}');
});

test('al cambiar de usuario se borran los datos de la API, pero no la app', async () => {
  const worker = loadWorker({ fetch: async (url) => basic(url, { status: 200 }) });
  await worker.install();
  await worker.dispatch(get('api/groups'));
  await worker.dispatch(get('api/session'));
  await worker.message({ type: 'forget-api-data' });
  assert.ok(![...worker.store.keys()].some((url) => url.includes('/api/')));
  assert.ok(worker.store.has(`${SCOPE}app.js`));
});

test('no intercepta escrituras, la vista de amigos ni los tipos de cambio', async () => {
  const worker = loadWorker({ fetch: async () => basic('x', { status: 200 }) });
  for (const request of [
    get('api/groups/1/expenses', { method: 'POST' }),
    get('s/'),
    get('api/shared'),
    get('api/fx?from=JPY&to=EUR&date=2026-11-02'),
    { url: 'https://otra-web.test/app.js', method: 'GET', mode: 'cors' },
  ]) {
    assert.equal(await worker.dispatch(request), null, request.url);
  }
});

test('navegación sin red: abre la última versión guardada de la app', async () => {
  let online = true;
  const worker = loadWorker({
    fetch: async () => {
      if (!online) throw new TypeError('offline');
      return basic('<html>app</html>', { status: 200 });
    },
  });
  await worker.dispatch(get('', { mode: 'navigate' }));
  online = false;
  const response = await worker.dispatch(get('', { mode: 'navigate' }));
  assert.equal(await response.text(), '<html>app</html>');
});
