import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';
import { parseUserList, resolveUser } from './auth.js';
import { HttpError } from './errors.js';
import { createRepository } from './repository.js';
import { createFxService } from './fx.js';
import { createPushService } from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Carpetas servidas como estáticos. "shared/" contiene el dominio común a servidor y navegador.
// /s/ es la vista de solo lectura para amigos: sirve la misma app (nginx la deja pasar sin Authelia).
const STATIC_DIRS = [
  { prefix: '/shared/', dir: path.join(projectRoot, 'shared') },
  { prefix: '/s/shared/', dir: path.join(projectRoot, 'shared') },
  { prefix: '/s/', dir: path.join(projectRoot, 'public') },
  { prefix: '/', dir: path.join(projectRoot, 'public') },
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const MAX_BODY_BYTES = 256 * 1024;

export function normalizeBasePath(value) {
  const cleaned = `/${String(value ?? '/').trim()}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return cleaned === '' ? '/' : cleaned;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(301, { ...SECURITY_HEADERS, Location: location });
  res.end();
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'La petición es demasiado grande.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'El cuerpo de la petición no contiene JSON válido.');
  }
}

function resolveStatic(relativePath) {
  for (const { prefix, dir } of STATIC_DIRS) {
    if (!relativePath.startsWith(prefix)) continue;
    let requested;
    try {
      requested = decodeURIComponent(relativePath.slice(prefix.length));
    } catch {
      return null;
    }
    const filePath = path.resolve(dir, requested || 'index.html');
    if (filePath !== dir && !filePath.startsWith(dir + path.sep)) return null;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
    return null;
  }
  return null;
}

function serveStatic(res, relativePath) {
  const filePath = resolveStatic(relativePath);
  if (!filePath) return false;
  const extension = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': extension === '.html' ? 'no-store' : 'no-cache',
  });
  res.end(content);
  return true;
}

export function createApp(options = {}) {
  const basePath = normalizeBasePath(options.basePath ?? process.env.BASE_PATH ?? '/');
  const db = options.db || openDatabase(options.databaseOptions);
  const authOptions = {
    devUser: options.auth?.devUser ?? null,
    allowedUsers: options.auth?.allowedUsers ?? parseUserList(process.env.APP_USERS),
  };
  const prefix = basePath === '/' ? '' : basePath;
  // Cada cambio confirmado puede generar avisos push para el resto del grupo (sin bloquear la respuesta).
  let push = null;
  const repo = createRepository(db, {
    onActivity: (event) => {
      push?.notify(event).catch((error) => console.error('Error en avisos push:', error));
    },
  });
  push = createPushService(repo, options.push);
  const fx = createFxService(db, options.fx);

  // [método, patrón, handler(ctx)] -> handler devuelve [status, body]. ctx = { params, body, me }.
  const routes = [
    ['GET', /^\/people$/, () => [200, { people: repo.listPeople() }]],
    ['GET', /^\/fx$/, async ({ query }) => [200, await fx.getRate(query.get('from'), query.get('to'), query.get('date'))]],
    ['POST', /^\/people$/, ({ body }) => [200, { person: repo.findOrCreatePerson(body.name) }]],
    ['PATCH', /^\/people\/(\d+)$/, ({ params, body }) => [200, { person: repo.renamePerson(params[0], body.name) }]],
    ['GET', /^\/people\/(\d+)\/summary$/, ({ params }) => [200, repo.personSummary(params[0])]],

    ['GET', /^\/groups$/, ({ me }) => [200, { groups: repo.listGroups(me.id), unreadActivity: repo.unreadCount(me.id) }]],
    ['GET', /^\/activity$/, ({ me, query }) => [200, repo.listActivity(me.id, { before: query.get('before'), limit: query.get('limit') })]],
    ['POST', /^\/activity\/seen$/, ({ me, body }) => [200, repo.markActivitySeen(me.id, body.lastId)]],
    ['GET', /^\/push\/key$/, () => [200, { publicKey: push.publicKey() }]],
    ['POST', /^\/push\/subscriptions$/, ({ me, body }) => [200, repo.savePushSubscription(me.id, body.subscription)]],
    ['DELETE', /^\/push\/subscriptions$/, ({ me, body }) => [200, repo.deletePushSubscription(me.id, body.endpoint)]],
    ['POST', /^\/groups$/, ({ body, me }) => [201, repo.createGroup(body, me.id)]],
    ['GET', /^\/groups\/(\d+)$/, ({ params, me }) => [200, repo.getGroupBundle(params[0], me.id)]],
    ['PATCH', /^\/groups\/(\d+)$/, ({ params, body, me }) => [200, repo.updateGroup(params[0], body, me.id)]],
    ['POST', /^\/groups\/(\d+)\/share$/, ({ params, me }) => [200, repo.setShareLink(params[0], true, me.id)]],
    ['DELETE', /^\/groups\/(\d+)\/share$/, ({ params, me }) => [200, repo.setShareLink(params[0], false, me.id)]],
    ['POST', /^\/groups\/(\d+)\/members$/, ({ params, body, me }) => [200, repo.addMember(params[0], body, me.id)]],
    ['DELETE', /^\/groups\/(\d+)\/members\/(\d+)$/, ({ params, me }) => [200, repo.removeMember(params[0], params[1], me.id)]],

    ['POST', /^\/groups\/(\d+)\/expenses$/, ({ params, body, me }) => {
      const { created, expense } = repo.createExpense(params[0], body, me.id);
      return [created ? 201 : 200, { expense }];
    }],
    ['PUT', /^\/expenses\/([\w-]+)$/, ({ params, body, me }) => [200, { expense: repo.updateExpense(params[0], body, me.id) }]],
    ['DELETE', /^\/expenses\/([\w-]+)$/, ({ params, body, me }) => [200, { expense: repo.deleteExpense(params[0], body, me.id) }]],
    ['POST', /^\/expenses\/([\w-]+)\/restore$/, ({ params, me }) => [200, { expense: repo.restoreExpense(params[0], me.id) }]],

    ['POST', /^\/groups\/(\d+)\/settlements$/, ({ params, body, me }) => {
      const { created, settlement } = repo.createSettlement(params[0], body, me.id);
      return [created ? 201 : 200, { settlement }];
    }],
    ['DELETE', /^\/settlements\/([\w-]+)$/, ({ params, me }) => [200, { settlement: repo.deleteSettlement(params[0], me.id) }]],
    ['POST', /^\/settlements\/([\w-]+)\/restore$/, ({ params, me }) => [200, { settlement: repo.restoreSettlement(params[0], me.id) }]],
  ];

  async function handleApi(req, res, route, query) {
    const method = req.method;

    // Las escrituras exigen JSON: un formulario de otra web no puede enviarlo sin CORS.
    if (method !== 'GET' && method !== 'HEAD') {
      const contentType = String(req.headers['content-type'] || '');
      if (!contentType.startsWith('application/json')) {
        throw new HttpError(415, 'Las peticiones de escritura deben enviar JSON.');
      }
    }

    if (route === '/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }

    // Enlace de amigos: público y de solo lectura (en nginx va sin Authelia).
    // El token llega en una cabecera, no en la URL, para que no quede en los logs de acceso.
    if (route === '/shared') {
      if (method !== 'GET') throw new HttpError(405, 'Método no permitido.');
      return sendJson(res, 200, repo.getSharedBundle(req.headers['x-share-token']), { 'X-Robots-Tag': 'noindex' });
    }

    // A partir de aquí todo requiere un usuario autenticado por Authelia.
    const user = resolveUser(req, authOptions);
    if (!user) {
      throw new HttpError(401, 'Necesitas iniciar sesión.');
    }

    const me = repo.ensureAuthPerson(user);

    if (route === '/session' && method === 'GET') {
      return sendJson(res, 200, { user, person: me });
    }

    let pathMatched = false;
    for (const [routeMethod, pattern, handler] of routes) {
      const match = pattern.exec(route);
      if (!match) continue;
      pathMatched = true;
      if (routeMethod !== method) continue;
      const body = method === 'GET' ? {} : await readJsonBody(req);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'El cuerpo de la petición debe ser un objeto JSON.');
      }
      const [status, payload] = await handler({ params: match.slice(1), body, me, query });
      return sendJson(res, status, payload);
    }

    if (pathMatched) throw new HttpError(405, 'Método no permitido.');
    throw new HttpError(404, 'API no encontrada.');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (prefix && (pathname === '/' || pathname === prefix)) {
        return redirect(res, `${prefix}/`);
      }
      if (prefix && !pathname.startsWith(`${prefix}/`)) {
        throw new HttpError(404, 'Ruta no encontrada.');
      }

      const relativePath = pathname.slice(prefix.length);
      if (relativePath === '/api' || relativePath.startsWith('/api/')) {
        return await handleApi(req, res, relativePath.slice('/api'.length) || '/', url.searchParams);
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(res, relativePath)) return;
      throw new HttpError(404, 'Ruta no encontrada.');
    } catch (error) {
      // Los HttpError son intencionados y su mensaje es para la persona; el resto se oculta.
      const expected = error instanceof HttpError;
      const status = expected ? error.status : 500;
      if (!expected) console.error(error);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, {
        error: expected ? error.message : 'Error interno del servidor.',
        ...(expected && error.details ? error.details : {}),
      });
    }
  });

  server.on('close', () => {
    if (!options.db) db.close();
  });

  return { server, basePath, db };
}
