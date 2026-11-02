import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';
import { parseUserList, resolveUser } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Carpetas servidas como estáticos. "shared/" contiene el dominio común a servidor y navegador.
const STATIC_DIRS = [
  { prefix: '/shared/', dir: path.join(projectRoot, 'shared') },
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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

function sendNoContent(res, headers = {}) {
  res.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end();
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

  async function handleApi(req, res, route) {
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

    // A partir de aquí todo requiere un usuario autenticado por Authelia.
    const user = resolveUser(req, authOptions);
    if (!user) {
      throw new HttpError(401, 'Necesitas iniciar sesión.');
    }

    if (route === '/session' && method === 'GET') {
      return sendJson(res, 200, { user });
    }

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
        return await handleApi(req, res, relativePath.slice('/api'.length) || '/');
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(res, relativePath)) return;
      throw new HttpError(404, 'Ruta no encontrada.');
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: status >= 500 ? 'Error interno del servidor.' : error.message });
    }
  });

  server.on('close', () => {
    if (!options.db) db.close();
  });

  return { server, basePath, db };
}
