#!/usr/bin/env node
/** Standalone release server. Uses Node standard library only; no npm install required. */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGzip, gzip as gzipCallback } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('Для запуска требуется Node.js 22.12 или новее.');
  process.exit(1);
}

const HOST = '127.0.0.1';
const portText = process.env.PORT ?? '4173';
if (!/^\d{1,5}$/u.test(portText) || Number(portText) > 65535) {
  console.error('PORT должен быть целым числом от 0 до 65535. По умолчанию используется 4173.');
  process.exit(1);
}

const ROOT = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const DIST = resolve(ROOT, 'dist');
const PUBLIC = resolve(ROOT, 'public');
const DATA = resolve(PUBLIC, 'data');
const gzip = promisify(gzipCallback);
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.geojson', 'application/geo+json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.txt', 'text/plain; charset=utf-8'],
]);
const COMPRESSIBLE = new Set([
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.geojson',
  '.webmanifest',
  '.svg',
]);
const ICONS = new Set([
  'favicon.svg',
  'favicon.ico',
  'favicon.png',
  'apple-touch-icon.png',
  'site.webmanifest',
]);
// Export fonts are public assets. Keep the list exact: no arbitrary text/source files.
const EXPORT_FONT_FILES = new Set(['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'LICENSE-DejaVu.txt']);
const ASSET_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.svg',
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);
// Public runtime settings are read once. Never expose an environment file or a secret key.
let cloudConfig = { schemaVersion: 1, supabaseUrl: '', supabasePublishableKey: '', realtime: true };
try {
  let raw;
  try {
    raw = await readFile(resolve(PUBLIC, 'workshop-config.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (raw !== undefined) {
    if (Buffer.byteLength(raw) > 16384) throw new Error('Файл настроек слишком велик.');
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.schemaVersion !== 1 ||
      Object.keys(parsed).some(
        (k) =>
          ![
            'schemaVersion',
            'supabaseUrl',
            'supabasePublishableKey',
            'realtime',
            'surveyUrl',
            'classroomOrigin',
          ].includes(k),
      )
    )
      throw new Error('Некорректный формат настроек.');
    if (parsed.supabaseUrl || parsed.supabasePublishableKey) {
      const url = new URL(parsed.supabaseUrl);
      if (
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error('Некорректный адрес Supabase.');
      const key = parsed.supabasePublishableKey;
      if (
        typeof key !== 'string' ||
        key.length < 20 ||
        key.length > 4000 ||
        key.startsWith('sb_secret_')
      )
        throw new Error('Для браузера нужен публичный ключ Supabase.');
      if (!key.startsWith('sb_publishable_')) {
        const claims = JSON.parse(
          Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8'),
        );
        if (claims.role !== 'anon')
          throw new Error('Секретный ключ запрещён в публичной конфигурации.');
      }
      cloudConfig = {
        schemaVersion: 1,
        supabaseUrl: url.origin,
        supabasePublishableKey: key,
        realtime: parsed.realtime !== false,
      };
      if (parsed.surveyUrl || parsed.classroomOrigin) {
        const survey = new URL(parsed.surveyUrl),
          classroom = new URL(parsed.classroomOrigin);
        const safe = (url) =>
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash;
        if (
          !safe(survey) ||
          !safe(classroom) ||
          !survey.pathname.endsWith('/survey.html') ||
          classroom.pathname !== '/' ||
          survey.origin === classroom.origin
        )
          throw new Error('Опрос требует отдельного origin.');
        cloudConfig.surveyUrl = survey.href;
        cloudConfig.classroomOrigin = classroom.origin;
      }
    }
  }
} catch {
  console.error(
    'Не удалось прочитать public/workshop-config.json. Проверьте JSON, адрес проекта и публичный ключ; секретные ключи запрещены.',
  );
  process.exit(1);
}
const cloudOrigins = cloudConfig.supabaseUrl
  ? [cloudConfig.supabaseUrl, cloudConfig.supabaseUrl.replace(/^http/u, 'ws')].join(' ')
  : '';
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${cloudOrigins ? ' ' + cloudOrigins : ''}`,
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join('; ');

const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 24;
const MAX_BUFFERED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_JOBS = 4;
const compressedCache = new Map();
const compressing = new Map();
let cacheBytes = 0;

function commonHeaders(response) {
  response.setHeader('Content-Security-Policy', CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cache-Control', 'no-cache');
}

function respondError(request, response, status, message) {
  const body = Buffer.from(message + '\n', 'utf8');
  for (const header of ['Content-Encoding', 'ETag', 'Last-Modified', 'Vary'])
    response.removeHeader(header);
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function requestPath(url) {
  if (typeof url !== 'string' || url.length > 4096 || !url.startsWith('/') || url.startsWith('//'))
    return { error: 400 };
  // Do not use URL.pathname here: its dot-segment normalization would hide traversal attempts.
  const raw = url.split('?')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { error: 400 };
  }
  if (/[\u0000-\u001f\u007f\\%:#?*<>"|]/u.test(decoded) || decoded.includes('//'))
    return { error: 400 };
  const parts = decoded.split('/').slice(1);
  if (parts.some((part) => part.startsWith('.'))) return { error: 403 };
  if (decoded !== '/' && parts.some((part) => !part || !/^[a-z\d_-][a-z\d_.-]*$/iu.test(part)))
    return { error: 404 };
  return { path: decoded };
}

function inside(directory, file) {
  const child = relative(directory, file);
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) &&
    !isAbsolute(child)
  );
}

async function fileWithin(directory, name) {
  const path = resolve(directory, name);
  if (!inside(directory, path)) return null;
  try {
    // A symlink cannot turn a permitted URL into a source file outside its permitted tree.
    const actualRoot = await realpath(directory);
    if (actualRoot !== directory) return null;
    const actualPath = await realpath(path);
    if (!inside(directory, actualPath)) return null;
    const info = await stat(actualPath);
    return info.isFile() ? { path: actualPath, info } : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

async function findFile(path) {
  if (path === '/' || path === '/index.html') return fileWithin(DIST, 'index.html');
  if (path === '/survey.html') return fileWithin(DIST, 'survey.html');
  const name = path.slice(1);
  if (ICONS.has(name)) return (await fileWithin(DIST, name)) ?? fileWithin(PUBLIC, name);
  if (path.startsWith('/assets/') && ASSET_EXTENSIONS.has(extname(path).toLowerCase()))
    return fileWithin(DIST, name);
  if (path.startsWith('/fonts/') && EXPORT_FONT_FILES.has(path.slice('/fonts/'.length))) {
    return (
      (await fileWithin(resolve(DIST, 'fonts'), path.slice('/fonts/'.length))) ??
      fileWithin(resolve(PUBLIC, 'fonts'), path.slice('/fonts/'.length))
    );
  }
  if (path.startsWith('/data/') && ['.json', '.geojson'].includes(extname(path).toLowerCase())) {
    return (
      (await fileWithin(resolve(DIST, 'data'), path.slice('/data/'.length))) ??
      fileWithin(DATA, path.slice('/data/'.length))
    );
  }
  return null;
}

function encodingQuality(header, encoding) {
  if (!header) return encoding === 'identity' ? 1 : 0;
  const values = new Map();
  for (const value of String(header).split(',')) {
    const [name, ...parameters] = value
      .trim()
      .toLowerCase()
      .split(';')
      .map((part) => part.trim());
    if (!name) continue;
    const q = parameters.find((part) => part.startsWith('q='));
    values.set(
      name,
      q === undefined
        ? 1
        : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(q.slice(2))
          ? Number(q.slice(2))
          : 0,
    );
  }
  if (values.has(encoding)) return values.get(encoding);
  if (encoding === 'identity') return values.get('*') === 0 ? 0 : 1;
  return values.get('*') ?? 0;
}

function touchCache(key) {
  const value = compressedCache.get(key);
  if (value) {
    compressedCache.delete(key);
    compressedCache.set(key, value);
  }
  return value;
}

async function compressed(file, key) {
  const cached = touchCache(key);
  if (cached) return cached;
  if (compressing.has(key)) return compressing.get(key);
  if (file.info.size > MAX_BUFFERED_FILE_BYTES || compressing.size >= MAX_BUFFERED_JOBS)
    return null;
  const promise = (async () => {
    const result = await gzip(await readFile(file.path), { level: 6 });
    if (result.length <= MAX_CACHE_BYTES) {
      compressedCache.set(key, result);
      cacheBytes += result.length;
      while (compressedCache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
        const oldest = compressedCache.keys().next().value;
        cacheBytes -= compressedCache.get(oldest).length;
        compressedCache.delete(oldest);
      }
    }
    return result;
  })();
  compressing.set(key, promise);
  try {
    return await promise;
  } finally {
    compressing.delete(key);
  }
}

function notModified(request, etag, modifiedAt) {
  const match = request.headers['if-none-match'];
  if (match !== undefined)
    return String(match)
      .split(',')
      .some(
        (token) =>
          token.trim() === '*' || token.trim().replace(/^W\//u, '') === etag.replace(/^W\//u, ''),
      );
  const since = Date.parse(String(request.headers['if-modified-since'] ?? ''));
  return Number.isFinite(since) && Math.floor(modifiedAt / 1000) * 1000 <= since;
}

async function handle(request, response) {
  commonHeaders(response);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    response.setHeader('Connection', 'close');
    return respondError(request, response, 405, 'Разрешены только GET и HEAD.');
  }
  const parsed = requestPath(request.url);
  if (parsed.error)
    return respondError(request, response, parsed.error, 'Запрошенный путь недопустим.');
  if (parsed.path === '/workshop-config.json') {
    const body = Buffer.from(JSON.stringify(cloudConfig));
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    return response.end(request.method === 'HEAD' ? undefined : body);
  }
  const file = await findFile(parsed.path);
  if (!file) return respondError(request, response, 404, 'Файл не найден.');
  const extension = extname(parsed.path === '/' ? 'index.html' : parsed.path).toLowerCase();
  const canCompress = COMPRESSIBLE.has(extension);
  const useGzip = canCompress && encodingQuality(request.headers['accept-encoding'], 'gzip') > 0;
  if (!useGzip && encodingQuality(request.headers['accept-encoding'], 'identity') === 0)
    return respondError(request, response, 406, 'Запрошенный способ передачи не поддерживается.');
  const fileKey = JSON.stringify([
    file.path,
    file.info.size,
    file.info.mtimeMs,
    file.info.ctimeMs,
    file.info.ino,
  ]);
  const encoding = useGzip ? 'gzip' : 'identity';
  const etag = `W/"${createHash('sha256')
    .update(fileKey + ':' + encoding)
    .digest('hex')
    .slice(0, 32)}"`;
  response.setHeader('Content-Type', MIME.get(extension));
  response.setHeader('ETag', etag);
  response.setHeader('Last-Modified', file.info.mtime.toUTCString());
  if (canCompress) response.setHeader('Vary', 'Accept-Encoding');
  if (useGzip) response.setHeader('Content-Encoding', 'gzip');
  if (notModified(request, etag, file.info.mtimeMs)) {
    response.writeHead(304);
    return response.end();
  }

  if (useGzip) {
    const body = await compressed(file, fileKey);
    if (response.destroyed) return;
    if (body) {
      response.setHeader('Content-Length', body.length);
      return response.end(request.method === 'HEAD' ? undefined : body);
    }
    if (request.method === 'HEAD') return response.end();
    return pipeline(createReadStream(file.path), createGzip({ level: 6 }), response);
  }
  response.setHeader('Content-Length', file.info.size);
  if (request.method === 'HEAD') return response.end();
  return pipeline(createReadStream(file.path), response);
}

if (!(await fileWithin(DIST, 'index.html'))) {
  console.error(
    'Готовая сборка dist/index.html не найдена. Распакуйте полный релиз или выполните npm ci и npm run build.',
  );
  process.exit(1);
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (
      response.destroyed ||
      error.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
      error.code === 'ECONNRESET'
    )
      return;
    if (!response.headersSent)
      respondError(request, response, 500, 'Не удалось прочитать файл сборки.');
    else response.destroy();
    console.error('Ошибка статического сервера:', error.code ?? error.name);
  });
});
server.keepAliveTimeout = 5000;
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.maxHeadersCount = 64;
server.maxConnections = 128;
server.on('connect', (_request, socket) =>
  socket.end(
    'HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
  ),
);
server.on('upgrade', (_request, socket) =>
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'),
);
server.on('error', (error) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? 'Порт занят. Остановите другой сервер или задайте свободный PORT.'
      : `Не удалось запустить сервер: ${error.code ?? error.message}`,
  );
  process.exitCode = 1;
});
server.listen(Number(portText), HOST, () => {
  console.log(`Демографическая мастерская: http://${HOST}:${server.address().port}/`);
  console.log('Локальная готовая сборка. Для остановки нажмите Ctrl+C.');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 5000).unref();
  });
