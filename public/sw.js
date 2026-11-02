// Service worker de Repartos: la app abre y se puede consultar sin conexión.
// - Archivos de la app: caché primero y se actualizan en segundo plano.
// - Lecturas de la API: red primero; sin red, la última respuesta guardada (marcada como offline).
// - Escrituras, enlaces de amigos y redirecciones de Authelia: nunca se guardan.
const CACHE = 'repartos-v1';
const SHELL = [
  './',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'shared/money.js',
  'shared/splits.js',
  'shared/fx.js',
  'icons/icon-192.png',
];

const scopeUrl = new URL(self.registration.scope);
const inScope = (url) => url.origin === scopeUrl.origin && url.pathname.startsWith(scopeUrl.pathname);
const relative = (url) => url.pathname.slice(scopeUrl.pathname.length);

// Solo se guardan respuestas buenas de verdad: ni redirecciones al login ni errores.
const cacheable = (response) => response && response.ok && response.type === 'basic' && !response.redirected;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (path) => {
      const response = await fetch(path, { redirect: 'manual', credentials: 'same-origin' });
      if (cacheable(response)) await cache.put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function fromNetworkThenCache(request, { offlineHeader = false } = {}) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (cacheable(response)) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (!cached) throw error;
    if (!offlineHeader) return cached;
    const headers = new Headers(cached.headers);
    headers.set('X-Repartos-Offline', '1');
    return new Response(await cached.blob(), { status: cached.status, headers });
  }
}

async function fromCacheThenUpdate(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const update = fetch(request).then(async (response) => {
    if (cacheable(response)) await cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(update.catch(() => {}));
    return cached;
  }
  return update;
}

// La app avisa cuando cambia el usuario: se borran los datos de la API de la persona anterior.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'forget-api-data') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const request of await cache.keys()) {
      if (relative(new URL(request.url)).startsWith('api/')) await cache.delete(request);
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !inScope(url)) return;
  const path = relative(url);

  // Vista de amigos y tipos de cambio: siempre a la red.
  if (path.startsWith('s/') || path.startsWith('api/shared') || path.startsWith('api/fx')) return;

  if (request.mode === 'navigate') {
    // Las redirecciones al login de Authelia pasan tal cual; sin red, la app guardada.
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (cacheable(response) && path === '') await (await caches.open(CACHE)).put('./', response.clone());
        return response;
      } catch {
        return (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }
  if (path.startsWith('api/')) {
    event.respondWith(fromNetworkThenCache(request, { offlineHeader: true }).catch(() => Response.json(
      { error: 'Sin conexión y sin datos guardados para esta pantalla.' },
      { status: 503, headers: { 'X-Repartos-Offline': '1' } },
    )));
    return;
  }
  event.respondWith(fromCacheThenUpdate(request, event));
});
