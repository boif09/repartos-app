import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, normalizeBasePath } from '../src/app.js';
import { openDatabase } from '../src/database.js';

async function startApp(t, options = {}) {
  const { server } = createApp({
    basePath: '/',
    db: openDatabase({ dbPath: ':memory:' }),
    auth: { allowedUsers: ['xavi', 'judit'] },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(baseUrl, pathName, { method = 'GET', body, user, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(user ? { 'Remote-User': user } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* no es JSON */ }
  return { response, json, text };
}

test('normalizeBasePath', () => {
  assert.equal(normalizeBasePath('/repartos/'), '/repartos');
  assert.equal(normalizeBasePath('repartos'), '/repartos');
  assert.equal(normalizeBasePath('/'), '/');
  assert.equal(normalizeBasePath(''), '/');
  assert.equal(normalizeBasePath(undefined), '/');
});

test('health es público y el resto de la API exige usuario de Authelia', async (t) => {
  const baseUrl = await startApp(t);

  let result = await call(baseUrl, '/api/health');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.json, { ok: true });

  result = await call(baseUrl, '/api/session');
  assert.equal(result.response.status, 401);

  result = await call(baseUrl, '/api/session', { user: 'otro' });
  assert.equal(result.response.status, 401, 'usuario de Authelia fuera de APP_USERS');

  result = await call(baseUrl, '/api/session', { user: 'Xavi' });
  assert.equal(result.response.status, 200);
  assert.equal(result.json.user, 'xavi');

  result = await call(baseUrl, '/api/no-existe', { user: 'judit' });
  assert.equal(result.response.status, 404);

  result = await call(baseUrl, '/api/no-existe');
  assert.equal(result.response.status, 401, 'sin usuario no se revela qué rutas existen');
});

test('usuario de desarrollo', async (t) => {
  const baseUrl = await startApp(t, { auth: { devUser: 'judit', allowedUsers: [] } });
  const result = await call(baseUrl, '/api/session');
  assert.equal(result.json.user, 'judit');
});

test('las escrituras sin JSON se rechazan (protección CSRF)', async (t) => {
  const baseUrl = await startApp(t);
  const result = await call(baseUrl, '/api/session', {
    method: 'POST',
    user: 'xavi',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(result.response.status, 415);
});

test('estáticos, cabeceras de seguridad y path traversal en la raíz del subdominio', async (t) => {
  const baseUrl = await startApp(t);

  let result = await call(baseUrl, '/');
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('content-type'), /text\/html/);
  assert.match(result.text, /<title>Repartos<\/title>/);
  assert.match(result.response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(result.response.headers.get('referrer-policy'), 'no-referrer');

  result = await call(baseUrl, '/app.js');
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('content-type'), /javascript/);

  for (const evil of ['/..%2Fsrc%2Fauth.js', '/..%2F.env', '/shared/..%2F..%2F.env', '/%2e%2e%2fpackage.json']) {
    result = await call(baseUrl, evil);
    assert.equal(result.response.status, 404, evil);
  }
});

test('también funciona bajo una subruta', async (t) => {
  const baseUrl = await startApp(t, { basePath: '/repartos' });

  let result = await call(baseUrl, '/repartos');
  assert.equal(result.response.status, 301);
  assert.equal(result.response.headers.get('location'), '/repartos/');

  result = await call(baseUrl, '/repartos/');
  assert.equal(result.response.status, 200);

  result = await call(baseUrl, '/repartos/api/session', { user: 'xavi' });
  assert.equal(result.json.user, 'xavi');

  result = await call(baseUrl, '/otra/app.js');
  assert.equal(result.response.status, 404);
});
